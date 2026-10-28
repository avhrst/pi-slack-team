import { stripVTControlCharacters } from "node:util";
import type { RpcRecord } from "../pi/rpc-client.js";
import { chunkSlackText } from "./chunk-text.js";
import { escapeSlackText } from "./mrkdwn.js";
import { toSlackMrkdwn } from "./pi-progress.js";

export const CONSOLE_MESSAGE_CHARS = 3_500;
const PREVIEW_LINES = 10;
export type ConsoleEntry =
  | { id: string; kind: "assistant"; text: string; complete: boolean }
  | { id: string; kind: "tool"; name: string; args: unknown; output: string; outputLines?: number; state: "running" | "completed" | "failed" }
  | { id: string; kind: "status"; text: string };
type Entry = ConsoleEntry;
export interface ConsoleSnapshot { entries: Entry[]; sequence: number; delegatedTools: Array<[string, string]>; statuses?: Array<[string, string]> }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function visibleText(value: unknown): string {
  const content = record(value)?.content;
  if (!Array.isArray(content)) return typeof value === "string" ? value : "";
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

function clean(text: string): string {
  return stripVTControlCharacters(text);
}

function preview(text: string, totalLines?: number): string {
  const lines = clean(text).split(/\r?\n/u);
  const hidden = Math.max(0, (totalLines ?? lines.length) - PREVIEW_LINES);
  let body = lines.slice(0, PREVIEW_LINES).join("\n");
  if (body.length > 1_200) body = `${body.slice(0, 1_200)}\n[preview shortened]`;
  if (hidden) body += `\n[${hidden} more lines hidden]`;
  return body;
}

function code(text: string): string {
  return `\`\`\`\n${escapeSlackText(text.replaceAll("```", "``\u200b`"))}\n\`\`\``;
}

/** Ordered visible Pi entries. Tool updates replace snapshots, never append them. */
export class ConsoleTranscript {
  readonly #entries: Entry[] = [];
  readonly #tools = new Map<string, Extract<Entry, { kind: "tool" }>>();
  readonly #statuses = new Map<string, Extract<Entry, { kind: "status" }>>();
  #sequence = 0;
  #assistant: Extract<Entry, { kind: "assistant" }> | undefined;
  #lastAssistant: Extract<Entry, { kind: "assistant" }> | undefined;
  readonly #delegatedTools = new Map<string, string>();

  constructor(snapshot?: ConsoleSnapshot) {
    if (!snapshot) return;
    this.#entries.push(...structuredClone(snapshot.entries));
    this.#sequence = snapshot.sequence;
    for (const pair of snapshot.delegatedTools) this.#delegatedTools.set(...pair);
    for (const entry of this.#entries) {
      if (entry.kind === "tool") this.#tools.set(entry.id.slice(5), entry);
      if (entry.kind === "assistant") {
        this.#lastAssistant = entry;
        if (!entry.complete) this.#assistant = entry;
      }
    }
    for (const [operation, id] of snapshot.statuses ?? []) {
      const entry = this.#entries.find(entry => entry.id === id);
      if (entry?.kind === "status") this.#statuses.set(operation, entry);
    }
  }

  snapshot(): ConsoleSnapshot {
    return structuredClone({ entries: this.#entries, sequence: this.#sequence, delegatedTools: [...this.#delegatedTools], statuses: [...this.#statuses].map(([operation, entry]) => [operation, entry.id]) });
  }

  record(event: RpcRecord): void {
    if (event.type === "public_notice" && typeof event.text === "string") {
      this.#entries.push({ id: `status-${++this.#sequence}`, kind: "status", text: clean(event.text) });
      return;
    }
    if (event.type === "delegation_status" && typeof event.toolCallId === "string" && typeof event.text === "string") {
      this.#delegatedTools.set(event.toolCallId, clean(event.text));
      return;
    }
    if (event.type === "message_start" && record(event.message)?.role === "assistant") {
      this.#finishAssistant();
    }
    if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.#currentAssistant().text += clean(update.delta);
      }
      // tmux coalesces cumulative visible snapshots rather than losing deltas.
      if (update?.type === "text_snapshot" && typeof update.text === "string") {
        this.#currentAssistant().text = clean(update.text);
      }
    }
    if (event.type === "message_end" && record(event.message)?.role === "assistant") {
      const text = clean(visibleText(event.message));
      if (text || this.#assistant) this.#currentAssistant().text = text;
      this.#finishAssistant();
    }
    if (event.type.startsWith("tool_execution_")) {
      this.#finishAssistant();
      const id = typeof event.toolCallId === "string" ? event.toolCallId : `anonymous-${++this.#sequence}`;
      let tool = this.#tools.get(id);
      if (!tool) {
        tool = {
          id: `tool-${id}`, kind: "tool", name: typeof event.toolName === "string" ? clean(event.toolName) : "tool",
          args: event.args, output: "", state: "running",
        };
        this.#tools.set(id, tool);
        this.#entries.push(tool);
      }
      if (event.args !== undefined) tool.args = event.args;
      if (typeof event.outputLines === "number" && Number.isSafeInteger(event.outputLines) && event.outputLines >= 0) {
        tool.outputLines = event.outputLines;
      }
      if (event.type === "tool_execution_update") tool.output = visibleText(event.partialResult);
      if (event.type === "tool_execution_end") {
        tool.output = visibleText(event.result);
        tool.state = event.isError ? "failed" : "completed";
      }
    }
    if (event.type === "auto_retry_start" || event.type === "compaction_start") {
      this.#finishAssistant();
      const status: Extract<Entry, { kind: "status" }> = { id: `status-${++this.#sequence}`, kind: "status", text:
        event.type === "compaction_start" ? "Compacting session context…" : "Retrying transient model error…" };
      this.#entries.push(status);
      this.#statuses.set(event.type.replace("_start", ""), status);
    }
    if (event.type === "compaction_end" || event.type === "auto_retry_end") {
      const operation = event.type.replace("_end", "");
      const status = this.#statuses.get(operation);
      if (status) {
        status.text = operation === "compaction"
          ? event.failed || event.aborted || event.errorMessage ? "Context compaction interrupted." : "Session context compacted."
          : event.success === false ? "Model retry failed." : "Model retry finished.";
        this.#statuses.delete(operation);
      }
    }
  }

  complete(finalText: string, omitFinal = false): void {
    const text = clean(finalText).trim();
    if (this.#assistant) {
      this.#assistant.text = text;
    } else if (text && this.#lastAssistant?.text.trim() !== text) {
      this.#currentAssistant().text = text;
    }
    this.#finishAssistant();
    // RPC delegation posts its final text once inside the correlated envelope.
    if (omitFinal && this.#lastAssistant?.text.trim() === text) {
      this.#entries.splice(this.#entries.indexOf(this.#lastAssistant), 1);
      this.#lastAssistant = this.#entries.filter((entry) => entry.kind === "assistant").at(-1);
    }
  }

  fail(message: string): void {
    this.#finishAssistant();
    for (const tool of this.#tools.values()) if (tool.state === "running") tool.state = "failed";
    for (const [operation, status] of this.#statuses) status.text = `${operation === "compaction" ? "Context compaction" : "Model retry"} interrupted.`;
    this.#statuses.clear();
    const last = this.#entries.at(-1);
    if (last?.kind === "status" && last.text === message) return;
    this.#entries.push({ id: `status-${++this.#sequence}`, kind: "status", text: message });
  }

  render(): Array<{ id: string; text: string }> {
    return this.#entries.flatMap((entry) => {
      let text: string;
      if (entry.kind === "assistant") text = toSlackMrkdwn(entry.text);
      else if (entry.kind === "status") text = escapeSlackText(clean(entry.text));
      else {
        const args = record(entry.args);
        const primary = args?.command ?? args?.path ?? args?.query ?? args?.url;
        const invocation = typeof primary === "string"
          ? `${entry.name === "bash" ? "$ " : ""}${primary}`
          : JSON.stringify(entry.args ?? {});
        const state = entry.state === "running" ? ":gear:" : entry.state === "failed" ? ":x:" : ":white_check_mark:";
        text = [
          `${state} *${escapeSlackText(entry.name.replaceAll("*", ""))}* · ${entry.state}`,
          code(preview(invocation)),
          ...(this.#delegatedTools.has(entry.id.slice(5))
            ? [escapeSlackText(this.#delegatedTools.get(entry.id.slice(5))!)]
            : entry.output ? [code(preview(entry.output, entry.outputLines))] : []),
        ].join("\n");
      }
      return text.trim() ? chunkSlackText(text, CONSOLE_MESSAGE_CHARS)
        .map((part, index) => ({ id: `${entry.id}:${index}`, text: part })) : [];
    });
  }

  #currentAssistant(): Extract<Entry, { kind: "assistant" }> {
    if (!this.#assistant) {
      this.#assistant = { id: `assistant-${++this.#sequence}`, kind: "assistant", text: "", complete: false };
      this.#lastAssistant = this.#assistant;
      this.#entries.push(this.#assistant);
    }
    return this.#assistant;
  }

  #finishAssistant(): void {
    if (this.#assistant) this.#assistant.complete = true;
    this.#assistant = undefined;
  }
}
