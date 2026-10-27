import type { RpcRecord } from "./rpc-client.js";

export const MAX_PROGRESS_NOTE_CHARS = 450;
const MAX_NOTES = 3;

export const PUBLIC_PROGRESS_GUIDANCE =
  "Public progress style: before the first tool and at meaningful phase changes, write 1–2 short Ukrainian sentences explaining what you are checking/changing and why. " +
  "After a material finding, say what was established and the next step or blocker. Do not narrate every tool, emit empty heartbeats, or claim unverified success. " +
  "These notes are visible to the Slack user and the coordinating agent: omit shell/SQL commands, raw tool names, arguments, traces, credentials and unrelated data. " +
  "Give concise outcome-oriented explanations, never private reasoning. Keep the final answer separate from progress notes.";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Public-facing text only. Never feed tool output or thinking to this helper. */
export function compactProgressText(value: string, limit = MAX_PROGRESS_NOTE_CHARS): string {
  const text = value
    .replace(/```[\s\S]*?(?:```|$)/gu, " [технічний блок приховано] ")
    // Deliberately strip terminal/control sequences from public progress notes.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/gu, " ")
    .replace(/\b(?:xox[baprs]-|xapp-|ghp_|github_pat_|sk-)[A-Za-z0-9_-]{12,}/gu, "[секрет приховано]")
    .replace(/\bauthorization\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+/giu, "[секрет приховано]")
    .replace(/\b(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "[секрет приховано]")
    .replace(/\b[A-Za-z][\w$#]*\/[^\s@]+@[\w.-]+(?::\d+)?(?:\/[\w.-]+)?/gu, "[з'єднання приховано]")
    .replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit - 1);
  const boundary = prefix.lastIndexOf(" ");
  return `${boundary > limit * 0.7 ? prefix.slice(0, boundary) : prefix}…`;
}

/** Only completed public commentary accompanying tools, never final answers or reasoning. */
export function publicProgressEvent(value: unknown): RpcRecord | undefined {
  const message = record(value);
  if (message?.role !== "assistant" || !Array.isArray(message.content) ||
      ["error", "aborted"].includes(String(message.stopReason))) return;
  const content = message.content.map(record);
  if (!content.some((part) => part?.type === "toolCall")) return;
  const text = compactProgressText(content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part!.text as string).join("\n"));
  if (text) return { type: "agent_progress", text };
}

/** Intentionally uses the tool name only, never guesses outcomes from command strings. */
export function toolActivity(name: unknown): string {
  if (typeof name !== "string") return "Виконую робочий крок";
  if (["read", "grep", "find", "ls"].includes(name)) return "Переглядаю файли та контекст";
  if (["edit", "write"].includes(name)) return "Вношу зміни до файлів";
  if (name === "team_status") return "Перевіряю доступність агентів";
  if (name === "delegate_to_worker") return "Очікую на результат профільного агента";
  if (name === "story_context" || name.startsWith("jira_")) {
    return /^jira_(?:create|update|delete|transition|add|move|link|remove|rank|batch_create)/u.test(name)
      ? "Оновлюю робочі дані в Jira" : "Збираю контекст у Jira";
  }
  if (name.startsWith("confluence_")) {
    return /^confluence_(?:create|update|delete|add)/u.test(name)
      ? "Оновлюю документацію" : "Переглядаю документацію";
  }
  if (name.startsWith("apexlang")) return "Працюю із застосунком APEX";
  return "Виконую робочий крок";
}

function workerId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9-]{1,62}$/u.test(value) ? value : undefined;
}

export function workerProgressDetails(id: string, text: string): Record<string, unknown> {
  return { progress: { version: 1, workerId: id, text: compactProgressText(text, 1_600) } };
}

export interface ActivitySnapshot {
  current: string;
  notes: string[];
  workers: Array<{ id: string; text: string }>;
  failures: number;
}

/** Bounded, factual activity view shared by Slack and worker → manager progress. */
export class ActivityProgress {
  #current = "Запит у черзі агента";
  readonly #notes: string[] = [];
  readonly #workers = new Map<string, string>();
  readonly #running = new Map<string, { activity: string; worker?: string }>();
  #failures = 0;
  #waiting = false;

  snapshot(): ActivitySnapshot {
    return {
      current: this.#current, notes: [...this.#notes], failures: this.#failures,
      workers: [...this.#workers].slice(-4).map(([id, text]) => ({ id, text })),
    };
  }

  /** Plain, compact prose for the relay. It contains no task result/trace. */
  describe(): string {
    return [this.#notes.at(-1), this.#current,
      ...(this.#failures ? [`Невдалі кроки: ${this.#failures}; подробиці будуть у підсумку.`] : []),
    ].filter(Boolean).join(" · ");
  }

  record(event: RpcRecord): boolean {
    const before = JSON.stringify(this.snapshot());
    this.#record(event);
    return before !== JSON.stringify(this.snapshot());
  }

  #record(event: RpcRecord): void {
    if (event.type === "message_end") {
      const progress = publicProgressEvent(event.message);
      if (progress) this.#record(progress);
      return;
    }
    if (event.type === "agent_progress" && typeof event.text === "string") {
      const text = compactProgressText(event.text);
      if (text && this.#notes.at(-1) !== text) {
        this.#notes.push(text);
        if (this.#notes.length > MAX_NOTES) this.#notes.shift();
      }
    } else if (event.type === "agent_start") {
      // A resumed low-level run must not reset meaningful progress.
      if (this.#current === "Запит у черзі агента") this.#current = "Опрацьовую запит";
    } else if (event.type === "agent_waiting") {
      this.#waiting = true;
      this.#current = "Очікую на вашу відповідь у Slack";
    } else if (event.type === "agent_resumed") {
      this.#waiting = false;
      this.#current = this.#latestActivity();
    } else if (event.type === "tool_execution_start") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "anonymous";
      const worker = event.toolName === "delegate_to_worker" ? workerId(record(event.args)?.workerId) : undefined;
      const activity = toolActivity(event.toolName);
      this.#running.set(id, { activity, ...(worker ? { worker } : {}) });
      if (this.#running.size > 64) this.#running.delete(this.#running.keys().next().value!);
      if (worker) this.#setWorker(worker, "Завдання передано; очікую початку роботи");
      if (!this.#waiting) this.#current = activity;
    } else if (event.type === "tool_execution_update" && event.toolName === "delegate_to_worker") {
      this.#workerUpdate(event.partialResult);
    } else if (event.type === "tool_execution_end") {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "anonymous";
      const worker = this.#running.get(id)?.worker;
      this.#running.delete(id);
      if (event.isError === true) this.#failures += 1;
      if (worker) this.#setWorker(worker, event.isError === true ? "Не вдалося завершити завдання" : "Результат отримано");
      if (event.toolName === "delegate_to_worker" && event.isError !== true) this.#workerUpdate(event.result);
      if (!this.#waiting) this.#current = this.#latestActivity();
    } else if (event.type === "compaction_start") {
      this.#current = "Стискаю накопичений контекст, щоб продовжити роботу";
    } else if (event.type === "auto_retry_start") {
      this.#current = "Повторюю запит після тимчасової помилки";
    }
  }

  #latestActivity(): string {
    return [...this.#running.values()].at(-1)?.activity ?? "Оцінюю результати виконаних кроків";
  }

  #workerUpdate(value: unknown): void {
    const progress = record(record(record(value)?.details)?.progress);
    const id = workerId(progress?.workerId);
    if (progress?.version !== 1 || !id || typeof progress.text !== "string") return;
    this.#setWorker(id, compactProgressText(progress.text, 1_600));
  }

  #setWorker(id: string, text: string): void {
    this.#workers.set(id, text);
    if (this.#workers.size > 4) this.#workers.delete(this.#workers.keys().next().value!);
  }
}
