import { describe, expect, it } from "vitest";
import { ActivityProgress, compactProgressText, publicProgressEvent, workerProgressDetails } from "../src/pi/activity-progress.js";
import { PiProgressTranscript } from "../src/slack/pi-progress.js";
import { agentConfigSchema } from "../src/config/schema.js";

const commentary = (text: string) => ({
  role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "PRIVATE_THINKING" },
    { type: "text", text },
    { type: "toolCall", name: "bash", arguments: { command: "SECRET_COMMAND" } },
  ],
});

describe("balanced activity", () => {
  it("accepts the middle mode without changing legacy defaults", () => {
    const input = { version: 1, agentId: "worker", expectedUnixUser: "worker", stateDir: "/tmp/worker", slack: { teamId: "T0", appId: "A0", allowedUserIds: ["U0"] }, pi: { cwd: "/tmp/worker", agentDir: "/tmp/worker", sessionDir: "/tmp/worker" } };
    expect(agentConfigSchema.parse({ ...input, slack: { ...input.slack, progressMode: "balanced" } }).slack.progressMode).toBe("balanced");
    expect(agentConfigSchema.parse(input).slack.progressMode).toBe("summary");
  });

  it("extracts only public commentary accompanying tools, never final text or reasoning", () => {
    expect(publicProgressEvent(commentary("Перевіряю, чому перевірка не проходить."))).toEqual({ type: "agent_progress", text: "Перевіряю, чому перевірка не проходить." });
    expect(publicProgressEvent({ role: "assistant", content: [{ type: "text", text: "FINAL_ANSWER" }], stopReason: "stop" })).toBeUndefined();
    expect(publicProgressEvent({ ...commentary("failure details"), stopReason: "error" })).toBeUndefined();
    expect(publicProgressEvent({ ...commentary("tool output"), role: "toolResult" })).toBeUndefined();
    expect(publicProgressEvent({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "toolCall" }] })).toBeUndefined();
  });

  it("shows meaningful milestones and current activity without technical payloads", () => {
    const progress = new PiProgressTranscript("balanced");
    progress.record({ type: "message_end", message: commentary("Знайшов розбіжність у налаштуваннях. Перевіряю, які запити вона зачіпає.") });
    progress.record({ type: "tool_execution_start", toolName: "bash", toolCallId: "uuid-secret", args: { command: "SECRET_COMMAND" } });
    progress.record({ type: "tool_execution_update", toolName: "bash", partialResult: { content: [{ type: "text", text: "SECRET_TOOL_TRACE" }] } });
    progress.record({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_THINKING" } });
    progress.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "FINAL_ANSWER" } });
    const text = progress.render("working");
    expect(text).toContain("Знайшов розбіжність");
    expect(text).toContain("*Зараз:* Виконую робочий крок");
    for (const hidden of ["SECRET", "PRIVATE", "FINAL_ANSWER", "uuid-secret", "bash", "*Tools:*"]) expect(text).not.toContain(hidden);
    expect(progress.render("completed", "FINAL_ANSWER")).not.toContain("FINAL_ANSWER");
  });

  it("deduplicates updates and retains only the last three milestones", () => {
    const progress = new ActivityProgress();
    for (let i = 0; i < 10; i++) progress.record({ type: "agent_progress", text: `Крок ${i}` });
    expect(progress.snapshot().notes).toEqual(["Крок 7", "Крок 8", "Крок 9"]);
    expect(progress.record({ type: "agent_progress", text: "Крок 9" })).toBe(false);
    expect(progress.record({ type: "tool_execution_start", toolName: "read", toolCallId: "one" })).toBe(true);
    expect(progress.record({ type: "tool_execution_start", toolName: "read", toolCallId: "two" })).toBe(false);
    expect(progress.record({ type: "tool_execution_update", toolName: "read", partialResult: { content: [{ type: "text", text: "arbitrary trace" }] } })).toBe(false);
  });

  it("shows independent worker notes but never exposes their full tool results", () => {
    const progress = new PiProgressTranscript("balanced");
    for (const worker of ["support", "msboard"]) {
      progress.record({ type: "tool_execution_start", toolName: "delegate_to_worker", toolCallId: worker, args: { workerId: worker, task: "PRIVATE_TASK" } });
      progress.record({ type: "tool_execution_update", toolName: "delegate_to_worker", toolCallId: worker,
        partialResult: { content: [{ type: "text", text: "RAW_TRACE" }], details: workerProgressDetails(worker, "Перевіряю причину збою, змін поки не вносив.") } });
    }
    const working = progress.render("working");
    expect(working).toContain("*support:* Перевіряю причину");
    expect(working).toContain("*msboard:* Перевіряю причину");
    expect(working).not.toMatch(/PRIVATE_TASK|RAW_TRACE|delegate_to_worker/);
    progress.record({ type: "tool_execution_end", toolName: "delegate_to_worker", toolCallId: "support", result: { content: [{ type: "text", text: "LONG_FINAL_RESULT" }], details: workerProgressDetails("support", "Результат отримано") } });
    expect(progress.render("working")).toContain("*support:* Результат отримано");
    expect(progress.render("working")).not.toContain("LONG_FINAL_RESULT");
  });

  it("does not accept progress-like payloads from arbitrary tools", () => {
    const progress = new PiProgressTranscript("balanced");
    progress.record({ type: "tool_execution_update", toolName: "bash", partialResult: { details: workerProgressDetails("support", "FAKE_NOTE_FROM_OUTPUT") } });
    progress.record({ type: "tool_execution_update", toolName: "delegate_to_worker", partialResult: { details: { progress: { version: 1, workerId: "<!channel>", text: "BAD_ID" } } } });
    expect(progress.render("working")).not.toMatch(/FAKE_NOTE_FROM_OUTPUT|BAD_ID/);
  });

  it("shows waiting, resumed and failed steps without claiming the whole task failed", () => {
    const progress = new PiProgressTranscript("balanced");
    progress.record({ type: "tool_execution_start", toolName: "write", toolCallId: "edit" });
    progress.record({ type: "agent_waiting" });
    expect(progress.render("working")).toContain("Очікую на вашу відповідь");
    progress.record({ type: "agent_resumed" });
    expect(progress.render("working")).toContain("Вношу зміни до файлів");
    progress.record({ type: "tool_execution_end", toolName: "write", toolCallId: "edit", isError: true, result: { content: [{ type: "text", text: "SECRET_STACK" }] } });
    expect(progress.render("working")).toContain("Невдалих робочих кроків: 1");
    expect(progress.render("working")).toContain("не обов’язково означає невдачу");
    expect(progress.render("failed", "request-123")).toContain("Код звернення: request-123");
    expect(progress.render("failed", "request-123")).not.toContain("SECRET_STACK");
  });

  it("bounds text, hides code blocks/tokens, and escapes Slack broadcast markup", () => {
    const token = ["xoxb", "abcdefghijk123456789"].join("-");
    expect(compactProgressText(`Перевірка\n\`\`\`sql\nselect secret\n\`\`\` ${token}`)).not.toMatch(/select secret|abcdefghijk123456789/);
    const progress = new PiProgressTranscript("balanced");
    for (let i = 0; i < 30; i++) progress.record({ type: "agent_progress", text: `Крок ${i} <!channel> ${"дуже довгий опис ".repeat(500)}` });
    const text = progress.render("working");
    expect(text.length).toBeLessThanOrEqual(3_500);
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });

  it("keeps validated deployment counts without surrounding command output", () => {
    const progress = new PiProgressTranscript("balanced");
    const marker = { version: 1, stage: "apex", state: "running", planned: 5, completed: 2, pending: 3, ok: 2, warn: 0, fail: 0, skip: 0, current: "TT3" };
    progress.record({ type: "tool_execution_update", toolName: "bash", partialResult: { content: [{ type: "text", text: `SECRET_OUTPUT\nPI_DEPLOY_PROGRESS ${JSON.stringify(marker)}` }] } });
    expect(progress.render("working")).toContain("*APEX:* 2/5");
    expect(progress.render("working")).not.toContain("SECRET_OUTPUT");
  });
});
