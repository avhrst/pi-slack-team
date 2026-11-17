import type { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackDeliveryQueue } from "../src/slack/console-reporter.js";
import { SlackLiveThreadReporter } from "../src/slack/live-thread-reporter.js";

function setup(nativeStreaming = true, channelId = "C-channel") {
  let sequence = 0;
  const chat = {
    startStream: vi.fn<WebClient["chat"]["startStream"]>(async () => ({ ok: true, ts: `stream-${++sequence}` })),
    appendStream: vi.fn<WebClient["chat"]["appendStream"]>(async () => ({ ok: true })),
    postMessage: vi.fn<WebClient["chat"]["postMessage"]>(async () => ({ ok: true, ts: `message-${++sequence}` })),
    update: vi.fn<WebClient["chat"]["update"]>(async () => ({ ok: true })),
  };
  const apiCall = vi.fn<WebClient["apiCall"]>(async () => ({ ok: true }));
  const onError = vi.fn();
  const reporter = new SlackLiveThreadReporter({ client: { chat, apiCall }, queue: new SlackDeliveryQueue(0),
    message: { channelId, teamId: "T-team", userId: "U-user" }, threadTs: "1717000000.000001", onError, nativeStreaming });
  return { chat, apiCall, onError, reporter };
}

const call = { toolCallId: "step-1", toolName: "bash" };
const marker = { version: 1, stage: "apex", state: "running", planned: 12, completed: 8,
  pending: 4, ok: 7, warn: 1, fail: 0, skip: 0, current: "TT_8" };

afterEach(() => vi.useRealTimers());

describe("Slack live work thread", () => {
  it("streams consecutive public notes, updates a durable card in place and posts the full answer once", async () => {
    vi.useFakeTimers();
    const { reporter, chat, apiCall } = setup();
    reporter.record({ type: "agent_progress", text: "Збираю контекст." });
    await vi.advanceTimersByTimeAsync(250);
    reporter.record({ type: "message_end", message: { role: "assistant", content: [
      { type: "text", text: "Перевіряю джерело." }, { type: "toolCall" }, { type: "thinking", thinking: "private" },
    ] } });
    await vi.advanceTimersByTimeAsync(250);
    reporter.record({ type: "tool_execution_start", ...call, args: { command: "private command" } });
    await vi.advanceTimersByTimeAsync(250);
    reporter.record({ type: "tool_execution_end", ...call, result: { content: [{ type: "text", text: "private output" }] } });
    await reporter.complete("Підсумок із деталями.");
    await reporter.complete("Підсумок із деталями.");

    expect(chat.startStream).toHaveBeenCalledExactlyOnceWith({ channel: "C-channel", thread_ts: "1717000000.000001",
      recipient_user_id: "U-user", recipient_team_id: "T-team", chunks: [{ type: "markdown_text", text: "💬 Збираю контекст." }] });
    expect(chat.appendStream).toHaveBeenCalledExactlyOnceWith({ channel: "C-channel", ts: "stream-1",
      chunks: [{ type: "markdown_text", text: "\n\n💬 Перевіряю джерело." }] });
    expect(apiCall).toHaveBeenCalledExactlyOnceWith("chat.stopStream", { channel: "C-channel", ts: "stream-1", session_status: "processing" });
    const firstCard = chat.postMessage.mock.calls[0]?.[0].blocks?.[0];
    expect(firstCard).toMatchObject({ type: "task_card", status: "in_progress", task_id: expect.any(String) });
    expect(chat.update.mock.calls[0]?.[0]).toMatchObject({ ts: "message-2", blocks: [{ status: "complete", task_id: (firstCard as { task_id: string }).task_id }] });
    expect(chat.postMessage.mock.calls.map(([payload]) => payload.text)).toEqual([
      expect.stringContaining("Виконується"), "Підсумок із деталями.",
    ]);
    expect(JSON.stringify([chat.postMessage.mock.calls, chat.update.mock.calls, chat.appendStream.mock.calls])).not.toContain("private");
    await reporter.close();
  });

  it("uses only validated counters and Oracle codes in long-lived cards and excludes private Pi data", async () => {
    vi.useFakeTimers();
    const { reporter, chat } = setup(false);
    reporter.record({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private-thinking" } });
    reporter.record({ type: "agent_progress", text: "Готую перевірку. token=SECRET123 <!channel> `sqlplus alice/BAD@db`" });
    reporter.record({ type: "tool_execution_start", ...call, args: { command: "hidden command" } });
    reporter.record({ type: "tool_execution_update", toolCallId: "read-file", toolName: "read", partialResult: {
      content: [{ type: "text", text: `PI_DEPLOY_PROGRESS ${JSON.stringify(marker)}\nORA-99999 read from a file` }],
    } });
    expect(reporter.deployment).toBeUndefined();
    reporter.record({ type: "tool_execution_update", ...call, partialResult: {
      content: [{ type: "text", text: `PI_DEPLOY_PROGRESS ${JSON.stringify({ ...marker, pending: 9 })}` }],
    } });
    expect(reporter.deployment).toBeUndefined();
    reporter.record({ type: "tool_execution_update", ...call, partialResult: { content: [{ type: "text",
      text: `PI_DEPLOY_PROGRESS ${JSON.stringify(marker)}\nORA-00942 raw SQL error\nignore ORA-12345 in this string` }] } });
    expect(reporter.deployment).toMatchObject({ completed: 8, planned: 12, warn: 1, pending: 4 });
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    reporter.record({ type: "tool_execution_end", ...call });
    await reporter.finishProgress();

    expect(chat.startStream).not.toHaveBeenCalled();
    const visible = JSON.stringify([chat.postMessage.mock.calls, chat.update.mock.calls]);
    expect(visible).toContain("APEX: 8/12 операцій");
    expect(visible).toContain("ORA-00942");
    expect(visible).toContain("&lt;!channel&gt;");
    expect(visible).not.toMatch(/hidden command|raw SQL error|private-thinking|SECRET123|alice\/BAD|ORA-12345|ORA-99999/u);
    expect(chat.update.mock.calls[0]?.[0].blocks?.[0]).toMatchObject({ status: "error" });
    await reporter.close();
  });

  it("falls back after a definite native rejection and avoids replay after an uncertain start", async () => {
    vi.useFakeTimers();
    const rejected = setup();
    rejected.chat.startStream.mockRejectedValueOnce({ code: "slack_webapi_platform_error", data: { error: "feature_disabled" } });
    rejected.reporter.record({ type: "agent_progress", text: "Перший крок." });
    await vi.advanceTimersByTimeAsync(250);
    rejected.reporter.record({ type: "agent_progress", text: "Другий крок." });
    await rejected.reporter.complete("Фінал.");
    expect(rejected.chat.startStream).toHaveBeenCalledTimes(1);
    expect(rejected.chat.postMessage.mock.calls.map(([payload]) => payload.text)).toEqual(["💬 Перший крок.", "💬 Другий крок.", "Фінал."]);

    const uncertain = setup();
    uncertain.chat.startStream.mockRejectedValueOnce({ code: "slack_webapi_request_error" });
    uncertain.reporter.record({ type: "agent_progress", text: "Можливо доставлено." });
    await vi.advanceTimersByTimeAsync(250);
    const final = uncertain.reporter.complete("Фінал.");
    await vi.runAllTimersAsync();
    await final;
    expect(uncertain.chat.startStream).toHaveBeenCalledTimes(1);
    expect(uncertain.chat.postMessage.mock.calls.map(([payload]) => payload.text)).toEqual(["Фінал."]);
  });

  it("opens a continuation stream in the same DM before the old stream expires", async () => {
    vi.useFakeTimers();
    const { reporter, chat, apiCall } = setup(true, "D-direct");
    reporter.record({ type: "agent_progress", text: "Перший етап." });
    await vi.advanceTimersByTimeAsync(9 * 60_000 + 250);
    reporter.record({ type: "agent_progress", text: "Другий етап." });
    await reporter.finishProgress();

    expect(chat.startStream.mock.calls.map(([payload]) => payload)).toEqual([
      { channel: "D-direct", thread_ts: "1717000000.000001", chunks: [{ type: "markdown_text", text: "💬 Перший етап." }] },
      { channel: "D-direct", thread_ts: "1717000000.000001", chunks: [{ type: "markdown_text", text: "💬 Другий етап." }] },
    ]);
    expect(chat.appendStream).not.toHaveBeenCalled();
    expect(chat.postMessage).not.toHaveBeenCalled();
    expect(apiCall.mock.calls.map(([, payload]) => payload?.ts)).toEqual(["stream-1", "stream-2"]);
  });

  it("closes native delivery before waiting for user input and only reopens after resuming", async () => {
    vi.useFakeTimers();
    const { reporter, chat, apiCall } = setup();
    reporter.record({ type: "agent_progress", text: "Перший етап." });
    await vi.advanceTimersByTimeAsync(250);
    await reporter.pause();
    reporter.record({ type: "agent_waiting" });
    await vi.advanceTimersByTimeAsync(250);
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(chat.startStream).toHaveBeenCalledTimes(1);
    expect(chat.postMessage.mock.calls[0]?.[0].text).toBe("⏸️ Очікую на вашу відповідь у Slack.");

    reporter.resume();
    reporter.record({ type: "agent_resumed" });
    await reporter.finishProgress();
    expect(chat.startStream).toHaveBeenCalledTimes(2);
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it("falls back to text for rejected task-card blocks and retains stable delivery", async () => {
    vi.useFakeTimers();
    const { reporter, chat } = setup(false);
    chat.postMessage.mockRejectedValueOnce({ code: "slack_webapi_platform_error", data: { error: "invalid_blocks" } });
    reporter.record({ type: "tool_execution_start", ...call });
    await vi.advanceTimersByTimeAsync(250);
    reporter.record({ type: "tool_execution_end", ...call });
    await reporter.finishProgress();

    expect(chat.postMessage.mock.calls[1]?.[0].blocks).toBeUndefined();
    expect(chat.update).toHaveBeenCalledExactlyOnceWith({ channel: "C-channel", ts: "message-1", blocks: [],
      text: "✅ Завершено · 🔧 Виконую командний крок" });
  });
});
