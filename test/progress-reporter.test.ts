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
    await reporter.complete();

    expect(update).toHaveBeenCalledTimes(2);
    expect(updates[0]).toContain("detailed tool output");
    expect(updates[1]).toContain(":white_check_mark: *Pi completed*");
    expect(updates[1]).toContain(" · `read` × 1");
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
    await expect(reporter.complete()).resolves.toBeUndefined();

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
    await expect(reporter.complete()).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(2);
    expect(attempts).toEqual(["configured", "summary-fallback"]);
  });

  it("coalesces queued progress while a Slack update is in flight", async () => {
    vi.useFakeTimers();
    try {
      const updates: string[] = [];
      let releaseFirst: (() => void) | undefined;
      const firstUpdate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const update = vi.fn(async (text: string) => {
        updates.push(text);
        if (updates.length === 1) await firstUpdate;
      });
      const reporter = new SlackProgressReporter(
        "summary",
        update,
        () => undefined,
      );
      const progress = (completed: number) =>
        event("tool_execution_update", {
          partialResult: {
            content: [{
              type: "text",
              text: `PI_DEPLOY_PROGRESS ${JSON.stringify({
                version: 1,
                stage: "sql-files",
                state: "running",
                planned: 3,
                completed,
                pending: 3 - completed,
                ok: completed,
                warn: 0,
                fail: 0,
                skip: 0,
                current: `TT${completed}`,
              })}`,
            }],
          },
        });

      reporter.record(progress(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(update).toHaveBeenCalledTimes(1);
      expect(updates[0]).toContain("1/3");

      reporter.record(progress(2));
      reporter.record(progress(3));
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(update).toHaveBeenCalledTimes(2);
      expect(updates[1]).toContain("3/3");
      expect(updates[1]).not.toContain("2/3");
      await reporter.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stalled update and still sends the latest final state", async () => {
    vi.useFakeTimers();
    try {
      const attempts: ProgressUpdateAttempt[] = [];
      const updates: string[] = [];
      const stalled = new Promise<void>(() => undefined);
      const update = vi.fn(async (text: string) => {
        updates.push(text);
        if (updates.length === 1) await stalled;
      });
      const reporter = new SlackProgressReporter(
        "summary",
        update,
        (_error, attempt) => attempts.push(attempt),
        100,
      );

      reporter.record(
        event("message_update", {
          assistantMessageEvent: { type: "text_delta", delta: "Checking." },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(update).toHaveBeenCalledTimes(1);

      const completing = reporter.complete();
      await vi.advanceTimersByTimeAsync(100);
      await completing;

      expect(update).toHaveBeenCalledTimes(2);
      expect(updates[1]).toContain(":white_check_mark: *Pi completed*");
      expect(attempts).toEqual(["configured"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not degrade raw progress on a rate limit", async () => {
    const updates: string[] = [];
    let calls = 0;
    const update = vi.fn(async (text: string) => {
      updates.push(text);
      calls += 1;
      if (calls === 1) throw rateLimited();
    });
    const reporter = new SlackProgressReporter("raw", update, () => undefined);

    rawToolEvents(reporter);
    await reporter.complete();

    expect(update).toHaveBeenCalledTimes(2);
    expect(updates[1]).toContain(":white_check_mark: *Pi completed*");
    expect(updates[1]).toContain("detailed tool output");
  });

  it("retries the final update until Slack accepts it", async () => {
    const errors: ProgressUpdateAttempt[] = [];
    let calls = 0;
    const update = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw rateLimited();
    });
    const reporter = new SlackProgressReporter(
      "summary",
      update,
      (_error, attempt) => errors.push(attempt),
    );

    await reporter.complete();

    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith(
      expect.stringContaining(":white_check_mark: *Pi completed*"),
    );
    expect(errors).toEqual(["configured", "configured"]);
  });

  it("retries a delivery-failed receipt like any final state", async () => {
    let calls = 0;
    const update = vi.fn<(text: string) => Promise<void>>(async () => {
      calls += 1;
      if (calls === 1) throw rateLimited();
    });
    const reporter = new SlackProgressReporter("summary", update, () => undefined);
    reporter.record(event("tool_execution_start", { toolCallId: "c", toolName: "bash" }));
    reporter.record(event("tool_execution_end", { toolCallId: "c", toolName: "bash" }));

    await reporter.complete({ posted: 1, total: 3, correlationId: "ref-1" });

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith(
      ":warning: Pi completed, but Slack rejected part 2 of 3 · `bash` × 1\n\n_Reference: ref-1_",
    );
  });

  it("gives up on the final update after bounded transient retries", async () => {
    const update = vi.fn(async () => {
      throw rateLimited();
    });
    const reporter = new SlackProgressReporter("summary", update, () => undefined);

    await reporter.complete();

    expect(update).toHaveBeenCalledTimes(3);
  });
});

function rateLimited(): Error {
  return Object.assign(new Error("A rate limit was exceeded"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: 0,
  });
}
