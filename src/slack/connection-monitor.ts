import type { SocketModeReceiver } from "@slack/bolt";
import type { Logger } from "../observability/logger.js";

export const SLACK_RECONNECT_GRACE_MS = 120_000;

type SocketModeClient = SocketModeReceiver["client"];
type FailureHandler = (error: Error) => void;

export class SlackConnectionMonitor {
  readonly #client: SocketModeClient;
  readonly #agentId: string;
  readonly #logger: Logger;
  readonly #onFailure: FailureHandler;
  readonly #graceMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unhealthySince: number | undefined;
  #lastReason: string | undefined;
  #running = false;

  readonly #handleConnected = () => {
    if (this.#unhealthySince !== undefined) {
      this.#logger.info("slack_connection_restored", {
        agentId: this.#agentId,
        outageMs: Date.now() - this.#unhealthySince,
      });
    }
    this.#clearFailureTimer();
  };

  readonly #handleReconnecting = () => this.#markUnhealthy("reconnecting");
  readonly #handleDisconnected = () => this.#markUnhealthy("disconnected");
  readonly #handleError = (error: unknown) =>
    this.#markUnhealthy("websocket-error", error);

  constructor(
    client: SocketModeClient,
    agentId: string,
    logger: Logger,
    onFailure: FailureHandler,
    graceMs = SLACK_RECONNECT_GRACE_MS,
  ) {
    this.#client = client;
    this.#agentId = agentId;
    this.#logger = logger;
    this.#onFailure = onFailure;
    this.#graceMs = graceMs;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#client.on("connected", this.#handleConnected);
    this.#client.on("reconnecting", this.#handleReconnecting);
    this.#client.on("disconnected", this.#handleDisconnected);
    this.#client.on("error", this.#handleError);
  }

  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#client.removeListener("connected", this.#handleConnected);
    this.#client.removeListener("reconnecting", this.#handleReconnecting);
    this.#client.removeListener("disconnected", this.#handleDisconnected);
    this.#client.removeListener("error", this.#handleError);
    this.#clearFailureTimer();
  }

  #markUnhealthy(reason: string, error?: unknown): void {
    if (!this.#running) return;
    this.#lastReason = reason;
    if (this.#timer) return;

    this.#unhealthySince = Date.now();
    this.#logger.warn("slack_connection_lost", {
      agentId: this.#agentId,
      reason,
      reconnectGraceMs: this.#graceMs,
      ...(error === undefined ? {} : { error }),
    });
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (!this.#running) return;
      this.#running = false;
      const failure = new Error(
        `Slack Socket Mode did not reconnect within ${this.#graceMs}ms`,
      );
      this.#logger.error("slack_connection_unhealthy", {
        agentId: this.#agentId,
        reason: this.#lastReason,
        outageMs:
          this.#unhealthySince === undefined
            ? this.#graceMs
            : Date.now() - this.#unhealthySince,
        error: failure,
      });
      this.#onFailure(failure);
    }, this.#graceMs);
    this.#timer.unref();
  }

  #clearFailureTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#unhealthySince = undefined;
    this.#lastReason = undefined;
  }
}
