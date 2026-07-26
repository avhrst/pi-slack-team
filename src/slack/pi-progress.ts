import type { RpcRecord } from "../pi/rpc-client.js";

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_ENTRIES = 100;

type ProgressEntry =
  | { kind: "text"; value: string }
  | { kind: "status"; value: string };

interface ToolStats {
  total: number;
  running: number;
  failed: number;
}

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

function transformMarkdownSegment(text: string): string {
  return text
    .replace(/^#{1,6}\s+(.+)$/gmu, "*$1*")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/gu, "*$1*")
    .replace(/__([^_\n]+)__/gu, "*$1*");
}

export function toSlackMrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/gu)
    .map((segment) =>
      segment.startsWith("`") ? segment : transformMarkdownSegment(segment),
    )
    .join("");
}

export type ProgressState = "working" | "completed";

export class PiProgressTranscript {
  readonly #entries: ProgressEntry[] = [];
  readonly #tools = new Map<string, ToolStats>();
  readonly #toolCalls = new Map<string, string>();
  #textBoundary = false;

  record(event: RpcRecord): boolean {
    if (event.type === "message_update") {
      const update = asRecord(event.assistantMessageEvent);
      if (update?.type !== "text_delta" || typeof update.delta !== "string") {
        return false;
      }
      return this.#appendText(update.delta);
    }

    if (event.type === "tool_execution_start") {
      const name = safeToolName(event.toolName);
      const stats = this.#toolStats(name);
      stats.total += 1;
      stats.running += 1;
      if (typeof event.toolCallId === "string") {
        this.#toolCalls.set(event.toolCallId, name);
      }
      this.#textBoundary = true;
      return true;
    }

    if (event.type === "tool_execution_end") {
      const callId =
        typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const name =
        (callId ? this.#toolCalls.get(callId) : undefined) ??
        safeToolName(event.toolName);
      const stats = this.#toolStats(name);
      if (stats.total === 0) stats.total = 1;
      stats.running = Math.max(0, stats.running - 1);
      if (event.isError === true) stats.failed += 1;
      if (callId) this.#toolCalls.delete(callId);
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

  render(state: ProgressState, finalText?: string): string {
    const heading =
      state === "completed"
        ? ":white_check_mark: *Pi completed*"
        : ":hourglass_flowing_sand: *Pi is working…*";
    const entries = [...this.#entries];
    if (state === "completed" && finalText?.trim()) {
      const lastTextIndex = entries.findLastIndex(
        (entry) => entry.kind === "text",
      );
      const last = entries[lastTextIndex];
      if (last?.kind === "text" && last.value.trim() === finalText.trim()) {
        entries.splice(lastTextIndex, 1);
      }
    }

    const sections = entries
      .map((entry) =>
        entry.kind === "text" ? toSlackMrkdwn(entry.value) : entry.value,
      )
      .join("\n")
      .trim();
    const tools = this.#renderTools(state);
    const body = [sections, tools].filter(Boolean).join("\n\n");
    if (!body) return heading;

    const available = MAX_TRANSCRIPT_CHARS - heading.length - 2;
    const bounded =
      body.length <= available
        ? body
        : `…\n${body.slice(-(available - 2))}`;
    return `${heading}\n\n${bounded}`;
  }

  #toolStats(name: string): ToolStats {
    const existing = this.#tools.get(name);
    if (existing) return existing;
    const created = { total: 0, running: 0, failed: 0 };
    this.#tools.set(name, created);
    return created;
  }

  #renderTools(state: ProgressState): string {
    if (this.#tools.size === 0) return "";
    const calls = [...this.#tools.entries()]
      .map(([name, stats]) => `\`${name}\` × ${stats.total}`)
      .join(" · ");
    const running = [...this.#tools.values()].reduce(
      (total, stats) => total + stats.running,
      0,
    );
    const failed = [...this.#tools.values()].reduce(
      (total, stats) => total + stats.failed,
      0,
    );
    const suffix = [
      ...(state === "working" && running > 0 ? [`${running} running`] : []),
      ...(failed > 0 ? [`:warning: ${failed} failed`] : []),
    ];
    return `:hammer_and_wrench: *Tools:* ${calls}${
      suffix.length > 0 ? ` · ${suffix.join(" · ")}` : ""
    }`;
  }

  #appendText(delta: string): boolean {
    if (!delta) return false;
    const last = this.#entries.at(-1);
    if (last?.kind === "text" && !this.#textBoundary) {
      last.value += delta;
    } else {
      this.#entries.push({ kind: "text", value: delta });
    }
    this.#textBoundary = false;
    this.#trimEntries();
    return true;
  }

  #appendStatus(value: string): void {
    this.#entries.push({ kind: "status", value });
    this.#textBoundary = true;
    this.#trimEntries();
  }

  #trimEntries(): void {
    while (this.#entries.length > MAX_ENTRIES) this.#entries.shift();
  }
}
