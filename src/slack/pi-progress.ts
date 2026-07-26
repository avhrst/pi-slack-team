import type { RpcRecord } from "../pi/rpc-client.js";

const MAX_TRANSCRIPT_CHARS = 35_000;
const MAX_TOOL_SECTION_CHARS = 12_000;
const MAX_ENTRIES = 100;

export type ProgressMode = "summary" | "raw";
export type ProgressState = "working" | "completed";

type ProgressEntry =
  | { kind: "text"; value: string }
  | { kind: "status"; value: string }
  | RawToolEntry;

interface RawToolEntry {
  kind: "tool";
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  state: "running" | "completed" | "failed";
}

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

function jsonText(value: unknown): string {
  if (value === undefined) return "";
  const encoded = JSON.stringify(value, null, 2);
  return encoded ?? String(value);
}

function resultText(value: unknown): string {
  const record = asRecord(value);
  if (Array.isArray(record?.content)) {
    const text = record.content
      .map((item) => asRecord(item))
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item?.text as string)
      .join("\n");
    if (text) return text;
  }
  return jsonText(value);
}

function codeBlock(text: string): string {
  const escaped = text.replaceAll("```", "``\u200b`");
  const bounded =
    escaped.length <= MAX_TOOL_SECTION_CHARS
      ? escaped
      : `[earlier output truncated]\n${escaped.slice(-MAX_TOOL_SECTION_CHARS)}`;
  return `\`\`\`\n${bounded}\n\`\`\``;
}

export function toSlackMrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/gu)
    .map((segment) =>
      segment.startsWith("`") ? segment : transformMarkdownSegment(segment),
    )
    .join("");
}

export class PiProgressTranscript {
  readonly #mode: ProgressMode;
  readonly #entries: ProgressEntry[] = [];
  readonly #tools = new Map<string, ToolStats>();
  readonly #toolCalls = new Map<string, string>();
  readonly #rawTools = new Map<string, RawToolEntry>();
  #anonymousToolSequence = 0;
  #textBoundary = false;

  constructor(mode: ProgressMode = "summary") {
    this.#mode = mode;
  }

  record(event: RpcRecord): boolean {
    if (event.type === "message_update") {
      const update = asRecord(event.assistantMessageEvent);
      if (update?.type !== "text_delta" || typeof update.delta !== "string") {
        return false;
      }
      return this.#appendText(update.delta);
    }

    if (event.type === "tool_execution_start") {
      const id = this.#toolId(event);
      const name = safeToolName(event.toolName);
      const stats = this.#toolStats(name);
      stats.total += 1;
      stats.running += 1;
      this.#toolCalls.set(id, name);
      if (this.#mode === "raw") {
        const tool: RawToolEntry = {
          kind: "tool",
          id,
          name,
          args: event.args,
          state: "running",
        };
        this.#rawTools.set(id, tool);
        this.#entries.push(tool);
        this.#trimEntries();
      }
      this.#textBoundary = true;
      return true;
    }

    if (event.type === "tool_execution_update") {
      if (this.#mode !== "raw") return false;
      const tool = this.#rawTool(event);
      tool.result = event.partialResult;
      tool.state = "running";
      return true;
    }

    if (event.type === "tool_execution_end") {
      const id = this.#toolId(event);
      const name = this.#toolCalls.get(id) ?? safeToolName(event.toolName);
      const stats = this.#toolStats(name);
      if (stats.total === 0) stats.total = 1;
      stats.running = Math.max(0, stats.running - 1);
      if (event.isError === true) stats.failed += 1;
      this.#toolCalls.delete(id);
      if (this.#mode === "raw") {
        const tool = this.#rawTool(event);
        tool.result = event.result;
        tool.state = event.isError === true ? "failed" : "completed";
      }
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

    const transcript = entries
      .map((entry) => this.#renderEntry(entry))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    const tools = this.#mode === "summary" ? this.#renderToolSummary(state) : "";
    const body = [transcript, tools].filter(Boolean).join("\n\n");
    if (!body) return heading;

    const available = MAX_TRANSCRIPT_CHARS - heading.length - 2;
    const bounded =
      body.length <= available
        ? body
        : `…\n${body.slice(-(available - 2))}`;
    return `${heading}\n\n${bounded}`;
  }

  #renderEntry(entry: ProgressEntry): string {
    if (entry.kind === "text") return toSlackMrkdwn(entry.value);
    if (entry.kind === "status") return entry.value;

    const state =
      entry.state === "running"
        ? ":gear: running"
        : entry.state === "failed"
          ? ":x: failed"
          : ":white_check_mark: completed";
    const args = jsonText(entry.args);
    const output = resultText(entry.result);
    return [
      `*Tool \`${entry.name}\`* — ${state}`,
      ...(args ? [`*Arguments*\n${codeBlock(args)}`] : []),
      ...(output ? [`*Output*\n${codeBlock(output)}`] : []),
    ].join("\n");
  }

  #toolId(event: RpcRecord): string {
    if (typeof event.toolCallId === "string") return event.toolCallId;
    return `anonymous-${++this.#anonymousToolSequence}`;
  }

  #rawTool(event: RpcRecord): RawToolEntry {
    const id =
      typeof event.toolCallId === "string"
        ? event.toolCallId
        : `anonymous-${this.#anonymousToolSequence}`;
    const existing = this.#rawTools.get(id);
    if (existing) return existing;
    const created: RawToolEntry = {
      kind: "tool",
      id,
      name: safeToolName(event.toolName),
      args: event.args,
      state: "running",
    };
    this.#rawTools.set(id, created);
    this.#entries.push(created);
    this.#trimEntries();
    return created;
  }

  #toolStats(name: string): ToolStats {
    const existing = this.#tools.get(name);
    if (existing) return existing;
    const created = { total: 0, running: 0, failed: 0 };
    this.#tools.set(name, created);
    return created;
  }

  #renderToolSummary(state: ProgressState): string {
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
