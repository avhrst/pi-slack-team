import { describe, expect, it } from "vitest";
import {
  parseAppMentionEvent,
  parseChannelMessageEvent,
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

  it("parses ambient public and private channel messages", () => {
    expect(
      parseChannelMessageEvent(body, {
        channel: "C01",
        channel_type: "channel",
        user: "U01",
        ts: "123.456",
        text: "we should track this bug",
      }),
    ).toMatchObject({
      kind: "channel-message",
      channelId: "C01",
      channelType: "channel",
      text: "we should track this bug",
    });
    expect(
      parseChannelMessageEvent(body, {
        channel: "G01",
        user: "U01",
        ts: "123.457",
        text: "private discussion",
      }),
    ).toMatchObject({
      kind: "channel-message",
      channelType: "group",
    });
  });

  it("leaves explicit mentions to the app mention listener", () => {
    expect(
      parseChannelMessageEvent(
        body,
        {
          channel: "C01",
          user: "U01",
          ts: "123.456",
          text: "<@UBOT> please investigate",
        },
        "UBOT",
      ),
    ).toBeUndefined();
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
          bot_id: "BMANAGER",
          app_id: "A02",
        },
        "UBOT",
      ),
    ).toMatchObject({
      kind: "app-mention",
      channelId: "C01",
      channelType: "channel",
      text: "please investigate\n  this issue",
      botId: "BMANAGER",
      senderAppId: "A02",
    });
  });

  it("preserves correlated envelope payload whitespace", () => {
    expect(
      parseAppMentionEvent(
        body,
        {
          channel: "C01",
          user: "UWORKER",
          ts: "123.456",
          text:
            "<@UBOT> [pi-slack-team:v1:response:123e4567-e89b-12d3-a456-426614174000:ok:1/2]\nchunk ",
          bot_id: "BWORKER",
          bot_profile: { app_id: "A02" },
        },
        "UBOT",
      )?.text,
    ).toBe(
      "[pi-slack-team:v1:response:123e4567-e89b-12d3-a456-426614174000:ok:1/2]\nchunk ",
    );
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

  it("decodes Slack entities for every event kind", () => {
    const text = "a &amp;&amp; b &lt; c &gt; d &amp;lt;";
    const decoded = "a && b < c > d &lt;";
    expect(
      parseMessageEvent(body, {
        channel: "D01",
        channel_type: "im",
        user: "U01",
        ts: "1.0",
        text,
      })?.text,
    ).toBe(decoded);
    expect(
      parseChannelMessageEvent(body, {
        channel: "C01",
        channel_type: "channel",
        user: "U01",
        ts: "1.0",
        text,
      })?.text,
    ).toBe(decoded);
    expect(
      parseAppMentionEvent(
        body,
        { channel: "C01", user: "U01", ts: "1.0", text: `<@UBOT> ${text}` },
        "UBOT",
      )?.text,
    ).toBe(decoded);
  });

  it("does not treat a typed, escaped mention as a mention", () => {
    expect(
      parseChannelMessageEvent(
        body,
        {
          channel: "C01",
          channel_type: "channel",
          user: "U01",
          ts: "1.0",
          text: "literal &lt;@UBOT&gt;",
        },
        "UBOT",
      )?.text,
    ).toBe("literal <@UBOT>");
  });

  it("decodes an envelope body without altering its header", () => {
    expect(
      parseAppMentionEvent(
        body,
        {
          channel: "C01",
          user: "UMANAGER",
          ts: "123.456",
          text:
            "<@UBOT> [pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nrun a &amp;&amp; b",
          bot_id: "BMANAGER",
          app_id: "A02",
        },
        "UBOT",
      )?.text,
    ).toBe(
      "[pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nrun a && b",
    );
  });
});

