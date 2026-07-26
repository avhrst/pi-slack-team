import { describe, expect, it, vi } from "vitest";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import { addSlackThreadContext } from "../src/slack/thread-context.js";

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
      cursor: "next",
    });
    expect(result).toContain("untrusted Slack conversation history");
    expect(result).toContain('"text": "Reply"');
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
