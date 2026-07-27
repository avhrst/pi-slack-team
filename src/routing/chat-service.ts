import type { AgentConfig } from "../config/schema.js";
import {
  incomingDelegationRequest,
  type IncomingDelegationRequest,
} from "../inter-agent/protocol.js";
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
    allowExistingOwner?: boolean,
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
    const delegation = incomingDelegationRequest(this.#config, message);
    const rejection = this.#rejectionReason(message, delegation);
    if (rejection) {
      this.#logger.warn("slack_message_ignored", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
        reason: rejection,
        userId: message.userId,
      });
      return { type: "ignored", reason: rejection };
    }

    if (!this.claimEvent(message.eventId)) {
      return { type: "duplicate" };
    }

    const key = conversationKey(message);
    const existing = this.#registry.getConversation(key);
    const sharedManagerChannel =
      this.#config.role === "manager" &&
      ["channel-message", "app-mention"].includes(message.kind);
    const sharedConversation = sharedManagerChannel || Boolean(delegation);
    if (
      existing &&
      existing.ownerUserId !== message.userId &&
      !sharedConversation
    ) {
      this.#logger.warn("slack_conversation_owner_mismatch", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
        userId: message.userId,
      });
      return { type: "ignored", reason: "conversation-owner-mismatch" };
    }

    await hooks.onAccepted?.();
    const promptText = hooks.preparePrompt
      ? await hooks.preparePrompt({ isNewConversation: !existing?.piSessionFile })
      : message.text;
    const ownerUserId = existing?.ownerUserId ?? message.userId;
    const result = sharedConversation
      ? await this.#pool.prompt(
          key,
          ownerUserId,
          promptText,
          hooks.onPiEvent,
          true,
        )
      : await this.#pool.prompt(
          key,
          ownerUserId,
          promptText,
          hooks.onPiEvent,
        );
    return { type: "completed", result };
  }

  claimEvent(eventId: string): boolean {
    if (this.#registry.claimEvent(eventId)) return true;
    this.#logger.info("slack_event_duplicate", {
      agentId: this.#config.agentId,
      eventId,
    });
    return false;
  }

  #rejectionReason(
    message: IncomingSlackMessage,
    delegation: IncomingDelegationRequest | undefined,
  ): string | undefined {
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
    const validManagerObservation =
      this.#config.role === "manager" &&
      message.kind === "channel-message" &&
      ["channel", "group"].includes(message.channelType) &&
      ["C", "G"].some((prefix) => message.channelId.startsWith(prefix));
    if (
      !validDirectMessage &&
      !validChannelMention &&
      !validManagerObservation
    ) {
      return "unsupported-conversation";
    }
    if (message.botId && !delegation) return "bot-message";
    if (!message.botId && !this.#allowedUsers.has(message.userId)) {
      return "unauthorized-user";
    }
    if (delegation && message.files.length > 0) {
      return "inter-agent-files-unsupported";
    }
    if (message.files.length > this.#config.slack.maxFilesPerMessage) {
      return "too-many-files";
    }
    if (
      message.files.length > 0 &&
      !this.#config.slack.fileUploads &&
      !validManagerObservation
    ) {
      return "file-uploads-disabled";
    }
    if (
      message.subtype &&
      !(
        (message.subtype === "file_share" && message.files.length > 0) ||
        (delegation && message.subtype === "bot_message")
      )
    ) {
      return "unsupported-subtype";
    }
    if (!message.text.trim() && message.files.length === 0) return "empty-message";
    return undefined;
  }
}
