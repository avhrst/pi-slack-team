import { describe, expect, it, vi } from "vitest";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import {
  addSlackThreadContext,
  type FetchSlackReplies,
} from "../src/slack/thread-context.js";

function message(overrides: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage {
  return {
    kind: "app-mention",
    eventId: "Ev01",
    teamId: "T01",
    appId: "A01",
    channelId: "C01",
    channelType: "channel",
    userId: "U01",
    ts: "103.000000",
    threadTs: "100.000000",
    text: "current request",
    files: [],
    ...overrides,
  };
}

describe("addSlackThreadContext", () => {
  it("adds the root title and complete prior thread history", async () => {
    const fetchReplies = vi.fn(async () => ({
      ok: true,
      messages: [
        { ts: "100.000000", user: "U02", text: "MSDashboard incident" },
        { ts: "101.000000", user: "U03", text: "The report is stale" },
        {
          ts: "102.000000",
          bot_id: "B01",
          username: "build-bot",
          text: "Build completed",
          files: [{ name: "report.txt", mimetype: "text/plain", size: 42 }],
        },
        { ts: "103.000000", user: "U01", text: "<@UBOT> current request" },
      ],
      response_metadata: { next_cursor: "" },
    }));

    const result = await addSlackThreadContext(
      message(),
      "current request",
      fetchReplies,
    );

    expect(fetchReplies).toHaveBeenCalledWith({
      channel: "C01",
      ts: "100.000000",
      limit: 100,
      latest: "103.000000",
      inclusive: true,
    });
    expect(result).toContain('"title": "MSDashboard incident"');
    expect(result).toContain('"author": "<@U03>"');
    expect(result).toContain('"name": "report.txt"');
    expect(result).not.toContain("<@UBOT> current request");
    expect(result).toContain("Current authorized Slack request:\ncurrent request");
  });

  it("paginates replies and marks message history as untrusted", async () => {
    const fetchReplies = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ ts: "100.000000", user: "U02", text: "Root" }],
        response_metadata: { next_cursor: "next" },
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ ts: "101.000000", user: "U03", text: "Reply" }],
        response_metadata: { next_cursor: "" },
      });

    const result = await addSlackThreadContext(message(), "request", fetchReplies);

    expect(fetchReplies).toHaveBeenCalledTimes(2);
    expect(fetchReplies).toHaveBeenLastCalledWith({
      channel: "C01",
      ts: "100.000000",
      limit: 100,
      latest: "103.000000",
      inclusive: true,
      cursor: "next",
    });
    expect(result).toContain("untrusted Slack conversation history");
    expect(result).toContain('"text": "Reply"');
  });

  it("keeps the root and most recent replies from a long thread", async () => {
    const threadMessages = [
      { ts: "100.000000", user: "U02", text: "Root" },
      ...Array.from({ length: 250 }, (_, index) => ({
        ts: `${101 + index}.000000`,
        user: "U03",
        text: `Reply-${index + 1}`,
      })),
    ];
    const fetchReplies: FetchSlackReplies = vi.fn(async (arguments_) => {
      const start = arguments_.cursor ? Number(arguments_.cursor) : 0;
      const end = Math.min(start + arguments_.limit, threadMessages.length);
      return {
        ok: true,
        messages: threadMessages.slice(start, end),
        response_metadata: {
          next_cursor: end < threadMessages.length ? String(end) : "",
        },
      };
    });

    const result = await addSlackThreadContext(
      message({ ts: "350.000000" }),
      "current request",
      fetchReplies,
    );
    const serialized = result
      .split("<slack_thread_context_json>\n", 2)[1]
      ?.split("\n</slack_thread_context_json>", 1)[0];
    const payload = JSON.parse(serialized ?? "null") as {
      messages: Array<{ text: string }>;
      truncated: boolean;
      omittedMessages: number;
    };

    expect(fetchReplies).toHaveBeenCalledTimes(3);
    expect(payload.messages).toHaveLength(200);
    expect(payload.messages[0]?.text).toBe("Root");
    expect(payload.messages[1]?.text).toBe("Reply-51");
    expect(payload.messages.at(-1)?.text).toBe("Reply-249");
    expect(payload).toMatchObject({
      truncated: true,
      omittedMessages: 50,
    });
  });

  it("fails when Slack denies thread history", async () => {
    await expect(
      addSlackThreadContext(
        message(),
        "request",
        async () => ({ ok: false, error: "missing_scope" }),
      ),
    ).rejects.toThrow("missing_scope");
  });
});
