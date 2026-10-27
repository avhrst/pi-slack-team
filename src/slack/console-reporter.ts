import type { RpcRecord } from "../pi/rpc-client.js";
import { ConsoleTranscript } from "./console-transcript.js";
import { sleep, transientFailure } from "./progress-reporter.js";

/** Shared by all console turns: bound message volume and honor workspace cooldowns. */
export class SlackDeliveryQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #nextAt = 0;
  readonly #cooldowns = new Map<string, number>();
  readonly #stop = new AbortController();

  constructor(readonly intervalMs = 1_250) {}

  send<T>(method: "post" | "update" | "delete", operation: () => Promise<T>, signal: AbortSignal = new AbortController().signal): Promise<T> {
    const combined = AbortSignal.any([signal, this.#stop.signal]);
    const result = this.#tail.then(async () => {
      for (let attempt = 1; ; attempt++) {
        combined.throwIfAborted();
        const delay = Math.max(this.#nextAt, this.#cooldowns.get(method) ?? 0) - Date.now();
        if (delay > 0) await sleep(delay, combined);
        combined.throwIfAborted();
        this.#nextAt = Date.now() + this.intervalMs;
        try {
          return await operation();
        } catch (error) {
          const transient = transientFailure(error);
          if (transient) this.#cooldowns.set(method, Date.now() + transient.retryAfterMs);
          if (!transient || attempt >= 3) throw error;
        }
      }
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  close(): void { this.#stop.abort(); }
}

export interface ConsoleDelivery {
  post(text: string): Promise<string>;
  update(ts: string, text: string): Promise<void>;
  remove(ts: string): Promise<void>;
}

/** Keep posted history; coalesce only edits to entries that are still changing. */
export class SlackConsoleReporter {
  readonly #transcript = new ConsoleTranscript();
  readonly #posted = new Map<string, { ts: string; text: string }>();
  readonly #abort = new AbortController();
  #placeholder: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #drain: Promise<void> | undefined;
  #revision = 0;
  #accepting = true;
  #failure: unknown;

  constructor(
    readonly queue: SlackDeliveryQueue,
    readonly delivery: ConsoleDelivery,
    readonly onError: (error: unknown) => void,
  ) {}

  async start(queued: boolean): Promise<void> {
    try {
      this.#placeholder = await this.queue.send("post", () => this.delivery.post(
        queued ? ":hourglass_flowing_sand: Queued for the agent…" : ":hourglass_flowing_sand: Working…",
      ), this.#abort.signal);
    } catch (error) { this.onError(error); }
  }

  record(event: RpcRecord): void {
    if (!this.#accepting) return;
    this.#transcript.record(event);
    this.#revision++;
    if (!this.#timer && !this.#drain) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.#flush();
      }, 250);
      this.#timer.unref();
    }
  }

  async complete(text: string, omitFinal = false): Promise<void> {
    this.#transcript.complete(text, omitFinal);
    await this.#finish();
    if (omitFinal && this.#placeholder) {
      const ts = this.#placeholder;
      await this.queue.send("delete", () => this.delivery.remove(ts), this.#abort.signal);
      this.#placeholder = undefined;
    }
  }

  async fail(text: string): Promise<void> {
    this.#transcript.fail(text);
    await this.#finish();
  }

  async close(): Promise<void> {
    this.#accepting = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#abort.abort();
    await this.#drain;
  }

  async #finish(): Promise<void> {
    this.#accepting = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#revision++;
    await this.#flush();
    if (this.#failure) throw this.#failure;
  }

  #flush(): Promise<void> {
    if (this.#drain) return this.#drain;
    const drain = this.#deliver().catch((error: unknown) => {
      this.#failure = error;
      this.onError(error);
    });
    this.#drain = drain;
    void drain.then(() => { if (this.#drain === drain) this.#drain = undefined; });
    return drain;
  }

  async #deliver(): Promise<void> {
    let revision: number;
    do {
      revision = this.#revision;
      const visibleIds = new Set(this.#transcript.render().map((entry) => entry.id));
      for (const [id, previous] of this.#posted) {
        if (visibleIds.has(id)) continue;
        // An authoritative message_end may shorten a streamed draft. Remove
        // only its surplus draft parts; distinct completed entries stay visible.
        await this.queue.send("delete", async () => {
          if (this.#transcript.render().some((entry) => entry.id === id)) return;
          await this.delivery.remove(previous.ts);
          this.#posted.delete(id);
        }, this.#abort.signal);
      }
      // Re-read each entry inside the queue so stale partial results aren't posted.
      for (const entry of this.#transcript.render()) {
        const previous = this.#posted.get(entry.id);
        if (previous?.text === entry.text) continue;
        const method = previous || this.#placeholder ? "update" : "post";
        await this.queue.send(method, async () => {
          const latest = this.#transcript.render().find((item) => item.id === entry.id);
          if (!latest) return;
          if (previous?.text === latest.text) return;
          const reuse = previous?.ts ?? this.#placeholder;
          const ts = reuse ?? await this.delivery.post(latest.text);
          if (reuse) await this.delivery.update(reuse, latest.text);
          this.#placeholder = undefined;
          this.#posted.set(entry.id, { ts, text: latest.text });
        }, this.#abort.signal);
      }
      this.#failure = undefined;
    } while (revision !== this.#revision && !this.#abort.signal.aborted);
  }
}
