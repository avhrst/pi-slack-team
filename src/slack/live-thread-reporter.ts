import type { WebClient } from "@slack/web-api";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { compactProgressText, publicProgressEvent, toolActivity } from "../pi/activity-progress.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import type { IncomingSlackMessage } from "../routing/chat-key.js";
import { chunkSlackText } from "./chunk-text.js";
import { definiteSlackRejection, type SlackDeliveryQueue } from "./console-reporter.js";
import { escapeSlackText } from "./mrkdwn.js";
import { deploymentSnapshot, toSlackMrkdwn, type DeploymentSnapshot } from "./pi-progress.js";

const STREAM_MAX_AGE_MS = 9 * 60_000;
const STREAM_MAX_TEXT = 11_000;
const COALESCE_MS = 250;
const MAX_TRACKED_STEPS = 256;

export interface SlackWorkStep {
  kind: "step";
  id: string;
  title: string;
  status: "in_progress" | "complete" | "error";
  detail: string;
}

export type SlackWorkProgressEntry = { kind: "note"; text: string } | SlackWorkStep;

const stepStatus = {
  in_progress: "⚙️ Виконується",
  complete: "✅ Завершено",
  error: "⚠️ Крок із помилкою або непідтвердженим результатом",
} as const;

function stepTitle(name: unknown): string {
  if (name === "bash") return "🔧 Виконую командний крок";
  return `🔧 ${toolActivity(name)}`;
}

function publicNote(value: string): string {
  return compactProgressText(value
    .replace(/`([^`\n]+)`/gu, (_match, inline: string) =>
      /^[\w.-]{1,64}$/u.test(inline) ? inline : "[технічний фрагмент приховано]")
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/gu, "$1")
    .replace(/https?:\/\/[^\s<>]+/giu, "[посилання]"));
}

export function renderSlackWorkProgress(entry: SlackWorkProgressEntry): string {
  return escapeSlackText(entry.kind === "note" ? entry.text :
    `${stepStatus[entry.status]} · ${entry.title}${entry.detail ? `\n${entry.detail}` : ""}`);
}

function resultCodes(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) return [];
  const text = result.content.filter((part): part is { type: "text"; text: string } =>
    part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n").slice(-64_000);
  return [...text.matchAll(/(?:^|\n)[ \t]*((?:ORA|PLS|TNS)-\d{5}|SP2-\d{4})\b/gu)].map(match => match[1]!);
}

interface WorkStepState {
  step: SlackWorkStep;
  name: unknown;
  snapshot?: DeploymentSnapshot;
  codes: string[];
  workerText?: string;
}

function stepDetail(state: WorkStepState): string {
  const parts: string[] = [];
  const status = state.snapshot;
  if (status) {
    const stage = status.stage === "apex" ? "APEX" : "SQL";
    parts.push(`${stage}: ${status.completed}/${status.planned} операцій, залишилося ${status.pending}`,
      `OK ${status.ok} · WARN ${status.warn} · FAIL ${status.fail} · SKIP ${status.skip}`);
    if (status.current) parts.push(`ТТ ${status.current}`);
  }
  if (state.codes.length) parts.push(`Коди: ${state.codes.join(", ")}`);
  if (state.workerText) parts.push(state.workerText);
  return parts.join("\n");
}

/** Projects verified public Pi events into Slack states without retaining commands or stdout. */
export class SlackWorkProgress {
  readonly #steps = new Map<string, WorkStepState>();
  #lastNote: string | undefined;
  #deployment: DeploymentSnapshot | undefined;

  get deployment(): DeploymentSnapshot | undefined { return this.#deployment; }

  record(event: RpcRecord): SlackWorkProgressEntry | undefined {
    if (event.type === "message_end") {
      const progress = publicProgressEvent(event.message);
      return progress ? this.record(progress) : undefined;
    }
    if (["agent_progress", "public_notice"].includes(event.type) && typeof event.text === "string") {
      const text = publicNote(event.text);
      return text ? this.#note(`${event.type === "public_notice" ? "ℹ️" : "💬"} ${text}`) : undefined;
    }
    if (event.type === "agent_waiting") return this.#note("⏸️ Очікую на вашу відповідь у Slack.");
    if (event.type === "agent_resumed") return this.#note("▶️ Продовжую роботу.");
    if (event.type === "compaction_start") return this.#note("🗂️ Упорядковую накопичений контекст.");
    if (event.type === "auto_retry_start") return this.#note("🔄 Повторюю запит після тимчасової помилки.");
    if (!["tool_execution_start", "tool_execution_update", "tool_execution_end", "delegation_status"].includes(event.type) ||
        typeof event.toolCallId !== "string" || !event.toolCallId) return;

    let state = this.#steps.get(event.toolCallId);
    const isNew = !state;
    if (!state) {
      const id = createHash("sha256").update(event.toolCallId).digest("hex").slice(0, 32);
      state = {
        name: event.toolName,
        step: { kind: "step", id, title: stepTitle(event.toolName), status: "in_progress", detail: "" },
        codes: [],
      };
      if (this.#steps.size >= MAX_TRACKED_STEPS) {
        const completed = [...this.#steps].find(([, item]) => item.step.status !== "in_progress");
        if (completed) this.#steps.delete(completed[0]);
      }
      this.#steps.set(event.toolCallId, state);
    }

    if (event.type === "tool_execution_start" && state.name === undefined) state.name = event.toolName;
    const title = stepTitle(state.name);
    if (event.type === "delegation_status" && typeof event.text === "string" &&
        (state.name === undefined || state.name === "delegate_to_worker")) {
      state.workerText = publicNote(event.text);
    }
    if (state.step.status !== "in_progress" && event.type !== "delegation_status") return;
    if (state.name === "bash" && ["tool_execution_update", "tool_execution_end"].includes(event.type)) {
      const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
      const snapshot = deploymentSnapshot(result);
      if (snapshot) {
        state.snapshot = snapshot;
        this.#deployment = snapshot;
      }
      state.codes = [...new Set([...state.codes, ...resultCodes(result)])].slice(-6);
    }

    const deploymentWarnings = state.snapshot && (state.snapshot.warn || state.snapshot.fail || state.snapshot.skip || state.snapshot.pending);
    const status = event.type === "tool_execution_end" ? (event.isError === true || deploymentWarnings ? "error" : "complete")
      : state.step.status;
    const step: SlackWorkStep = { ...state.step, title, status, detail: stepDetail(state) };
    if (!isNew && state.step.title === step.title && state.step.status === step.status && state.step.detail === step.detail) return;
    state.step = step;
    return step;
  }

  interrupt(): SlackWorkStep[] {
    const unsettled: SlackWorkStep[] = [];
    for (const state of this.#steps.values()) {
      if (state.step.status !== "in_progress") continue;
      state.step = { ...state.step, status: "error",
        detail: [state.step.detail, "Завершення кроку не підтверджено."].filter(Boolean).join("\n") };
      unsettled.push(state.step);
    }
    return unsettled;
  }

  #note(text: string): SlackWorkProgressEntry | undefined {
    if (this.#lastNote === text) return;
    this.#lastNote = text;
    return { kind: "note", text };
  }
}

interface SlackLiveThreadOptions {
  client: Pick<WebClient, "apiCall"> & { chat: Pick<WebClient["chat"], "startStream" | "appendStream" | "postMessage" | "update"> };
  queue: SlackDeliveryQueue;
  message: Pick<IncomingSlackMessage, "channelId" | "teamId" | "userId">;
  threadTs: string;
  onError: (error: unknown) => void;
  nativeStreaming?: boolean;
}

interface StreamState { ts: string; opened: number; length: number }

function slackError(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}

function canRetryAsMessage(error: unknown): boolean {
  // Slack documents that these explicit errors can follow partial success.
  return definiteSlackRejection(error) && !["fatal_error", "internal_error", "request_timeout"].includes(slackError(error) ?? "");
}

/** Serializes a turn's public notes, durable Slack cards and final answer within its work thread. */
export class SlackLiveThreadReporter {
  readonly #progress = new SlackWorkProgress();
  readonly #abort = new AbortController();
  readonly #pending = new Map<string, SlackWorkProgressEntry>();
  readonly #posted = new Map<string, { ts: string; text: string }>();
  readonly #uncertainCards = new Set<string>();
  #native: boolean;
  #nativeCards = true;
  #paused = false;
  #stream: StreamState | undefined;
  #stopping: Promise<void> | undefined;
  #accepting = true;
  #sequence = 0;
  #timer: NodeJS.Timeout | undefined;
  #draining: Promise<void> | undefined;
  #finished: Promise<void> | undefined;
  #result: Promise<void> | undefined;

  constructor(private readonly options: SlackLiveThreadOptions) {
    this.#native = options.nativeStreaming !== false && typeof options.client.chat.startStream === "function";
  }

  get deployment(): DeploymentSnapshot | undefined { return this.#progress.deployment; }

  record(event: RpcRecord): void {
    if (!this.#accepting) return;
    const entry = this.#progress.record(event);
    if (!entry) return;
    this.#enqueue(entry);
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, COALESCE_MS).unref();
  }

  finishProgress(): Promise<void> {
    this.#finished ??= this.#finishProgress();
    return this.#finished;
  }

  async pause(): Promise<void> {
    this.#paused = true;
    await this.#draining;
    await this.#stopStream();
  }

  resume(): void { this.#paused = false; }

  complete(finalText: string): Promise<void> {
    return this.#publishResult(toSlackMrkdwn(stripVTControlCharacters(finalText.trim())) || "Агент завершив запит без текстової відповіді.");
  }

  fail(text: string): Promise<void> {
    return this.#publishResult(`🛑 ${escapeSlackText(publicNote(text) || "Запит перервано.")}`);
  }

  async close(): Promise<void> {
    this.#accepting = false;
    this.#cancelTimer();
    this.#abort.abort();
    this.#pending.clear();
    await this.#draining;
  }

  #cancelTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #enqueue(entry: SlackWorkProgressEntry): void {
    this.#pending.set(entry.kind === "step" ? entry.id : `note-${++this.#sequence}`, entry);
  }

  async #finishProgress(): Promise<void> {
    this.#accepting = false;
    this.#cancelTimer();
    for (const step of this.#progress.interrupt()) this.#enqueue(step);
    await this.#flush();
    await this.#stopStream();
  }

  #publishResult(text: string): Promise<void> {
    this.#result ??= (async () => {
      await this.finishProgress();
      for (const part of chunkSlackText(text)) await this.#post(part);
    })();
    return this.#result;
  }

  #flush(): Promise<void> {
    this.#draining ??= this.#deliver().finally(() => { this.#draining = undefined; });
    return this.#draining;
  }

  async #deliver(): Promise<void> {
    while (this.#pending.size && !this.#abort.signal.aborted) {
      const entries = [...this.#pending.values()];
      this.#pending.clear();
      let notes: string[] = [];
      for (const entry of entries) {
        if (this.#abort.signal.aborted) return;
        if (entry.kind === "note") {
          notes.push(renderSlackWorkProgress(entry));
          continue;
        }
        await this.#sendNotes(notes);
        notes = [];
        // Close this passage before appending the next comment after the card.
        await this.#stopStream();
        await this.#writeCard(entry).catch(error => this.#reportError(error));
      }
      await this.#sendNotes(notes);
    }
  }

  async #sendNotes(notes: string[]): Promise<void> {
    if (!notes.length) return;
    for (const text of chunkSlackText(notes.join("\n\n"), 3_500)) {
      await this.#sendNote(text).catch(error => this.#reportError(error));
    }
  }

  async #sendNote(text: string): Promise<void> {
    if (this.#native && !this.#paused) {
      try {
        await this.#streamNote(text);
        return;
      } catch (error) {
        this.#native = false;
        await this.#stopStream();
        if (!canRetryAsMessage(error)) throw error;
        this.#reportError(error);
      }
    }
    await this.#post(text);
  }

  async #streamNote(text: string): Promise<void> {
    const { client, message, queue, threadTs } = this.options;
    if (this.#stream && (Date.now() - this.#stream.opened >= STREAM_MAX_AGE_MS ||
        this.#stream.length + text.length + 2 >= STREAM_MAX_TEXT)) await this.#stopStream();

    if (this.#stream) {
      const stream = this.#stream;
      try {
        await queue.send("post", () => client.chat.appendStream({ channel: message.channelId, ts: stream.ts,
          chunks: [{ type: "markdown_text", text: `\n\n${text}` }] }), this.#abort.signal, true);
        stream.length += text.length + 2;
        return;
      } catch (error) {
        if (slackError(error) !== "message_not_in_streaming_state") throw error;
        this.#stream = undefined;
      }
    }

    const opened = Date.now();
    const result = await queue.send("post", () => client.chat.startStream({
      channel: message.channelId, thread_ts: threadTs,
      ...(!message.channelId.startsWith("D") ? { recipient_user_id: message.userId, recipient_team_id: message.teamId } : {}),
      chunks: [{ type: "markdown_text", text }],
    }), this.#abort.signal, true);
    if (!result.ts) throw new Error("Slack did not confirm the streaming message timestamp");
    this.#stream = { ts: result.ts, opened, length: text.length };
  }

  async #stopStream(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const stream = this.#stream;
    if (!stream) return;
    this.#stream = undefined;
    const { client, message, queue } = this.options;
    this.#stopping = queue.send("update", () => client.apiCall("chat.stopStream", {
      channel: message.channelId, ts: stream.ts, session_status: "processing",
    }), this.#abort.signal).then(() => undefined, (error: unknown) => {
      if (slackError(error) !== "message_not_in_streaming_state") this.#reportError(error);
    }).finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async #writeCard(step: SlackWorkStep): Promise<void> {
    if (this.#uncertainCards.has(step.id)) return;
    const text = renderSlackWorkProgress(step);
    const previous = this.#posted.get(step.id);
    if (previous?.text === text) return;
    try {
      await this.#sendCard(step, text, previous?.ts);
    } catch (error) {
      if (this.#nativeCards && ["invalid_blocks", "invalid_block", "invalid_arguments"].includes(slackError(error) ?? "")) {
        this.#nativeCards = false;
        await this.#sendCard(step, text, previous?.ts);
      } else throw error;
    }
  }

  async #sendCard(step: SlackWorkStep, text: string, ts?: string): Promise<void> {
    const { client, message, queue, threadTs } = this.options;
    const details = step.detail ? `${stepStatus[step.status]}\n${step.detail}` : stepStatus[step.status];
    const block = this.#nativeCards ? { type: "task_card", task_id: step.id, title: step.title, status: step.status,
      details: { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: details }] }] } } : undefined;
    try {
      if (ts) {
        await queue.send("update", () => client.chat.update({ channel: message.channelId,
          ts, text, blocks: block ? [block] : [],
        }), this.#abort.signal);
        this.#posted.set(step.id, { ts, text });
      } else {
        const posted = await queue.send("post", () => client.chat.postMessage({ channel: message.channelId,
          thread_ts: threadTs, text, ...(block ? { blocks: [block] } : {}), unfurl_links: false, unfurl_media: false,
        }), this.#abort.signal, true);
        if (!posted.ts) throw new Error("Slack did not confirm the task card timestamp");
        this.#posted.set(step.id, { ts: posted.ts, text });
      }
    } catch (error) {
      if (!ts && !canRetryAsMessage(error)) this.#uncertainCards.add(step.id);
      throw error;
    }
  }

  async #post(text: string): Promise<void> {
    const { client, message, queue, threadTs } = this.options;
    await queue.send("post", () => client.chat.postMessage({ channel: message.channelId, thread_ts: threadTs,
      text, unfurl_links: false, unfurl_media: false,
    }), this.#abort.signal, true);
  }

  #reportError(error: unknown): void {
    if (!this.#abort.signal.aborted) this.options.onError(error);
  }
}
