import type { RpcRecord } from "../pi/rpc-client.js";
import {
  PiProgressTranscript,
  type ProgressMode,
  type ProgressState,
} from "./pi-progress.js";

const SLACK_PROGRESS_INTERVAL_MS = 1_000;
export const SLACK_PROGRESS_UPDATE_TIMEOUT_MS = 20_000;

export type ProgressUpdateAttempt = "configured" | "summary-fallback";

interface QueuedProgressUpdate {
  state: ProgressState;
  finalText?: string;
}

/**
 * Serializes Slack progress updates and permanently degrades a raw transcript
 * to the compact summary transcript when Slack rejects a detailed payload.
 */
export class SlackProgressReporter {
  readonly #configuredTranscript: PiProgressTranscript;
  readonly #summaryTranscript: PiProgressTranscript | undefined;
  readonly #update: (text: string) => Promise<void>;
  readonly #onError: (
    error: unknown,
    attempt: ProgressUpdateAttempt,
  ) => void;
  readonly #updateTimeoutMs: number;
  #timer: NodeJS.Timeout | undefined;
  #lastUpdateAt = 0;
  #queuedUpdate: QueuedProgressUpdate | undefined;
  #drainPromise: Promise<void> | undefined;
  #accepting = true;
  #discardPending = false;
  #usingSummaryFallback = false;

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
    this.#summaryTranscript = mode === "raw"
      ? new PiProgressTranscript("summary")
      : undefined;
    this.#update = update;
    this.#onError = onError;
    this.#updateTimeoutMs = updateTimeoutMs;
  }

  record(event: RpcRecord): void {
    if (!this.#accepting) return;
    const configuredChanged = this.#configuredTranscript.record(event);
    const summaryChanged = this.#summaryTranscript?.record(event) ?? false;
    const activeChanged = this.#usingSummaryFallback
      ? summaryChanged
      : configuredChanged;
    if (!activeChanged) return;
    this.#queuedUpdate = { state: "working" };
    this.#schedule();
  }

  async complete(finalText: string): Promise<void> {
    this.#accepting = false;
    this.#clearTimer();
    this.#queuedUpdate = { state: "completed", finalText };
    await this.#drainAll();
  }

  async close(): Promise<void> {
    this.#accepting = false;
    this.#discardPending = true;
    this.#queuedUpdate = undefined;
    this.#clearTimer();
    await this.#drainPromise;
  }

  #schedule(): void {
    if (this.#timer || !this.#queuedUpdate || !this.#accepting) return;
    const delay = Math.max(
      0,
      SLACK_PROGRESS_INTERVAL_MS - (Date.now() - this.#lastUpdateAt),
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
      if (this.#queuedUpdate.state === "completed") {
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
      await this.#attemptUpdate(update.state, update.finalText);
      // record() or complete() may replace the queue while the request awaits.
      const nextUpdate = this.#queuedUpdate as QueuedProgressUpdate | undefined;
      if (nextUpdate?.state === "completed") continue;
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
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `Slack progress update timed out after ${this.#updateTimeoutMs}ms`,
        );
        error.name = "SlackProgressUpdateTimeoutError";
        reject(error);
      }, this.#updateTimeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([Promise.resolve().then(() => this.#update(text)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #attemptUpdate(
    state: ProgressState,
    finalText?: string,
  ): Promise<void> {
    const transcript = this.#usingSummaryFallback
      ? this.#summaryTranscript ?? this.#configuredTranscript
      : this.#configuredTranscript;
    try {
      await this.#updateWithTimeout(transcript.render(state, finalText));
      return;
    } catch (error) {
      this.#reportError(
        error,
        this.#usingSummaryFallback ? "summary-fallback" : "configured",
      );
    }

    if (this.#usingSummaryFallback || !this.#summaryTranscript) return;
    this.#usingSummaryFallback = true;
    try {
      await this.#updateWithTimeout(
        this.#summaryTranscript.render(state, finalText),
      );
    } catch (error) {
      this.#reportError(error, "summary-fallback");
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
