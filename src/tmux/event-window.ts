import type { RpcRecord } from "../pi/rpc-client.js";

export interface SequencedEvent {
  sequence: number;
  event: RpcRecord;
}

/**
 * Unpublished events for one run. Only mutable snapshots may be coalesced.
 * Structural events survive until persisted to immutable mailbox packets;
 * the consumer acknowledges those packets by removing them after reading.
 */
export class RunEventWindow {
  #events: SequencedEvent[] = [];
  #sequence = 0;

  constructor(readonly limit = 16, readonly milestoneLimit = 0) {}

  get events(): readonly SequencedEvent[] {
    return this.#events;
  }

  get sequence(): number { return this.#sequence; }

  batch(): readonly SequencedEvent[] {
    let bytes = 0;
    return this.#events.slice(0, this.limit).filter((item) => {
      bytes += Buffer.byteLength(JSON.stringify(item));
      return bytes < 900_000;
    });
  }

  published(throughSequence: number): void {
    this.#events = this.#events.filter((item) => item.sequence > throughSequence);
  }

  push(event: RpcRecord): void {
    if (event.type === "tool_execution_update" && typeof event.toolCallId === "string") {
      this.#events = this.#events.filter((item) =>
        item.event.type !== "tool_execution_update" || item.event.toolCallId !== event.toolCallId);
    }
    if (event.type === "message_update" && typeof event.messageId === "number") {
      this.#events = this.#events.filter((item) =>
        item.event.type !== "message_update" || item.event.messageId !== event.messageId);
    }
    this.#events.push({ sequence: ++this.#sequence, event });
    if (this.milestoneLimit > 0) {
      while (this.#events.filter((item) => item.event.type === "agent_progress").length > this.milestoneLimit) {
        this.#events.splice(this.#events.findIndex((item) => item.event.type === "agent_progress"), 1);
      }
    }
  }

  reset(): void {
    this.#events = [];
    this.#sequence = 0;
  }
}
