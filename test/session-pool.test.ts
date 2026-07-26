import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import { createLogger } from "../src/observability/logger.js";
import {
  PiSessionPool,
  type RpcClientFactory,
  type RpcClientLike,
} from "../src/pi/session-pool.js";
import type {
  RpcClientOptions,
  RpcRecord,
} from "../src/pi/rpc-client.js";
import { Registry, type ConversationKey } from "../src/storage/registry.js";

class FakeClient extends EventEmitter implements RpcClientLike {
  running = false;
  readonly options: RpcClientOptions;
  readonly requests: RpcRecord[] = [];

  constructor(options: RpcClientOptions) {
    super();
    this.options = options;
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async request(command: Record<string, unknown>): Promise<RpcRecord> {
    const record = command as RpcRecord;
    this.requests.push(record);
    if (record.type === "get_session_stats") {
      return {
        type: "response",
        success: true,
        data: {
          sessionFile: this.options.sessionFile ?? "/tmp/new-session.jsonl",
          sessionId: "session-01",
        },
      };
    }
    if (record.type === "prompt") {
      queueMicrotask(() => this.emit("event", { type: "agent_settled" }));
      return { type: "response", success: true };
    }
    if (record.type === "get_last_assistant_text") {
      return {
        type: "response",
        success: true,
        data: { text: "final response" },
      };
    }
    return { type: "response", success: true };
  }

  sendUiResponse(): void {}

  async stop(): Promise<void> {
    this.running = false;
    this.emit("stopped");
  }
}

const temporaryDirectories: string[] = [];

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-team-pool-"));
  temporaryDirectories.push(directory);
  const config = agentConfigSchema.parse({
    version: 1,
    agentId: "support",
    expectedUnixUser: "support-agent",
    stateDir: directory,
    slack: {
      teamId: "T01",
      appId: "A01",
      allowedUserIds: ["U01"],
    },
    pi: {
      command: "/usr/bin/pi",
      cwd: directory,
      agentDir: directory,
      sessionDir: path.join(directory, "sessions"),
      idleTimeoutMs: 10_000,
    },
  });
  const registry = new Registry(path.join(directory, "state.sqlite"));
  const clients: FakeClient[] = [];
  const factory: RpcClientFactory = (options) => {
    const client = new FakeClient(options);
    clients.push(client);
    return client;
  };
  const logger = createLogger(() => undefined);
  const pool = new PiSessionPool(
    config,
    registry,
    logger,
    async () => ({ cancelled: true }),
    factory,
  );
  return { clients, config, registry, pool, factory, logger };
}

const key: ConversationKey = {
  teamId: "T01",
  appId: "A01",
  channelId: "D01",
  threadTs: "123.456",
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PiSessionPool", () => {
  it("persists new session metadata and reuses the active client", async () => {
    const { clients, pool, registry } = setup();
    await expect(pool.prompt(key, "U01", "first")).resolves.toMatchObject({
      text: "final response",
      sessionId: "session-01",
    });
    await pool.prompt(key, "U01", "second");

    expect(clients).toHaveLength(1);
    expect(registry.getConversation(key)).toMatchObject({
      piSessionFile: "/tmp/new-session.jsonl",
      piSessionId: "session-01",
      status: "idle",
    });
    await pool.shutdown();
    registry.close();
  });

  it("resumes the persisted Pi session after pool restart", async () => {
    const { clients, config, pool, registry, factory, logger } = setup();
    await pool.prompt(key, "U01", "first");
    await pool.shutdown();

    const restarted = new PiSessionPool(
      config,
      registry,
      logger,
      async () => ({ cancelled: true }),
      factory,
    );
    await restarted.prompt(key, "U01", "after restart");

    expect(clients).toHaveLength(2);
    expect(clients[1]?.options.sessionFile).toBe("/tmp/new-session.jsonl");
    await restarted.shutdown();
    registry.close();
  });
});
