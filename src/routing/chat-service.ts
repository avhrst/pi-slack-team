import type { AgentConfig } from "../config/schema.js";
import {
  incomingDelegationRequest,
  type IncomingDelegationRequest,
} from "../inter-agent/protocol.js";
import type { Logger } from "../observability/logger.js";
import type { PiTurnResult } from "../pi/session-pool.js";
import {
  conversationKey,
  serializeConversationKey,
  type IncomingSlackMessage,
} from "./chat-key.js";
import type { Registry, SlackWorkThread } from "../storage/registry.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import { piSessionKey, serializePiSessionKey } from "./session-key.js";
import { KeyedSerialQueue } from "./queue.js";

export type MessageDisposition =
  | { type: "ignored"; reason: string }
  | { type: "duplicate" }
  | { type: "completed"; result: PiTurnResult };

export interface SlackTurnRoute {
  isObservation: boolean;
  threadTs?: string;
  workThread?: true;
  workThreadCreated?: boolean;
  workThreadTopic?: string;
}

export interface MessageHooks {
  /** Publish the root. Subsequent Slack writes can use it after routing binds and engages it. */
  resolveWorkThread?: (context: { message: IncomingSlackMessage; isObservation: boolean; waiting: boolean }) =>
    Promise<{ threadTs: string; topic: string } | undefined>;
  /** Cosmetic acknowledgement after authorization/dedup, before the serial wait. */
  onQueued?: (context: SlackTurnRoute & { waiting: boolean }) => Promise<void>;
  /** The lane is acquired; authorization-sensitive turn state may now change. */
  onAccepted?: (context: SlackTurnRoute) => Promise<void>;
  preparePrompt?: (context: { isNewConversation: boolean; afterTs?: string }) => Promise<
    string | { text: string; contextThroughTs?: string }
  >;
  onPiEvent?: (event: RpcRecord) => void;
  onCompleted?: (result: PiTurnResult) => Promise<void>;
  onFailed?: (error: unknown) => Promise<void>;
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
  readonly #openingThreads = new Map<string, Promise<SlackWorkThread | undefined>>();

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

    const sourceKey = conversationKey(message);
    const threadBinding = this.#registry.slackWorkThread(sourceKey);
    const knownWorkThread = delegation ? undefined : threadBinding;
    if (knownWorkThread?.sourceEventId === message.eventId || !this.claimEvent(message.eventId)) {
      return { type: "duplicate" };
    }

    const engaged = this.#registry.threadState(sourceKey).engaged;
    const isObservation = this.#config.role === "manager" &&
      message.kind === "channel-message" && !engaged;
    // A follow-up in the work thread uses the original lane, including while
    // the first turn is being acknowledged. Pi uses the work thread's own key.
    const laneKey = threadBinding ? { ...sourceKey, threadTs: threadBinding.sourceThreadTs } : sourceKey;
    // The lane includes prompt preparation and output finalization, not just Pi.
    const lane = this.#config.pi.transport === "tmux"
      ? `agent:${sourceKey.teamId}:${sourceKey.appId}`
      : serializePiSessionKey(piSessionKey(laneKey, message.userId));
    const sharedManagerChannel = this.#config.role === "manager" &&
      ["channel-message", "app-mention"].includes(message.kind);
    const sharedWorkerThread = this.#config.role === "worker" &&
      ["channel-message", "app-mention"].includes(message.kind);
    const sharedConversation = sharedManagerChannel || sharedWorkerThread || Boolean(delegation);
    // Do not acknowledge a private conversation owned by someone else. Repeat
    // this check inside the lane as ownership may change while we wait.
    const queuedConversation = this.#registry.getConversation(knownWorkThread
      ? { ...sourceKey, threadTs: knownWorkThread.workThreadTs }
      : sourceKey);
    if (queuedConversation && queuedConversation.ownerUserId !== message.userId && !sharedConversation) {
      this.#logger.warn("slack_conversation_owner_mismatch", {
        agentId: this.#config.agentId, eventId: message.eventId, userId: message.userId,
      });
      return { type: "ignored", reason: "conversation-owner-mismatch" };
    }
    const waiting = this.#queue.isPending(lane);
    if (message.kind === "app-mention") this.#registry.engageThread(sourceKey);
    const sourceId = serializeConversationKey(sourceKey);
    let opening = delegation ? undefined : this.#openingThreads.get(sourceId);
    const canOpen = !knownWorkThread && !opening && !delegation && !message.botId && (
      (message.kind === "direct-message" && !message.threadTs && !queuedConversation) ||
      (message.kind === "app-mention" && !engaged)
    );
    const openWorkThread = hooks.resolveWorkThread;
    if (canOpen && openWorkThread) {
      opening = Promise.resolve()
        .then(() => openWorkThread({ message, isObservation, waiting }))
        .then((root) => root && this.#registry.bindSlackWorkThread(sourceKey, message.eventId, root.threadTs, root.topic))
        .catch((error: unknown) => {
          this.#logger.warn("slack_work_thread_open_failed", { agentId: this.#config.agentId, eventId: message.eventId, error });
          return undefined;
        })
        .finally(() => { this.#openingThreads.delete(sourceId); });
      this.#openingThreads.set(sourceId, opening);
    }
    const route = Promise.resolve(knownWorkThread ?? opening).then((workThread): SlackTurnRoute => ({
      isObservation,
      ...(workThread ? {
        threadTs: workThread.workThreadTs,
        workThread: true,
        workThreadCreated: workThread.sourceEventId === message.eventId,
        workThreadTopic: workThread.topic,
      } : {}),
    }));
    // Begin the acknowledgement independently of the predecessor. Register the
    // operation synchronously (no await here), preserving FIFO even if Slack is
    // slow. A failed cosmetic acknowledgement must not suppress actual work.
    const queuedAck = route.then((value) => hooks.onQueued?.({ ...value, waiting }))
      .catch((error: unknown) => {
        this.#logger.warn("slack_queue_ack_failed", { agentId: this.#config.agentId, eventId: message.eventId, error });
      });
    return this.#queue.run(lane, async () => {
      await queuedAck;
      const turnRoute = await route;
      const key = turnRoute.threadTs ? { ...sourceKey, threadTs: turnRoute.threadTs } : sourceKey;
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

      try {
        await hooks.onAccepted?.(turnRoute);
        const ownerUserId = existing?.ownerUserId ?? message.userId;
        const sessionKey =
          existing?.sessionKey ?? serializePiSessionKey(piSessionKey(key, ownerUserId));
        const persistedSession = this.#registry.getPiSession(sessionKey);
        const isNewConversation = this.#config.pi.transport === "tmux"
          ? !existing || !existing.sessionKey.startsWith("agent:")
          : !persistedSession?.piSessionFile;
        const afterTs = isNewConversation ? undefined : this.#registry.threadState(sourceKey).contextTs;
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
          this.#registry.advanceThreadContext(sourceKey, prepared.contextThroughTs);
        }
        await hooks.onCompleted?.(result);
        return { type: "completed", result };
      } catch (error) {
        await hooks.onFailed?.(error);
        throw error;
      }
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
    if (this.#config.role === "manager" && message.kind === "channel-message" && !message.botId &&
        this.#config.interAgent?.peers.some(peer => (message.mentionedUserIds ?? []).includes(peer.botUserId))) {
      return "addressed-to-peer";
    }
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
