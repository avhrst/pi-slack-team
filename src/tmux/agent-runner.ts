import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import { ActivityProgress } from "../pi/activity-progress.js";
import type { PiTurnResult, PiUiHandler } from "../pi/session-pool.js";
import type { ConversationKey, ConversationRecord, Registry } from "../storage/registry.js";
import { bufferName, TmuxMailbox, tmuxSocketPath } from "./mailbox.js";
import { delegationOutputSchema, peerRequestSchema, readySchema, runResultSchema, workerRunId, type DelegationContext, type DelegationPresenter, type PeerRequest, type PeerResponse, type RunRequest, type RunResult } from "./protocol.js";
import { RunEventWindow } from "./event-window.js";

export class TmuxAgentRunner {
  presenter: DelegationPresenter | undefined;
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

  async start(receivePeers = true): Promise<void> {
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
        ...(this.config.pi.provider ? ["--provider", this.config.pi.provider] : []),
        ...(this.config.pi.model ? ["--model", this.config.pi.model] : []),
        ...(this.config.pi.thinkingLevel ? ["--thinking", this.config.pi.thinkingLevel] : []),
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
        if (receivePeers) this.startPeers();
        this.logger.info("tmux_agent_ready", { agentId: this.config.agentId, session, socketPath: this.mailbox.socketPath, sessionId: ready.sessionId });
        return;
      } catch { await this.mailbox.wait(this.#stop.signal, 500); }
    }
    throw new Error(`Interactive Pi did not become ready. Inspect tmux session ${session}.`);
  }

  startPeers(): void {
    if (this.#peerLoop) return;
    this.#peerLoop = this.#receivePeers();
    void this.#peerLoop.catch((error: unknown) => {
      if (!this.#stop.signal.aborted) this.#peerFailure = true;
      this.logger.error("tmux_peer_loop_failed", { agentId: this.config.agentId, error });
    });
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
      return { runId: request.id, text: result.text, sessionFile: result.sessionFile, sessionId: result.sessionId };
    } catch (error) {
      this.registry.setStatus(key, "error");
      await this.presenter?.finishParent?.(request.id);
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
        // Child packets bypass Pi entirely. Persist renderer state before acknowledging.
        for (const name of names.filter(name => name.startsWith(`pst-child-events-${request.id}-`)).sort((a, b) => Number(a.split("-").at(-1)) - Number(b.split("-").at(-1)))) {
          const packet = delegationOutputSchema.parse(await this.mailbox.read(name));
          const worker = this.config.interAgent?.peers.find(peer => peer.agentId === packet.workerId && peer.role === "worker");
          if (!worker || packet.parentRunId !== request.id || packet.from !== this.config.agentId ||
              JSON.stringify(packet.origin) !== JSON.stringify(request.origin) ||
              name !== `pst-child-events-${request.id}-${packet.id}-${packet.events[0]!.sequence}`) throw new Error("Invalid child output correlation");
          this.presenter?.consume(packet);
          for (const item of packet.events) {
            const event = item.event;
            if (["delegation_start", "agent_start", "delegation_end"].includes(String(event.type))) {
              const text = event.type === "delegation_start" ? `${packet.workerId}: завдання прийнято; очікую черги.`
                : event.type === "agent_start" ? `${packet.workerId}: виконує завдання.`
                : `${packet.workerId}: ${event.ok ? "завершено" : "помилка"}. ${event.deliveryFailed ? "Доставка стрічки перервана; результат доступний менеджеру." : "Стрічку результату показано окремо."}`;
              onEvent?.({ type: "delegation_status", toolCallId: packet.toolCallId, text });
            }
          }
          const ack = await this.mailbox.readIfPresent(bufferName("child-ack", packet.id)) as { throughSequence?: number } | undefined;
          await this.mailbox.put(bufferName("child-ack", packet.id), { parentRunId: request.id, throughSequence: Math.max(ack?.throughSequence ?? 0, packet.events.at(-1)!.sequence) }, false);
          await this.mailbox.remove(name);
        }
        if (!accepted && names.includes(bufferName("accepted", request.id))) {
          accepted = true;
          onAccepted?.();
        }
        const eventPrefix = bufferName("events", request.id);
        const packets = names.filter((name) => name === eventPrefix || name.startsWith(`${eventPrefix}-`))
          .sort((a, b) => Number(a.slice(eventPrefix.length + 1) || 0) - Number(b.slice(eventPrefix.length + 1) || 0));
        for (const packet of packets) {
          const progress = await this.mailbox.readIfPresent(packet) as { events?: Array<{ sequence: number; event: RpcRecord }> } | undefined;
          for (const item of progress?.events ?? []) {
            if (item.sequence > lastSequence) { onEvent?.(item.event); lastSequence = item.sequence; }
          }
          // Acknowledgement: never delete a packet until every event was consumed.
          if (packet !== eventPrefix) await this.mailbox.remove(packet);
        }
        if (conversation) for (const name of names.filter((name) => /^pst-ui-[0-9a-f-]{36}$/.test(name))) {
          if (dialogs.has(name)) continue;
          const ui = await this.mailbox.readIfPresent(name) as (RpcRecord & { runId?: string; id?: string }) | undefined;
          if (!ui || ui.runId !== request.id || typeof ui.id !== "string") continue;
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
          const value = await this.mailbox.readIfPresent(bufferName("done", request.id));
          if (value === undefined) continue;
          const result = runResultSchema.parse(value);
          if (result.id !== request.id) throw new Error("Mismatched tmux result");
          if ((result.finalEventSequence ?? 0) > lastSequence) {
            await this.mailbox.wait(signal, 500);
            continue;
          }
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
      for (const name of await this.mailbox.list(`${bufferName("events", request.id)}-`)) await this.mailbox.remove(name);
      this.#activeRuns.delete(request.id);
    }
  }

  async #receivePeers(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      const names = await this.mailbox.list("pst-peer-in-");
      for (const name of names.slice(0, 128)) {
        if (this.#peers.has(name)) continue;
        const value = await this.mailbox.readIfPresent(name);
        if (value === undefined) continue;
        const parsed = peerRequestSchema.safeParse(value);
        if (!parsed.success || name !== bufferName("peer-in", `${parsed.data.from}-${parsed.data.id}`)) {
          await this.mailbox.remove(name);
          continue;
        }
        const task = this.#handlePeer(parsed.data).catch((error: unknown) => {
          this.logger.error("tmux_peer_request_failed", { agentId: this.config.agentId, error });
        }).finally(() => { this.#peers.delete(name); });
        this.#peers.set(name, task);
      }
      await this.mailbox.wait(this.#stop.signal, 2_000);
    }
  }

  async #handlePeer(request: PeerRequest): Promise<void> {
    const peer = this.config.interAgent?.peers.find((peer) => peer.agentId === request.from && peer.role === "manager");
    const replyName = bufferName("out-response", `${request.from}-${request.id}`);
    if ((await this.mailbox.list(replyName)).includes(replyName)) return;
    let ok = false;
    let text = "Unauthorized delegation";
    let finalOutputSequence: number | undefined;
    let persistReceipt = false;
    const authorized = this.config.role === "worker" && request.to === this.config.agentId && peer &&
      (request.origin.kind === "local" || (request.origin.teamId === this.config.slack.teamId &&
        request.origin.appId === peer.appId && this.config.slack.allowedUserIds.includes(request.origin.userId)));
    if (authorized) {
      const claimed = this.registry.claimEvent(`tmux-peer:${request.from}:${request.id}`);
      if (!claimed) {
        const receipt = this.registry.loadPublication<{ requestHash: string; response: PeerResponse }>(`peer-result:${request.from}:${request.id}`);
        if (receipt?.requestHash === peerFingerprint(request)) {
          if (!(await this.mailbox.list(`pst-out-events-${request.from}-${request.id}-`)).length) receipt.response.finalOutputSequence = 0;
          await this.mailbox.put(replyName, receipt.response); return;
        }
        text = "Previous worker delivery was interrupted or already accepted; not replaying tools.";
      }
      else {
        persistReceipt = true;
        const id = workerRunId(request.from, request.id);
        if (request.origin.kind === "slack") this.registry.ensureDelegatedThread({
          teamId: request.origin.teamId, appId: this.config.slack.appId,
          channelId: request.origin.channelId, threadTs: request.origin.threadTs,
        });
        const context: DelegationContext | undefined = request.origin.kind === "slack" && request.parentRunId && request.toolCallId && this.presenter ? {
          id: request.id, from: request.from, workerId: this.config.agentId,
          parentRunId: request.parentRunId, toolCallId: request.toolCallId, origin: request.origin,
        } : undefined;
        const output = new RunEventWindow();
        let outputWrite = Promise.resolve();
        let publishedSequence = 0;
        const publish = () => {
          outputWrite = outputWrite.then(async () => {
            while (context && output.events.length) {
              const events = output.batch();
              if (!events.length) throw new Error("Child output exceeds the transport bound");
              await this.mailbox.put(`pst-out-events-${request.from}-${request.id}-${events[0]!.sequence}`, { ...context, events }, false);
              output.published(events.at(-1)!.sequence);
              publishedSequence = events.at(-1)!.sequence;
            }
          }).catch(() => { /* Retain the packet window for the next flush; never replay Pi. */ });
        };
        const visible = (event: RpcRecord) => {
          if (!context) return;
          if (event.type === "delegation_end" && typeof event.text === "string") {
            let text = event.text;
            while (Buffer.byteLength(JSON.stringify(text)) > 400_000) text = text.slice(0, Math.floor(text.length * 0.8));
            event = { ...event, text: text.length === event.text.length ? text : `${text}\n[transport text truncated]` };
          }
          output.push(event);
          this.presenter!.record(context, output.sequence, event);
          publish();
        };
        const activity = new ActivityProgress();
        let status = "";
        let statusWrite = Promise.resolve();
        const progress = (next: string) => {
          if (next === status) return;
          status = next;
          statusWrite = statusWrite.then(() => this.mailbox.put(bufferName("out-progress", `${request.from}-${request.id}`), {
            id: request.id, to: request.from, text: next,
          }, false)).catch(() => undefined);
        };
        progress(activity.describe());
        try {
          if (context) {
            const route = await this.presenter!.begin(context);
            visible({ type: "delegation_start", ...route });
          }
          const result = await this.#run({
            id, text: request.task, origin: request.origin, fromAgent: request.from,
            createdAt: request.createdAt,
            expiresAt: Math.min(request.expiresAt, Date.now() + this.config.pi.turnTimeoutMs),
          }, (event) => {
            if (activity.record(event)) progress(activity.describe());
            visible(event);
          });
          text = result.text;
          ok = true;
        } catch (error) { text = error instanceof Error ? error.message : "Worker failed"; }
        if (context) {
          const delivered = await this.presenter!.finish(context, ok, text).catch(() => false);
          visible({ type: "delegation_end", ok, text, deliveryFailed: !delivered });
          await outputWrite;
          finalOutputSequence = publishedSequence;
          if (output.events.length) text += "\nWorker output transport was interrupted; executed actions were not replayed.";
        }
        await statusWrite;
      }
    }
    const response: PeerResponse = {
      id: request.id, to: request.from, ok,
      text: text.slice(0, this.config.interAgent?.maxResponseChars ?? 50_000),
      ...(finalOutputSequence !== undefined ? { finalOutputSequence } : {}),
    };
    if (persistReceipt) this.registry.savePublication(`peer-result:${request.from}:${request.id}`, { requestHash: peerFingerprint(request), response });
    await this.mailbox.put(replyName, response);
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

function peerFingerprint(request: PeerRequest): string {
  const identity: Omit<PeerRequest, "expiresAt"> & { expiresAt?: number } = { ...request };
  delete identity.expiresAt;
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
