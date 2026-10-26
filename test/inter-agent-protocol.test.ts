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
import { escapeSlackText } from "../src/slack/mrkdwn.js";
import { parseAppMentionEvent } from "../src/slack/parse-event.js";
import { toSlackMrkdwn } from "../src/slack/pi-progress.js";

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

  it("never splits a surrogate pair across response chunks", () => {
    const request = incomingDelegationRequest(
      config("worker"),
      botMention(
        "worker",
        `[pi-slack-team:v1:request:${delegationId}]\nDo the work`,
      ),
    );
    const resultText = `${"a".repeat(999)}😀${"b".repeat(10)}`;
    const messages = delegationResponseMessages(request!, resultText, 1_000);
    const texts = messages.map(
      (message) =>
        incomingDelegationResponse(
          config("manager"),
          botMention("manager", message.replace("<@UMANAGER> ", "")),
        )?.text ?? "",
    );
    expect(texts[0]).toBe("a".repeat(999));
    expect(texts.join("")).toBe(resultText);
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

  it("round-trips request and response envelopes through Slack escaping", () => {
    const body = { event_id: "Ev01", team_id: "T01", api_app_id: "A01" };
    const task = "Run `a && b` for Promise<string> & <!channel>";
    const requestEvent = parseAppMentionEvent(
      body,
      {
        channel: "C01",
        user: "UMANAGER",
        ts: "1.0",
        text: delegationRequestText("UWORKER", delegationId, escapeSlackText(task)),
        bot_id: "BMANAGER",
        app_id: "A01",
      },
      "UWORKER",
    );
    const request = incomingDelegationRequest(config("worker"), requestEvent!);
    expect(request?.task).toBe(task);

    const [responseText] = delegationResponseMessages(
      request!,
      toSlackMrkdwn("Done: a && b <!here>"),
    );
    const responseEvent = parseAppMentionEvent(
      { ...body, api_app_id: "A02" },
      {
        channel: "C01",
        user: "UWORKER",
        ts: "2.0",
        text: responseText,
        bot_id: "BWORKER",
        app_id: "A02",
      },
      "UMANAGER",
    );
    expect(
      incomingDelegationResponse(config("manager"), responseEvent!)?.text,
    ).toBe("Done: a && b <!here>");
  });
});

