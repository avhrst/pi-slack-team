import type { RpcRecord } from "../pi/rpc-client.js";

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_ENTRIES = 100;

type ProgressEntry =
  | { kind: "text"; value: string }
  | { kind: "status"; value: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "tool";
  return value
    .trim()
    .replaceAll(/[^a-zA-Z0-9_.:/-]/gu, "_")
    .slice(0, 80);
}

export type ProgressState = "working" | "completed";

export class PiProgressTranscript {
  readonly #entries: ProgressEntry[] = [];

  record(event: RpcRecord): boolean {
    if (event.type === "message_update") {
      const update = asRecord(event.assistantMessageEvent);
      if (update?.type !== "text_delta" || typeof update.delta !== "string") {
        return false;
      }
      return this.#appendText(update.delta);
    }

    if (event.type === "tool_execution_start") {
      this.#appendStatus(`:gear: Running \`${safeToolName(event.toolName)}\`…`);
      return true;
    }

    if (event.type === "tool_execution_end") {
      const icon = event.isError === true ? ":x:" : ":white_check_mark:";
      const outcome = event.isError === true ? "failed" : "finished";
      this.#appendStatus(
        `${icon} \`${safeToolName(event.toolName)}\` ${outcome}`,
      );
      return true;
    }

    if (event.type === "compaction_start") {
      this.#appendStatus(":arrows_counterclockwise: Compacting session context…");
      return true;
    }

    if (event.type === "auto_retry_start") {
      const attempt =
        typeof event.attempt === "number" ? ` (attempt ${event.attempt})` : "";
      this.#appendStatus(`:repeat: Retrying transient model error${attempt}…`);
      return true;
    }

    return false;
  }

  render(state: ProgressState): string {
    const heading =
      state === "completed"
        ? ":white_check_mark: *Pi completed*"
        : ":hourglass_flowing_sand: *Pi is working…*";
    const body = this.#entries
      .map((entry) => entry.value)
      .join("\n")
      .trim();
    if (!body) return heading;

    const available = MAX_TRANSCRIPT_CHARS - heading.length - 2;
    const bounded =
      body.length <= available
        ? body
        : `…\n${body.slice(-(available - 2))}`;
    return `${heading}\n\n${bounded}`;
  }

  #appendText(delta: string): boolean {
    if (!delta) return false;
    const last = this.#entries.at(-1);
    if (last?.kind === "text") {
      last.value += delta;
    } else {
      this.#entries.push({ kind: "text", value: delta });
    }
    this.#trimEntries();
    return true;
  }

  #appendStatus(value: string): void {
    this.#entries.push({ kind: "status", value });
    this.#trimEntries();
  }

  #trimEntries(): void {
    while (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
  }
}
