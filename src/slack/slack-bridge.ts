import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { AgentConfig } from "../config/schema.js";
import type { SlackCredentials } from "../config/load-config.js";
import type { InterAgentGateway } from "../inter-agent/gateway.js";
import {
  delegationPrompt,
  delegationResponseMessages,
  incomingDelegationRequest,
  type IncomingDelegationRequest,
} from "../inter-agent/protocol.js";
import type { Logger } from "../observability/logger.js";
import type {
  ChatService,
  MessageDisposition,
} from "../routing/chat-service.js";
import type { PiTurnResult, PiUiRequestContext } from "../pi/session-pool.js";
import { EMPTY_TURN_TEXT } from "../pi/turn-text.js";
import { matchAutomaticSelect } from "../pi/ui-policy.js";
import {
  conversationKey,
  serializeConversationKey,
  type IncomingSlackMessage,
} from "../routing/chat-key.js";
import { chunkSlackText } from "./chunk-text.js";
import { SlackConsoleReporter, SlackDeliveryQueue } from "./console-reporter.js";
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
import { toSlackMrkdwn, type DeliveryFailure } from "./pi-progress.js";
import { SlackProgressReporter } from "./progress-reporter.js";
import { SlackUiBroker } from "./slack-ui.js";
import { addSlackThreadContext } from "./thread-context.js";
import type { Registry } from "../storage/registry.js";
import { SlackDelegationPublisher } from "./delegation-publisher.js";

const SLACK_PROGRESS_REQUEST_TIMEOUT_MS = 15_000;

interface DeliveryResult {
  posted: number;
  total: number;
  correlationId?: string;
}

export class SlackBridge {
  readonly delegations: SlackDelegationPublisher | undefined;
  readonly #config: AgentConfig;
  readonly #chatService: ChatService;
  readonly #interAgent: InterAgentGateway;
  readonly #logger: Logger;
  readonly #app: App;
  readonly #connectionMonitor: SlackConnectionMonitor;
  readonly #progressClient: WebClient;
  readonly #botToken: string;
  readonly #uiBroker = new SlackUiBroker();
  readonly #deliveryQueue = new SlackDeliveryQueue();
  readonly #consoleReporters = new Set<SlackConsoleReporter>();
  readonly #delegatedTurns = new Map<string, number>();
  #botUserId: string | undefined;

  constructor(
    config: AgentConfig,
    credentials: SlackCredentials,
    chatService: ChatService,
    interAgent: InterAgentGateway,
    logger: Logger,
    onConnectionFailure: (error: Error) => void,
    registry?: Registry,
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
        unfurl_links: false,
        unfurl_media: false,
        channel: message.channelId,
        thread_ts: message.threadTs,
        text: message.text,
      });
    });
    this.#registerListeners();
    if (registry) this.delegations = new SlackDelegationPublisher(config, registry, this.#deliveryQueue, (channel, thread) => ({
      post: async text => {
        const result = await this.#progressClient.chat.postMessage({ channel, thread_ts: thread, text, unfurl_links: false, unfurl_media: false });
        if (!result.ts) throw new Error("Slack did not return a message timestamp");
        return result.ts;
      },
      update: async (ts, text) => { await this.#progressClient.chat.update({ channel, ts, text }); },
      remove: async ts => { await this.#progressClient.chat.delete({ channel, ts }); },
    }), error => this.#logger.warn("slack_delegation_delivery_failed", { agentId: config.agentId, error }));
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
    await this.delegations?.recover();
  }

  async stop(): Promise<void> {
    this.#connectionMonitor.stop();
    this.#uiBroker.cancelAll();
    this.#deliveryQueue.close();
    await this.delegations?.close();
    await Promise.allSettled([...this.#consoleReporters].map((reporter) => reporter.close()));
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
        unfurl_links: false,
        unfurl_media: false,
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
        unfurl_links: false,
        unfurl_media: false,
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
    let managerObservation =
      this.#config.role === "manager" && message.kind === "channel-message";
    const delegatedRequest = this.#config.pi.transport === "tmux"
      ? undefined : incomingDelegationRequest(this.#config, message);
    const delegatedKey = delegatedRequest
      ? serializeConversationKey(conversationKey(message))
      : undefined;
    let delegatedAccepted = false;
    let workingTs: string | undefined;
    let progressUpdateSequence = 0;
    const progress = new SlackProgressReporter(
      this.#config.slack.progressMode === "console" ? "summary" : this.#config.slack.progressMode,
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
    const consoleReporter = this.#config.slack.progressMode === "console"
      ? new SlackConsoleReporter(this.#deliveryQueue, {
          post: async (text) => {
            const posted = await this.#progressClient.chat.postMessage({
              unfurl_links: false, unfurl_media: false,
              channel: message.channelId, thread_ts: message.threadTs ?? message.ts, text,
            });
            if (!posted.ts) throw new Error("Slack did not return a message timestamp");
            return posted.ts;
          },
          update: async (ts, text) => {
            await this.#progressClient.chat.update({ channel: message.channelId, ts, text });
          },
          remove: async (ts) => {
            await this.#progressClient.chat.delete({ channel: message.channelId, ts });
          },
        }, (error) => this.#logger.warn("slack_console_delivery_failed", {
          agentId: this.#config.agentId, eventId: message.eventId, error,
        }))
      : undefined;
    if (consoleReporter) this.#consoleReporters.add(consoleReporter);
    let acknowledgementAttempted = false;
    const acknowledge = async (context: { isObservation: boolean; waiting?: boolean }): Promise<void> => {
      managerObservation = context.isObservation;
      if (managerObservation || acknowledgementAttempted) return;
      acknowledgementAttempted = true;
      const queuedText = context.waiting
        ? ":hourglass_flowing_sand: Запит отримано й поставлено в чергу. Агент ще обробляє попередній запит; відповість після його завершення."
        : undefined;
      if (consoleReporter) {
        await consoleReporter.start(this.#config.pi.transport === "tmux" || Boolean(context.waiting), queuedText);
        return;
      }
      try {
        const posted = await client.chat.postMessage({
          unfurl_links: false, unfurl_media: false,
          channel: message.channelId, thread_ts: message.threadTs ?? message.ts,
          text: queuedText ?? (this.#config.pi.transport === "tmux"
            ? ":hourglass_flowing_sand: Queued for the agent…" : ":hourglass_flowing_sand: Working…"),
        });
        workingTs = posted.ts;
      } catch (error) {
        this.#logger.warn("slack_placeholder_failed", {
          agentId: this.#config.agentId, eventId: message.eventId, error,
        });
      }
    };
    let finalized = false;
    const finishResponse = async (result: PiTurnResult): Promise<void> => {
      finalized = true;
      const childDelivery = result.runId ? await this.delegations?.finishParent(result.runId) : true;
      let responseText = managerObservation
        ? managerVisibleResponse(result.text)
        : result.text;
      if (childDelivery === false) {
        const notice = "Worker завершив роботу, але доставка його стрічки перервана. Результат доступний менеджеру; вже виконані дії не повторювалися.";
        if (consoleReporter) consoleReporter.record({ type: "public_notice", text: notice });
        else responseText += `\n\n${notice}`;
      }
      if (!responseText) {
        await progress.close();
        this.#logger.info("manager_observation_silent", {
          agentId: this.#config.agentId,
          eventId: message.eventId,
        });
        return;
      }

      if (consoleReporter) {
        try {
          await consoleReporter.complete(responseText, Boolean(delegatedRequest));
        } catch (error) {
          const correlationId = crypto.randomUUID();
          this.#logger.error("slack_response_delivery_failed", {
            agentId: this.#config.agentId, eventId: message.eventId, correlationId, error,
          });
          await client.chat.postMessage({
            unfurl_links: false, unfurl_media: false,
            channel: message.channelId, thread_ts: message.threadTs ?? message.ts,
            text: `Pi completed this request, but Slack delivery was interrupted. Verify the result before repeating actions. Reference: ${correlationId}`,
          }).catch(() => undefined);
        }
        if (!delegatedRequest) return;
      }

      // The answer goes out before the placeholder update, which may wait out
      // Slack rate limits; the placeholder is settled even if delivery throws.
      let delivery: DeliveryResult | undefined;
      try {
        const renderedResponse = toSlackMrkdwn(responseText);
        const outputChunks = delegatedRequest
          ? delegationResponseMessages(delegatedRequest, renderedResponse)
          : chunkSlackText(renderedResponse);
        if (outputChunks.length === 0) outputChunks.push(EMPTY_TURN_TEXT);
        delivery = await this.#deliverResponse(
          message,
          client,
          workingTs,
          delegatedRequest,
          outputChunks,
          Boolean(consoleReporter),
        );
      } finally {
        if (workingTs) await progress.complete(deliveryFailure(delivery));
        else await progress.close();
      }
    };
    try {
      let disposition: MessageDisposition;
      try {
        disposition = await this.#chatService.handleMessage(message, {
          onQueued: acknowledge,
          onAccepted: async (context) => {
            managerObservation = context?.isObservation ?? managerObservation;
            // Queued delegations must not cancel dialogs in the current human turn.
            if (delegatedKey) {
              this.#delegatedTurns.set(delegatedKey, (this.#delegatedTurns.get(delegatedKey) ?? 0) + 1);
              delegatedAccepted = true;
            }
            // Keep UI/delegation state changes inside the lane, but reuse the
            // early acknowledgement instead of posting a second placeholder.
            await acknowledge({ isObservation: managerObservation });
          },
          preparePrompt: async ({ isNewConversation, afterTs }) => {
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
            let contextThroughTs: string | undefined;
            if (isNewConversation || message.kind !== "direct-message" || message.threadTs) {
              try {
                prompt = await addSlackThreadContext(
                  message,
                  currentPrompt,
                  (arguments_) => client.conversations.replies(arguments_),
                  { ...(afterTs ? { afterTs } : {}), ...(this.#botUserId ? { botUserId: this.#botUserId } : {}) },
                );
                contextThroughTs = message.ts;
              } catch (error) {
                this.#logger.warn("slack_thread_context_failed", {
                  agentId: this.#config.agentId,
                  eventId: message.eventId,
                  error,
                });
              }
            }
            return {
              text: managerObservation ? managerObservationPrompt(message, prompt) : prompt,
              ...(contextThroughTs ? { contextThroughTs } : {}),
            };
          },
          onPiEvent: (event) => {
            if (managerObservation) return;
            if (consoleReporter) consoleReporter.record(event);
            else progress.record(event);
          },
          onCompleted: finishResponse,
        });
      } catch (error) {
        const retainProgress = Boolean(workingTs && ["balanced", "informative"].includes(this.#config.slack.progressMode));
        if (!retainProgress) await progress.close();
        if (consoleReporter && !managerObservation) {
          const correlationId = crypto.randomUUID();
          this.#logger.error("slack_message_failed", {
            agentId: this.#config.agentId, eventId: message.eventId, correlationId, error,
          });
          await consoleReporter.fail(`Pi could not complete this request. Reference: ${correlationId}`)
            .catch(() => undefined);
          if (delegatedRequest) await this.#postDelegationError(
            message, client, delegatedRequest, `Worker could not complete the request. Reference: ${correlationId}`,
          );
          return;
        }
        await this.#reportTurnFailure(
          message,
          client,
          workingTs,
          delegatedRequest,
          managerObservation,
          error,
          retainProgress ? progress : undefined,
        );
        return;
      }
      if (disposition.type !== "completed") {
        await progress.close();
        return;
      }
      // Also supports lightweight adapters that don't implement completion hooks.
      if (!finalized) await finishResponse(disposition.result);
    } finally {
      if (consoleReporter) {
        await consoleReporter.close();
        this.#consoleReporters.delete(consoleReporter);
      }
      if (delegatedKey && delegatedAccepted) {
        const remaining = (this.#delegatedTurns.get(delegatedKey) ?? 1) - 1;
        if (remaining > 0) this.#delegatedTurns.set(delegatedKey, remaining);
        else this.#delegatedTurns.delete(delegatedKey);
      }
    }
  }

  async #reportTurnFailure(
    message: IncomingSlackMessage,
    client: App["client"],
    workingTs: string | undefined,
    delegatedRequest: IncomingDelegationRequest | undefined,
    managerObservation: boolean,
    error: unknown,
    progress?: SlackProgressReporter,
  ): Promise<void> {
    const correlationId = crypto.randomUUID();
    this.#logger.error("slack_message_failed", {
      agentId: this.#config.agentId,
      eventId: message.eventId,
      correlationId,
      error,
    });
    if (workingTs && progress) {
      await progress.fail(correlationId);
    } else if (workingTs) {
      await client.chat
        .update({
          channel: message.channelId,
          ts: workingTs,
          text: `Pi could not complete this request. Reference: ${correlationId}`,
        })
        .catch(() => undefined);
    } else if (!managerObservation && !delegatedRequest) {
      // Without a placeholder the human would otherwise see no outcome at all.
      await client.chat
        .postMessage({
          unfurl_links: false,
          unfurl_media: false,
          channel: message.channelId,
          thread_ts: message.threadTs ?? message.ts,
          text: `:x: Pi could not complete this request. Reference: ${correlationId}`,
        })
        .catch(() => undefined);
    }
    if (delegatedRequest) {
      await this.#postDelegationError(
        message,
        client,
        delegatedRequest,
        `Worker could not complete the delegated request. Reference: ${correlationId}`,
      );
    }
  }

  /**
   * Pi has already finished when this runs. A delivery failure must never be
   * reported as a turn failure: that invites a retry which replays tools.
   */
  async #deliverResponse(
    message: IncomingSlackMessage,
    client: App["client"],
    workingTs: string | undefined,
    delegatedRequest: IncomingDelegationRequest | undefined,
    texts: string[],
    consoleDelivery = false,
  ): Promise<DeliveryResult> {
    let posted = 0;
    try {
      for (const text of texts) {
        const payload = {
          unfurl_links: false,
          unfurl_media: false,
          channel: message.channelId,
          thread_ts: message.threadTs ?? message.ts,
          text,
        };
        if (consoleDelivery) {
          await this.#deliveryQueue.send("post", () => this.#progressClient.chat.postMessage(payload));
        } else {
          await client.chat.postMessage(payload);
        }
        posted += 1;
      }
      return { posted, total: texts.length };
    } catch (error) {
      const correlationId = crypto.randomUUID();
      this.#logger.error("slack_response_delivery_failed", {
        agentId: this.#config.agentId,
        eventId: message.eventId,
        correlationId,
        postedParts: posted,
        totalParts: texts.length,
        error,
      });
      // A placeholder reports the failure in its receipt; keep its tools line.
      if (!workingTs) {
        const notice = `:warning: Pi completed this request, but Slack did not accept part ${posted + 1} of ${texts.length} of the response. Reference: ${correlationId}`;
        await client.chat
          .postMessage({
            unfurl_links: false,
            unfurl_media: false,
            channel: message.channelId,
            thread_ts: message.threadTs ?? message.ts,
            text: notice,
          })
          .catch(() => undefined);
      }
      // A later error envelope would conflict with parts the manager already holds.
      if (delegatedRequest && posted === 0) {
        await this.#postDelegationError(
          message,
          client,
          delegatedRequest,
          `Worker completed the delegated request, but its response could not be posted to Slack. Verify the outcome before repeating any mutating step. Reference: ${correlationId}`,
        );
      }
      return { posted, total: texts.length, correlationId };
    }
  }

  async #postDelegationError(
    message: IncomingSlackMessage,
    client: App["client"],
    delegatedRequest: IncomingDelegationRequest,
    failure: string,
  ): Promise<void> {
    for (const text of delegationResponseMessages(
      delegatedRequest,
      failure,
      37_000,
      "error",
    )) {
      await client.chat
        .postMessage({
          unfurl_links: false,
          unfurl_media: false,
          channel: message.channelId,
          thread_ts: message.threadTs ?? message.ts,
          text,
        })
        .catch(() => undefined);
    }
  }
}

function deliveryFailure(
  delivery: DeliveryResult | undefined,
): DeliveryFailure | undefined {
  return delivery?.correlationId
    ? {
        posted: delivery.posted,
        total: delivery.total,
        correlationId: delivery.correlationId,
      }
    : undefined;
}
