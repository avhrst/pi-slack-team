import { describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import { workerProgressDetails } from "../src/pi/activity-progress.js";
import { PiProgressTranscript } from "../src/slack/pi-progress.js";
import { SlackProgressReporter } from "../src/slack/progress-reporter.js";

function marker(overrides: Record<string, unknown> = {}) {
  return { version: 1, stage: "sql-files", state: "running", planned: 51, completed: 12,
    pending: 39, ok: 12, warn: 0, fail: 0, skip: 0, current: "VINMAG", ...overrides };
}
function progress(payload = marker()) {
  return { type: "tool_execution_update", toolName: "bash", toolCallId: "deployment",
    partialResult: { content: [{ type: "text", text: `PRIVATE_TRACE\nPI_DEPLOY_PROGRESS ${JSON.stringify(payload)}\nPRIVATE_SQL` }] } };
}
function commentary(text: string) {
  return { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "text", text },
    { type: "toolCall", name: "bash", arguments: { command: "SECRET_COMMAND" } },
  ] } };
}

describe("informative progress", () => {
  it("accepts the opt-in mode alongside the console default", () => {
    const input = { version: 1, agentId: "deploy", expectedUnixUser: "deploy-agent", stateDir: "/tmp/state",
      slack: { teamId: "T0", appId: "A0", allowedUserIds: ["U0"], progressMode: "informative" },
      pi: { cwd: "/tmp", agentDir: "/tmp", sessionDir: "/tmp" } };
    expect(agentConfigSchema.parse(input).slack.progressMode).toBe("informative");
    expect(agentConfigSchema.parse({ ...input, slack: { ...input.slack, progressMode: undefined } }).slack.progressMode).toBe("console");
  });

  it("combines public milestones, meaningful work totals, and validated rollout progress", () => {
    const view = new PiProgressTranscript("informative");
    view.record(commentary("Перевірку файла завершено. Оновлюю лише підтверджені активні ТТ."));
    view.record({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "/PRIVATE_PATH" } });
    view.record({ type: "tool_execution_end", toolCallId: "r", toolName: "read", result: { content: [{ type: "text", text: "PRIVATE_SOURCE" }] } });
    view.record({ type: "tool_execution_start", toolCallId: "deployment", toolName: "bash", args: { command: "SECRET_COMMAND" } });
    view.record(progress());
    const text = view.render("working");
    expect(text).toContain("Перевірку файла завершено");
    expect(text).toContain("*Розгортання SQL:* 12/51 операцій • залишилось 39");
    expect(text).toContain("OK 12 • WARN 0 • FAIL 0 • SKIP 0");
    expect(text).toContain("*Поточна ТТ:* VINMAG");
    expect(text).toContain("Перегляд матеріалів: завершено 1");
    expect(text).toContain("Командні кроки: завершено 0, виконується 1");
    for (const hidden of ["PRIVATE", "SECRET", "bash", "PI_DEPLOY_PROGRESS", "toolCall", "arguments"]) expect(text).not.toContain(hidden);
  });

  it("extracts only canonical error codes, not traces, SQL, credentials, or file contents", () => {
    const view = new PiProgressTranscript("informative");
    view.record({ type: "tool_execution_end", toolName: "read", toolCallId: "r", result: { content: [{ type: "text", text: "ORA-12345: FILE_CONTENT" }] } });
    view.record({ type: "tool_execution_end", toolName: "bash", toolCallId: "b", isError: true,
      result: { content: [{ type: "text", text: "ORA-20092: user/private@host:1521/xe\nPLS-00302: PRIVATE_SQL\nSP2-0734: PRIVATE_TRACE\nconst code = 'ORA-54321';" }] } });
    const text = view.render("working");
    expect(text).toContain("ORA-20092, PLS-00302, SP2-0734");
    expect(text).toContain("Невдалих робочих кроків: 1");
    expect(text).toContain("Це не підсумковий статус усієї задачі");
    expect(text).not.toMatch(/ORA-12345|ORA-54321|PRIVATE|user\/private|host|const code/);
  });

  it("never labels a halted or skipped rollout as a clean success", () => {
    const view = new PiProgressTranscript("informative");
    view.record(progress(marker({ state: "completed", ok: 11, fail: 1 })));
    const text = view.render("completed", "SEPARATE_FINAL_ANSWER");
    expect(text).toContain("з невирішеними пунктами");
    expect(text).toContain("Процес завершився до кінця плану");
    expect(text).toContain("39 операцій не виконано");
    expect(text).not.toContain(":white_check_mark:");
    expect(text).not.toContain("SEPARATE_FINAL_ANSWER");
    const skipped = new PiProgressTranscript("informative");
    skipped.record(progress(marker({ state: "completed", planned: 1, completed: 1, pending: 0, ok: 0, skip: 1 })));
    expect(skipped.render("completed")).toContain("пропущені цілі");
    expect(skipped.render("completed")).not.toContain(":white_check_mark:");
  });

  it("shows a completed clean rollout and keeps the final answer separate", () => {
    const view = new PiProgressTranscript("informative");
    view.record(progress(marker({ state: "completed", completed: 51, pending: 0, ok: 51, current: null })));
    expect(view.render("completed", "FINAL_ANSWER")).toContain(":white_check_mark:");
    expect(view.render("completed", "FINAL_ANSWER")).not.toContain("FINAL_ANSWER");
  });

  it("ignores invalid deployment markers and arbitrary progress-shaped tool data", () => {
    const view = new PiProgressTranscript("informative");
    view.record(progress(marker({ current: "<!channel>" })));
    view.record(progress(marker({ ok: 200 })));
    view.record(progress(marker({ pending: -1 })));
    view.record({ ...progress(), toolName: "read" });
    expect(view.render("working")).not.toMatch(/Розгортання|channel|PRIVATE/);
  });

  it("deduplicates terminal events, repeated milestones, and partial output noise", () => {
    const view = new PiProgressTranscript("informative");
    expect(view.record({ type: "agent_progress", text: "Знайдено причину." })).toBe(true);
    expect(view.record({ type: "agent_progress", text: "Знайдено причину." })).toBe(false);
    expect(view.record({ type: "tool_execution_update", toolName: "bash", partialResult: { content: [{ type: "text", text: "NOISE" }] } })).toBe(false);
    const end = { type: "tool_execution_end", toolName: "bash", toolCallId: "same", isError: true };
    expect(view.record(end)).toBe(true);
    expect(view.record(end)).toBe(false);
    expect(view.render("working")).toContain("завершено 1");
    expect(view.render("working")).toContain("Невдалих робочих кроків: 1");
  });

  it("shows worker status without exposing delegated tasks or complete worker results", () => {
    const view = new PiProgressTranscript("informative");
    view.record({ type: "tool_execution_start", toolName: "delegate_to_worker", toolCallId: "d", args: { workerId: "support", task: "PRIVATE_TASK" } });
    view.record({ type: "tool_execution_update", toolName: "delegate_to_worker", toolCallId: "d", partialResult: {
      content: [{ type: "text", text: "PRIVATE_RESULT" }], details: workerProgressDetails("support", "Перевіряю фактичний стан, без змін.") } });
    const text = view.render("working");
    expect(text).toContain("support: Перевіряю фактичний стан");
    expect(text).not.toContain("PRIVATE");
  });

  it("sanitizes commentary and bounds the ledger while keeping blockers first", () => {
    const view = new PiProgressTranscript("informative");
    for (let i = 0; i < 1_000; i++) {
      view.record({ type: "agent_progress", text: `Етап ${i} <!channel> password=PRIVATE_PASSWORD user/PRIVATE_DB@host/xe ${"публічний опис ".repeat(100)}` });
      view.record({ type: "tool_execution_end", toolCallId: String(i), toolName: "read" });
    }
    for (const workerId of ["deploy", "support", "msboard", "dev"]) {
      view.record({ type: "tool_execution_update", toolName: "delegate_to_worker", partialResult: { details: workerProgressDetails(workerId, "Публічний стан ".repeat(120)) } });
    }
    view.record(progress(marker({ state: "completed", ok: 11, fail: 1 })));
    const text = view.render("failed", "request-123");
    expect(text.length).toBeLessThanOrEqual(3_500);
    expect(text).toContain("Процес завершився до кінця плану");
    expect(text).toContain("request-123");
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).not.toMatch(/PRIVATE|user\/|<!channel>|Етап 0 /);
  });

  it("ignores streaming text/thinking and does not duplicate final messages", () => {
    const view = new PiProgressTranscript("informative");
    for (const type of ["thinking_delta", "text_delta", "toolcall_delta"]) {
      expect(view.record({ type: "message_update", assistantMessageEvent: { type, delta: "PRIVATE_OR_FINAL" } })).toBe(false);
    }
    view.record({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "FINAL_TEXT" }] } });
    expect(view.render("completed", "FINAL_TEXT")).not.toMatch(/PRIVATE|FINAL/);
  });
});

describe("informative Slack delivery", () => {
  it("coalesces meaningful updates at five seconds and flushes completion immediately", async () => {
    vi.useFakeTimers();
    try {
      const update = vi.fn(async () => undefined);
      const reporter = new SlackProgressReporter("informative", update, () => undefined);
      reporter.record(commentary("Перевіряю файл."));
      await vi.advanceTimersByTimeAsync(0);
      expect(update).toHaveBeenCalledTimes(1);
      reporter.record(progress());
      await vi.advanceTimersByTimeAsync(4_999);
      expect(update).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(update).toHaveBeenCalledTimes(2);
      reporter.record(progress());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(update).toHaveBeenCalledTimes(2);
      await reporter.complete();
      expect(update).toHaveBeenCalledTimes(3);
      expect(update.mock.calls.at(-1)?.[0]).not.toContain("FINAL_ANSWER");
    } finally { vi.useRealTimers(); }
  });

  it("retains milestones and counters when the turn fails", async () => {
    const updates: string[] = [];
    const reporter = new SlackProgressReporter("informative", async text => { updates.push(text); }, () => undefined);
    reporter.record(commentary("Знайдено розбіжність у збереженому коді."));
    reporter.record(progress());
    await reporter.fail("request-123");
    expect(updates.at(-1)).toContain("Знайдено розбіжність");
    expect(updates.at(-1)).toContain("12/51");
    expect(updates.at(-1)).toContain("request-123");
  });

  it("falls back to safe balanced prose, never unfiltered summary text deltas", async () => {
    const updates: string[] = [];
    const attempts: string[] = [];
    const fallback = new SlackProgressReporter("informative", async text => {
      updates.push(text);
      if (text.includes("*Робочі кроки*")) throw new Error("fixture rejection");
    }, (_error, attempt) => attempts.push(attempt));
    fallback.record(commentary("Встановлено причину. password=PRIVATE_SECRET"));
    fallback.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "PRIVATE_RAW_DELTA" } });
    fallback.record({ type: "tool_execution_end", toolName: "read", toolCallId: "r" });
    await fallback.complete();
    expect(updates).toHaveLength(2);
    expect(attempts).toEqual(["configured"]);
    expect(updates.at(-1)).toContain("Хід роботи");
    expect(updates.at(-1)).not.toMatch(/PRIVATE_SECRET|PRIVATE_RAW_DELTA|FINAL/);
  });
});
