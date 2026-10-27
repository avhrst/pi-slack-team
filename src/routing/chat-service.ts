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
import { piSessionKey, serializePiSessionKey } from "./session-key.js";
import { KeyedSerialQueue } from "./queue.js";

export type MessageDisposition =
  | { type: "ignored"; reason: string }
  | { type: "duplicate" }
  | { type: "completed"; result: PiTurnResult };

export interface MessageHooks {
  onAccepted?: (context: { isObservation: boolean }) => Promise<void>;
  preparePrompt?: (context: { isNewConversation: boolean; afterTs?: string }) => Promise<
    string | { text: string; contextThroughTs?: string }
  >;
  onPiEvent?: (event: RpcRecord) => void;
  onCompleted?: (result: PiTurnResult) => Promise<void>;
}

export interface PiPromptRunner {
  prompt(
    key: ReturnType<typeof conversationKey>,
    ownerUserId: string,
    text: string,
    onEvent?: (event: RpcRecord) => void,
    allowExistingOwner?: boolean,
    sourceUserId?: string,
  ): Promise<PiTurnResult>;
}

export class ChatService {
  readonly #config: AgentConfig;
  readonly #registry: Registry;
  readonly #pool: PiPromptRunner;
  readonly #logger: Logger;
  readonly #allowedUsers: Set<string>;
  readonly #managerBotUsers: Set<string>;
  readonly #queue = new KeyedSerialQueue();

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
    if (config.role === "worker") registry.backfillWorkerThreads();
    this.#allowedUsers = new Set(config.slack.allowedUserIds);
    this.#managerBotUsers = new Set(
      config.interAgent?.peers
        .filter((peer) => peer.role === "manager")
        .map((peer) => peer.botUserId) ?? [],
    );
  }

  async handleMessage(
    message: IncomingSlackMessage,
    hooks: MessageHooks = {},
  ): Promise<MessageDisposition> {
    const delegation = this.#config.pi.transport === "tmux"
      ? undefined : incomingDelegationRequest(this.#config, message);
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
    if (message.kind === "app-mention") this.#registry.engageThread(key);
    const isObservation = this.#config.role === "manager" &&
      message.kind === "channel-message" && !this.#registry.threadState(key).engaged;
    // Claim and engage synchronously, before a second Slack event can arrive.
    // The lane includes prompt preparation and output finalization, not just Pi.
    const lane = this.#config.pi.transport === "tmux"
      ? `agent:${key.teamId}:${key.appId}`
      : serializePiSessionKey(piSessionKey(key, message.userId));
    return this.#queue.run(lane, async () => {
      let existing = this.#registry.getConversation(key);
      const humanClaimingManagerOwnedThread = Boolean(
        existing &&
        this.#config.role === "worker" &&
        ["app-mention", "channel-message"].includes(message.kind) &&
        !message.botId &&
        existing.ownerUserId !== message.userId &&
        this.#managerBotUsers.has(existing.ownerUserId),
      );
      if (existing && humanClaimingManagerOwnedThread) {
        const previousOwnerUserId = existing.ownerUserId;
        const claimed = this.#registry.transferConversationOwner(
          key,
          previousOwnerUserId,
          message.userId,
        );
        if (claimed) {
          existing = claimed;
          this.#logger.info("slack_delegated_conversation_claimed", {
            agentId: this.#config.agentId,
            eventId: message.eventId,
            previousOwnerUserId,
            userId: message.userId,
          });
        }
      }
      const sharedManagerChannel =
        this.#config.role === "manager" &&
        ["channel-message", "app-mention"].includes(message.kind);
      const sharedWorkerThread =
        this.#config.role === "worker" &&
        ["app-mention", "channel-message"].includes(message.kind);
      const sharedConversation =
        sharedManagerChannel || sharedWorkerThread || Boolean(delegation);
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

      await hooks.onAccepted?.({ isObservation });
      const ownerUserId = existing?.ownerUserId ?? message.userId;
      const sessionKey =
        existing?.sessionKey ?? serializePiSessionKey(piSessionKey(key, ownerUserId));
      const persistedSession = this.#registry.getPiSession(sessionKey);
      const isNewConversation = this.#config.pi.transport === "tmux"
        ? !existing || !existing.sessionKey.startsWith("agent:")
        : !persistedSession?.piSessionFile;
      const afterTs = isNewConversation ? undefined : this.#registry.threadState(key).contextTs;
      const prepared = hooks.preparePrompt
        ? await hooks.preparePrompt({
            isNewConversation,
            ...(afterTs ? { afterTs } : {}),
          })
        : message.text;
      const promptText = typeof prepared === "string" ? prepared : prepared.text;
      const result = sharedConversation || this.#config.pi.transport === "tmux"
        ? await this.#pool.prompt(
            key,
            ownerUserId,
            promptText,
            hooks.onPiEvent,
            sharedConversation,
            message.userId,
          )
        : await this.#pool.prompt(
            key,
            ownerUserId,
            promptText,
            hooks.onPiEvent,
          );
      if (typeof prepared !== "string" && prepared.contextThroughTs) {
        this.#registry.advanceThreadContext(key, prepared.contextThroughTs);
      }
      await hooks.onCompleted?.(result);
      return { type: "completed", result };
    });
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
    const validThreadReply = message.kind === "channel-message" &&
      Boolean(message.threadTs) &&
      ["channel", "group"].includes(message.channelType) &&
      ["C", "G"].some((prefix) => message.channelId.startsWith(prefix)) &&
      this.#registry.threadState(conversationKey(message)).engaged;
    const metadataOnlyObservation = validManagerObservation &&
      !this.#registry.threadState(conversationKey(message)).engaged;
    if (
      !validDirectMessage &&
      !validChannelMention &&
      !validManagerObservation &&
      !validThreadReply
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
      !metadataOnlyObservation
    ) {
      return "file-uploads-disabled";
    }
    const validHumanThreadBroadcast =
      message.subtype === "thread_broadcast" &&
      !message.botId &&
      (validChannelMention || validManagerObservation || validThreadReply);
    if (
      message.subtype &&
      !(
        (message.subtype === "file_share" && message.files.length > 0) ||
        (delegation && message.subtype === "bot_message") ||
        validHumanThreadBroadcast
      )
    ) {
      return "unsupported-subtype";
    }
    if (!message.text.trim() && message.files.length === 0) return "empty-message";
    return undefined;
  }
}
