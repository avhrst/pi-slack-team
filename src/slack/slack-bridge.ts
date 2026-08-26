import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { AgentConfig } from "../config/schema.js";
import type { SlackCredentials } from "../config/load-config.js";
import type { InterAgentGateway } from "../inter-agent/gateway.js";
import {
  delegationPrompt,
  delegationResponseMessages,
  incomingDelegationRequest,
} from "../inter-agent/protocol.js";
import type { Logger } from "../observability/logger.js";
import type { ChatService } from "../routing/chat-service.js";
import type { PiUiRequestContext } from "../pi/session-pool.js";
import { matchAutomaticSelect } from "../pi/ui-policy.js";
import {
  conversationKey,
  serializeConversationKey,
  type IncomingSlackMessage,
} from "../routing/chat-key.js";
import { SlackConnectionMonitor } from "./connection-monitor.js";
import { downloadSlackFiles } from "./file-download.js";
import {
  parseAppMentionEvent,
  parseChannelMessageEvent,
  parseMessageEvent,
} from "./parse-event.js";
import {
  managerObservationContent,
  managerObservationPrompt,
  managerVisibleResponse,
} from "./manager-mode.js";
import { toSlackMrkdwn } from "./pi-progress.js";
import { SlackProgressReporter } from "./progress-reporter.js";
import { SlackUiBroker } from "./slack-ui.js";
import { addSlackThreadContext } from "./thread-context.js";

const SLACK_CHUNK_LIMIT = 38_000;
const SLACK_PROGRESS_REQUEST_TIMEOUT_MS = 15_000;
function chunks(text: string): string[] {
  if (text.length <= SLACK_CHUNK_LIMIT) return [text];
  const result: string[] = [];
  for (let offset = 0; offset < text.length; offset += SLACK_CHUNK_LIMIT) {
    result.push(text.slice(offset, offset + SLACK_CHUNK_LIMIT));
  }
  return result;
}

export class SlackBridge {
  readonly #config: AgentConfig;
  readonly #chatService: ChatService;
  readonly #interAgent: InterAgentGateway;
  readonly #logger: Logger;
  readonly #app: App;
  readonly #connectionMonitor: SlackConnectionMonitor;
  readonly #progressClient: WebClient;
  readonly #botToken: string;
  readonly #uiBroker = new SlackUiBroker();
  readonly #delegatedTurns = new Map<string, number>();
  #botUserId: string | undefined;

  constructor(
    config: AgentConfig,
    credentials: SlackCredentials,
    chatService: ChatService,
    interAgent: InterAgentGateway,
    logger: Logger,
    onConnectionFailure: (error: Error) => void,
  ) {
    this.#config = config;
    this.#chatService = chatService;
    this.#interAgent = interAgent;
    this.#botToken = credentials.botToken;
    this.#logger = logger;
    this.#progressClient = new WebClient(credentials.botToken, {
      logLevel: LogLevel.ERROR,
      timeout: SLACK_PROGRESS_REQUEST_TIMEOUT_MS,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
    });
    const receiver = new SocketModeReceiver({
      appToken: credentials.appToken,
      autoReconnectEnabled: true,
      clientPingTimeout: 5_000,
      serverPingTimeout: 30_000,
      logLevel: LogLevel.ERROR,
    });
    this.#app = new App({
      token: credentials.botToken,
      receiver,
      logLevel: LogLevel.ERROR,
    });
    this.#connectionMonitor = new SlackConnectionMonitor(
      receiver.client,
      config.agentId,
      logger,
      onConnectionFailure,
    );
    this.#interAgent.setSlackSender(async (message) => {
      await this.#app.client.chat.postMessage({
        channel: message.channelId,
        thread_ts: message.threadTs,
        text: message.text,
      });
    });
    this.#registerListeners();
  }

  async start(): Promise<void> {
    const identity = await this.#app.client.auth.test();
    if (identity.team_id !== this.#config.slack.teamId) {
      throw new Error("Slack bot token belongs to a different workspace");
    }
    if (!identity.user_id) {
      throw new Error("Slack auth response did not include a bot user ID");
    }
    this.#botUserId = identity.user_id;
    this.#connectionMonitor.start();
    try {
      await this.#app.start();
    } catch (error) {
      this.#connectionMonitor.stop();
      throw error;
    }
    this.#logger.info("slack_connected", {
      agentId: this.#config.agentId,
      role: this.#config.role,
      teamId: identity.team_id,
      botUserId: identity.user_id,
    });
  }

  async stop(): Promise<void> {
    this.#connectionMonitor.stop();
    this.#uiBroker.cancelAll();
    await this.#app.stop();
  }

  async handlePiUiRequest(
    context: PiUiRequestContext,
  ): Promise<Record<string, unknown>> {
    if (context.signal.aborted) return { cancelled: true };
    const automaticSelect = matchAutomaticSelect(
      this.#config.pi.autoSelect,
      context.request,
    );
    if (automaticSelect) {
      this.#logger.info("pi_ui_auto_selected", {
        agentId: this.#config.agentId,
        ruleIndex: automaticSelect.ruleIndex,
      });
      return automaticSelect.response;
    }

    const key = serializeConversationKey(context.conversation);
    if (
      this.#delegatedTurns.has(key) ||
      this.#interAgent.isTrustedManagerUser(context.conversation.ownerUserId)
    ) {
      return { cancelled: true };
    }
    return this.#uiBroker.request(context, async (text) => {
      await this.#app.client.chat.postMessage({
        channel: context.conversation.channelId,
        thread_ts: context.conversation.threadTs,
        text,
      });
    });
  }

  #registerListeners(): void {
    this.#app.event("message", async ({ body, event, client }) => {
      const directMessage = parseMessageEvent(body, event);
      if (directMessage) {
        await this.#routeMessage(directMessage, client);
        return;
      }
      if (this.#config.role !== "manager") return;
      const channelMessage = parseChannelMessageEvent(
        body,
        event,
        this.#botUserId,
      );
      if (channelMessage) await this.#routeMessage(channelMessage, client);
    });

    this.#app.event("app_mention", async ({ body, event, client }) => {
      if (!this.#botUserId) return;
      const message = parseAppMentionEvent(body, event, this.#botUserId);
      if (message) await this.#routeMessage(message, client);
    });

    this.#app.event("app_home_opened", async () => {
      // Presence only. Opening the Messages tab must never allocate a Pi session.
    });

    this.#app.event("assistant_thread_started", async () => {
      // Session creation remains lazy until the first authorized DM or mention.
    });

    this.#app.error(async (error) => {
      this.#logger.error("slack_runtime_error", {
        agentId: this.#config.agentId,
        error,
      });
    });
  }

  async #routeMessage(
    message: IncomingSlackMessage,
    client: App["client"],
  ): Promise<void> {
    const interAgentResponse = this.#interAgent.parseResponse(message);
    if (interAgentResponse) {
      if (this.#chatService.claimEvent(message.eventId)) {
        this.#interAgent.acceptResponse(interAgentResponse);
      }
      return;
    }
    const uiResult = this.#uiBroker.consume(
      message,
      (eventId) => this.#chatService.claimEvent(eventId),
    );
    if (!uiResult.handled) {
      await this.#handleMessage(message, client);
      return;
    }
    if (uiResult.acknowledgement) {
      await client.chat.postMessage({
        channel: message.channelId,
        thread_ts: message.threadTs ?? message.ts,
        text: uiResult.acknowledgement,
      });
    }
  }

  async #handleMessage(
    message: IncomingSlackMessage,
    client: App["client"],
  ): Promise<void> {
    const managerObservation =
      this.#config.role === "manager" && message.kind === "channel-message";
    const delegatedRequest = incomingDelegationRequest(this.#config, message);
    const delegatedKey = delegatedRequest
      ? serializeConversationKey(conversationKey(message))
      : undefined;
    if (delegatedKey) {
      this.#delegatedTurns.set(
        delegatedKey,
        (this.#delegatedTurns.get(delegatedKey) ?? 0) + 1,
      );
    }
    let workingTs: string | undefined;
    let progressUpdateSequence = 0;
    const progress = new SlackProgressReporter(
      this.#config.slack.progressMode,
      async (text) => {
        if (!workingTs) return;
        const updateSequence = ++progressUpdateSequence;
        const startedAt = Date.now();
        await this.#progressClient.chat.update({
          channel: message.channelId,
          ts: workingTs,
          text,
        });
        this.#logger.debug("slack_progress_updated", {
          agentId: this.#config.agentId,
          eventId: message.eventId,
          updateSequence,
          durationMs: Date.now() - startedAt,
        });
      },
      (error, updateAttempt) => {
        this.#logger.warn("slack_progress_update_failed", {
          agentId: this.#config.agentId,
          eventId: message.eventId,
          progressMode: this.#config.slack.progressMode,
          updateAttempt,
          updateSequence: progressUpdateSequence,
          error,
        });
      },
    );
    try {
      const disposition = await this.#chatService.handleMessage(message, {
        onAccepted: async () => {
          if (managerObservation) return;
          const posted = await client.chat.postMessage({
            channel: message.channelId,
            thread_ts: message.threadTs ?? message.ts,
            text: ":hourglass_flowing_sand: Working…",
          });
          workingTs = posted.ts;
        },
        preparePrompt: async ({ isNewConversation }) => {
          const currentPrompt = delegatedRequest
            ? delegationPrompt(delegatedRequest)
            : managerObservation && !this.#config.slack.fileUploads
              ? managerObservationContent(message)
              : await downloadSlackFiles(
                  this.#config,
                  message,
                  this.#botToken,
                );
          let prompt = currentPrompt;
          if (isNewConversation) {
            try {
              prompt = await addSlackThreadContext(
                message,
                currentPrompt,
                (arguments_) => client.conversations.replies(arguments_),
              );
            } catch (error) {
              this.#logger.warn("slack_thread_context_failed", {
                agentId: this.#config.agentId,
                eventId: message.eventId,
                error,
              });
            }
          }
          return managerObservation
            ? managerObservationPrompt(message, prompt)
            : prompt;
        },
        onPiEvent: (event) => progress.record(event),
      });
      if (disposition.type !== "completed") {
        await progress.close();
        return;
      }

      const responseText = managerObservation
        ? managerVisibleResponse(disposition.result.text)
        : disposition.result.text;
      if (!responseText) {
        await progress.close();
        this.#logger.info("manager_observation_silent", {
          agentId: this.#config.agentId,
          eventId: message.eventId,
        });
        return;
      }

      if (workingTs) await progress.complete(responseText);
      else await progress.close();
      const renderedResponse = toSlackMrkdwn(responseText);
      const outputChunks = delegatedRequest
        ? delegationResponseMessages(delegatedRequest, renderedResponse)
        : chunks(renderedResponse);
      if (outputChunks.length === 0) {
        outputChunks.push("Pi completed without a text response.");
      }
      for (const text of outputChunks) {
        await client.chat.postMessage({
          channel: message.channelId,
          thread_ts: message.threadTs ?? message.ts,
          text,
        });
      }
    } catch (error) {
      await progress.close();
      const correlationId = crypto.randomUUID();
      this.#logger.error("slack_message_failed", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
        correlationId,
        error,
      });
      if (workingTs) {
        await client.chat
          .update({
            channel: message.channelId,
            ts: workingTs,
            text: `Pi could not complete this request. Reference: ${correlationId}`,
          })
          .catch(() => undefined);
      }
      if (delegatedRequest) {
        const failure = `Worker could not complete the delegated request. Reference: ${correlationId}`;
        for (const text of delegationResponseMessages(
          delegatedRequest,
          failure,
          37_000,
          "error",
        )) {
          await client.chat
            .postMessage({
              channel: message.channelId,
              thread_ts: message.threadTs ?? message.ts,
              text,
            })
            .catch(() => undefined);
        }
      }
    } finally {
      if (delegatedKey) {
        const remaining = (this.#delegatedTurns.get(delegatedKey) ?? 1) - 1;
        if (remaining > 0) this.#delegatedTurns.set(delegatedKey, remaining);
        else this.#delegatedTurns.delete(delegatedKey);
      }
    }
  }
}
