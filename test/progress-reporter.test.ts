import { describe, expect, it, vi } from "vitest";
import type { RpcRecord } from "../src/pi/rpc-client.js";
import {
  SlackProgressReporter,
  type ProgressUpdateAttempt,
} from "../src/slack/progress-reporter.js";

function event(type: string, fields: Record<string, unknown> = {}): RpcRecord {
  return { type, ...fields };
}

function rawToolEvents(reporter: SlackProgressReporter): void {
  reporter.record(
    event("tool_execution_start", {
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "/srv/app/large-output.txt" },
    }),
  );
  reporter.record(
    event("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "detailed tool output" }],
      },
      isError: false,
    }),
  );
}

describe("SlackProgressReporter", () => {
  it("retries a rejected raw update with a compact summary", async () => {
    const updates: string[] = [];
    const errors: ProgressUpdateAttempt[] = [];
    const update = vi.fn(async (text: string) => {
      updates.push(text);
      if (text.includes("*Output*")) {
        throw new Error("Slack rejected detailed payload");
      }
    });
    const reporter = new SlackProgressReporter(
      "raw",
      update,
      (_error, attempt) => errors.push(attempt),
    );

    rawToolEvents(reporter);
    await reporter.complete("Completed result");

    expect(update).toHaveBeenCalledTimes(2);
    expect(updates[0]).toContain("detailed tool output");
    expect(updates[1]).toContain(":white_check_mark: *Pi completed*");
    expect(updates[1]).toContain("*Tools:* `read` × 1");
    expect(updates[1]).not.toContain("detailed tool output");
    expect(errors).toEqual(["configured"]);
  });

  it("uses only summary updates after a live raw fallback", async () => {
    vi.useFakeTimers();
    try {
      const updates: string[] = [];
      const update = vi.fn(async (text: string) => {
        updates.push(text);
        if (text.includes("*Output*")) {
          throw new Error("Slack rejected detailed payload");
        }
      });
      const reporter = new SlackProgressReporter("raw", update, () => undefined);

      rawToolEvents(reporter);
      await vi.runOnlyPendingTimersAsync();
      expect(update).toHaveBeenCalledTimes(2);

      reporter.record(
        event("tool_execution_start", {
          toolCallId: "call-2",
          toolName: "bash",
          args: { command: "sensitive detailed command" },
        }),
      );
      await vi.advanceTimersByTimeAsync(1_000);

      expect(update).toHaveBeenCalledTimes(3);
      expect(updates.at(-1)).toContain("`bash` × 1");
      expect(updates.at(-1)).not.toContain("sensitive detailed command");
      await reporter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a rejected summary update indefinitely", async () => {
    const attempts: ProgressUpdateAttempt[] = [];
    const update = vi.fn(async () => {
      throw new Error("Slack unavailable");
    });
    const reporter = new SlackProgressReporter(
      "summary",
      update,
      (_error, attempt) => attempts.push(attempt),
    );

    reporter.record(
      event("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: "Checking." },
      }),
    );
    await expect(reporter.complete("Done")).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual(["configured"]);
  });

  it("reports both failures when Slack rejects raw and fallback updates", async () => {
    const attempts: ProgressUpdateAttempt[] = [];
    const update = vi.fn(async () => {
      throw new Error("Slack unavailable");
    });
    const reporter = new SlackProgressReporter(
      "raw",
      update,
      (_error, attempt) => attempts.push(attempt),
    );

    rawToolEvents(reporter);
    await expect(reporter.complete("Done")).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["configured", "summary-fallback"]);
  });
});
