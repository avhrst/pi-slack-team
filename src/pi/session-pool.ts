import type { AgentConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import {
  KeyedSerialQueue,
  Semaphore,
} from "../routing/queue.js";
import type {
  ConversationKey,
  ConversationRecord,
  Registry,
} from "../storage/registry.js";
import { serializeConversationKey } from "../routing/chat-key.js";
import { RpcClient, type RpcRecord } from "./rpc-client.js";
import type { RpcClientOptions } from "./rpc-client.js";

export interface PiTurnResult {
  text: string;
  sessionFile: string;
  sessionId: string;
}

export interface PiUiRequestContext {
  conversation: ConversationRecord;
  request: RpcRecord;
}

export type PiUiHandler = (
  context: PiUiRequestContext,
) => Promise<Record<string, unknown>>;

interface SessionHandle {
  client: RpcClientLike;
  sessionFile: string;
  sessionId: string;
  idleTimer?: NodeJS.Timeout;
}

function responseData(record: RpcRecord): Record<string, unknown> {
  return record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : {};
}

export interface RpcClientLike {
  readonly running: boolean;
  start(): Promise<void>;
  request(
    command: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<RpcRecord>;
  sendUiResponse(record: Record<string, unknown>): void;
  stop(graceMs?: number): Promise<void>;
  on(event: "event", listener: (event: RpcRecord) => void): this;
  on(event: "stderr", listener: (text: string) => void): this;
  on(event: "protocolError", listener: (error: Error) => void): this;
  on(event: "unexpectedExit", listener: (details: unknown) => void): this;
  on(event: "stopped", listener: () => void): this;
  off(event: "event", listener: (event: RpcRecord) => void): this;
  off(event: "unexpectedExit", listener: (details: unknown) => void): this;
  off(event: "stopped", listener: () => void): this;
}

export type RpcClientFactory = (options: RpcClientOptions) => RpcClientLike;

export class PiSessionPool {
  readonly #config: AgentConfig;
  readonly #registry: Registry;
  readonly #logger: Logger;
  readonly #queue = new KeyedSerialQueue();
  readonly #semaphore: Semaphore;
  readonly #handles = new Map<string, SessionHandle>();
  readonly #uiHandler: PiUiHandler;
  readonly #clientFactory: RpcClientFactory;

  constructor(
    config: AgentConfig,
    registry: Registry,
    logger: Logger,
    uiHandler: PiUiHandler = async () => ({ cancelled: true }),
    clientFactory: RpcClientFactory = (options) => new RpcClient(options),
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#logger = logger;
    this.#semaphore = new Semaphore(config.pi.maxActiveSessions);
    this.#uiHandler = uiHandler;
    this.#clientFactory = clientFactory;
  }

  async prompt(
    key: ConversationKey,
    ownerUserId: string,
    text: string,
    onEvent?: (event: RpcRecord) => void,
  ): Promise<PiTurnResult> {
    const serialized = serializeConversationKey(key);
    return this.#queue.run(serialized, () =>
      this.#semaphore.run(async () => {
        const conversation =
          this.#registry.getConversation(key) ??
          this.#registry.createConversation(key, ownerUserId);
        if (conversation.ownerUserId !== ownerUserId) {
          throw new Error("Conversation belongs to another Slack user");
        }

        const handle = await this.#getOrStart(key, conversation);
        if (handle.idleTimer) clearTimeout(handle.idleTimer);
        this.#registry.setStatus(key, "running");

        const eventListener = (event: RpcRecord) => {
          onEvent?.(event);
          if (event.type === "extension_ui_request") {
            void this.#handleUiRequest(conversation, handle.client, event);
          }
        };
        handle.client.on("event", eventListener);

        try {
          const settled = this.#waitForSettled(handle.client);
          try {
            await handle.client.request({ type: "prompt", message: text });
            await settled.promise;
          } finally {
            settled.cancel();
          }

          const lastMessage = await handle.client.request({
            type: "get_last_assistant_text",
          });
          const value = responseData(lastMessage).text;
          this.#registry.setStatus(key, "idle");
          this.#scheduleIdle(serialized, handle);
          return {
            text:
              typeof value === "string" && value.trim()
                ? value
                : "Pi completed without a text response.",
            sessionFile: handle.sessionFile,
            sessionId: handle.sessionId,
          };
        } catch (error) {
          this.#registry.setStatus(key, "error");
          this.#logger.error("pi_turn_failed", {
            agentId: this.#config.agentId,
            conversationKey: serialized,
            error,
          });
          await this.#disposeHandle(serialized, handle);
          throw error;
        } finally {
          handle.client.off("event", eventListener);
        }
      }),
    );
  }

  async abort(key: ConversationKey): Promise<void> {
    const serialized = serializeConversationKey(key);
    const handle = this.#handles.get(serialized);
    if (!handle) return;
    await handle.client.request({ type: "abort" }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    const handles = [...this.#handles.entries()];
    await Promise.all(
      handles.map(([key, handle]) => this.#disposeHandle(key, handle)),
    );
  }

  async #getOrStart(
    key: ConversationKey,
    conversation: ConversationRecord,
  ): Promise<SessionHandle> {
    const serialized = serializeConversationKey(key);
    const existing = this.#handles.get(serialized);
    if (existing?.client.running) return existing;

    const client = this.#clientFactory({
      command: this.#config.pi.command,
      cwd: this.#config.pi.cwd,
      agentDir: this.#config.pi.agentDir,
      sessionDir: this.#config.pi.sessionDir,
      requestTimeoutMs: this.#config.pi.requestTimeoutMs,
      ...(conversation.piSessionFile
        ? { sessionFile: conversation.piSessionFile }
        : { sessionName: `slack-${key.threadTs.replace(/\W/g, "-").slice(0, 48)}` }),
    });
    client.on("stderr", () => {
      this.#logger.warn("pi_stderr", {
        agentId: this.#config.agentId,
        conversationKey: serialized,
      });
    });
    client.on("protocolError", () => {
      this.#logger.error("pi_protocol_error", {
        agentId: this.#config.agentId,
        conversationKey: serialized,
      });
    });
    client.on("unexpectedExit", () => {
      this.#logger.error("pi_unexpected_exit", {
        agentId: this.#config.agentId,
        conversationKey: serialized,
      });
      this.#handles.delete(serialized);
    });

    await client.start();
    const stats = responseData(
      await client.request({ type: "get_session_stats" }),
    );
    const sessionFile = stats.sessionFile;
    const sessionId = stats.sessionId;
    if (typeof sessionFile !== "string" || typeof sessionId !== "string") {
      await client.stop();
      throw new Error("Pi did not return persistent session metadata");
    }

    const handle: SessionHandle = { client, sessionFile, sessionId };
    this.#handles.set(serialized, handle);
    this.#registry.setSession(key, sessionFile, sessionId);
    this.#logger.info("pi_session_ready", {
      agentId: this.#config.agentId,
      conversationKey: serialized,
      sessionId,
      resumed: Boolean(conversation.piSessionFile),
    });
    return handle;
  }

  #waitForSettled(client: RpcClientLike): {
    promise: Promise<void>;
    cancel: () => void;
  } {
    let cancel: () => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      const onEvent = (event: RpcRecord) => {
        if (event.type !== "agent_settled") return;
        cleanup();
        resolve();
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Pi exited before the agent settled"));
      };
      const cleanup = () => {
        client.off("event", onEvent);
        client.off("unexpectedExit", onExit);
        client.off("stopped", onExit);
      };
      cancel = cleanup;
      client.on("event", onEvent);
      client.on("unexpectedExit", onExit);
      client.on("stopped", onExit);
    });
    return { promise, cancel };
  }

  async #handleUiRequest(
    conversation: ConversationRecord,
    client: RpcClientLike,
    request: RpcRecord,
  ): Promise<void> {
    if (typeof request.id !== "string") return;
    try {
      const response = await this.#uiHandler({ conversation, request });
      client.sendUiResponse({ id: request.id, ...response });
    } catch {
      client.sendUiResponse({ id: request.id, cancelled: true });
    }
  }

  #scheduleIdle(key: string, handle: SessionHandle): void {
    handle.idleTimer = setTimeout(() => {
      void this.#disposeHandle(key, handle);
    }, this.#config.pi.idleTimeoutMs);
    handle.idleTimer.unref();
  }

  async #disposeHandle(key: string, handle: SessionHandle): Promise<void> {
    if (handle.idleTimer) clearTimeout(handle.idleTimer);
    if (this.#handles.get(key) === handle) this.#handles.delete(key);
    await handle.client.stop();
  }
}
