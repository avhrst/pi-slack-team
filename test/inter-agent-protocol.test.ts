import { describe, expect, it } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import {
  delegationPrompt,
  delegationRequestText,
  delegationResponseMessages,
  incomingDelegationRequest,
  incomingDelegationResponse,
} from "../src/inter-agent/protocol.js";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";

const delegationId = "123e4567-e89b-12d3-a456-426614174000";

function config(role: "worker" | "manager") {
  return agentConfigSchema.parse({
    version: 1,
    agentId: role === "manager" ? "coordinator" : "specialist",
    role,
    expectedUnixUser: `${role}-agent`,
    stateDir: `/home/${role}-agent/.local/state/pi-slack-team`,
    slack: {
      teamId: "T01",
      appId: role === "manager" ? "A01" : "A02",
      allowedUserIds: ["U01"],
    },
    interAgent: {
      peers: [
        {
          agentId: role === "manager" ? "specialist" : "coordinator",
          role: role === "manager" ? "worker" : "manager",
          appId: role === "manager" ? "A02" : "A01",
          botUserId: role === "manager" ? "UWORKER" : "UMANAGER",
        },
      ],
    },
    pi: {
      cwd: `/home/${role}-agent`,
      agentDir: `/home/${role}-agent/.pi/agent`,
      sessionDir: `/home/${role}-agent/.pi/agent/sessions`,
    },
  });
}

function botMention(
  role: "worker" | "manager",
  text: string,
  overrides: Partial<IncomingSlackMessage> = {},
): IncomingSlackMessage {
  return {
    kind: "app-mention",
    eventId: "Ev01",
    teamId: "T01",
    appId: role === "manager" ? "A01" : "A02",
    channelId: "C01",
    channelType: "channel",
    userId: role === "manager" ? "UWORKER" : "UMANAGER",
    ts: "123.456",
    text,
    files: [],
    subtype: "bot_message",
    botId: "B01",
    senderAppId: role === "manager" ? "A02" : "A01",
    ...overrides,
  };
}

describe("inter-agent Slack protocol", () => {
  it("authenticates a manager request with both sender app and bot user IDs", () => {
    const workerConfig = config("worker");
    const text = delegationRequestText("UWORKER", delegationId, "Do the work")
      .replace("<@UWORKER> ", "");
    const request = incomingDelegationRequest(
      workerConfig,
      botMention("worker", text),
    );

    expect(request).toMatchObject({
      delegationId,
      task: "Do the work",
      peer: { agentId: "coordinator" },
    });
    expect(delegationPrompt(request!)).toContain(
      '"source": "authenticated_manager_delegation"',
    );
  });

  it("rejects spoofed, malformed, and wrong-direction requests", () => {
    const text = `[pi-slack-team:v1:request:${delegationId}]\nDo the work`;
    expect(
      incomingDelegationRequest(
        config("worker"),
        botMention("worker", text, { senderAppId: "A99" }),
      ),
    ).toBeUndefined();
    expect(
      incomingDelegationRequest(
        config("worker"),
        botMention("worker", "Do the work"),
      ),
    ).toBeUndefined();
    expect(
      incomingDelegationRequest(
        config("manager"),
        botMention("manager", text),
      ),
    ).toBeUndefined();
  });

  it("chunks and parses correlated worker responses", () => {
    const request = incomingDelegationRequest(
      config("worker"),
      botMention(
        "worker",
        `[pi-slack-team:v1:request:${delegationId}]\nDo the work`,
      ),
    );
    const resultText = `${"a".repeat(1_000)} ${"b".repeat(500)}`;
    const messages = delegationResponseMessages(request!, resultText, 1_000);
    expect(messages).toHaveLength(2);

    const responses = messages.map((message) =>
      incomingDelegationResponse(
        config("manager"),
        botMention("manager", message.replace("<@UMANAGER> ", "")),
      ),
    );
    expect(responses[0]).toMatchObject({
      delegationId,
      status: "ok",
      part: 1,
      total: 2,
      peer: { agentId: "specialist" },
    });
    expect(responses.map((response) => response?.text).join("")).toBe(
      resultText,
    );
  });

  it("marks worker failures explicitly", () => {
    const request = incomingDelegationRequest(
      config("worker"),
      botMention(
        "worker",
        `[pi-slack-team:v1:request:${delegationId}]\nDo the work`,
      ),
    );
    const [message] = delegationResponseMessages(
      request!,
      "failed safely",
      1_000,
      "error",
    );
    const response = incomingDelegationResponse(
      config("manager"),
      botMention("manager", message!.replace("<@UMANAGER> ", "")),
    );
    expect(response).toMatchObject({ status: "error", text: "failed safely" });
  });
});
