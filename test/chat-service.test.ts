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

function setup() {
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
    eventId: "Ev01",
    teamId: "T01",
    appId: "A01",
    channelId: "D01",
    channelType: "im",
    userId: "U01",
    ts: "123.456",
    text: "hello",
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

  it("fails closed for wrong users, apps, and non-DM channels", async () => {
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
    ).resolves.toMatchObject({ type: "ignored", reason: "dm-only" });
    expect(prompt).not.toHaveBeenCalled();
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
