import { conversationKey, type IncomingSlackMessage } from "../routing/chat-key.js";
import { serializeConversationKey } from "../routing/chat-key.js";
import type { PiUiRequestContext } from "../pi/session-pool.js";

const DEFAULT_DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_DIALOG_TIMEOUT_MS = 1_000;
const MAX_DIALOG_TIMEOUT_MS = 10 * 60 * 1000;
const CANCEL_WORDS = new Set(["cancel", "скасувати", "відміна", "відмінити"]);

interface PendingDialog {
  method: string;
  ownerUserId: string;
  options: string[];
  resolve: (response: Record<string, unknown>) => void;
  timer: NodeJS.Timeout;
}

export interface SlackUiMessageResult {
  handled: boolean;
  acknowledgement?: string;
}

function dialogTimeout(request: Record<string, unknown>): number {
  const requested = typeof request.timeout === "number"
    ? request.timeout
    : DEFAULT_DIALOG_TIMEOUT_MS;
  return Math.min(MAX_DIALOG_TIMEOUT_MS, Math.max(MIN_DIALOG_TIMEOUT_MS, requested - 1_000));
}

function requestText(request: Record<string, unknown>): string | undefined {
  const method = request.method;
  const title = typeof request.title === "string" ? request.title.trim() : "Pi confirmation";
  if (method === "select") {
    const options = Array.isArray(request.options)
      ? request.options.filter((option): option is string => typeof option === "string")
      : [];
    if (options.length === 0) return undefined;
    return [
      `*${title}*`,
      ...options.map((option, index) => `${index + 1}. ${option}`),
      "Reply in this thread with the option number. Reply `cancel` to cancel.",
    ].join("\n");
  }
  if (method === "confirm") {
    const message = typeof request.message === "string" ? request.message.trim() : "";
    return [`*${title}*`, message, "Reply `yes` or `no`. Reply `cancel` to cancel."]
      .filter(Boolean)
      .join("\n");
  }
  if (method === "input" || method === "editor") {
    return `*${title}*\nReply in this thread with the requested value. Reply \`cancel\` to cancel.`;
  }
  return undefined;
}

export class SlackUiBroker {
  readonly #pending = new Map<string, PendingDialog>();

  async request(
    context: PiUiRequestContext,
    post: (text: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const text = requestText(context.request);
    if (!text || typeof context.request.method !== "string") {
      return { cancelled: true };
    }

    const key = serializeConversationKey(context.conversation);
    if (this.#pending.has(key)) return { cancelled: true };

    let pending: PendingDialog | undefined;
    const response = new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.get(key) !== pending) return;
        this.#pending.delete(key);
        resolve({ cancelled: true });
      }, dialogTimeout(context.request));
      timer.unref();
      pending = {
        method: context.request.method as string,
        ownerUserId: context.conversation.ownerUserId,
        options: Array.isArray(context.request.options)
          ? context.request.options.filter((option): option is string => typeof option === "string")
          : [],
        resolve,
        timer,
      };
      this.#pending.set(key, pending);
    });

    try {
      await post(text);
    } catch (error) {
      if (this.#pending.get(key) === pending) this.#pending.delete(key);
      if (pending) clearTimeout(pending.timer);
      pending?.resolve({ cancelled: true });
      throw error;
    }
    return response;
  }

  consume(message: IncomingSlackMessage): SlackUiMessageResult {
    const key = serializeConversationKey(conversationKey(message));
    const pending = this.#pending.get(key);
    if (!pending || message.userId !== pending.ownerUserId || message.botId) {
      return { handled: false };
    }

    const answer = message.text.trim();
    const normalized = answer.toLocaleLowerCase();
    if (CANCEL_WORDS.has(normalized)) {
      this.#resolve(key, pending, { cancelled: true });
      return { handled: true, acknowledgement: "APEXlang choice cancelled." };
    }

    if (pending.method === "select") {
      const numeric = /^\d+$/.test(answer) ? Number(answer) : 0;
      const exactIndex = pending.options.findIndex(
        (option) => option.toLocaleLowerCase() === normalized,
      );
      const index = numeric > 0 ? numeric - 1 : exactIndex;
      const value = pending.options[index];
      if (!value) {
        return {
          handled: true,
          acknowledgement: `Invalid choice. Reply with a number from 1 to ${pending.options.length}, or \`cancel\`.`,
        };
      }
      this.#resolve(key, pending, { value });
      return { handled: true, acknowledgement: `Choice accepted: *${value}*` };
    }

    if (pending.method === "confirm") {
      if (["yes", "y", "так"].includes(normalized)) {
        this.#resolve(key, pending, { confirmed: true });
        return { handled: true, acknowledgement: "Confirmation accepted." };
      }
      if (["no", "n", "ні"].includes(normalized)) {
        this.#resolve(key, pending, { confirmed: false });
        return { handled: true, acknowledgement: "Confirmation declined." };
      }
      return {
        handled: true,
        acknowledgement: "Invalid response. Reply `yes`, `no`, or `cancel`.",
      };
    }

    if (!answer) {
      return { handled: true, acknowledgement: "A non-empty response is required." };
    }
    this.#resolve(key, pending, { value: answer });
    return { handled: true, acknowledgement: "Response accepted." };
  }

  cancelAll(): void {
    for (const [key, pending] of this.#pending) {
      this.#resolve(key, pending, { cancelled: true });
    }
  }

  #resolve(
    key: string,
    pending: PendingDialog,
    response: Record<string, unknown>,
  ): void {
    if (this.#pending.get(key) !== pending) return;
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }
}
