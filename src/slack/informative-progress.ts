import { ActivityProgress, compactProgressText } from "../pi/activity-progress.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import type { DeliveryFailure, DeploymentSnapshot, ProgressState } from "./pi-progress.js";
import { escapeSlackText } from "./mrkdwn.js";

const MAX_MESSAGE = 3_500;
const MAX_TRACKED_CALLS = 128;

function plain(text: string, limit = 380): string {
  return escapeSlackText(compactProgressText(text
    .replace(/`([^`\n]+)`/gu, (_match, value: string) => /^[\w.-]{1,64}$/u.test(value) ? value : "[технічний фрагмент приховано]"), limit));
}

function group(name: unknown): string {
  if (["read", "grep", "find", "ls"].includes(String(name))) return "Перегляд матеріалів";
  if (["edit", "write"].includes(String(name))) return "Зміни файлів";
  if (name === "delegate_to_worker") return "Делеговані завдання";
  if (name === "bash") return "Командні кроки";
  return "Інші робочі кроки";
}

function textResult(value: unknown): string {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return "";
  return value.content.filter((part): part is { type: "text"; text: string } =>
    part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n").slice(-64_000);
}

/** Selective, bounded public ledger. Never stores arguments or raw tool output. */
export class InformativeProgress {
  readonly #activity = new ActivityProgress();
  readonly #running = new Map<string, { group: string; name: unknown }>();
  readonly #finished = new Set<string>();
  readonly #groups = new Map<string, { done: number; failed: number }>();
  readonly #codes = new Set<string>();
  #deployment: DeploymentSnapshot | undefined;

  record(event: RpcRecord, deployment?: DeploymentSnapshot): boolean {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (id && ["tool_execution_start", "tool_execution_end"].includes(String(event.type)) && this.#finished.has(id)) return false;
    const before = this.render("working");
    this.#activity.record(event);
    if (deployment && (event.toolName === "bash" || event.toolName === undefined)) this.#deployment = deployment;
    if (event.type === "tool_execution_start" && id && !this.#finished.has(id)) {
      this.#running.set(id, { group: group(event.toolName), name: event.toolName });
      if (this.#running.size > MAX_TRACKED_CALLS) this.#running.delete(this.#running.keys().next().value!);
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const name = event.toolName ?? (id ? this.#running.get(id)?.name : undefined);
      // Codes alone, never SQLcl error text/commands/connection strings. Ignore
      // file reads and embedded error literals; only real command-output lines.
      if (name === "bash") {
        for (const match of textResult(event.type === "tool_execution_end" ? event.result : event.partialResult)
          .matchAll(/(?:^|\n)[ \t]*((?:ORA|PLS|TNS)-\d{5}|SP2-\d{4})\b/gu)) {
          this.#codes.add(match[1]!);
          if (this.#codes.size > 6) this.#codes.delete(this.#codes.keys().next().value!);
        }
      }
    }
    if (event.type === "tool_execution_end" && id && !this.#finished.has(id)) {
      const category = this.#running.get(id)?.group ?? group(event.toolName);
      const totals = this.#groups.get(category) ?? { done: 0, failed: 0 };
      totals.done += 1;
      if (event.isError === true) totals.failed += 1;
      this.#groups.set(category, totals);
      this.#running.delete(id);
      this.#finished.add(id);
      if (this.#finished.size > MAX_TRACKED_CALLS) this.#finished.delete(this.#finished.values().next().value!);
    }
    return before !== this.render("working");
  }

  render(state: ProgressState, detail?: DeliveryFailure | string): string {
    const reference = typeof detail === "string" ? detail : detail?.correlationId;
    const activity = this.#activity.snapshot();
    const status = this.#deployment;
    const incomplete = status && (status.fail > 0 || status.warn > 0 || status.skip > 0 || status.pending > 0);
    const sections = [state === "delivery-failed" && typeof detail === "object"
      ? `:warning: *Pi завершив роботу, але Slack не прийняв частину ${detail.posted + 1} з ${detail.total} відповіді.* Не повторюйте дії без перевірки результату.`
      : state === "failed" ? ":warning: *Запит не завершено*"
      : state === "completed" && incomplete ? ":warning: *Роботу над запитом завершено з невирішеними пунктами*"
      : state === "completed" ? ":white_check_mark: *Роботу над запитом завершено*"
      : ":hourglass_flowing_sand: *Хід виконання*"];
    // Operational blockers/counters have priority over narrative if space runs out.
    if (status) {
      sections.push(`*Розгортання ${status.stage === "apex" ? "APEX" : "SQL"}:* ${status.completed}/${status.planned} операцій • залишилось ${status.pending}\n` +
        `OK ${status.ok} • WARN ${status.warn} • FAIL ${status.fail} • SKIP ${status.skip}` +
        (status.current ? `\n*${status.state === "running" && state === "working" ? "Поточна" : "Остання"} ТТ:* ${status.current}` : ""));
      if (status.state === "completed" && status.pending > 0) {
        sections.push(`:warning: *Процес завершився до кінця плану:* ${status.pending} операцій не виконано. Потрібне уточнення перед продовженням.`);
      } else if (status.fail > 0 || status.warn > 0 || status.skip > 0) {
        sections.push(":warning: Є помилки, попередження або пропущені цілі; успіх усього розгортання не підтверджено.");
      }
    }
    if (this.#codes.size) sections.push(`*Виявлені коди:* ${[...this.#codes].join(", ")}. Пояснення та рішення — у повідомленні агента.`);
    if (activity.failures) sections.push(`:warning: Невдалих робочих кроків: ${activity.failures}. Це не підсумковий статус усієї задачі.`);
    if (["failed", "delivery-failed"].includes(state) && reference && /^[a-zA-Z0-9-]{1,100}$/u.test(reference)) sections.push(`Код звернення: ${reference}`);
    if (state === "working") sections.push(`*Зараз:* ${plain(activity.current)}`);
    if (activity.notes.length) sections.push(`*Що встановлено / наступний крок*\n${activity.notes.map(note => `• ${plain(note)}`).join("\n")}`);
    if (activity.workers.length) sections.push(`*Профільні агенти*\n${activity.workers.map(worker => `• ${worker.id}: ${plain(worker.text, 200)}`).join("\n")}`);
    const categories = new Set([...this.#groups.keys(), ...[...this.#running.values()].map(call => call.group)]);
    if (categories.size) sections.push("*Робочі кроки* (не результати ТТ)\n" + [...categories].map(category => {
      const totals = this.#groups.get(category) ?? { done: 0, failed: 0 };
      const running = [...this.#running.values()].filter(call => call.group === category).length;
      return `• ${category}: завершено ${totals.done}` +
        (running ? `, виконується ${running}` : "") + (totals.failed ? `, з помилкою ${totals.failed}` : "");
    }).join("\n"));
    let output = "";
    for (const section of sections) {
      if (output.length + section.length + 2 > MAX_MESSAGE) {
        const available = MAX_MESSAGE - output.length - 3;
        if (available > 0) output += "\n\n" + section.slice(0, available) + "…";
        break;
      }
      output += (output ? "\n\n" : "") + section;
    }
    return output;
  }
}
