import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { AgentConfig } from "../config/schema.js";
import { interAgentSocketPath } from "./environment.js";
import type { Logger } from "../observability/logger.js";
import type { IncomingSlackMessage } from "../routing/chat-key.js";
import type { ConversationKey, Registry } from "../storage/registry.js";
import {
  delegationRequestText,
  incomingDelegationResponse,
  type IncomingDelegationResponse,
  type InterAgentPeer,
} from "./protocol.js";

export interface DelegationSlackMessage {
  channelId: string;
  threadTs: string;
  text: string;
}

export type DelegationSlackSender = (
  message: DelegationSlackMessage,
) => Promise<void>;

export interface DelegationResult {
  delegationId: string;
  workerId: string;
  text: string;
}

interface PendingDelegation {
  peer: InterAgentPeer;
  chunks: Map<number, string>;
  total?: number;
  status?: "ok" | "error";
  resolve: (result: DelegationResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
}

interface DelegationIpcRequest {
  requestId: string;
  conversation: ConversationKey;
  workerId: string;
  task: string;
}

interface DelegationIpcResponse {
  requestId: string;
  ok: boolean;
  result?: DelegationResult;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ipcRequest(value: unknown): DelegationIpcRequest | undefined {
  if (!isRecord(value) || !isRecord(value.conversation)) return undefined;
  const requestId = value.requestId;
  const workerId = value.workerId;
  const task = value.task;
  const conversation = value.conversation;
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9-]{1,100}$/u.test(requestId) ||
    typeof workerId !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/u.test(workerId) ||
    typeof task !== "string" ||
    typeof conversation.teamId !== "string" ||
    typeof conversation.appId !== "string" ||
    typeof conversation.channelId !== "string" ||
    typeof conversation.threadTs !== "string"
  ) {
    return undefined;
  }
  return {
    requestId,
    workerId,
    task,
    conversation: {
      teamId: conversation.teamId,
      appId: conversation.appId,
      channelId: conversation.channelId,
      threadTs: conversation.threadTs,
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Inter-agent delegation failed";
}

export class InterAgentGateway {
  readonly #config: AgentConfig;
  readonly #registry: Registry;
  readonly #logger: Logger;
  readonly #pending = new Map<string, PendingDelegation>();
  readonly #socketPath: string;
  #server: net.Server | undefined;
  #sender: DelegationSlackSender | undefined;
  #stopping = false;
  #ownsSocket = false;

  constructor(config: AgentConfig, registry: Registry, logger: Logger) {
    this.#config = config;
    this.#registry = registry;
    this.#logger = logger;
    this.#socketPath = interAgentSocketPath(config);
  }

  get enabledForManager(): boolean {
    return Boolean(
      this.#config.pi.transport !== "tmux" &&
      this.#config.role === "manager" &&
        this.#config.interAgent?.peers.some((peer) => peer.role === "worker"),
    );
  }

  setSlackSender(sender: DelegationSlackSender): void {
    this.#sender = sender;
  }

  async start(): Promise<void> {
    if (!this.enabledForManager) return;
    if (this.#server) throw new Error("Inter-agent gateway already started");
    this.#stopping = false;
    fs.mkdirSync(path.dirname(this.#socketPath), {
      recursive: true,
      mode: 0o700,
    });
    try {
      const stat = fs.lstatSync(this.#socketPath);
      if (!stat.isSocket()) {
        throw new Error("Inter-agent IPC path exists and is not a socket");
      }
      fs.unlinkSync(this.#socketPath);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }

    const server = net.createServer((socket) => this.#handleSocket(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#socketPath);
    });
    this.#ownsSocket = true;
    fs.chmodSync(this.#socketPath, 0o600);
    this.#logger.info("inter_agent_gateway_started", {
      agentId: this.#config.agentId,
      peerCount: this.#config.interAgent?.peers.length ?? 0,
    });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const [delegationId, pending] of this.#pending) {
      this.#rejectPending(
        delegationId,
        pending,
        new Error("Inter-agent gateway stopped"),
      );
    }
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.#ownsSocket) {
      this.#ownsSocket = false;
      try {
        fs.unlinkSync(this.#socketPath);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }
  }

  parseResponse(
    message: IncomingSlackMessage,
  ): IncomingDelegationResponse | undefined {
    return this.#config.pi.transport === "tmux"
      ? undefined : incomingDelegationResponse(this.#config, message);
  }

  acceptResponse(response: IncomingDelegationResponse): void {
    const pending = this.#pending.get(response.delegationId);
    if (!pending) {
      this.#logger.warn("inter_agent_response_orphaned", {
        agentId: this.#config.agentId,
        workerId: response.peer.agentId,
        delegationId: response.delegationId,
      });
      return;
    }
    if (pending.peer.agentId !== response.peer.agentId) {
      this.#logger.warn("inter_agent_response_peer_mismatch", {
        agentId: this.#config.agentId,
        workerId: response.peer.agentId,
        delegationId: response.delegationId,
      });
      return;
    }
    if (
      (pending.total !== undefined && pending.total !== response.total) ||
      (pending.status !== undefined && pending.status !== response.status)
    ) {
      this.#rejectPending(
        response.delegationId,
        pending,
        new Error("Worker response envelope changed between chunks"),
      );
      return;
    }
    pending.total = response.total;
    pending.status = response.status;
    pending.chunks.set(response.part, response.text);
    const responseChars = [...pending.chunks.values()].reduce(
      (total, chunk) => total + chunk.length,
      0,
    );
    if (responseChars > (this.#config.interAgent?.maxResponseChars ?? 0)) {
      this.#rejectPending(
        response.delegationId,
        pending,
        new Error("Worker response exceeds the configured limit"),
      );
      return;
    }
    if (pending.chunks.size !== response.total) return;

    const parts: string[] = [];
    for (let part = 1; part <= response.total; part += 1) {
      const chunk = pending.chunks.get(part);
      if (chunk === undefined) return;
      parts.push(chunk);
    }
    const text = parts.join("");
    if (response.status === "error") {
      this.#rejectPending(
        response.delegationId,
        pending,
        new Error(text || `Worker ${pending.peer.agentId} failed`),
      );
      return;
    }
    this.#resolvePending(response.delegationId, pending, {
      delegationId: response.delegationId,
      workerId: pending.peer.agentId,
      text,
    });
  }

  isTrustedManagerUser(userId: string): boolean {
    return Boolean(
      this.#config.interAgent?.peers.some(
        (peer) => peer.role === "manager" && peer.botUserId === userId,
      ),
    );
  }

  async delegate(
    conversation: ConversationKey,
    workerId: string,
    taskValue: string,
    signal?: AbortSignal,
  ): Promise<DelegationResult> {
    if (!this.enabledForManager || this.#stopping) {
      throw new Error("Inter-agent delegation is not enabled for this manager");
    }
    const sender = this.#sender;
    if (!sender) throw new Error("Slack inter-agent transport is not ready");
    const peer = this.#config.interAgent?.peers.find(
      (candidate) =>
        candidate.role === "worker" && candidate.agentId === workerId,
    );
    if (!peer) throw new Error(`Unknown or unauthorized worker: ${workerId}`);
    if (
      conversation.teamId !== this.#config.slack.teamId ||
      conversation.appId !== this.#config.slack.appId ||
      !["C", "G"].some((prefix) =>
        conversation.channelId.startsWith(prefix),
      )
    ) {
      throw new Error(
        "Inter-agent delegation requires the originating shared Slack channel thread",
      );
    }
    if (!this.#registry.getConversation(conversation)) {
      throw new Error("The originating Slack conversation is not registered");
    }
    const task = taskValue.trim();
    if (!task) throw new Error("Delegated task must not be empty");
    if (task.length > (this.#config.interAgent?.maxTaskChars ?? 0)) {
      throw new Error("Delegated task exceeds the configured limit");
    }
    if (signal?.aborted) throw new Error("Inter-agent delegation was cancelled");

    const delegationId = crypto.randomUUID();
    let pending: PendingDelegation | undefined;
    const result = new Promise<DelegationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending) {
          this.#rejectPending(
            delegationId,
            pending,
            new Error(`Worker ${workerId} did not respond before timeout`),
          );
        }
      }, this.#config.interAgent?.requestTimeoutMs ?? 0);
      timer.unref();
      const abortListener = signal
        ? () => {
            if (pending) {
              this.#rejectPending(
                delegationId,
                pending,
                new Error("Inter-agent delegation was cancelled"),
              );
            }
          }
        : undefined;
      pending = {
        peer,
        chunks: new Map(),
        resolve,
        reject,
        timer,
        ...(signal ? { signal } : {}),
        ...(abortListener ? { abortListener } : {}),
      };
      this.#pending.set(delegationId, pending);
      if (signal && abortListener) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    this.#logger.info("inter_agent_delegation_started", {
      agentId: this.#config.agentId,
      workerId,
      delegationId,
      channelId: conversation.channelId,
      threadTs: conversation.threadTs,
    });
    try {
      await sender({
        channelId: conversation.channelId,
        threadTs: conversation.threadTs,
        text: delegationRequestText(peer.botUserId, delegationId, task),
      });
    } catch (error) {
      if (pending) {
        this.#rejectPending(
          delegationId,
          pending,
          new Error("Could not send delegation to worker"),
        );
      }
      await result.catch(() => undefined);
      throw new Error("Could not send delegation to worker", { cause: error });
    }

    const completed = await result;
    this.#logger.info("inter_agent_delegation_completed", {
      agentId: this.#config.agentId,
      workerId,
      delegationId,
    });
    return completed;
  }

  #handleSocket(socket: net.Socket): void {
    const controller = new AbortController();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const maxBytes = (this.#config.interAgent?.maxTaskChars ?? 0) * 4 + 4_096;
    let buffer = Buffer.alloc(0);
    let handled = false;
    let completed = false;

    const respond = (response: DelegationIpcResponse) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(response)}\n`, "utf8");
    };
    const fail = (requestId: string, error: unknown) => {
      respond({
        requestId,
        ok: false,
        error: errorMessage(error),
      });
    };
    const handle = async (line: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(line));
      } catch {
        fail("unknown", new Error("Invalid inter-agent IPC request"));
        return;
      }
      const request = ipcRequest(parsed);
      if (!request) {
        fail("unknown", new Error("Invalid inter-agent IPC request"));
        return;
      }
      try {
        const result = await this.delegate(
          request.conversation,
          request.workerId,
          request.task,
          controller.signal,
        );
        completed = true;
        respond({ requestId: request.requestId, ok: true, result });
      } catch (error) {
        completed = true;
        fail(request.requestId, error);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        handled = true;
        fail("unknown", new Error("Inter-agent IPC request is too large"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      handled = true;
      const line = buffer.subarray(0, newline);
      const remainder = buffer.subarray(newline + 1);
      buffer = Buffer.alloc(0);
      if (remainder.some((byte) => ![0x0a, 0x0d, 0x20, 0x09].includes(byte))) {
        fail("unknown", new Error("Only one inter-agent IPC request is allowed"));
        return;
      }
      void handle(line);
    });
    socket.on("end", () => {
      if (!handled) {
        handled = true;
        fail("unknown", new Error("Incomplete inter-agent IPC request"));
      }
    });
    socket.on("error", () => controller.abort());
    socket.on("close", () => {
      if (!completed) controller.abort();
    });
  }

  #resolvePending(
    delegationId: string,
    pending: PendingDelegation,
    result: DelegationResult,
  ): void {
    if (this.#pending.get(delegationId) !== pending) return;
    this.#cleanupPending(delegationId, pending);
    pending.resolve(result);
  }

  #rejectPending(
    delegationId: string,
    pending: PendingDelegation,
    error: Error,
  ): void {
    if (this.#pending.get(delegationId) !== pending) return;
    this.#cleanupPending(delegationId, pending);
    this.#logger.warn("inter_agent_delegation_failed", {
      agentId: this.#config.agentId,
      workerId: pending.peer.agentId,
      delegationId,
      error,
    });
    pending.reject(error);
  }

  #cleanupPending(
    delegationId: string,
    pending: PendingDelegation,
  ): void {
    this.#pending.delete(delegationId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }
}
