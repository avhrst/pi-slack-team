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
  readonly uiResponses: Record<string, unknown>[] = [];

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

  sendUiResponse(record: Record<string, unknown>): void {
    if (!this.running) throw new Error("Pi RPC process is not running");
    this.uiResponses.push(record);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.emit("stopped");
  }
}

class DeferredClient extends FakeClient {
  override async request(
    command: Record<string, unknown>,
  ): Promise<RpcRecord> {
    if (command.type !== "prompt") return super.request(command);
    this.requests.push(command as RpcRecord);
    return { type: "response", success: true };
  }

  settle(): void {
    this.emit("event", { type: "agent_settled" });
  }
}

class DialogExitClient extends FakeClient {
  override async request(
    command: Record<string, unknown>,
  ): Promise<RpcRecord> {
    if (command.type !== "prompt") return super.request(command);
    this.requests.push(command as RpcRecord);
    queueMicrotask(() => {
      this.emit("event", {
        type: "extension_ui_request",
        id: "dialog-1",
        method: "confirm",
        title: "Continue?",
        message: "Run the operation",
      });
      queueMicrotask(() => {
        this.running = false;
        this.emit("unexpectedExit", { code: 1, signal: null });
        this.emit("stopped");
      });
    });
    return { type: "response", success: true };
  }
}

const temporaryDirectories: string[] = [];

function setup(
  piOverrides: Partial<{
    maxActiveSessions: number;
    maxConcurrentTurns: number;
    maxResidentProcesses: number;
    idleTimeoutMs: number;
  }> = {},
) {
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
      ...piOverrides,
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

  it("reuses one process for different DM roots from the same user", async () => {
    const { clients, pool, registry } = setup();
    await pool.prompt(key, "U01", "first root");
    await pool.prompt({ ...key, threadTs: "789.000" }, "U01", "second root");

    expect(clients).toHaveLength(1);
    expect(
      registry.getConversation({ ...key, threadTs: "789.000" })?.sessionKey,
    ).toBe(registry.getConversation(key)?.sessionKey);
    await pool.shutdown();
    registry.close();
  });

  it("uses different processes for different users and channel threads", async () => {
    const { clients, pool, registry } = setup();
    await pool.prompt(key, "U01", "user one");
    await pool.prompt(
      { ...key, channelId: "D02", threadTs: "222.000" },
      "U02",
      "user two",
    );
    await pool.prompt(
      { ...key, channelId: "C01", threadTs: "333.000" },
      "U01",
      "thread one",
    );
    await pool.prompt(
      { ...key, channelId: "C01", threadTs: "444.000" },
      "U01",
      "thread two",
    );

    expect(clients).toHaveLength(4);
    await pool.shutdown();
    registry.close();
  });

  it("runs different user sessions concurrently", async () => {
    const { config, registry, logger } = setup({
      maxConcurrentTurns: 2,
      maxResidentProcesses: 2,
    });
    const clients: DeferredClient[] = [];
    const pool = new PiSessionPool(
      config,
      registry,
      logger,
      async () => ({ cancelled: true }),
      (options) => {
        const client = new DeferredClient(options);
        clients.push(client);
        return client;
      },
    );

    const first = pool.prompt(key, "U01", "first");
    const second = pool.prompt(
      { ...key, channelId: "D02", threadTs: "222.000" },
      "U02",
      "second",
    );
    await vi.waitFor(() => {
      expect(clients).toHaveLength(2);
      expect(
        clients.every((client) =>
          client.requests.some((request) => request.type === "prompt"),
        ),
      ).toBe(true);
    });
    clients.forEach((client) => client.settle());
    await Promise.all([first, second]);

    await pool.shutdown();
    registry.close();
  });

  it("hibernates the least-recent idle process at resident capacity", async () => {
    const { clients, pool, registry } = setup({
      maxConcurrentTurns: 1,
      maxResidentProcesses: 1,
    });
    const channelKey = { ...key, channelId: "C01" };
    await pool.prompt(key, "U01", "direct");
    await pool.prompt(channelKey, "U01", "channel");

    expect(clients).toHaveLength(2);
    expect(clients[0]?.running).toBe(false);
    expect(clients[1]?.running).toBe(true);

    await pool.prompt(key, "U01", "resume direct");
    expect(clients).toHaveLength(3);
    expect(clients[2]?.options.sessionFile).toBe("/tmp/new-session.jsonl");
    await pool.shutdown();
    registry.close();
  });

  it("can retain the first owner for an authorized shared manager thread", async () => {
    const { clients, pool, registry } = setup();
    const channelKey = { ...key, channelId: "C01" };
    registry.createConversation(channelKey, "U01");

    await expect(
      pool.prompt(channelKey, "U02", "blocked by default"),
    ).rejects.toThrow("another Slack user");
    await expect(
      pool.prompt(channelKey, "U02", "manager turn", undefined, true),
    ).resolves.toMatchObject({ text: "final response" });

    expect(clients).toHaveLength(1);
    expect(registry.getConversation(channelKey)?.ownerUserId).toBe("U01");
    await pool.shutdown();
    registry.close();
  });

  it("loads the manager delegation extension with bound conversation context", async () => {
    const { clients, config, registry, factory, logger } = setup();
    const managerConfig = agentConfigSchema.parse({
      ...config,
      role: "manager",
      interAgent: {
        peers: [
          {
            agentId: "specialist",
            role: "worker",
            appId: "A02",
            botUserId: "UWORKER",
          },
        ],
      },
    });
    const managerPool = new PiSessionPool(
      managerConfig,
      registry,
      logger,
      async () => ({ cancelled: true }),
      factory,
    );
    const channelKey = { ...key, channelId: "C01" };

    await managerPool.prompt(channelKey, "U01", "delegate this");

    expect(clients[0]?.options.extensionPaths?.[0]).toMatch(
      /inter-agent\/delegate-extension\.js$/u,
    );
    expect(clients[0]?.options.environment).toMatchObject({
      PI_SLACK_TEAM_INTER_AGENT_WORKERS: '["specialist"]',
      PI_SLACK_TEAM_INTER_AGENT_MAX_TASK_CHARS: "30000",
    });
    const encoded = clients[0]?.options.environment?.[
      "PI_SLACK_TEAM_INTER_AGENT_CONVERSATION"
    ];
    expect(
      JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8")),
    ).toEqual(channelKey);

    await managerPool.prompt(key, "U01", "DM cannot host another app");
    expect(clients[1]?.options.extensionPaths).toBeUndefined();
    await managerPool.shutdown();
    registry.close();
  });

  it("cancels a pending UI request when its RPC client exits", async () => {
    const { config, registry, logger } = setup();
    const clients: DialogExitClient[] = [];
    let uiSignal: AbortSignal | undefined;
    const pool = new PiSessionPool(
      config,
      registry,
      logger,
      async ({ signal }) => {
        uiSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ cancelled: true }),
            { once: true },
          );
        });
      },
      (options) => {
        const client = new DialogExitClient(options);
        clients.push(client);
        return client;
      },
    );

    await expect(pool.prompt(key, "U01", "first")).rejects.toThrow(
      "Pi exited before the agent settled",
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(uiSignal?.aborted).toBe(true);
    expect(clients[0]?.uiResponses).toEqual([]);
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
