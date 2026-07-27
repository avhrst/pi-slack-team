import { App, LogLevel } from "@slack/bolt";
import type { AgentConfig } from "../config/schema.js";
import type { SlackCredentials } from "../config/load-config.js";
import type { Logger } from "../observability/logger.js";
import type { ChatService } from "../routing/chat-service.js";
import type { RpcRecord } from "../pi/rpc-client.js";
import type { PiUiRequestContext } from "../pi/session-pool.js";
import type { IncomingSlackMessage } from "../routing/chat-key.js";
import { downloadSlackFiles } from "./file-download.js";
import { parseAppMentionEvent, parseMessageEvent } from "./parse-event.js";
import { PiProgressTranscript, toSlackMrkdwn } from "./pi-progress.js";
import { SlackUiBroker } from "./slack-ui.js";
import { addSlackThreadContext } from "./thread-context.js";

const SLACK_CHUNK_LIMIT = 38_000;
const SLACK_PROGRESS_INTERVAL_MS = 1_000;

function chunks(text: string): string[] {
  if (text.length <= SLACK_CHUNK_LIMIT) return [text];
  const result: string[] = [];
  for (let offset = 0; offset < text.length; offset += SLACK_CHUNK_LIMIT) {
    result.push(text.slice(offset, offset + SLACK_CHUNK_LIMIT));
  }
  return result;
}

class SlackProgressReporter {
  readonly #transcript: PiProgressTranscript;
  readonly #update: (text: string) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  #updates: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #lastUpdateAt = 0;
  #pending = false;
  #closed = false;

  constructor(
    mode: AgentConfig["slack"]["progressMode"],
    update: (text: string) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.#transcript = new PiProgressTranscript(mode);
    this.#update = update;
    this.#onError = onError;
  }

  record(event: RpcRecord): void {
    if (this.#closed || !this.#transcript.record(event)) return;
    this.#pending = true;
    this.#schedule();
  }

  async complete(finalText: string): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = false;
    await this.#updates;
    await this.#runUpdate(this.#transcript.render("completed", finalText));
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending = false;
    await this.#updates;
  }

  #schedule(): void {
    if (this.#timer || this.#closed) return;
    const delay = Math.max(
      0,
      SLACK_PROGRESS_INTERVAL_MS - (Date.now() - this.#lastUpdateAt),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, delay);
    this.#timer.unref();
  }

  #flush(): void {
    if (!this.#pending || this.#closed) return;
    this.#pending = false;
    this.#lastUpdateAt = Date.now();
    this.#updates = this.#runUpdate(this.#transcript.render("working"));
  }

  async #runUpdate(text: string): Promise<void> {
    const update = this.#updates.then(() => this.#update(text));
    const handled = update.catch((error: unknown) => {
      this.#onError(error);
    });
    this.#updates = handled;
    await handled;
  }
}

export class SlackBridge {
  readonly #config: AgentConfig;
  readonly #chatService: ChatService;
  readonly #logger: Logger;
  readonly #app: App;
  readonly #botToken: string;
  readonly #uiBroker = new SlackUiBroker();
  #botUserId: string | undefined;

  constructor(
    config: AgentConfig,
    credentials: SlackCredentials,
    chatService: ChatService,
    logger: Logger,
  ) {
    this.#config = config;
    this.#chatService = chatService;
    this.#botToken = credentials.botToken;
    this.#logger = logger;
    this.#app = new App({
      token: credentials.botToken,
      appToken: credentials.appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
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
    await this.#app.start();
    this.#logger.info("slack_connected", {
      agentId: this.#config.agentId,
      teamId: identity.team_id,
      botUserId: identity.user_id,
    });
  }

  async stop(): Promise<void> {
    this.#uiBroker.cancelAll();
    await this.#app.stop();
  }

  async handlePiUiRequest(
    context: PiUiRequestContext,
  ): Promise<Record<string, unknown>> {
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
      const message = parseMessageEvent(body, event);
      if (message) await this.#routeMessage(message, client);
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
    let workingTs: string | undefined;
    const progress = new SlackProgressReporter(
      this.#config.slack.progressMode,
      async (text) => {
        if (!workingTs) return;
        await client.chat.update({
          channel: message.channelId,
          ts: workingTs,
          text,
        });
      },
      (error) => {
        this.#logger.warn("slack_progress_update_failed", {
          agentId: this.#config.agentId,
          eventId: message.eventId,
          error,
        });
      },
    );
    try {
      const disposition = await this.#chatService.handleMessage(message, {
        onAccepted: async () => {
          const posted = await client.chat.postMessage({
            channel: message.channelId,
            thread_ts: message.threadTs ?? message.ts,
            text: ":hourglass_flowing_sand: Working…",
          });
          workingTs = posted.ts;
        },
        preparePrompt: async ({ isNewConversation }) => {
          const currentPrompt = await downloadSlackFiles(
            this.#config,
            message,
            this.#botToken,
          );
          if (!isNewConversation) return currentPrompt;
          try {
            return await addSlackThreadContext(
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
            return currentPrompt;
          }
        },
        onPiEvent: (event) => progress.record(event),
      });
      if (disposition.type !== "completed" || !workingTs) {
        await progress.close();
        return;
      }

      await progress.complete(disposition.result.text);
      const outputChunks = chunks(toSlackMrkdwn(disposition.result.text));
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
    }
  }
}
