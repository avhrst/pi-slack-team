import type { ConversationKey } from "../storage/registry.js";

export type PiSessionKey =
  | {
      scope: "direct-user";
      teamId: string;
      appId: string;
      userId: string;
    }
  | {
      scope: "channel-thread";
      teamId: string;
      appId: string;
      channelId: string;
      threadTs: string;
    };

export function piSessionKey(
  conversation: ConversationKey,
  ownerUserId: string,
): PiSessionKey {
  return conversation.channelId.startsWith("D")
    ? {
        scope: "direct-user",
        teamId: conversation.teamId,
        appId: conversation.appId,
        userId: ownerUserId,
      }
    : {
        scope: "channel-thread",
        teamId: conversation.teamId,
        appId: conversation.appId,
        channelId: conversation.channelId,
        threadTs: conversation.threadTs,
      };
}

export function serializePiSessionKey(key: PiSessionKey): string {
  return key.scope === "direct-user"
    ? [key.scope, key.teamId, key.appId, key.userId].join(":")
    : [
        key.scope,
        key.teamId,
        key.appId,
        key.channelId,
        key.threadTs,
      ].join(":");
}

export function piSessionName(key: PiSessionKey): string {
  const identity =
    key.scope === "direct-user"
      ? `dm-${key.userId}`
      : `thread-${key.threadTs}`;
  return `slack-${identity.replace(/\W/g, "-").slice(0, 48)}`;
}
