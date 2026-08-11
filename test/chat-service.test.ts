import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import { createLogger } from "../src/observability/logger.js";
import {
  ChatService,
  type PiPromptRunner,
} from "../src/routing/chat-service.js";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import { Registry } from "../src/storage/registry.js";

const temporaryDirectories: string[] = [];

function setup(
  fileUploads = false,
  role: "worker" | "manager" = "worker",
  interAgent = false,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-team-chat-"));
  temporaryDirectories.push(directory);
  const config = agentConfigSchema.parse({
    version: 1,
    agentId: "support",
    role,
    expectedUnixUser: "support-agent",
    stateDir: directory,
    slack: {
      teamId: "T01",
      appId: "A01",
      allowedUserIds: ["U01", "U02"],
      fileUploads,
    },
    ...(interAgent
      ? {
          interAgent: {
            peers: [
              {
                agentId: role === "worker" ? "coordinator" : "specialist",
                role: role === "worker" ? "manager" : "worker",
                appId: "A02",
                botUserId: role === "worker" ? "UMANAGER" : "UWORKER",
              },
            ],
          },
        }
      : {}),
    pi: {
      cwd: directory,
      agentDir: directory,
      sessionDir: path.join(directory, "sessions"),
    },
  });
  const registry = new Registry(path.join(directory, "state.sqlite"));
  const prompt = vi.fn(async () => ({
    text: "done",
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
  }));
  const runner: PiPromptRunner = { prompt };
  const logger = createLogger(() => undefined);
  return {
    registry,
    prompt,
    service: new ChatService(config, registry, runner, logger),
  };
}

function message(
  overrides: Partial<IncomingSlackMessage> = {},
): IncomingSlackMessage {
  return {
    kind: "direct-message",
    eventId: "Ev01",
    teamId: "T01",
    appId: "A01",
    channelId: "D01",
    channelType: "im",
    userId: "U01",
    ts: "123.456",
    text: "hello",
    files: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChatService", () => {
  it("runs one prompt and deduplicates a retried Slack event", async () => {
    const { service, prompt, registry } = setup();
    await expect(service.handleMessage(message())).resolves.toMatchObject({
      type: "completed",
    });
    await expect(service.handleMessage(message())).resolves.toEqual({
      type: "duplicate",
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    registry.close();
  });

  it("deduplicates a normal retry after a UI reply claimed the event", async () => {
    const { service, prompt, registry } = setup();

    expect(service.claimEvent("Ev01")).toBe(true);
    await expect(service.handleMessage(message())).resolves.toEqual({
      type: "duplicate",
    });

    expect(prompt).not.toHaveBeenCalled();
    registry.close();
  });

  it("fails closed for wrong users, apps, and unmentioned channels", async () => {
    const { service, prompt, registry } = setup();
    await expect(
      service.handleMessage(message({ userId: "U99" })),
    ).resolves.toMatchObject({ type: "ignored", reason: "unauthorized-user" });
    await expect(
      service.handleMessage(message({ eventId: "Ev02", appId: "A99" })),
    ).resolves.toMatchObject({ type: "ignored", reason: "wrong-app" });
    await expect(
      service.handleMessage(
        message({
          kind: "channel-message",
          eventId: "Ev03",
          channelId: "C01",
          channelType: "channel",
        }),
      ),
    ).resolves.toMatchObject({
      type: "ignored",
      reason: "unsupported-conversation",
    });
    expect(prompt).not.toHaveBeenCalled();
    registry.close();
  });

  it("lets a manager evaluate authorized ambient channel messages", async () => {
    const { service, prompt, registry } = setup(false, "manager");
    await expect(
      service.handleMessage(
        message({
          kind: "channel-message",
          channelId: "C01",
          channelType: "channel",
          text: "this regression needs a ticket",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "U01",
      "this regression needs a ticket",
      undefined,
      true,
    );
    registry.close();
  });

  it("keeps ambient manager observations authorized and human-only", async () => {
    const { service, prompt, registry } = setup(false, "manager");
    const ambient = {
      kind: "channel-message" as const,
      channelId: "C01",
      channelType: "channel",
    };
    await expect(
      service.handleMessage(
        message({ ...ambient, userId: "U99" }),
      ),
    ).resolves.toMatchObject({ type: "ignored", reason: "unauthorized-user" });
    await expect(
      service.handleMessage(
        message({ ...ambient, eventId: "Ev02", botId: "B01" }),
      ),
    ).resolves.toMatchObject({ type: "ignored", reason: "bot-message" });
    expect(prompt).not.toHaveBeenCalled();
    registry.close();
  });

  it("accepts only a correlated app mention from a configured manager bot", async () => {
    const { service, prompt, registry } = setup(false, "worker", true);
    const delegated = message({
      kind: "app-mention",
      channelId: "C01",
      channelType: "channel",
      userId: "UMANAGER",
      text:
        "[pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nImplement the task",
      subtype: "bot_message",
      botId: "BMANAGER",
      senderAppId: "A02",
    });

    await expect(service.handleMessage(delegated)).resolves.toMatchObject({
      type: "completed",
    });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "UMANAGER",
      delegated.text,
      undefined,
      true,
    );

    await expect(
      service.handleMessage({
        ...delegated,
        eventId: "Ev02",
        senderAppId: "A99",
      }),
    ).resolves.toMatchObject({ type: "ignored", reason: "bot-message" });
    registry.close();
  });

  it("lets an authorized human claim an idle manager-created worker thread", async () => {
    const { service, prompt, registry } = setup(false, "worker", true);
    const key = {
      teamId: "T01",
      appId: "A01",
      channelId: "C01",
      threadTs: "123.456",
    };
    registry.createConversation(key, "UMANAGER");
    registry.setSession(key, "/tmp/session.jsonl", "session-01");

    await expect(
      service.handleMessage(
        message({
          kind: "app-mention",
          eventId: "Ev02",
          channelId: "C01",
          channelType: "channel",
          userId: "U01",
          threadTs: "123.456",
          ts: "124.000",
          text: "continue directly",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(registry.getConversation(key)?.ownerUserId).toBe("U01");
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "U01",
      "continue directly",
      undefined,
      true,
    );

    const delegated = message({
      kind: "app-mention",
      eventId: "Ev03",
      channelId: "C01",
      channelType: "channel",
      userId: "UMANAGER",
      threadTs: "123.456",
      ts: "125.000",
      text:
        "[pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nContinue through manager",
      subtype: "bot_message",
      botId: "BMANAGER",
      senderAppId: "A02",
    });
    await expect(service.handleMessage(delegated)).resolves.toMatchObject({
      type: "completed",
    });
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "U01",
      delegated.text,
      undefined,
      true,
    );

    await expect(
      service.handleMessage(
        message({
          kind: "app-mention",
          eventId: "Ev04",
          channelId: "C01",
          channelType: "channel",
          userId: "U02",
          threadTs: "123.456",
          ts: "126.000",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "U01",
      "hello",
      undefined,
      true,
    );
    expect(registry.getConversation(key)?.ownerUserId).toBe("U01");
    registry.close();
  });

  it("allows authorized participants to continue a manager channel thread", async () => {
    const { service, prompt, registry } = setup(false, "manager");
    registry.createConversation(
      {
        teamId: "T01",
        appId: "A01",
        channelId: "C01",
        threadTs: "123.456",
      },
      "U01",
    );

    await expect(
      service.handleMessage(
        message({
          kind: "channel-message",
          eventId: "Ev02",
          channelId: "C01",
          channelType: "channel",
          userId: "U02",
          threadTs: "123.456",
          ts: "124.000",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "U01",
      "hello",
      undefined,
      true,
    );
    registry.close();
  });

  it("observes file metadata without enabling manager file downloads", async () => {
    const { service, prompt, registry } = setup(false, "manager");
    const attachment = {
      id: "F01",
      name: "bug.txt",
      size: 12,
      urlPrivateDownload: "https://files.slack.com/files-pri/bug.txt",
    };
    await expect(
      service.handleMessage(
        message({
          kind: "channel-message",
          channelId: "C01",
          channelType: "channel",
          text: "see evidence",
          files: [attachment],
          subtype: "file_share",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(prompt).toHaveBeenCalledTimes(1);
    registry.close();
  });

  it("allows authorized users to share a worker channel thread", async () => {
    const { service, prompt, registry } = setup();
    const threadKey = {
      teamId: "T01",
      appId: "A01",
      channelId: "C01",
      threadTs: "123.456",
    };
    registry.createConversation(threadKey, "U01");
    registry.setSession(threadKey, "/tmp/shared.jsonl", "shared-session");

    await expect(
      service.handleMessage(
        message({
          kind: "app-mention",
          eventId: "Ev02",
          channelId: "C01",
          channelType: "channel",
          userId: "U02",
          threadTs: "123.456",
          ts: "124.000",
          text: "continue the shared work",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(prompt).toHaveBeenCalledWith(
      threadKey,
      "U01",
      "continue the shared work",
      undefined,
      true,
    );
    expect(registry.getConversation(threadKey)?.ownerUserId).toBe("U01");
    registry.close();
  });

  it("accepts an authorized app mention in a channel", async () => {
    const { service, prompt, registry } = setup();
    await expect(
      service.handleMessage(
        message({
          kind: "app-mention",
          channelId: "C01",
          channelType: "channel",
          text: "help in this channel",
        }),
      ),
    ).resolves.toMatchObject({ type: "completed" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C01", threadTs: "123.456" }),
      "U01",
      "help in this channel",
      undefined,
      true,
    );
    registry.close();
  });

  it("accepts human thread broadcasts but rejects edits and bot broadcasts", async () => {
    const { service, prompt, registry } = setup();
    const broadcast = {
      kind: "app-mention" as const,
      channelId: "C01",
      channelType: "channel",
      subtype: "thread_broadcast",
    };

    await expect(
      service.handleMessage(message(broadcast)),
    ).resolves.toMatchObject({ type: "completed" });
    await expect(
      service.handleMessage(
        message({ ...broadcast, eventId: "Ev02", subtype: "message_changed" }),
      ),
    ).resolves.toMatchObject({
      type: "ignored",
      reason: "unsupported-subtype",
    });
    await expect(
      service.handleMessage(
        message({ ...broadcast, eventId: "Ev03", botId: "B01" }),
      ),
    ).resolves.toMatchObject({ type: "ignored", reason: "bot-message" });
    expect(prompt).toHaveBeenCalledTimes(1);
    registry.close();
  });

  it("accepts files only when enabled and uses the prepared prompt", async () => {
    const attachment = {
      id: "F01",
      name: "change.sql",
      size: 12,
      urlPrivateDownload: "https://files.slack.com/files-pri/change.sql",
    };
    const disabled = setup();
    await expect(
      disabled.service.handleMessage(message({ files: [attachment] })),
    ).resolves.toMatchObject({
      type: "ignored",
      reason: "file-uploads-disabled",
    });
    disabled.registry.close();

    const enabled = setup(true);
    const preparePrompt = vi.fn(async () => "downloaded: /tmp/change.sql");
    await expect(
      enabled.service.handleMessage(message({ text: "", files: [attachment] }), {
        preparePrompt,
      }),
    ).resolves.toMatchObject({ type: "completed" });
    expect(preparePrompt).toHaveBeenCalledWith({ isNewConversation: true });
    expect(enabled.prompt).toHaveBeenCalledWith(
      expect.anything(),
      "U01",
      "downloaded: /tmp/change.sql",
      undefined,
    );
    enabled.registry.close();
  });

  it("treats a sessionless conversation record as new", async () => {
    const { service, registry } = setup();
    registry.createConversation(
      {
        teamId: "T01",
        appId: "A01",
        channelId: "D01",
        threadTs: "123.456",
      },
      "U01",
    );
    const preparePrompt = vi.fn(async () => "recovered request");

    await service.handleMessage(message(), { preparePrompt });

    expect(preparePrompt).toHaveBeenCalledWith({ isNewConversation: true });
    registry.close();
  });

  it("resumes a direct-user session from a different DM root", async () => {
    const { service, registry } = setup();
    const firstRoot = {
      teamId: "T01",
      appId: "A01",
      channelId: "D01",
      threadTs: "111.000",
    };
    registry.createConversation(firstRoot, "U01");
    registry.setSession(firstRoot, "/tmp/direct.jsonl", "direct-session");
    const preparePrompt = vi.fn(async () => "continued request");

    await service.handleMessage(
      message({ eventId: "Ev02", ts: "222.000" }),
      { preparePrompt },
    );

    expect(preparePrompt).toHaveBeenCalledWith({ isNewConversation: false });
    registry.close();
  });

  it("marks a persisted Slack conversation as resumed", async () => {
    const { service, registry } = setup();
    const conversationKey = {
      teamId: "T01",
      appId: "A01",
      channelId: "D01",
      threadTs: "123.456",
    };
    registry.createConversation(conversationKey, "U01");
    registry.setSession(
      conversationKey,
      "/tmp/session.jsonl",
      "session-01",
    );
    const preparePrompt = vi.fn(async () => "resumed request");

    await service.handleMessage(message(), { preparePrompt });

    expect(preparePrompt).toHaveBeenCalledWith({ isNewConversation: false });
    registry.close();
  });

  it("prevents another allowed user from taking over a thread", async () => {
    const { service, registry } = setup();
    registry.createConversation(
      {
        teamId: "T01",
        appId: "A01",
        channelId: "D01",
        threadTs: "123.456",
      },
      "U01",
    );
    await expect(
      service.handleMessage(message({ eventId: "Ev02", userId: "U02" })),
    ).resolves.toMatchObject({
      type: "ignored",
      reason: "conversation-owner-mismatch",
    });
    registry.close();
  });
});
