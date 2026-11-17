import type { WebClient } from "@slack/web-api";
import { compactProgressText } from "../pi/activity-progress.js";
import type { IncomingSlackMessage } from "../routing/chat-key.js";
import type { SlackDeliveryQueue } from "./console-reporter.js";
import { decodeSlackEntities, escapeSlackText, unwrapSlackLinks } from "./mrkdwn.js";

type WorkThreadClient = Pick<WebClient, "apiCall"> & {
  chat: Pick<WebClient["chat"], "postMessage" | "update" | "getPermalink">;
};

type SessionStatus = "active" | "processing" | "suspended";
const STATUS = {
  queued: ["⏳", "У черзі"],
  running: ["🔄", "У роботі"],
  waiting: ["🟡", "Очікую на відповідь"],
  complete: ["✅", "Завершено"],
  warning: ["⚠️", "Завершено з попередженням"],
  failed: ["❌", "Запит не завершено"],
} as const;

type HeadingLabel = typeof STATUS[keyof typeof STATUS];
type HeadingView = { status: SessionStatus; label: HeadingLabel; detail?: string };

function publicHeadingText(value: string, limit: number): string {
  const clean = unwrapSlackLinks(decodeSlackEntities(value))
    .replace(/(?:https?:\/\/|mailto:)[^\s<>|]+/giu, "[посилання]")
    .replace(/<(?:@|#|!)[^>]*>/gu, "")
    .replace(/`([^`\n]+)`/gu, (_match, identifier: string) => /^[\w.-]{1,64}$/u.test(identifier)
      ? identifier : "[технічний фрагмент приховано]");
  return compactProgressText(clean, limit).replace(/[\uD800-\uDFFF]/gu, "�");
}

export function slackWorkTopic(prompt: string): string {
  const headline = prompt.trim().split(/\r?\n/u, 1)[0] ?? "";
  return publicHeadingText(headline, 90) || "Запит до агента";
}

function heading(topic: string, [emoji, label]: HeadingLabel, detail?: string): string {
  const summary = detail ? publicHeadingText(detail, 70) : "";
  return `${emoji} ${topic} · ${label}${summary ? ` · ${summary}` : ""}`;
}

function rootContent(title: string) {
  return {
    text: escapeSlackText(title),
    blocks: [{ type: "section" as const, text: { type: "plain_text" as const, text: title } }],
  };
}

function safePermalink(url: string | undefined): string | undefined {
  if (!url || /[<>|\s]/u.test(url) || URL.parse(url)?.protocol !== "https:") return undefined;
  return url;
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}

export async function createSlackWorkThread(
  client: WorkThreadClient,
  queue: SlackDeliveryQueue,
  message: IncomingSlackMessage,
  waiting = false,
): Promise<string> {
  const title = heading(slackWorkTopic(message.text), waiting ? STATUS.queued : STATUS.running);
  const root = await queue.send("post", () => client.chat.postMessage({
    channel: message.channelId,
    ...rootContent(title),
    unfurl_links: false,
    unfurl_media: false,
  }), undefined, true);
  if (!root.ts) throw new Error("Slack did not return the work thread root timestamp");
  return root.ts;
}

/** The bot-owned root provides a readable summary in every client, including when Agent Sessions is unavailable. */
export class SlackWorkThread {
  readonly #topic: string;
  readonly #onError: (error: unknown) => void;
  #acknowledged: Promise<void> | undefined;
  #nativeAvailable = true;
  #nativeStatus: SessionStatus | undefined;
  #nativeTitle: string | undefined;
  #rootTitle: string | undefined;
  #pending: HeadingView | undefined;
  #writing: Promise<void> | undefined;
  #running = false;
  #terminal = false;

  constructor(
    readonly client: WorkThreadClient,
    readonly queue: SlackDeliveryQueue,
    readonly message: IncomingSlackMessage,
    readonly threadTs: string,
    options: { topic?: string; onError?: (error: unknown) => void } = {},
  ) {
    this.#topic = slackWorkTopic(options.topic ?? message.text);
    this.#onError = options.onError ?? (() => undefined);
  }

  acknowledge(waiting: boolean, first: boolean): Promise<void> {
    this.#acknowledged ??= this.#acknowledge(waiting, first);
    return this.#acknowledged;
  }

  async #acknowledge(waiting: boolean, first: boolean): Promise<void> {
    if (first) {
      const title = heading(this.#topic, waiting ? STATUS.queued : STATUS.running);
      this.#rootTitle = title;
      await this.#setStatus("processing", title);
      const reply = await this.#attempt(() => this.#post(this.threadTs, waiting
        ? "⏳ Запит отримано й поставлено в чергу."
        : "🔄 Запит прийнято. Тут з’являтиметься хід роботи."));
      const link = await this.#attempt(() => this.client.chat.getPermalink({
        channel: this.message.channelId,
        message_ts: reply?.ts ?? this.threadTs,
      }));
      const permalink = safePermalink(link?.permalink);
      const origin = this.message.threadTs ?? this.message.ts;
      if (permalink && origin !== this.threadTs) {
        await this.#attempt(() => this.#post(origin, `🧵 <${permalink}|Відкрити хід роботи>`));
      }
    } else if (waiting) {
      await this.#attempt(() => this.#post(this.threadTs, "⏳ Уточнення отримано й поставлено в чергу."));
    }
  }

  running(): Promise<void> {
    if (this.#running || this.#terminal) return this.#writing ?? Promise.resolve();
    this.#running = true;
    return this.#schedule({ status: "processing", label: STATUS.running });
  }

  updateSummary(summary: string): Promise<void> {
    if (!this.#running || this.#terminal || !summary.trim()) return Promise.resolve();
    return this.#schedule({ status: "processing", label: STATUS.running, detail: summary });
  }

  waitingForInput(): Promise<void> {
    if (!this.#running || this.#terminal) return this.#writing ?? Promise.resolve();
    this.#running = false;
    return this.#schedule({ status: "suspended", label: STATUS.waiting });
  }

  complete(summary?: string, warning = false): Promise<void> {
    return this.#finish(warning ? STATUS.warning : STATUS.complete, summary);
  }

  fail(summary?: string): Promise<void> {
    return this.#finish(STATUS.failed, summary);
  }

  #finish(label: HeadingLabel, detail?: string): Promise<void> {
    if (this.#terminal) return this.#writing ?? Promise.resolve();
    this.#terminal = true;
    return this.#schedule({ status: "active", label, ...(detail ? { detail } : {}) });
  }

  #post(threadTs: string, text: string) {
    return this.queue.send("post", () => this.client.chat.postMessage({
      channel: this.message.channelId,
      thread_ts: threadTs,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }), undefined, true);
  }

  #schedule(view: HeadingView): Promise<void> {
    this.#pending = view;
    this.#writing ??= this.#drain();
    return this.#writing;
  }

  async #drain(): Promise<void> {
    try {
      while (this.#pending) {
        const view = this.#pending;
        this.#pending = undefined;
        const title = heading(this.#topic, view.label, view.detail);
        if (this.#rootTitle !== title) {
          await this.#attempt(() => this.queue.send("update", async () => {
            await this.client.chat.update({ channel: this.message.channelId, ts: this.threadTs, ...rootContent(title) });
            this.#rootTitle = title;
          }));
        }
        await this.#setStatus(view.status, title);
        if (this.#nativeAvailable && this.#nativeStatus && this.#nativeTitle !== title) {
          if (await this.#native("agents.sessions.rename", { title })) this.#nativeTitle = title;
        }
      }
    } finally {
      this.#writing = undefined;
    }
  }

  async #setStatus(status: SessionStatus, title: string): Promise<void> {
    if (!this.#nativeAvailable || this.#nativeStatus === status) return;
    const result = await this.#native("agents.sessions.setStatus", {
      status,
      title,
      // Explicitly subscribe the requester when the root belongs to the bot.
      ...(!this.#nativeStatus ? { initiator_user_id: this.message.userId } : {}),
    });
    if (result) {
      this.#nativeStatus = status;
      if ("title" in result && typeof result.title === "string") this.#nativeTitle = result.title;
    }
  }

  async #native(method: "agents.sessions.setStatus" | "agents.sessions.rename", args: Record<string, unknown>) {
    return this.#attempt(async () => {
      try {
        const result = await this.queue.send("update", () => this.client.apiCall(method, {
          channel_id: this.message.channelId,
          thread_ts: this.threadTs,
          ...args,
        }));
        if (!result.ok) throw Object.assign(new Error(`Slack rejected ${method}`), { data: result });
        return result;
      } catch (error) {
        const code = slackErrorCode(error);
        if (["feature_disabled", "missing_scope", "unknown_method", "method_not_found"].includes(code ?? "")) {
          this.#nativeAvailable = false;
        }
        throw error;
      }
    });
  }

  async #attempt<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try { return await operation(); }
    catch (error) { this.#onError(error); return undefined; }
  }
}
