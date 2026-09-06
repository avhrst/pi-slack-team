import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import type { PiTurnResult, PiUiHandler } from "../pi/session-pool.js";
import type { ConversationKey, ConversationRecord, Registry } from "../storage/registry.js";
import { bufferName, TmuxMailbox, tmuxSocketPath } from "./mailbox.js";
import { peerRequestSchema, readySchema, runResultSchema, workerRunId, type PeerRequest, type RunRequest, type RunResult } from "./protocol.js";

export class TmuxAgentRunner {
  readonly mailbox: TmuxMailbox;
  readonly #stop = new AbortController();
  readonly #peers = new Map<string, Promise<void>>();
  readonly #activeRuns = new Set<string>();
  #peerLoop: Promise<void> | undefined;
  #instanceId: string | undefined;
  #peerFailure = false;
  #ownsSession = false;

  constructor(
    readonly config: AgentConfig,
    readonly configPath: string,
    readonly registry: Registry,
    readonly logger: Logger,
    readonly uiHandler: PiUiHandler = async () => ({ cancelled: true }),
  ) {
    this.mailbox = new TmuxMailbox(config.pi.tmuxCommand, tmuxSocketPath(config));
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.config.stateDir, { recursive: true, mode: 0o700 });
    const session = this.config.expectedUnixUser;
    const sessions = await this.mailbox.exec(["list-sessions", "-F", "#{session_name}"])
      .then((text) => text.trim().split("\n").filter(Boolean), () => []);
    if (sessions.length && (sessions.length !== 1 || sessions[0] !== session)) {
      throw new Error("Refusing to change an unrelated/non-singleton tmux server");
    }
    if (!sessions.length) {
      const sessionFile = path.join(this.config.pi.sessionDir, "tmux-agent.jsonl");
      fs.mkdirSync(this.config.pi.sessionDir, { recursive: true, mode: 0o700 });
      await this.mailbox.exec([
        "-f", fileURLToPath(new URL("../../deploy/tmux.conf", import.meta.url)),
        "new-session", "-d", "-s", session, "-n", "pi", "-c", this.config.pi.cwd,
        "-x", "160", "-y", "48",
        "/usr/bin/env", `PI_CODING_AGENT_DIR=${this.config.pi.agentDir}`,
        `PI_CODING_AGENT_SESSION_DIR=${this.config.pi.sessionDir}`, `PI_TMUX_CONFIG=${this.configPath}`,
        this.config.pi.command, "--session", sessionFile,
        "--exclude-tools", "subagent",
        "--extension", fileURLToPath(new URL("./agent-extension.js", import.meta.url)),
      ], undefined, 10_000);
      this.#ownsSession = true;
      await this.mailbox.exec(["set-option", "-t", session, "@pi-team-agent", this.config.agentId]);
    } else {
      const owner = (await this.mailbox.exec(["show-option", "-v", "-t", session, "@pi-team-agent"])).trim();
      if (owner !== this.config.agentId) throw new Error("Refusing to adopt an unrelated tmux session");
      this.#ownsSession = true;
    }
    const deadline = Date.now() + Math.max(this.config.pi.requestTimeoutMs, 90_000);
    while (Date.now() < deadline && !this.#stop.signal.aborted) {
      try {
        const ready = await this.health();
        this.#instanceId = ready.instanceId;
        this.#peerLoop = this.#receivePeers();
        void this.#peerLoop.catch((error: unknown) => {
          if (!this.#stop.signal.aborted) this.#peerFailure = true;
          this.logger.error("tmux_peer_loop_failed", { agentId: this.config.agentId, error });
        });
        this.logger.info("tmux_agent_ready", { agentId: this.config.agentId, session, socketPath: this.mailbox.socketPath, sessionId: ready.sessionId });
        return;
      } catch { await this.mailbox.wait(this.#stop.signal, 500); }
    }
    throw new Error(`Interactive Pi did not become ready. Inspect tmux session ${session}.`);
  }

  async health() {
    if (this.#peerFailure) throw new Error("tmux peer receiver failed");
    const ready = readySchema.parse(await this.mailbox.read("pst-ready"));
    if (ready.agentId !== this.config.agentId || Date.now() - ready.updatedAt > 15_000 ||
        (this.#instanceId && ready.instanceId !== this.#instanceId)) {
      throw new Error("tmux agent heartbeat is stale or process identity changed");
    }
    return ready;
  }

  async prompt(
    key: ConversationKey, ownerUserId: string, text: string,
    onEvent?: (event: RpcRecord) => void, allowExistingOwner = false, sourceUserId = ownerUserId,
  ): Promise<PiTurnResult> {
    const conversation = this.registry.getConversation(key) ?? this.registry.createConversation(key, ownerUserId);
    if (conversation.ownerUserId !== ownerUserId && !allowExistingOwner) throw new Error("Conversation belongs to another Slack user");
    const ready = await this.health();
    this.registry.bindAgentSession(key, ready.sessionFile, ready.sessionId);
    const request: RunRequest = {
      id: crypto.randomUUID(), text,
      origin: { kind: "slack", ...key, userId: sourceUserId },
      createdAt: Date.now(), expiresAt: Date.now() + this.config.pi.turnTimeoutMs,
    };
    try {
      const result = await this.#run(request, onEvent, { ...conversation, ownerUserId: sourceUserId }, () => this.registry.setStatus(key, "running"));
      this.registry.setStatus(key, "idle");
      return { text: result.text, sessionFile: result.sessionFile, sessionId: result.sessionId };
    } catch (error) {
      this.registry.setStatus(key, "error");
      throw error;
    }
  }

  async #run(
    request: RunRequest, onEvent?: (event: RpcRecord) => void,
    conversation?: ConversationRecord, onAccepted?: () => void,
  ): Promise<RunResult> {
    if (this.#stop.signal.aborted) throw new Error("tmux agent is stopping");
    if (this.#activeRuns.size >= 128) throw new Error("Agent request queue is full");
    this.#activeRuns.add(request.id);
    const uiController = new AbortController();
    const signal = AbortSignal.any([uiController.signal, this.#stop.signal]);
    const dialogs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
    let lastSequence = 0;
    let accepted = false;
    let completed = false;
    let lastHealth = 0;
    try {
      await this.mailbox.put(bufferName("run", request.id), request);
      while (!this.#stop.signal.aborted && Date.now() < request.expiresAt) {
        if (Date.now() - lastHealth > 3_000) { await this.health(); lastHealth = Date.now(); }
        const names = await this.mailbox.list();
        if (!accepted && names.includes(bufferName("accepted", request.id))) {
          accepted = true;
          onAccepted?.();
          onEvent?.({ type: "agent_start" });
        }
        if (names.includes(bufferName("events", request.id))) {
          const progress = await this.mailbox.read(bufferName("events", request.id)) as { events?: Array<{ sequence: number; event: RpcRecord }> };
          for (const item of progress.events ?? []) {
            if (item.sequence > lastSequence) { onEvent?.(item.event); lastSequence = item.sequence; }
          }
        }
        if (conversation) for (const name of names.filter((name) => /^pst-ui-[0-9a-f-]{36}$/.test(name))) {
          if (dialogs.has(name)) continue;
          const ui = await this.mailbox.read(name) as RpcRecord & { runId?: string; id?: string };
          if (ui.runId !== request.id || typeof ui.id !== "string") continue;
          const dialogController = new AbortController();
          const promise = this.uiHandler({
            conversation, request: ui, signal: AbortSignal.any([signal, dialogController.signal]),
          }).catch(() => ({ cancelled: true })).then(async (response) => {
            if (!signal.aborted && !dialogController.signal.aborted) await this.mailbox.put(bufferName("ui-reply", ui.id!), response);
          }).catch(() => undefined);
          dialogs.set(name, { controller: dialogController, promise });
        }
        for (const [name, dialog] of dialogs) if (!names.includes(name)) dialog.controller.abort();
        if (names.includes(bufferName("done", request.id))) {
          const result = runResultSchema.parse(await this.mailbox.read(bufferName("done", request.id)));
          if (result.id !== request.id) throw new Error("Mismatched tmux result");
          completed = true;
          if (!result.ok) throw new Error(result.text);
          return result;
        }
        await this.mailbox.wait(signal, 500);
      }
      throw new Error("Agent request cancelled or timed out; executed actions are not undone.");
    } finally {
      uiController.abort();
      if (!completed) {
        await this.mailbox.put(bufferName("cancel", request.id), { id: request.id }).catch(() => undefined);
        // A queued request is removed; active work receives the correlated cancellation.
        await this.mailbox.remove(bufferName("run", request.id));
      }
      await Promise.all([...dialogs.values()].map((dialog) => dialog.promise));
      for (const kind of ["accepted", "events", "done"]) await this.mailbox.remove(bufferName(kind, request.id));
      this.#activeRuns.delete(request.id);
    }
  }

  async #receivePeers(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      const names = await this.mailbox.list("pst-peer-in-");
      for (const name of names.slice(0, 128)) {
        if (this.#peers.has(name)) continue;
        const parsed = peerRequestSchema.safeParse(await this.mailbox.read(name));
        if (!parsed.success || name !== bufferName("peer-in", `${parsed.data.from}-${parsed.data.id}`)) {
          await this.mailbox.remove(name);
          continue;
        }
        const task = this.#handlePeer(parsed.data).catch((error: unknown) => {
          this.logger.error("tmux_peer_request_failed", { agentId: this.config.agentId, error });
        }).finally(() => { this.#peers.delete(name); });
        this.#peers.set(name, task);
      }
      await this.mailbox.wait(this.#stop.signal, 500);
    }
  }

  async #handlePeer(request: PeerRequest): Promise<void> {
    const peer = this.config.interAgent?.peers.find((peer) => peer.agentId === request.from && peer.role === "manager");
    const replyName = bufferName("out-response", `${request.from}-${request.id}`);
    if ((await this.mailbox.list(replyName)).includes(replyName)) return;
    let ok = false;
    let text = "Unauthorized delegation";
    const authorized = this.config.role === "worker" && request.to === this.config.agentId && peer &&
      (request.origin.kind === "local" || (request.origin.teamId === this.config.slack.teamId &&
        request.origin.appId === peer.appId && this.config.slack.allowedUserIds.includes(request.origin.userId)));
    if (authorized) {
      const claimed = this.registry.claimEvent(`tmux-peer:${request.from}:${request.id}`);
      if (!claimed) text = "Previous worker delivery was interrupted or already accepted; not replaying tools.";
      else {
        const id = workerRunId(request.from, request.id);
        let status = "queued";
        let statusWrite = Promise.resolve();
        const progress = (next: string) => {
          if (next === status) return;
          status = next;
          statusWrite = statusWrite.then(() => this.mailbox.put(bufferName("out-progress", `${request.from}-${request.id}`), {
            id: request.id, to: request.from, text: next,
          }, false)).catch(() => undefined);
        };
        progress("accepted; waiting for agent queue");
        try {
          const result = await this.#run({
            id, text: request.task, origin: request.origin, fromAgent: request.from,
            createdAt: request.createdAt,
            expiresAt: Math.min(request.expiresAt, Date.now() + this.config.pi.turnTimeoutMs),
          }, (event) => {
            if (event.type === "agent_start") progress("running");
            if (event.type === "tool_execution_start") progress(`running tool ${String(event.toolName).slice(0, 120)}`);
            if (event.type === "tool_execution_end") progress(`tool ${String(event.toolName).slice(0, 120)} ${event.isError ? "failed" : "completed"}`);
          });
          text = result.text;
          ok = true;
        } catch (error) { text = error instanceof Error ? error.message : "Worker failed"; }
        await statusWrite;
      }
    }
    await this.mailbox.put(replyName, {
      id: request.id, to: request.from, ok,
      text: text.slice(0, this.config.interAgent?.maxResponseChars ?? 50_000),
    });
    this.logger.info("tmux_peer_completed", { agentId: this.config.agentId, from: request.from, requestId: request.id, ok });
  }

  async shutdown(): Promise<void> {
    this.#stop.abort();
    await this.#peerLoop?.catch(() => undefined);
    await Promise.allSettled(this.#peers.values());
    const deadline = Date.now() + 10_000;
    while (this.#activeRuns.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    // Only this agent's dedicated server/session; never touch the operator's tmux.
    if (this.#ownsSession) await this.mailbox.exec(["kill-session", "-t", this.config.expectedUnixUser]).catch(() => undefined);
    this.#ownsSession = false;
  }
}
