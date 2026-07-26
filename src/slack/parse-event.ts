import type { IncomingSlackMessage } from "../routing/chat-key.js";

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
    (kind === "app-mention" && channelId
      ? channelId.startsWith("C")
        ? "channel"
        : channelId.startsWith("G")
          ? "group"
          : undefined
      : undefined);
  const userId = requiredString(event, "user");
  const ts = requiredString(event, "ts");
  const rawText = requiredString(event, "text");
  const text = rawText === undefined ? undefined : textTransform(rawText);
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
    ...(typeof event.thread_ts === "string"
      ? { threadTs: event.thread_ts }
      : {}),
    ...(typeof event.subtype === "string" ? { subtype: event.subtype } : {}),
    ...(typeof event.bot_id === "string" ? { botId: event.bot_id } : {}),
  };
}

export function parseMessageEvent(
  bodyValue: unknown,
  eventValue: unknown,
): IncomingSlackMessage | undefined {
  return parseEvent(bodyValue, eventValue, "direct-message");
}

export function parseAppMentionEvent(
  bodyValue: unknown,
  eventValue: unknown,
  botUserId: string,
): IncomingSlackMessage | undefined {
  const mention = `<@${botUserId}>`;
  return parseEvent(bodyValue, eventValue, "app-mention", (text) => {
    if (!text.includes(mention)) return undefined;
    return text.replaceAll(mention, "").trim();
  });
}
