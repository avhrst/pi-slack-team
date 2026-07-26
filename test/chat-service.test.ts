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

function setup(fileUploads = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-team-chat-"));
  temporaryDirectories.push(directory);
  const config = agentConfigSchema.parse({
    version: 1,
    agentId: "support",
    expectedUnixUser: "support-agent",
    stateDir: directory,
    slack: {
      teamId: "T01",
      appId: "A01",
      allowedUserIds: ["U01", "U02"],
      fileUploads,
    },
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
    );
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
    expect(preparePrompt).toHaveBeenCalledOnce();
    expect(enabled.prompt).toHaveBeenCalledWith(
      expect.anything(),
      "U01",
      "downloaded: /tmp/change.sql",
      undefined,
    );
    enabled.registry.close();
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
