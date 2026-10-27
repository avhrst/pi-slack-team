import type { RpcRecord } from "../pi/rpc-client.js";
import {
  PiProgressTranscript,
  type DeliveryFailure,
  type ProgressMode,
  type ProgressState,
} from "./pi-progress.js";

const SLACK_PROGRESS_INTERVAL_MS = 1_000;
export const SLACK_PROGRESS_UPDATE_TIMEOUT_MS = 20_000;
const TIMEOUT_ERROR_NAME = "SlackProgressUpdateTimeoutError";
const FINAL_UPDATE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Rate limits, timeouts and network/5xx failures say nothing about the payload,
 * so they must neither trigger the summary fallback nor drop the final state.
 */
export function transientFailure(error: unknown): { retryAfterMs: number } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    code?: unknown;
    name?: unknown;
    retryAfter?: unknown;
    statusCode?: unknown;
    data?: { error?: unknown };
  };
  const transient =
    record.code === "slack_webapi_rate_limited_error" ||
    record.data?.error === "ratelimited" ||
    record.code === "slack_webapi_request_error" ||
    record.name === TIMEOUT_ERROR_NAME ||
    (record.code === "slack_webapi_http_error" &&
      typeof record.statusCode === "number" &&
      (record.statusCode === 429 || record.statusCode >= 500));
  if (!transient) return undefined;
  return {
    retryAfterMs:
      typeof record.retryAfter === "number" && record.retryAfter >= 0
        ? record.retryAfter * 1_000
        : DEFAULT_RETRY_DELAY_MS,
  };
}

export function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export type ProgressUpdateAttempt = "configured" | "summary-fallback" | "balanced-fallback";

interface QueuedProgressUpdate {
  state: ProgressState;
  failure?: DeliveryFailure;
  reference?: string;
}

/**
 * Serializes Slack progress updates and degrades rejected payloads safely.
 * Informative falls back to balanced (never raw text deltas); legacy modes
 * keep their summary fallback. Identical views are never reposted.
 */
export class SlackProgressReporter {
  readonly #configuredTranscript: PiProgressTranscript;
  readonly #fallbackTranscript: PiProgressTranscript | undefined;
  readonly #fallbackAttempt: ProgressUpdateAttempt;
  readonly #update: (text: string) => Promise<void>;
  readonly #onError: (
    error: unknown,
    attempt: ProgressUpdateAttempt,
  ) => void;
  readonly #updateTimeoutMs: number;
  readonly #intervalMs: number;
  readonly #retryAbort = new AbortController();
  #lastRenderedText: string | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastUpdateAt = 0;
  #notBefore = 0;
  #queuedUpdate: QueuedProgressUpdate | undefined;
  #drainPromise: Promise<void> | undefined;
  #accepting = true;
  #discardPending = false;
  #usingFallback = false;

  constructor(
    mode: ProgressMode,
    update: (text: string) => Promise<void>,
    onError: (
      error: unknown,
      attempt: ProgressUpdateAttempt,
    ) => void,
    updateTimeoutMs = SLACK_PROGRESS_UPDATE_TIMEOUT_MS,
  ) {
    this.#configuredTranscript = new PiProgressTranscript(mode);
    this.#fallbackTranscript = mode !== "summary"
      ? new PiProgressTranscript(mode === "informative" ? "balanced" : "summary")
      : undefined;
    this.#fallbackAttempt = mode === "informative" ? "balanced-fallback" : "summary-fallback";
    this.#update = update;
    this.#onError = onError;
    this.#updateTimeoutMs = updateTimeoutMs;
    this.#intervalMs = mode === "informative" ? 5_000 : mode === "balanced" ? 3_000 : SLACK_PROGRESS_INTERVAL_MS;
  }

  record(event: RpcRecord): void {
    if (!this.#accepting) return;
    const configuredChanged = this.#configuredTranscript.record(event);
    const fallbackChanged = this.#fallbackTranscript?.record(event) ?? false;
    const activeChanged = this.#usingFallback
      ? fallbackChanged
      : configuredChanged;
    if (!activeChanged) return;
    this.#queuedUpdate = { state: "working" };
    this.#schedule();
  }

  /** Settles the placeholder as a receipt, noting a failed answer delivery. */
  async complete(failure?: DeliveryFailure): Promise<void> {
    if (this.#discardPending) return;
    this.#accepting = false;
    this.#clearTimer();
    this.#queuedUpdate = failure
      ? { state: "delivery-failed", failure }
      : { state: "completed" };
    await this.#drainAll();
  }

  async fail(reference: string): Promise<void> {
    if (this.#discardPending) return;
    this.#accepting = false;
    this.#clearTimer();
    this.#queuedUpdate = { state: "failed", reference };
    await this.#drainAll();
  }

  async close(): Promise<void> {
    this.#accepting = false;
    this.#discardPending = true;
    this.#queuedUpdate = undefined;
    this.#clearTimer();
    this.#retryAbort.abort();
    await this.#drainPromise;
  }

  #schedule(): void {
    if (this.#timer || !this.#queuedUpdate || !this.#accepting) return;
    const now = Date.now();
    const delay = Math.max(
      0,
      this.#intervalMs - (now - this.#lastUpdateAt),
      this.#notBefore - now,
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#startDrain();
    }, delay);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #startDrain(): Promise<void> {
    if (this.#drainPromise) return this.#drainPromise;
    const drain = this.#drain();
    this.#drainPromise = drain;
    void drain.finally(() => {
      if (this.#drainPromise === drain) this.#drainPromise = undefined;
      if (this.#discardPending || !this.#queuedUpdate) return;
      if (this.#queuedUpdate.state !== "working") {
        void this.#startDrain();
      } else {
        this.#schedule();
      }
    });
    return drain;
  }

  async #drain(): Promise<void> {
    while (!this.#discardPending && this.#queuedUpdate) {
      const update = this.#queuedUpdate;
      this.#queuedUpdate = undefined;
      this.#lastUpdateAt = Date.now();
      await this.#attemptUpdate(update.state, update.failure ?? update.reference);
      // record() or complete() may replace the queue while the request awaits.
      const nextUpdate = this.#queuedUpdate as QueuedProgressUpdate | undefined;
      if (nextUpdate && nextUpdate.state !== "working") continue;
      if (nextUpdate) this.#schedule();
      return;
    }
  }

  async #drainAll(): Promise<void> {
    while (this.#queuedUpdate || this.#drainPromise) {
      const active = this.#drainPromise ?? this.#startDrain();
      await active;
    }
  }

  async #updateWithTimeout(text: string): Promise<void> {
    if (text === this.#lastRenderedText) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Slack progress update timed out after ${this.#updateTimeoutMs}ms`,
        );
        error.name = TIMEOUT_ERROR_NAME;
        reject(error);
      }, this.#updateTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([Promise.resolve().then(() => this.#update(text)), timeout]);
      this.#lastRenderedText = text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #attemptUpdate(
    state: ProgressState,
    detail?: DeliveryFailure | string,
  ): Promise<void> {
    // Transient failures must not downgrade the payload. Final receipts get a
    // bounded retry budget, including delivery-failed and turn-failed receipts.
    const maxAttempts = state === "working" ? 1 : FINAL_UPDATE_ATTEMPTS;
    for (let attempt = 1; ; attempt += 1) {
      // Completion/failure bypasses the working scheduler, but not Slack's
      // retry-after cooldown. Shutdown can cancel even a long cooldown.
      const delay = this.#notBefore - Date.now();
      if (delay > 0) await sleep(delay, this.#retryAbort.signal);
      if (this.#discardPending) return;
      const transcript = this.#usingFallback
        ? this.#fallbackTranscript ?? this.#configuredTranscript
        : this.#configuredTranscript;
      try {
        await this.#updateWithTimeout(transcript.render(state, detail));
        return;
      } catch (error) {
        this.#reportError(error, this.#usingFallback ? this.#fallbackAttempt : "configured");
        const transient = transientFailure(error);
        if (transient) {
          this.#notBefore = Date.now() + transient.retryAfterMs;
          if (attempt >= maxAttempts) return;
          continue;
        }
        if (this.#usingFallback || !this.#fallbackTranscript) return;
        this.#usingFallback = true;
      }
    }
  }

  #reportError(error: unknown, attempt: ProgressUpdateAttempt): void {
    try {
      this.#onError(error, attempt);
    } catch {
      // Observability must never fail a Pi turn or its final Slack response.
    }
  }
}
