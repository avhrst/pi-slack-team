import type { AgentConfig } from "../config/schema.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import type { Registry } from "../storage/registry.js";
import type { DelegationContext, DelegationOutput, DelegationPresenter } from "../tmux/protocol.js";
import { SlackConsoleReporter, type SlackDeliveryQueue, type ConsoleDelivery, type ConsoleReporterState } from "./console-reporter.js";
import { PiProgressTranscript } from "./pi-progress.js";

interface Publication {
  context: DelegationContext;
  route: "worker" | "manager";
  reason?: string;
  proxy: boolean;
  sequence: number;
  deliveredSequence?: number;
  stage: "queued" | "running" | "completed" | "failed";
  headerTs?: string;
  headerPending?: boolean;
  headerText?: string;
  console?: ConsoleReporterState;
  deliveryFailed?: boolean;
  finalText?: string;
  settled?: boolean;
  parentFinished?: boolean;
}
interface LivePublication {
  state: Publication;
  reporter: SlackConsoleReporter;
  writes: Promise<void>;
  progress: PiProgressTranscript;
  refreshQueued: boolean;
  finishing?: Promise<boolean>;
}

/** Visible child events go straight from authenticated transport to this renderer. */
export class SlackDelegationPublisher implements DelegationPresenter {
  readonly #live = new Map<string, LivePublication>();
  constructor(
    readonly config: AgentConfig,
    readonly registry: Registry,
    readonly queue: SlackDeliveryQueue,
    readonly delivery: (channel: string, thread: string) => ConsoleDelivery,
    readonly onError: (error: unknown) => void,
  ) {}

  #id(context: DelegationContext, proxy: boolean): string { return `delegation:${proxy ? "proxy" : "worker"}:${context.from}:${context.id}`; }
  #save(live: LivePublication): void { this.registry.savePublication(this.#id(live.state.context, live.state.proxy), live.state); }
  #open(context: DelegationContext, proxy: boolean, route: Publication["route"], reason?: string): LivePublication {
    if (this.#live.size > 256) for (const [key, live] of this.#live) {
      if (live.state.settled && (!live.state.proxy || live.state.parentFinished)) {
        void live.reporter.close();
        this.#live.delete(key);
      }
    }
    const id = this.#id(context, proxy);
    const previous = this.#live.get(id);
    if (previous) return previous;
    const state = this.registry.loadPublication<Publication>(id) ?? {
      context, proxy, route, ...(reason ? { reason } : {}), sequence: 0, stage: "queued",
    };
    if (context.origin.kind !== "slack") throw new Error("Slack publication requires Slack origin");
    const origin = context.origin;
    const target = this.delivery(origin.channelId, origin.threadTs);
    const label = proxy ? `*Worker ${context.workerId}*\n` : "";
    const live: LivePublication = {
      state, writes: Promise.resolve(), refreshQueued: false,
      progress: new PiProgressTranscript(this.config.slack.progressMode === "console" ? "summary" : this.config.slack.progressMode),
      reporter: new SlackConsoleReporter(this.queue, {
        post: text => target.post(label + text), update: (ts, text) => target.update(ts, label + text), remove: ts => target.remove(ts),
      }, error => { state.deliveryFailed = true; this.#save(live); this.onError(error); }, {
        ...(state.console ? { state: state.console } : {}),
        save: snapshot => { state.console = snapshot; this.#save(live); },
      }),
    };
    this.#live.set(id, live);
    this.#save(live);
    return live;
  }

  #header(live: LivePublication, initial = false): Promise<void> {
    const write = live.writes.then(async () => {
      const { state } = live;
      if (state.context.origin.kind !== "slack" || state.deliveryFailed) return;
      const target = this.delivery(state.context.origin.channelId, state.context.origin.threadTs);
      const label = state.proxy ? `*Worker ${state.context.workerId}*\n` : "";
      const status = initial || state.stage === "queued" ? "Отримав завдання від менеджера. Очікую черги."
        : state.stage === "running" ? "Виконую." : state.stage === "completed" ? "Завдання завершено." : "Виконання перервано; вже виконані дії не скасовано.";
      const text = label + status + (state.reason ? `\n${state.reason}` : "") +
        (state.stage === "running" && this.config.slack.progressMode !== "console" ? `\n${live.progress.render("working")}` : "");
      if (state.headerTs && state.headerText === text) return;
      if (state.headerTs) await this.queue.send("update", () => target.update(state.headerTs!, text));
      else {
        if (state.headerPending) throw new Error("Uncertain delegation acknowledgement; refusing to post twice");
        state.headerPending = true;
        this.#save(live);
        state.headerTs = await this.queue.send("post", () => target.post(text), undefined, true);
        state.headerPending = false;
      }
      state.headerText = text;
      this.#save(live);
    });
    live.writes = write.catch(error => { this.onError(error); });
    return write;
  }

  async begin(context: DelegationContext): Promise<{ route: "worker" | "manager"; reason?: string }> {
    const dm = context.origin.kind === "slack" && context.origin.channelId.startsWith("D");
    const live = this.#open(context, false, dm ? "manager" : "worker", dm ? "У DM стрічку worker показує менеджер." : undefined);
    if (live.state.route === "worker") {
      try { if (!live.state.headerTs) await this.#header(live, true); }
      catch {
        // No access or an uncertain initial acknowledgement: switch once, never invite/repost.
        live.state.route = "manager";
        live.state.reason = "Worker не зміг підтвердити доставку в канал. Його стрічку показує менеджер.";
        this.#save(live);
      }
    }
    return { route: live.state.route, ...(live.state.reason ? { reason: live.state.reason } : {}) };
  }

  record(context: DelegationContext, sequence: number, event: RpcRecord): void {
    const live = this.#open(context, false, "worker");
    if (sequence <= live.state.sequence) return;
    live.state.sequence = sequence;
    if (live.state.route === "worker") this.#record(live, event);
    if (live.state.route === "worker" && live.state.settled && !live.state.deliveryFailed) live.state.deliveredSequence = sequence;
    this.#save(live);
  }

  #record(live: LivePublication, event: RpcRecord): void {
    if (live.state.deliveryFailed) return;
    if (event.type === "agent_start" && live.state.stage === "queued") {
      live.state.stage = "running";
      void this.#header(live).catch(error => { live.state.deliveryFailed = true; this.#save(live); this.onError(error); });
    }
    if (this.config.slack.progressMode === "console") live.reporter.record(event);
    else if (live.progress.record(event) && live.state.stage === "running") {
      // At most one queued header refresh; re-read the latest transcript on delivery.
      if (!live.refreshQueued) {
        live.refreshQueued = true;
        void live.writes.then(() => { live.refreshQueued = false; return this.#header(live); }).catch(error => {
          live.state.deliveryFailed = true; this.#save(live); this.onError(error);
        });
      }
    }
  }

  #finish(live: LivePublication, ok: boolean, text: string): Promise<boolean> {
    live.finishing ??= this.#finishOnce(live, ok, text);
    return live.finishing;
  }

  async #finishOnce(live: LivePublication, ok: boolean, text: string): Promise<boolean> {
    if (live.state.settled) return !live.state.deliveryFailed;
    live.state.stage = ok ? "completed" : "failed";
    live.state.finalText = text;
    this.#save(live);
    await live.writes;
    if (!live.state.deliveryFailed) {
      try {
        if (ok) await live.reporter.complete(text);
        else await live.reporter.fail(text);
        await this.#header(live);
      } catch (error) { live.state.deliveryFailed = true; this.onError(error); }
    }
    live.state.settled = true;
    if (!live.state.deliveryFailed) live.state.deliveredSequence = live.state.sequence;
    this.#save(live);
    return !live.state.deliveryFailed;
  }

  async finish(context: DelegationContext, ok: boolean, text: string): Promise<boolean> {
    const live = this.#open(context, false, "worker");
    if (live.state.route === "manager") {
      live.state.stage = ok ? "completed" : "failed";
      live.state.finalText = text;
      live.state.settled = true;
      this.#save(live);
      return true;
    }
    return this.#finish(live, ok, text);
  }

  consume(packet: DelegationOutput): void {
    let live = this.#live.get(this.#id(packet, true));
    for (const item of packet.events) {
      if (item.event.type === "delegation_start") {
        if (item.event.route !== "manager") continue;
        live = this.#open(packet, true, "manager", typeof item.event.reason === "string" ? item.event.reason : undefined);
        if (!live.state.headerTs && !live.state.headerPending) void this.#header(live, true).catch(error => {
          live!.state.deliveryFailed = true; this.#save(live!); this.onError(error);
        });
      }
      if (!live || item.sequence <= live.state.sequence) continue;
      live.state.sequence = item.sequence;
      if (item.event.type === "delegation_end") {
        // Completion is durable before acknowledging the packet. Delivery may lag Pi.
        live.state.stage = item.event.ok ? "completed" : "failed";
        live.state.finalText = typeof item.event.text === "string" ? item.event.text : "Worker finished.";
        void this.#finish(live, Boolean(item.event.ok), live.state.finalText);
      } else this.#record(live, item.event);
      this.#save(live);
    }
  }

  async finishParent(parentRunId: string): Promise<boolean> {
    let delivered = true;
    for (const [id, live] of this.#live) if (live.state.proxy && live.state.context.parentRunId === parentRunId) {
      await live.writes;
      if (!await this.#finish(live, live.state.stage === "completed", live.state.finalText ?? "Parent request stopped; worker actions were not replayed.")) delivered = false;
      live.state.parentFinished = true;
      this.#save(live);
      await live.reporter.close();
      this.#live.delete(id);
    }
    return delivered;
  }

  async recover(): Promise<void> {
    for (const { id, state } of this.registry.publications<Publication>()) {
      if (!id.startsWith("delegation:")) continue;
      if (state.route !== "worker" && !state.proxy) continue;
      if (state.settled) continue;
      const live = this.#open(state.context, state.proxy, state.route, state.reason);
      const terminal = state.stage === "completed" || state.stage === "failed";
      await this.#finish(live, terminal && state.stage === "completed", terminal ? state.finalText ?? "Worker finished." : "Bridge restarted; interrupted work was not replayed.");
    }
  }

  async close(): Promise<void> { await Promise.allSettled([...this.#live.values()].map(async live => { await live.writes; await live.reporter.close(); await live.finishing; })); }
}
