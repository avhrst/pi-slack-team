import type { RpcRecord } from "../pi/rpc-client.js";
import {
  PiProgressTranscript,
  type ProgressMode,
  type ProgressState,
} from "./pi-progress.js";

const SLACK_PROGRESS_INTERVAL_MS = 1_000;

export type ProgressUpdateAttempt = "configured" | "summary-fallback";

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
  #updates: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #lastUpdateAt = 0;
  #pending = false;
  #closed = false;
  #usingSummaryFallback = false;

  constructor(
    mode: ProgressMode,
    update: (text: string) => Promise<void>,
    onError: (
      error: unknown,
      attempt: ProgressUpdateAttempt,
    ) => void,
  ) {
    this.#configuredTranscript = new PiProgressTranscript(mode);
    this.#summaryTranscript = mode === "raw"
      ? new PiProgressTranscript("summary")
      : undefined;
    this.#update = update;
    this.#onError = onError;
  }

  record(event: RpcRecord): void {
    if (this.#closed) return;
    const configuredChanged = this.#configuredTranscript.record(event);
    const summaryChanged = this.#summaryTranscript?.record(event) ?? false;
    const activeChanged = this.#usingSummaryFallback
      ? summaryChanged
      : configuredChanged;
    if (!activeChanged) return;
    this.#pending = true;
    this.#schedule();
  }

  async complete(finalText: string): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = false;
    await this.#updates;
    await this.#queueUpdate("completed", finalText);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = false;
    await this.#updates;
  }

  #schedule(): void {
    if (this.#timer || this.#closed) return;
    const delay = Math.max(
      0,
      SLACK_PROGRESS_INTERVAL_MS - (Date.now() - this.#lastUpdateAt),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, delay);
    this.#timer.unref();
  }

  #flush(): void {
    if (!this.#pending || this.#closed) return;
    this.#pending = false;
    this.#lastUpdateAt = Date.now();
    void this.#queueUpdate("working");
  }

  async #queueUpdate(
    state: ProgressState,
    finalText?: string,
  ): Promise<void> {
    const update = this.#updates.then(() =>
      this.#attemptUpdate(state, finalText)
    );
    this.#updates = update;
    await update;
  }

  async #attemptUpdate(
    state: ProgressState,
    finalText?: string,
  ): Promise<void> {
    const transcript = this.#usingSummaryFallback
      ? this.#summaryTranscript ?? this.#configuredTranscript
      : this.#configuredTranscript;
    try {
      await this.#update(transcript.render(state, finalText));
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
      await this.#update(this.#summaryTranscript.render(state, finalText));
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
