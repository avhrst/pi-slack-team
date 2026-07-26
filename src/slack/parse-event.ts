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

export function parseMessageEvent(
  bodyValue: unknown,
  eventValue: unknown,
): IncomingSlackMessage | undefined {
  const body = asRecord(bodyValue);
  const event = asRecord(eventValue);
  if (!body || !event) return undefined;

  const eventId = requiredString(body, "event_id");
  const teamId = requiredString(body, "team_id");
  const appId = requiredString(body, "api_app_id");
  const channelId = requiredString(event, "channel");
  const channelType = requiredString(event, "channel_type");
  const userId = requiredString(event, "user");
  const ts = requiredString(event, "ts");
  const text = requiredString(event, "text");
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
