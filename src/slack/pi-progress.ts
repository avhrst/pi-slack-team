import type { RpcRecord } from "../pi/rpc-client.js";

// Slack recommends keeping top-level message text below 4,000 characters.
// Final answers are chunked separately; progress updates favor reliability.
const MAX_TRANSCRIPT_CHARS = 3_500;
const MAX_TOOL_SECTION_CHARS = 1_200;
const MAX_ENTRIES = 100;
const DEPLOY_STORE_RE = /^[A-Z0-9_]{1,32}$/u;

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

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function deploymentProgress(value: unknown): string | undefined {
  const text = resultText(value);
  const markers = [...text.matchAll(/PI_DEPLOY_PROGRESS (\{[^\r\n]{1,1200}\})/gu)];
  const encoded = markers.at(-1)?.[1];
  if (!encoded) return undefined;

  let payload: Record<string, unknown>;
  try {
    payload = asRecord(JSON.parse(encoded)) ?? {};
  } catch {
    return undefined;
  }
  const stage = payload.stage;
  const state = payload.state;
  const planned = safeInteger(payload.planned);
  const completed = safeInteger(payload.completed);
  const pending = safeInteger(payload.pending);
  const ok = safeInteger(payload.ok);
  const warn = safeInteger(payload.warn);
  const fail = safeInteger(payload.fail);
  const skip = safeInteger(payload.skip);
  const current = payload.current;
  if (
    payload.version !== 1 ||
    !["apex", "sql-files"].includes(String(stage)) ||
    !["running", "completed"].includes(String(state)) ||
    planned === undefined ||
    completed === undefined ||
    pending === undefined ||
    ok === undefined ||
    warn === undefined ||
    fail === undefined ||
    skip === undefined ||
    completed > planned ||
    pending !== planned - completed ||
    ok + warn + fail + skip !== completed ||
    !(current === null || current === undefined ||
      (typeof current === "string" && DEPLOY_STORE_RE.test(current)))
  ) {
    return undefined;
  }

  const label = stage === "apex" ? "APEX" : "SQL file";
  const icon = state === "completed" ? ":white_check_mark:" : ":rocket:";
  const currentText = typeof current === "string" ? ` • current ${inlineCode(current)}` : "";
  return `${icon} *${label}:* ${completed}/${planned} • OK ${ok} • WARN ${warn} • FAIL ${fail} • SKIP ${skip}${currentText}`;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function argumentValue(value: unknown): string {
  if (typeof value === "string") {
    return value.includes("\n") ? codeBlock(value) : inlineCode(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return inlineCode(String(value));
  }
  if (Array.isArray(value)) return `${value.length} items`;
  const record = asRecord(value);
  if (record) return `${Object.keys(record).length} fields`;
  return inlineCode(String(value));
}

function toolArguments(toolName: string, value: unknown): string {
  const args = asRecord(value);
  if (!args) return value === undefined ? "" : codeBlock(String(value));

  const entries = Object.entries(args);
  const primaryKey = ["command", "path", "query", "url"].find(
    (key) => typeof args[key] === "string",
  );
  const sections: string[] = [];
  if (primaryKey) {
    const labels: Record<string, string> = {
      command: "Command",
      path: "Path",
      query: "Query",
      url: "URL",
    };
    const primary = args[primaryKey] as string;
    const rendered =
      primaryKey === "command"
        ? codeBlock(`$ ${primary}`)
        : primaryKey === "path" || primaryKey === "url"
          ? inlineCode(primary)
          : primary.includes("\n")
            ? codeBlock(primary)
            : primary;
    sections.push(`*${labels[primaryKey]}*\n${rendered}`);
  }

  const details = entries
    .filter(([key]) => key !== primaryKey)
    .map(([key, item]) => `• *${key}:* ${argumentValue(item)}`);
  if (details.length > 0) sections.push(details.join("\n"));
  if (sections.length > 0) return sections.join("\n");
  return `*Tool:* ${inlineCode(toolName)}`;
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
  #deploymentStatus: string | undefined;

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
      if (this.#mode !== "raw") {
        const status = deploymentProgress(event.partialResult);
        if (!status || status === this.#deploymentStatus) return false;
        this.#deploymentStatus = status;
        return true;
      }
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
      } else {
        this.#deploymentStatus =
          deploymentProgress(event.result) ?? this.#deploymentStatus;
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
    const body = [transcript, this.#deploymentStatus, tools].filter(Boolean).join("\n\n");
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
    const args = toolArguments(entry.name, entry.args);
    const output = resultText(entry.result);
    return [
      `*Tool \`${entry.name}\`* — ${state}`,
      ...(args ? [args] : []),
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
