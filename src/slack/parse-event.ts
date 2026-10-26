import type {
  IncomingSlackFile,
  IncomingSlackMessage,
} from "../routing/chat-key.js";
import { decodeSlackEntities } from "./mrkdwn.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function parseFiles(value: unknown): IncomingSlackFile[] {
  if (!Array.isArray(value)) return [];
  const files: IncomingSlackFile[] = [];
  for (const item of value) {
    const file = asRecord(item);
    if (!file) continue;
    const id = requiredString(file, "id");
    const name = requiredString(file, "name");
    const urlPrivateDownload =
      requiredString(file, "url_private_download") ??
      requiredString(file, "url_private");
    const size = file.size;
    if (
      !id ||
      !name ||
      !urlPrivateDownload ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      continue;
    }
    files.push({
      id,
      name,
      size,
      urlPrivateDownload,
      ...(typeof file.mimetype === "string" ? { mimetype: file.mimetype } : {}),
    });
  }
  return files;
}

function parseEvent(
  bodyValue: unknown,
  eventValue: unknown,
  kind: IncomingSlackMessage["kind"],
  textTransform: (text: string) => string | undefined = (text) => text,
): IncomingSlackMessage | undefined {
  const body = asRecord(bodyValue);
  const event = asRecord(eventValue);
  if (!body || !event) return undefined;

  const eventId = requiredString(body, "event_id");
  const teamId = requiredString(body, "team_id");
  const appId = requiredString(body, "api_app_id");
  const channelId = requiredString(event, "channel");
  const channelType =
    requiredString(event, "channel_type") ??
    (channelId?.startsWith("D")
      ? "im"
      : channelId?.startsWith("C")
        ? "channel"
        : channelId?.startsWith("G")
          ? "group"
          : undefined);
  const userId = requiredString(event, "user");
  const botProfile = asRecord(event.bot_profile);
  const senderAppId =
    requiredString(event, "app_id") ??
    (botProfile ? requiredString(botProfile, "app_id") : undefined);
  const ts = requiredString(event, "ts");
  const rawText = requiredString(event, "text");
  // Transforms match Slack markup (`<@U…>`) on the raw text; decode exactly once
  // afterwards so a human's `a && b` reaches Pi as typed.
  const transformed = rawText === undefined ? undefined : textTransform(rawText);
  const text = transformed === undefined
    ? undefined
    : decodeSlackEntities(transformed);
  if (
    !eventId ||
    !teamId ||
    !appId ||
    !channelId ||
    !channelType ||
    !userId ||
    !ts ||
    text === undefined
  ) {
    return undefined;
  }

  return {
    kind,
    eventId,
    teamId,
    appId,
    channelId,
    channelType,
    userId,
    ts,
    text,
    files: parseFiles(event.files),
    ...(typeof event.thread_ts === "string"
      ? { threadTs: event.thread_ts }
      : {}),
    ...(typeof event.subtype === "string" ? { subtype: event.subtype } : {}),
    ...(typeof event.bot_id === "string" ? { botId: event.bot_id } : {}),
    ...(senderAppId ? { senderAppId } : {}),
  };
}

export function parseMessageEvent(
  bodyValue: unknown,
  eventValue: unknown,
): IncomingSlackMessage | undefined {
  const message = parseEvent(bodyValue, eventValue, "direct-message");
  return message?.channelType === "im" && message.channelId.startsWith("D")
    ? message
    : undefined;
}

export function parseChannelMessageEvent(
  bodyValue: unknown,
  eventValue: unknown,
  botUserId?: string,
): IncomingSlackMessage | undefined {
  // The app_mention listener handles explicit requests and strips the mention.
  // Checked on the raw text: a typed `&lt;@U…&gt;` is not a mention.
  const message = parseEvent(
    bodyValue,
    eventValue,
    "channel-message",
    (text) =>
      botUserId && text.includes(`<@${botUserId}>`) ? undefined : text,
  );
  if (
    !message ||
    !["channel", "group"].includes(message.channelType) ||
    !["C", "G"].some((prefix) => message.channelId.startsWith(prefix))
  ) {
    return undefined;
  }
  return message;
}

export function parseAppMentionEvent(
  bodyValue: unknown,
  eventValue: unknown,
  botUserId: string,
): IncomingSlackMessage | undefined {
  const mention = `<@${botUserId}>`;
  return parseEvent(bodyValue, eventValue, "app-mention", (text) => {
    if (!text.includes(mention)) return undefined;
    const firstMentionRemoved = text.replace(mention, "");
    const leadingTrimmed = firstMentionRemoved.trimStart();
    return leadingTrimmed.startsWith("[pi-slack-team:v1:")
      ? leadingTrimmed
      : text.replaceAll(mention, "").trim();
  });
}
