import { describe, expect, it } from "vitest";
import { ActivityProgress, compactProgressText, publicProgressEvent, workerProgressDetails } from "../src/pi/activity-progress.js";

const commentary = (text: string) => ({
  role: "assistant", stopReason: "toolUse", content: [
    { type: "thinking", thinking: "PRIVATE_THINKING" },
    { type: "text", text },
    { type: "toolCall", name: "bash", arguments: { command: "SECRET_COMMAND" } },
  ],
});

describe("public activity", () => {
  it("extracts only public commentary accompanying tools, never final text or reasoning", () => {
    expect(publicProgressEvent(commentary("Перевіряю, чому перевірка не проходить."))).toEqual({ type: "agent_progress", text: "Перевіряю, чому перевірка не проходить." });
    expect(publicProgressEvent({ role: "assistant", content: [{ type: "text", text: "FINAL_ANSWER" }], stopReason: "stop" })).toBeUndefined();
    expect(publicProgressEvent({ ...commentary("failure details"), stopReason: "error" })).toBeUndefined();
    expect(publicProgressEvent({ ...commentary("tool output"), role: "toolResult" })).toBeUndefined();
    expect(publicProgressEvent({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "toolCall" }] })).toBeUndefined();
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

  it("keeps per-worker notes without exposing the delegated task or result", () => {
    const progress = new ActivityProgress();
    for (const worker of ["support", "msboard"]) {
      progress.record({ type: "tool_execution_start", toolName: "delegate_to_worker", toolCallId: worker,
        args: { workerId: worker, task: "PRIVATE_TASK" } });
      progress.record({ type: "tool_execution_update", toolName: "delegate_to_worker", toolCallId: worker,
        partialResult: { content: [{ type: "text", text: "RAW_TRACE" }],
          details: workerProgressDetails(worker, "Перевіряю причину збою.") } });
    }
    expect(progress.snapshot().workers).toEqual([
      { id: "support", text: "Перевіряю причину збою." },
      { id: "msboard", text: "Перевіряю причину збою." },
    ]);
    progress.record({ type: "tool_execution_end", toolName: "delegate_to_worker", toolCallId: "support",
      result: { content: [{ type: "text", text: "LONG_FINAL_RESULT" }],
        details: workerProgressDetails("support", "Результат отримано") } });
    expect(progress.snapshot().workers).toContainEqual({ id: "support", text: "Результат отримано" });
    expect(JSON.stringify(progress.snapshot())).not.toMatch(/PRIVATE_TASK|RAW_TRACE|LONG_FINAL_RESULT/u);
  });

  it("ignores worker-like progress from arbitrary tools and invalid worker IDs", () => {
    const progress = new ActivityProgress();
    progress.record({ type: "tool_execution_update", toolName: "bash",
      partialResult: { details: workerProgressDetails("support", "FAKE_NOTE_FROM_OUTPUT") } });
    progress.record({ type: "tool_execution_update", toolName: "delegate_to_worker",
      partialResult: { details: { progress: { version: 1, workerId: "<!channel>", text: "BAD_ID" } } } });
    expect(progress.snapshot().workers).toEqual([]);
  });

  it("reports waiting, resumed and failed steps", () => {
    const progress = new ActivityProgress();
    progress.record({ type: "tool_execution_start", toolName: "write", toolCallId: "edit" });
    progress.record({ type: "agent_waiting" });
    expect(progress.snapshot().current).toBe("Очікую на вашу відповідь у Slack");
    progress.record({ type: "agent_resumed" });
    expect(progress.snapshot().current).toBe("Вношу зміни до файлів");
    progress.record({ type: "tool_execution_end", toolName: "write", toolCallId: "edit", isError: true,
      result: { content: [{ type: "text", text: "SECRET_STACK" }] } });
    expect(progress.snapshot().failures).toBe(1);
    expect(JSON.stringify(progress.snapshot())).not.toContain("SECRET_STACK");
  });

  it("bounds public notes and redacts code blocks and tokens", () => {
    const token = ["xoxb", "abcdefghijk123456789"].join("-");
    const text = compactProgressText(`Перевірка\`\`\`sql
select secret
\`\`\` ${token} ${"довгий опис ".repeat(50)}`);
    expect(text).not.toMatch(/select secret|abcdefghijk123456789/u);
    expect(text.length).toBeLessThanOrEqual(450);
  });
});
