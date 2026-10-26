import type { RpcRecord } from "../pi/rpc-client.js";

export interface SequencedEvent {
  sequence: number;
  event: RpcRecord;
}

/**
 * Bounded progress buffer for one tmux run. Only the latest partial result of a
 * tool call matters, so updates are coalesced and evicted before the start/end
 * events that drive Slack tool counts.
 */
export class RunEventWindow {
  #events: SequencedEvent[] = [];
  #sequence = 0;

  constructor(readonly limit = 16) {}

  get events(): readonly SequencedEvent[] {
    return this.#events;
  }

  push(event: RpcRecord): void {
    if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
      this.#events = this.#events.filter((item) =>
        item.event.type !== "tool_execution_update" || item.event.toolCallId !== event.toolCallId);
    }
    this.#events.push({ sequence: ++this.#sequence, event });
    while (this.#events.length > this.limit) {
      const update = this.#events.findIndex((item) => item.event.type === "tool_execution_update");
      this.#events.splice(Math.max(update, 0), 1);
    }
  }

  reset(): void {
    this.#events = [];
    this.#sequence = 0;
  }
}
