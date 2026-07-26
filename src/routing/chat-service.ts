import type { AgentConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { PiTurnResult } from "../pi/session-pool.js";
import {
  conversationKey,
  type IncomingSlackMessage,
} from "./chat-key.js";
import type { Registry } from "../storage/registry.js";
import type { RpcRecord } from "../pi/rpc-client.js";

export type MessageDisposition =
  | { type: "ignored"; reason: string }
  | { type: "duplicate" }
  | { type: "completed"; result: PiTurnResult };

export interface MessageHooks {
  onAccepted?: () => Promise<void>;
  preparePrompt?: (context: { isNewConversation: boolean }) => Promise<string>;
  onPiEvent?: (event: RpcRecord) => void;
}

export interface PiPromptRunner {
  prompt(
    key: ReturnType<typeof conversationKey>,
    ownerUserId: string,
    text: string,
    onEvent?: (event: RpcRecord) => void,
  ): Promise<PiTurnResult>;
}

export class ChatService {
  readonly #config: AgentConfig;
  readonly #registry: Registry;
  readonly #pool: PiPromptRunner;
  readonly #logger: Logger;
  readonly #allowedUsers: Set<string>;

  constructor(
    config: AgentConfig,
    registry: Registry,
    pool: PiPromptRunner,
    logger: Logger,
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#pool = pool;
    this.#logger = logger;
    this.#allowedUsers = new Set(config.slack.allowedUserIds);
  }

  async handleMessage(
    message: IncomingSlackMessage,
    hooks: MessageHooks = {},
  ): Promise<MessageDisposition> {
    const rejection = this.#rejectionReason(message);
    if (rejection) {
      this.#logger.warn("slack_message_ignored", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
        reason: rejection,
        userId: message.userId,
      });
      return { type: "ignored", reason: rejection };
    }

    if (!this.#registry.claimEvent(message.eventId)) {
      this.#logger.info("slack_event_duplicate", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
      });
      return { type: "duplicate" };
    }

    const key = conversationKey(message);
    const existing = this.#registry.getConversation(key);
    if (existing && existing.ownerUserId !== message.userId) {
      this.#logger.warn("slack_conversation_owner_mismatch", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
        userId: message.userId,
      });
      return { type: "ignored", reason: "conversation-owner-mismatch" };
    }

    await hooks.onAccepted?.();
    const promptText = hooks.preparePrompt
      ? await hooks.preparePrompt({ isNewConversation: !existing })
      : message.text;
    const result = await this.#pool.prompt(
      key,
      message.userId,
      promptText,
      hooks.onPiEvent,
    );
    return { type: "completed", result };
  }

  #rejectionReason(message: IncomingSlackMessage): string | undefined {
    if (message.teamId !== this.#config.slack.teamId) return "wrong-team";
    if (message.appId !== this.#config.slack.appId) return "wrong-app";
    const validDirectMessage =
      message.kind === "direct-message" &&
      message.channelType === "im" &&
      message.channelId.startsWith("D");
    const validChannelMention =
      message.kind === "app-mention" &&
      ["channel", "group"].includes(message.channelType) &&
      ["C", "G"].some((prefix) => message.channelId.startsWith(prefix));
    if (!validDirectMessage && !validChannelMention) {
      return "unsupported-conversation";
    }
    if (!this.#allowedUsers.has(message.userId)) return "unauthorized-user";
    if (message.botId) return "bot-message";
    if (message.files.length > this.#config.slack.maxFilesPerMessage) {
      return "too-many-files";
    }
    if (message.files.length > 0 && !this.#config.slack.fileUploads) {
      return "file-uploads-disabled";
    }
    if (
      message.subtype &&
      !(message.subtype === "file_share" && message.files.length > 0)
    ) {
      return "unsupported-subtype";
    }
    if (!message.text.trim() && message.files.length === 0) return "empty-message";
    return undefined;
  }
}
