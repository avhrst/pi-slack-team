import type { ConversationKey } from "../storage/registry.js";

export interface IncomingSlackMessage {
  eventId: string;
  teamId: string;
  appId: string;
  channelId: string;
  channelType: string;
  userId: string;
  ts: string;
  threadTs?: string;
  text: string;
  subtype?: string;
  botId?: string;
}

export function conversationKey(
  message: IncomingSlackMessage,
): ConversationKey {
  return {
    teamId: message.teamId,
    appId: message.appId,
    channelId: message.channelId,
    threadTs: message.threadTs ?? message.ts,
  };
}

export function serializeConversationKey(key: ConversationKey): string {
  return [key.teamId, key.appId, key.channelId, key.threadTs].join(":");
}
