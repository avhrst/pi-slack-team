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
        signal: new AbortController().signal,
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
        signal: new AbortController().signal,
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
        signal: new AbortController().signal,
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

  it("claims a UI event before applying it and ignores duplicate delivery", async () => {
    const broker = new SlackUiBroker();
    const pending = broker.request(
      {
        conversation,
        request: {
          type: "extension_ui_request",
          id: "dialog-4",
          method: "select",
          title: "Choose",
          options: ["Check only", "Import"],
        },
        signal: new AbortController().signal,
      },
      async () => undefined,
    );

    expect(broker.consume(message("2"), () => false)).toEqual({
      handled: true,
    });
    expect(broker.consume(message("1"), () => true)).toMatchObject({
      handled: true,
      acknowledgement: expect.stringContaining("Check only"),
    });
    await expect(pending).resolves.toEqual({ value: "Check only" });
  });

  it("cancels and removes a pending dialog when its Pi client stops", async () => {
    const broker = new SlackUiBroker();
    const controller = new AbortController();
    const pending = broker.request(
      {
        conversation,
        request: {
          type: "extension_ui_request",
          id: "dialog-5",
          method: "confirm",
          title: "Continue?",
          message: "Run the operation",
        },
        signal: controller.signal,
      },
      async () => undefined,
    );

    controller.abort();

    await expect(pending).resolves.toEqual({ cancelled: true });
    expect(broker.consume(message("yes"))).toEqual({ handled: false });
  });

  it("requires an explicit agent mention for channel replies", async () => {
    const broker = new SlackUiBroker();
    const post = vi.fn(async () => undefined);
    const pending = broker.request(
      {
        conversation: {
          ...conversation,
          channelId: "C01",
        },
        request: {
          type: "extension_ui_request",
          id: "dialog-6",
          method: "confirm",
          title: "Continue?",
          message: "Run the operation",
        },
        signal: new AbortController().signal,
      },
      post,
    );

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining(
        "Channel replies must explicitly @mention this agent",
      ),
    );
    broker.cancelAll();
    await expect(pending).resolves.toEqual({ cancelled: true });
  });
});
