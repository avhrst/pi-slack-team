import { describe, expect, it } from "vitest";
import {
  parseAppMentionEvent,
  parseMessageEvent,
} from "../src/slack/parse-event.js";

const body = {
  event_id: "Ev01",
  team_id: "T01",
  api_app_id: "A01",
};

describe("Slack event parsing", () => {
  it("parses direct messages", () => {
    expect(
      parseMessageEvent(body, {
        channel: "D01",
        channel_type: "im",
        user: "U01",
        ts: "123.456",
        text: "hello",
        subtype: "file_share",
        files: [
          {
            id: "F01",
            name: "change.sql",
            mimetype: "text/plain",
            size: 9,
            url_private_download:
              "https://files.slack.com/files-pri/change.sql",
          },
        ],
      }),
    ).toMatchObject({
      kind: "direct-message",
      text: "hello",
      files: [
        {
          id: "F01",
          name: "change.sql",
          size: 9,
          urlPrivateDownload:
            "https://files.slack.com/files-pri/change.sql",
        },
      ],
    });
  });

  it("parses channel mentions and removes only the agent mention", () => {
    expect(
      parseAppMentionEvent(
        body,
        {
          channel: "C01",
          user: "U01",
          ts: "123.456",
          text: "<@UBOT> please investigate\n  this issue",
        },
        "UBOT",
      ),
    ).toMatchObject({
      kind: "app-mention",
      channelId: "C01",
      channelType: "channel",
      text: "please investigate\n  this issue",
    });
  });

  it("rejects an app mention event that does not mention this bot", () => {
    expect(
      parseAppMentionEvent(
        body,
        {
          channel: "C01",
          user: "U01",
          ts: "123.456",
          text: "<@UOTHER> hello",
        },
        "UBOT",
      ),
    ).toBeUndefined();
  });
});
