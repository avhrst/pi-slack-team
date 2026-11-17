import { compactProgressText } from "../pi/activity-progress.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import type { Registry } from "../storage/registry.js";
import type { DelegationContext, DelegationOutput, DelegationPresenter } from "../tmux/protocol.js";
import { SlackConsoleReporter, type SlackDeliveryQueue, type ConsoleDelivery, type ConsoleReporterState } from "./console-reporter.js";
import type { ConsoleEntry } from "./console-transcript.js";
import { renderSlackWorkProgress, SlackWorkProgress, type SlackWorkStep } from "./live-thread-reporter.js";
import { escapeSlackText } from "./mrkdwn.js";

const WORKER_FAILED = "🛑 Профільний агент не завершив завдання.";
const WORKER_COMPLETE = "✅ Профільний агент завершив завдання.";

function projectStep(id: string, step: SlackWorkStep): Extract<ConsoleEntry, { kind: "public-step" }> {
  return { id, kind: "public-step", step, text: renderSlackWorkProgress(step) };
}

function migrateConsole(state: ConsoleReporterState, progress: SlackWorkProgress, stage: Publication["stage"], finalText?: string): ConsoleReporterState {
  const entries = state.transcript.entries.flatMap((entry): ConsoleEntry[] => {
    const isFinal = entry.kind !== "tool" && entry.text.trim() === finalText?.trim();
    if (entry.kind === "status") {
      return [{ ...entry, text: stage === "failed" && isFinal ? WORKER_FAILED : compactProgressText(entry.text) }];
    }
    if (entry.kind === "assistant") return stage === "completed" && isFinal ? [entry] : [];
    if (entry.kind === "public-step") return [entry];
    const step = progress.record({
      type: entry.state === "running" ? "tool_execution_update" : "tool_execution_end",
      toolCallId: entry.id.slice(5), toolName: entry.name, isError: entry.state === "failed",
      result: { content: [{ type: "text", text: entry.output }] },
      partialResult: { content: [{ type: "text", text: entry.output }] },
    });
    return step?.kind === "step" ? [projectStep(entry.id, step)] : [];
  });
  return {
    transcript: { entries, sequence: state.transcript.sequence, delegatedTools: [] },
    // Keep Slack IDs and pending receipts for reconciliation; stop storing old payloads.
    posted: state.posted.map(([id, item]) => [id, { ts: item.ts, text: "" }]),
    pending: state.pending,
  };
}

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
  publicJournal?: true;
  deliveryFailed?: boolean;
  finalText?: string;
  settled?: boolean;
  parentFinished?: boolean;
}
interface LivePublication {
  state: Publication;
  reporter: SlackConsoleReporter;
  writes: Promise<void>;
  progress: SlackWorkProgress;
  finishing?: Promise<boolean>;
}

/** Visible child events go straight from authenticated transport to this renderer. */
export class SlackDelegationPublisher implements DelegationPresenter {
  readonly #live = new Map<string, LivePublication>();
  constructor(
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
    const label = proxy ? `🤖 *Профільний агент ${context.workerId}*\n` : "";
    const progress = new SlackWorkProgress();
    if (state.reason) state.reason = compactProgressText(state.reason);
    if (state.console && !state.publicJournal) {
      state.console = migrateConsole(state.console, progress, state.stage, state.finalText);
      if (state.stage === "failed") state.finalText = WORKER_FAILED;
      if (state.headerText) state.headerText = "";
    }
    state.publicJournal = true;
    const live: LivePublication = {
      state, writes: Promise.resolve(), progress,
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
      const label = state.proxy ? `🤖 *Профільний агент ${state.context.workerId}*\n` : "";
      const status = initial || state.stage === "queued" ? "⏳ Отримав завдання від менеджера. Очікую черги."
        : state.stage === "running" ? "🔄 Виконую."
          : state.stage === "completed" ? "✅ Завдання завершено." : "🛑 Виконання перервано. Уже виконані дії залишаються чинними.";
      const reason = state.reason && compactProgressText(state.reason);
      const text = label + status + (reason ? `\n${escapeSlackText(reason)}` : "");
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
    const live = this.#open(context, false, dm ? "manager" : "worker", dm ? "У DM стрічку профільного агента показує менеджер." : undefined);
    if (live.state.route === "worker") {
      try { if (!live.state.headerTs) await this.#header(live, true); }
      catch {
        // No access or an uncertain initial acknowledgement: switch once, never invite/repost.
        live.state.route = "manager";
        live.state.reason = "Доставку в канал не підтверджено. Стрічку профільного агента показує менеджер.";
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
    const entry = live.progress.record(event);
    if (entry?.kind === "note") live.reporter.record({ type: "public_notice", text: entry.text });
    else if (entry?.kind === "step" && typeof event.toolCallId === "string") {
      this.#recordStep(live, `tool-${event.toolCallId}`, entry);
    }
  }

  #recordStep(live: LivePublication, id: string, step: SlackWorkStep): void {
    const projected = projectStep(id, step);
    live.reporter.record({ type: "slack_public_step", id, step, text: projected.text });
  }

  #finish(live: LivePublication, ok: boolean, text: string): Promise<boolean> {
    live.finishing ??= this.#finishOnce(live, ok, text);
    return live.finishing;
  }

  async #finishOnce(live: LivePublication, ok: boolean, text: string): Promise<boolean> {
    if (live.state.settled) return !live.state.deliveryFailed;
    live.state.stage = ok ? "completed" : "failed";
    live.state.finalText = ok ? text : WORKER_FAILED;
    this.#save(live);
    await live.writes;
    if (!live.state.deliveryFailed) {
      try {
        for (const entry of live.state.console?.transcript.entries ?? []) {
          if (entry.kind !== "public-step" || entry.step.status !== "in_progress") continue;
          this.#recordStep(live, entry.id, { ...entry.step, status: "error",
            detail: [entry.step.detail, "Завершення кроку не підтверджено."].filter(Boolean).join("\n") });
        }
        if (ok) await live.reporter.complete(text);
        else await live.reporter.fail(WORKER_FAILED);
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
      live.state.finalText = ok ? text : WORKER_FAILED;
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
        live.state.finalText = item.event.ok ? (typeof item.event.text === "string" ? item.event.text : WORKER_COMPLETE) : WORKER_FAILED;
        void this.#finish(live, Boolean(item.event.ok), live.state.finalText);
      } else this.#record(live, item.event);
      this.#save(live);
    }
  }

  async finishParent(parentRunId: string): Promise<boolean> {
    let delivered = true;
    for (const [id, live] of this.#live) if (live.state.proxy && live.state.context.parentRunId === parentRunId) {
      await live.writes;
      if (!await this.#finish(live, live.state.stage === "completed", live.state.finalText ?? WORKER_COMPLETE)) delivered = false;
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
      await this.#finish(live, state.stage === "completed", state.finalText ?? WORKER_COMPLETE);
    }
  }

  async close(): Promise<void> { await Promise.allSettled([...this.#live.values()].map(async live => { await live.writes; await live.reporter.close(); await live.finishing; })); }
}
