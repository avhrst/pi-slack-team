import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleTranscript } from "../src/slack/console-transcript.js";
import { SlackConsoleReporter, SlackDeliveryQueue } from "../src/slack/console-reporter.js";
import { VisibleEventProjector } from "../src/pi/visible-events.js";

const textMessage = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
afterEach(() => vi.useRealTimers());

describe("Pi console transcript", () => {
  it("keeps commentary, tool results and the final answer in order without duplicating the final", () => {
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "message_start", message: textMessage("") });
    transcript.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking." } });
    transcript.record({ type: "message_end", message: textMessage("Checking.") });
    transcript.record({ type: "tool_execution_start", toolCallId: "one", toolName: "bash", args: { command: "git status" } });
    transcript.record({ type: "tool_execution_update", toolCallId: "one", partialResult: { content: [{ type: "text", text: "partial" }] } });
    transcript.record({ type: "tool_execution_end", toolCallId: "one", result: { content: [{ type: "text", text: "clean" }] } });
    transcript.record({ type: "message_start", message: textMessage("") });
    transcript.record({ type: "message_end", message: textMessage("All green.") });
    transcript.complete("All green.");
    const entries = transcript.render();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.text).toBe("Checking.");
    expect(entries[1]?.text).toContain("$ git status");
    expect(entries[1]?.text).toContain("clean");
    expect(entries[1]?.text).not.toContain("partial");
    expect(entries[2]?.text).toBe("All green.");
  });

  it("bounds previews, strips terminal controls, escapes Slack and never displays thinking", () => {
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } });
    transcript.record({ type: "tool_execution_start", toolCallId: "x", toolName: "read", args: { path: "/tmp/<file>" } });
    transcript.record({ type: "tool_execution_end", toolCallId: "x", isError: true, result: {
      content: [{ type: "thinking", thinking: "private" }, { type: "text", text:
        Array.from({ length: 15 }, (_, i) => `\u001b[31mline ${i} <!channel>`).join("\n") }],
    } });
    const output = transcript.render().map((entry) => entry.text).join("\n");
    expect(output).toContain("failed");
    expect(output).toContain("line 9 &lt;!channel&gt;");
    expect(output).toContain("[5 more lines hidden]");
    expect(output).not.toMatch(/private|line 10/u);
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output.length).toBeLessThanOrEqual(3_500);
  });

  it("reconciles authoritative message endings, cumulative snapshots and missing final events", () => {
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "message_update", assistantMessageEvent: { type: "text_snapshot", text: "hel" } });
    transcript.record({ type: "message_update", assistantMessageEvent: { type: "text_snapshot", text: "hello" } });
    transcript.record({ type: "message_end", message: textMessage("Hello!") });
    transcript.complete("Hello!");
    expect(transcript.render().map((entry) => entry.text)).toEqual(["Hello!"]);
    const fallback = new ConsoleTranscript();
    fallback.complete("Only final text was available.");
    expect(fallback.render()[0]?.text).toBe("Only final text was available.");
  });

  it("splits long fenced answers and preserves existing text when the turn fails", () => {
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "message_end", message: textMessage(`\`\`\`\n${"x\n\n".repeat(3_000)}\n\`\`\``) });
    transcript.fail("Request failed. Reference: test");
    const entries = transcript.render();
    expect(entries.length).toBeGreaterThan(2);
    for (const entry of entries) {
      expect(entry.text.length).toBeLessThanOrEqual(3_500);
      expect(entry.text.split("```").length % 2).toBe(1);
    }
    expect(entries.at(-1)?.text).toContain("Reference: test");
  });

  it("settles retry and compaction statuses in place", () => {
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "compaction_start" });
    transcript.record({ type: "compaction_end", aborted: false });
    transcript.record({ type: "auto_retry_start", attempt: 1 });
    transcript.record({ type: "auto_retry_end", success: false });
    transcript.complete("Recovered by the next request.");
    expect(transcript.render().map((entry) => entry.text)).toEqual([
      "Session context compacted.", "Model retry failed.", "Recovered by the next request.",
    ]);
  });
});

describe("Slack console delivery", () => {
  function setup(interval = 0) {
    const messages = new Map<string, string>();
    const delivery = {
      post: vi.fn(async (text: string) => { const ts = String(messages.size + 1); messages.set(ts, text); return ts; }),
      update: vi.fn(async (ts: string, text: string) => { messages.set(ts, text); }),
      remove: vi.fn(async (ts: string) => { messages.delete(ts); }),
    };
    const queue = new SlackDeliveryQueue(interval);
    const onError = vi.fn();
    return { messages, delivery, queue, onError, reporter: new SlackConsoleReporter(queue, delivery, onError) };
  }

  it("reuses the placeholder, streams updates and retains earlier elements after completion", async () => {
    vi.useFakeTimers();
    const { reporter, delivery, messages } = setup();
    await reporter.start(false);
    reporter.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking." } });
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.get("1")).toBe("Checking.");
    reporter.record({ type: "message_end", message: textMessage("Checking.") });
    reporter.record({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "true" } });
    reporter.record({ type: "tool_execution_end", toolCallId: "t", result: { content: [{ type: "text", text: "ok" }] } });
    reporter.record({ type: "message_end", message: textMessage("Done.") });
    await reporter.complete("Done.");
    expect([...messages.values()]).toEqual(["Checking.", expect.stringContaining("ok"), "Done."]);
    expect(delivery.post).toHaveBeenCalledTimes(3); // placeholder + tool + final
    await reporter.close();
  });

  it("coalesces snapshots while delivery is rate limited and waits the full cooldown", async () => {
    vi.useFakeTimers();
    const { reporter, delivery, messages } = setup();
    await reporter.start(false);
    delivery.update.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 30 });
    reporter.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
    await vi.advanceTimersByTimeAsync(250);
    const finished = reporter.complete("Final answer");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(delivery.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(delivery.update).toHaveBeenCalledTimes(2);
    expect(messages.get("1")).toBe("Final answer");
    await reporter.close();
  });

  it("reconciles a shorter authoritative ending without retaining extra draft chunks", async () => {
    vi.useFakeTimers();
    const { reporter, delivery, messages } = setup();
    reporter.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(5_000) } });
    await vi.advanceTimersByTimeAsync(250);
    expect(messages.size).toBe(2);
    reporter.record({ type: "message_end", message: textMessage("Short final answer.") });
    await reporter.complete("Short final answer.");
    expect([...messages.values()]).toEqual(["Short final answer."]);
    expect(delivery.remove).toHaveBeenCalledTimes(1);
    await reporter.close();
  });

  it("leaves no working placeholder or duplicate final text when delegation posts its own envelope", async () => {
    vi.useFakeTimers();
    for (const streamFirst of [false, true]) {
      const { reporter, messages } = setup();
      await reporter.start(false);
      reporter.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Delegated final" } });
      if (streamFirst) {
        await vi.advanceTimersByTimeAsync(250);
        expect([...messages.values()]).toEqual(["Delegated final"]);
      }
      await reporter.complete("Delegated final", true);
      expect(messages.size).toBe(0);
      await reporter.close();
    }
  });

  it("serializes concurrent turns through the shared queue and cancels pending retry waits", async () => {
    vi.useFakeTimers();
    const queue = new SlackDeliveryQueue(1_000);
    const signal = new AbortController();
    const times: number[] = [];
    const operation = async () => { times.push(Date.now()); };
    const first = queue.send("post", operation, signal.signal);
    const second = queue.send("post", operation, signal.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([first, second]);
    expect(times[1]! - times[0]!).toBe(1_000);
    const failing = vi.fn(async () => { throw { code: "slack_webapi_rate_limited_error", retryAfter: 30 }; });
    const cancelled = queue.send("update", failing, signal.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    signal.abort();
    expect(await cancelled).toBeInstanceOf(Error);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("keeps delivered entries when a later post fails", async () => {
    const { reporter, delivery, messages } = setup();
    reporter.record({ type: "message_end", message: textMessage("Commentary") });
    reporter.record({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "/tmp/a" } });
    delivery.post.mockImplementationOnce(async (text) => { messages.set("1", text); return "1"; })
      .mockRejectedValueOnce(new Error("Slack rejected this message"));
    await expect(reporter.complete("Final")).rejects.toThrow("Slack rejected");
    expect(messages.get("1")).toBe("Commentary");
    await reporter.close();
  });
});

describe("visible tmux events", () => {
  it("preserves the real hidden-line count even when tool transport truncates a long result", () => {
    const filter = new VisibleEventProjector();
    const transcript = new ConsoleTranscript();
    const output = Array.from({ length: 500 }, (_, i) => `${i}: ${"x".repeat(40)}`).join("\n");
    const projected = filter.project({ type: "tool_execution_end", toolCallId: "long", toolName: "read", result: { content: [{ type: "text", text: output }] } })!;
    expect(projected.outputLines).toBe(500);
    expect(JSON.stringify(projected).length).toBeLessThan(9_000);
    transcript.record(projected);
    expect(transcript.render()[0]?.text).toContain("[490 more lines hidden]");
  });

  it("exports cumulative text, never full assistant messages or thinking fields", () => {
    const filter = new VisibleEventProjector();
    filter.project({ type: "message_start", message: textMessage("") });
    expect(filter.project({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret" } })).toBeUndefined();
    const projected = filter.project({ type: "message_update", message: {
      role: "assistant", content: [{ type: "thinking", thinking: "secret", thinkingSignature: "signature" }, { type: "text", text: "visible" }],
    }, assistantMessageEvent: { type: "text_delta", delta: "visible" } });
    expect(projected?.assistantMessageEvent).toEqual({ type: "text_snapshot", text: "visible" });
    expect(JSON.stringify(projected)).not.toMatch(/secret|signature|thinking/u);
    const end = filter.project({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "final" }] } });
    expect(JSON.stringify(end)).not.toContain("secret");
  });
});
