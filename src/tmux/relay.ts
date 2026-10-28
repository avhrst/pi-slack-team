import type { AgentConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { TmuxMailbox, bufferName, tmuxSocketPath } from "./mailbox.js";
import { delegationOutputSchema, delegationSchema, peerResponseSchema, readySchema, workerRunId, type Delegation } from "./protocol.js";

export function authorizeRelay(source: AgentConfig, target: AgentConfig, request: Delegation): boolean {
  return source.pi.transport === "tmux" && target.pi.transport === "tmux" &&
    source.role === "manager" && target.role === "worker" && request.to === target.agentId &&
    source.slack.teamId === target.slack.teamId && source.agentId !== target.agentId &&
    Boolean(source.interAgent?.peers.some((peer) => peer.agentId === target.agentId && peer.appId === target.slack.appId && peer.role === "worker")) &&
    Boolean(target.interAgent?.peers.some((peer) => peer.agentId === source.agentId && peer.appId === source.slack.appId && peer.role === "manager")) &&
    request.task.length <= (source.interAgent?.maxTaskChars ?? 0) &&
    request.task.length <= (target.interAgent?.maxTaskChars ?? 0) &&
    request.createdAt <= Date.now() + 5_000 &&
    request.expiresAt - request.createdAt <= (source.interAgent?.requestTimeoutMs ?? 0) &&
    (request.origin.kind === "local" || (
      request.origin.teamId === source.slack.teamId && request.origin.appId === source.slack.appId &&
      source.slack.allowedUserIds.includes(request.origin.userId) && target.slack.allowedUserIds.includes(request.origin.userId)
    ));
}

/** Privileged but narrow: fixed per-agent sockets, buffers only, reciprocal peer ACLs.
 * No argv, socket path, shell command or tmux target comes from a message body.
 * Pending requests stay in the source tmux buffer until result delivery, so relay
 * restart needs no separate message queue and worker claims prevent replay.
 */
export class TmuxRelay {
  readonly #agents = new Map<string, { config: AgentConfig; mailbox: TmuxMailbox }>();
  #lastStatusAt = 0;
  constructor(configs: AgentConfig[], readonly logger: Logger) {
    for (const config of configs) {
      if (this.#agents.has(config.agentId)) throw new Error("Duplicate relay agent");
      if (config.pi.transport !== "tmux") throw new Error("Relay requires tmux agents");
      this.#agents.set(config.agentId, { config, mailbox: new TmuxMailbox(config.pi.tmuxCommand, tmuxSocketPath(config)) });
    }
    if (new Set(configs.map((config) => config.expectedUnixUser)).size !== configs.length ||
        new Set(configs.map(tmuxSocketPath)).size !== configs.length) throw new Error("Relay agent identities/sockets must be unique");
  }

  async tick(): Promise<void> {
    if (Date.now() - this.#lastStatusAt > 2_000) {
      this.#lastStatusAt = Date.now();
      const statuses: Array<{ agentId: string; role: string; state: string }> = [];
      for (const { config, mailbox } of this.#agents.values()) {
        let state = "offline";
        try {
          const ready = readySchema.parse(await mailbox.read("pst-ready"));
          state = ready.agentId !== config.agentId || Date.now() - ready.updatedAt > 15_000 ? "stale" : ready.busy ? "busy" : "idle";
        } catch { /* offline/unready */ }
        statuses.push({ agentId: config.agentId, role: config.role, state });
      }
      for (const { config, mailbox } of this.#agents.values()) {
        const allowed = new Set([config.agentId, ...(config.interAgent?.peers.map((peer) => peer.agentId) ?? [])]);
        await mailbox.put("pst-team-status", { updatedAt: Date.now(), agents: statuses.filter((status) => allowed.has(status.agentId)) }, false).catch(() => undefined);
      }
    }
    for (const { config: source, mailbox: sourceBox } of this.#agents.values()) {
      let names: string[];
      try { names = await sourceBox.list("pst-out-request-"); }
      catch { continue; /* offline agent, no request to relay */ }
      for (const name of names.slice(0, 128)) {
        try {
          const value = await sourceBox.readIfPresent(name);
          if (value === undefined) continue;
          const parsed = delegationSchema.safeParse(value);
          if (!parsed.success || name !== bufferName("out-request", parsed.data.id)) {
            await sourceBox.remove(name);
            this.logger.warn("tmux_relay_rejected", { agentId: source.agentId, reason: "invalid-envelope" });
            continue;
          }
          const request = parsed.data;
          const target = this.#agents.get(request.to);
          const respond = async (ok: boolean, text: string, finalOutputSequence?: number) => {
            await sourceBox.put(bufferName("peer-result", request.id), { id: request.id, to: source.agentId, ok, text, ...(finalOutputSequence !== undefined ? { finalOutputSequence } : {}) });
            await sourceBox.remove(name);
          };
          if (!target || !authorizeRelay(source, target.config, request)) {
            await respond(false, "Unknown or unauthorized tmux peer request");
            continue;
          }
          const targetBox = target.mailbox;
          const peerId = `${source.agentId}-${request.id}`;
          const inbox = bufferName("peer-in", peerId);
          const responseName = bufferName("out-response", peerId);
          const progressName = bufferName("out-progress", peerId);
          const outputPrefix = `pst-out-events-${peerId}-`;
          const ackName = bufferName("child-ack", request.id);
          const cleanup = async () => {
            await targetBox.remove(inbox);
            await targetBox.remove(responseName);
            await targetBox.remove(progressName);
            for (const output of await targetBox.list(outputPrefix)) await targetBox.remove(output);
            if (request.parentRunId) for (const output of await sourceBox.list(`pst-child-events-${request.parentRunId}-${request.id}-`)) await sourceBox.remove(output);
            await sourceBox.remove(ackName);
          };
          if (Date.now() >= request.expiresAt) {
            await targetBox.put(bufferName("cancel", workerRunId(source.agentId, request.id)), { id: workerRunId(source.agentId, request.id) }).catch(() => undefined);
            await respond(false, "Delegation expired or was cancelled; already executed actions are not undone.");
            await cleanup();
            continue;
          }
          let targetNames: string[];
          try {
            const ready = readySchema.parse(await targetBox.read("pst-ready"));
            if (ready.agentId !== target.config.agentId || Date.now() - ready.updatedAt > 15_000) throw new Error("stale");
            targetNames = await targetBox.list();
          } catch {
            await respond(false, `Worker ${request.to} is offline or not ready; task was not replayed.`);
            continue;
          }
          const acknowledgement = await sourceBox.readIfPresent(ackName) as { parentRunId?: string; throughSequence?: number } | undefined;
          const acknowledged = acknowledgement?.parentRunId === request.parentRunId && Number.isSafeInteger(acknowledgement?.throughSequence)
            ? acknowledgement!.throughSequence! : 0;
          for (const output of targetNames.filter(name => name.startsWith(outputPrefix)).sort((a, b) => Number(a.slice(outputPrefix.length)) - Number(b.slice(outputPrefix.length)))) {
            const packet = delegationOutputSchema.parse(await targetBox.read(output));
            if (packet.id !== request.id || packet.from !== source.agentId || packet.workerId !== target.config.agentId ||
                packet.parentRunId !== request.parentRunId || packet.toolCallId !== request.toolCallId ||
                JSON.stringify(packet.origin) !== JSON.stringify(request.origin) ||
                output !== `${outputPrefix}${packet.events[0]!.sequence}` ||
                packet.events.some((item, index) => index > 0 && item.sequence <= packet.events[index - 1]!.sequence)) throw new Error("Invalid worker output packet");
            if (packet.events.at(-1)!.sequence <= acknowledged) await targetBox.remove(output);
            else {
              const destination = `pst-child-events-${request.parentRunId}-${request.id}-${packet.events[0]!.sequence}`;
              // Immutable until the source Node renderer acknowledges it.
              if (!(await sourceBox.list(destination)).includes(destination)) await sourceBox.put(destination, packet, false);
            }
          }
          if (targetNames.includes(responseName)) {
            const response = peerResponseSchema.parse(await targetBox.read(responseName));
            if ((response.finalOutputSequence ?? 0) > acknowledged) continue;
            if (response.id !== request.id || response.to !== source.agentId || response.text.length > source.interAgent!.maxResponseChars) {
              await respond(false, "Invalid or oversized worker response");
            } else await respond(response.ok, response.text, response.finalOutputSequence);
            await cleanup();
            this.logger.info("tmux_relay_completed", { agentId: source.agentId, workerId: request.to, requestId: request.id });
          } else {
            if (!targetNames.includes(inbox)) {
              await targetBox.put(inbox, { ...request, from: source.agentId });
              this.logger.info("tmux_relay_delivered", { agentId: source.agentId, workerId: request.to, requestId: request.id });
            }
            if (targetNames.includes(progressName)) {
              const progress = await targetBox.read(progressName) as { id?: string; to?: string; text?: unknown };
              if (progress.id === request.id && progress.to === source.agentId && typeof progress.text === "string") {
                await sourceBox.put(bufferName("peer-progress", request.id), { text: progress.text.slice(0, 4_000) }, false);
              }
            }
          }
        } catch {
          this.logger.warn("tmux_relay_delivery_failed", { agentId: source.agentId });
          // Keep source request for retry, bounded by its original deadline.
        }
      }
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tick();
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 500);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
}
