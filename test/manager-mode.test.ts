import { describe, expect, it } from "vitest";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import {
  MANAGER_SILENT_RESPONSE,
  managerObservationContent,
  managerObservationPrompt,
  managerVisibleResponse,
} from "../src/slack/manager-mode.js";

function message(
  overrides: Partial<IncomingSlackMessage> = {},
): IncomingSlackMessage {
  return {
    kind: "channel-message",
    eventId: "Ev01",
    teamId: "T01",
    appId: "A01",
    channelId: "C01",
    channelType: "channel",
    userId: "U01",
    ts: "123.456",
    text: "We agreed that this bug needs durable tracking.",
    files: [],
    ...overrides,
  };
}

describe("manager mode", () => {
  it("frames ambient Slack content as an optional, untrusted observation", () => {
    const prompt = managerObservationPrompt(message(), "thread context");

    expect(prompt).toContain("not an explicit request");
    expect(prompt).toContain("untrusted user content");
    expect(prompt).toContain("create a non-duplicate Jira issue");
    expect(prompt).toContain('"senderUserId": "U01"');
    expect(prompt).toContain("thread context");
    expect(prompt).toContain(MANAGER_SILENT_RESPONSE);
  });

  it("suppresses only the exact silent decision", () => {
    expect(managerVisibleResponse(`  ${MANAGER_SILENT_RESPONSE}\n`)).toBeUndefined();
    expect(managerVisibleResponse("Created WH-42 to track the regression.")).toBe(
      "Created WH-42 to track the regression.",
    );
  });

  it("includes attachment metadata without private download URLs", () => {
    const content = managerObservationContent(
      message({
        files: [
          {
            id: "F01",
            name: "error.log",
            mimetype: "text/plain",
            size: 42,
            urlPrivateDownload:
              "https://files.slack.com/files-pri/secret-download-url",
          },
        ],
      }),
    );

    expect(content).toContain("error.log");
    expect(content).toContain('"size": 42');
    expect(content).not.toContain("secret-download-url");
  });
});
