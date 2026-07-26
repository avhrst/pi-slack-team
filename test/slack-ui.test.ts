import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import type { ConversationRecord } from "../src/storage/registry.js";
import { SlackUiBroker } from "../src/slack/slack-ui.js";

const conversation: ConversationRecord = {
  teamId: "T01",
  appId: "A01",
  channelId: "D01",
  threadTs: "123.456",
  ownerUserId: "U01",
  piSessionFile: "/tmp/session.jsonl",
  piSessionId: "session-01",
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: "2026-01-01T00:00:00.000Z",
};

function message(text: string, userId = "U01"): IncomingSlackMessage {
  return {
    kind: "direct-message",
    eventId: crypto.randomUUID(),
    teamId: conversation.teamId,
    appId: conversation.appId,
    channelId: conversation.channelId,
    channelType: "im",
    userId,
    ts: crypto.randomUUID(),
    threadTs: conversation.threadTs,
    text,
    files: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SlackUiBroker", () => {
  it("renders a select request and resolves an owner numeric choice", async () => {
    const broker = new SlackUiBroker();
    const post = vi.fn(async () => undefined);
    const pending = broker.request(
      {
        conversation,
        request: {
          type: "extension_ui_request",
          id: "dialog-1",
          method: "select",
          title: "Choose",
          options: ["Check only", "Import"],
          timeout: 300_000,
        },
      },
      post,
    );

    expect(post).toHaveBeenCalledWith(expect.stringContaining("2. Import"));
    expect(broker.consume(message("2"))).toMatchObject({
      handled: true,
      acknowledgement: expect.stringContaining("Import"),
    });
    await expect(pending).resolves.toEqual({ value: "Import" });
  });

  it("does not accept a choice from another Slack user", async () => {
    const broker = new SlackUiBroker();
    const pending = broker.request(
      {
        conversation,
        request: {
          type: "extension_ui_request",
          id: "dialog-2",
          method: "select",
          title: "Choose",
          options: ["Check only", "Import"],
        },
      },
      async () => undefined,
    );

    expect(broker.consume(message("2", "U02"))).toEqual({ handled: false });
    broker.cancelAll();
    await expect(pending).resolves.toEqual({ cancelled: true });
  });

  it("keeps an invalid choice pending and supports explicit cancellation", async () => {
    const broker = new SlackUiBroker();
    const pending = broker.request(
      {
        conversation,
        request: {
          type: "extension_ui_request",
          id: "dialog-3",
          method: "select",
          title: "Choose",
          options: ["Check only", "Import"],
        },
      },
      async () => undefined,
    );

    expect(broker.consume(message("9"))).toMatchObject({
      handled: true,
      acknowledgement: expect.stringContaining("Invalid choice"),
    });
    expect(broker.consume(message("cancel"))).toMatchObject({ handled: true });
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});
