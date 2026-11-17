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
  MessageHooks,
  MessageDisposition,
} from "../routing/chat-service.js";
import type { PiTurnResult, PiUiRequestContext } from "../pi/session-pool.js";
import { toolActivity } from "../pi/activity-progress.js";
import { EMPTY_TURN_TEXT } from "../pi/turn-text.js";
import { matchAutomaticSelect } from "../pi/ui-policy.js";
import {
  conversationKey,
  serializeConversationKey,
  type IncomingSlackMessage,
} from "../routing/chat-key.js";
import { chunkSlackText } from "./chunk-text.js";
import { definiteSlackRejection, SlackDeliveryQueue } from "./console-reporter.js";
import { SlackConnectionMonitor } from "./connection-monitor.js";
import { SlackLiveThreadReporter } from "./live-thread-reporter.js";
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
import { toSlackMrkdwn, type DeploymentSnapshot } from "./pi-progress.js";
import { SlackUiBroker } from "./slack-ui.js";
import { addSlackThreadContext } from "./thread-context.js";
import type { Registry } from "../storage/registry.js";
import { SlackDelegationPublisher } from "./delegation-publisher.js";
import { createSlackWorkThread, slackWorkTopic, SlackWorkThread } from "./work-thread.js";

const SLACK_PROGRESS_REQUEST_TIMEOUT_MS = 15_000;

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
  readonly #liveReporters = new Set<SlackLiveThreadReporter>();
  readonly #activeWorkThreads = new Map<string, { thread: SlackWorkThread; reporter: SlackLiveThreadReporter }>();
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
    if (registry) this.delegations = new SlackDelegationPublisher(registry, this.#deliveryQueue, (channel, thread) => ({
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
    await Promise.allSettled([...this.#liveReporters].map((reporter) => reporter.close()));
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
    const work = this.#activeWorkThreads.get(key);
    let pending = true;
    let waiting: Promise<void> | undefined;
    const reportStatusError = (error: unknown): void => this.#logger.warn("slack_dialog_status_failed", {
      agentId: this.#config.agentId, error,
    });
    try {
      return await this.#uiBroker.request(context, async (text) => {
        await this.#app.client.chat.postMessage({
          unfurl_links: false,
          unfurl_media: false,
          channel: context.conversation.channelId,
          thread_ts: context.conversation.threadTs,
          text,
        });
        if (work) {
          waiting = work.reporter.pause().then(async () => {
            if (pending && !context.signal.aborted) await work.thread.waitingForInput();
          }).catch(reportStatusError);
        }
      });
    } finally {
      pending = false;
      if (work && waiting) void waiting.then(async () => {
        if (context.signal.aborted) return;
        await work.thread.running();
        work.reporter.resume();
      }).catch(reportStatusError);
    }
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
    let threadTs = message.threadTs ?? message.ts;
    let workThread: SlackWorkThread | undefined;
    let activeWorkKey: string | undefined;
    let live: SlackLiveThreadReporter | undefined;
    const finishedSteps = new Map<string, boolean>();
    let acknowledgementAttempted = false;
    const reportError = (error: unknown): void => this.#logger.warn("slack_work_thread_delivery_failed", {
      agentId: this.#config.agentId, eventId: message.eventId, threadTs, error,
    });
    const acknowledge: NonNullable<MessageHooks["onQueued"]> = async (context) => {
      managerObservation = context.isObservation;
      if (managerObservation || acknowledgementAttempted) return;
      acknowledgementAttempted = true;
      if (context.threadTs && context.workThread) {
        threadTs = context.threadTs;
        workThread = new SlackWorkThread(this.#progressClient, this.#deliveryQueue, message, threadTs, {
          ...(context.workThreadTopic ? { topic: context.workThreadTopic } : {}),
          onError: reportError,
        });
        await workThread.acknowledge(context.waiting, Boolean(context.workThreadCreated)).catch(reportError);
      } else if (context.waiting && !delegatedRequest) {
        await this.#deliveryQueue.send("post", () => this.#progressClient.chat.postMessage({
          channel: message.channelId, thread_ts: threadTs,
          text: "⏳ Запит отримано й поставлено в чергу. Агент ще обробляє попередній запит.",
          unfurl_links: false, unfurl_media: false,
        }), undefined, true).catch(reportError);
      }
    };
    const openLive = (): SlackLiveThreadReporter => {
      if (!live) {
        live = new SlackLiveThreadReporter({
          client: this.#progressClient, queue: this.#deliveryQueue, message, threadTs,
          nativeStreaming: Boolean(workThread) && !delegatedRequest, onError: reportError,
        });
        this.#liveReporters.add(live);
      }
      return live;
    };
    let finalized = false;
    const finishResponse = async (result: PiTurnResult): Promise<void> => {
      finalized = true;
      const childDelivery = !result.runId || await this.delegations?.finishParent(result.runId).catch((error: unknown) => {
        reportError(error);
        return false;
      }) !== false;
      const responseText = managerObservation ? managerVisibleResponse(result.text) : result.text;
      if (managerObservation) {
        for (const text of responseText ? chunkSlackText(toSlackMrkdwn(responseText)) : []) {
          try {
            await this.#deliveryQueue.send("post", () => this.#progressClient.chat.postMessage({
              channel: message.channelId, thread_ts: threadTs, text,
              unfurl_links: false, unfurl_media: false,
            }), undefined, true);
          } catch (error) {
            reportError(error);
            break;
          }
        }
        return;
      }

      const reporter = openLive();
      if (!childDelivery) reporter.record({
        type: "public_notice",
        text: "⚠️ Профільний агент завершив роботу. Доставку його стрічки перервано.",
      });
      let responseDelivered = true;
      try {
        if (delegatedRequest) {
          await reporter.finishProgress().catch(reportError);
          await this.#deliverDelegationResponse(message, client, delegatedRequest, responseText || EMPTY_TURN_TEXT);
        } else {
          await reporter.complete(responseText || EMPTY_TURN_TEXT);
        }
      } catch (error) {
        responseDelivered = false;
        const correlationId = crypto.randomUUID();
        this.#logger.error("slack_response_delivery_failed", {
          agentId: this.#config.agentId, eventId: message.eventId, correlationId, error,
        });
        await this.#deliveryQueue.send("post", () => this.#progressClient.chat.postMessage({
          channel: message.channelId, thread_ts: threadTs,
          text: `⚠️ Pi завершив роботу. Доставку результату в Slack перервано. Код звернення: ${correlationId}`,
          unfurl_links: false, unfurl_media: false,
        }), undefined, true).catch(reportError);
      } finally {
        const snapshot = reporter.deployment;
        const failedSteps = [...finishedSteps.values()].filter(Boolean).length;
        const stepSummary = finishedSteps.size ? `Кроків виконано: ${finishedSteps.size} · невдалих: ${failedSteps}` : undefined;
        const summary = responseDelivered ? deploymentSummary(snapshot) ?? stepSummary : "Доставку результату перервано";
        await workThread?.complete(summary, !responseDelivered || !childDelivery ||
          Boolean(snapshot && (snapshot.pending || snapshot.fail || snapshot.warn || snapshot.skip))).catch(reportError);
      }
    };
    let failureReported = false;
    const failTurn = async (error: unknown): Promise<void> => {
      if (failureReported) return;
      failureReported = true;
      const correlationId = crypto.randomUUID();
      this.#logger.error("slack_message_failed", {
        agentId: this.#config.agentId, eventId: message.eventId, correlationId, error,
      });
      if (delegatedRequest) {
        await live?.finishProgress().catch(reportError);
        await this.#postDelegationError(message, client, delegatedRequest,
          `Профільний агент не завершив запит. Код звернення: ${correlationId}`);
      } else if (!managerObservation) {
        await openLive().fail(`Pi не завершив запит. Код звернення: ${correlationId}`).catch(reportError);
        await workThread?.fail().catch(reportError);
      }
    };
    try {
      const disposition: MessageDisposition = await this.#chatService.handleMessage(message, {
        resolveWorkThread: async ({ waiting }) => ({
          threadTs: await createSlackWorkThread(this.#progressClient, this.#deliveryQueue, message, waiting),
          topic: slackWorkTopic(message.text),
        }),
        onQueued: acknowledge,
        onAccepted: async (context) => {
          if (context) await acknowledge({ ...context, waiting: false });
          if (delegatedKey) {
            this.#delegatedTurns.set(delegatedKey, (this.#delegatedTurns.get(delegatedKey) ?? 0) + 1);
            delegatedAccepted = true;
          }
          if (!managerObservation) openLive();
          if (workThread) {
            activeWorkKey = serializeConversationKey({ ...conversationKey(message), threadTs });
            this.#activeWorkThreads.set(activeWorkKey, { thread: workThread, reporter: openLive() });
          }
          await workThread?.running().catch(reportError);
        },
        preparePrompt: async ({ isNewConversation, afterTs }) => {
          const currentPrompt = delegatedRequest
            ? delegationPrompt(delegatedRequest)
            : managerObservation && !this.#config.slack.fileUploads
              ? managerObservationContent(message)
              : await downloadSlackFiles(this.#config, message, this.#botToken);
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
                agentId: this.#config.agentId, eventId: message.eventId, error,
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
          if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
            finishedSteps.set(event.toolCallId, event.isError === true);
          }
          const reporter = openLive();
          const previous = deploymentSummary(reporter.deployment);
          reporter.record(event);
          const current = deploymentSummary(reporter.deployment);
          if (current && current !== previous) void workThread?.updateSummary(current).catch(reportError);
          else if (!current && event.type === "tool_execution_start") {
            void workThread?.updateSummary(toolActivity(event.toolName)).catch(reportError);
          }
        },
        onCompleted: finishResponse,
        onFailed: failTurn,
      });
      if (disposition.type === "completed" && !finalized) await finishResponse(disposition.result);
    } catch (error) {
      await failTurn(error);
    } finally {
      if (activeWorkKey && this.#activeWorkThreads.get(activeWorkKey)?.thread === workThread) {
        this.#activeWorkThreads.delete(activeWorkKey);
      }
      if (live) {
        await live.close();
        this.#liveReporters.delete(live);
      }
      if (delegatedKey && delegatedAccepted) {
        const remaining = (this.#delegatedTurns.get(delegatedKey) ?? 1) - 1;
        if (remaining > 0) this.#delegatedTurns.set(delegatedKey, remaining);
        else this.#delegatedTurns.delete(delegatedKey);
      }
    }
  }

  async #deliverDelegationResponse(
    message: IncomingSlackMessage,
    client: App["client"],
    request: IncomingDelegationRequest,
    response: string,
  ): Promise<void> {
    let posted = 0;
    try {
      for (const text of delegationResponseMessages(request, toSlackMrkdwn(response))) {
        await this.#deliveryQueue.send("post", () => this.#progressClient.chat.postMessage({
          channel: message.channelId, thread_ts: message.threadTs ?? message.ts, text,
          unfurl_links: false, unfurl_media: false,
        }), undefined, true);
        posted++;
      }
    } catch (error) {
      // Do not send a conflicting envelope if Slack may already have a result.
      if (!posted && definiteSlackRejection(error)) {
        await this.#postDelegationError(message, client, request,
          "Роботу завершено. Slack відхилив відповідь. Перевірте результат перед повторенням дій.");
      }
      throw error;
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

function deploymentSummary(snapshot: DeploymentSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  return `${snapshot.completed}/${snapshot.planned} операцій · OK ${snapshot.ok} · ⚠️ ${snapshot.warn} · ❌ ${snapshot.fail} · пропущено ${snapshot.skip}`;
}
