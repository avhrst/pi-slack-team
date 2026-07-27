import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import { interAgentSocketPath } from "../src/inter-agent/environment.js";
import {
  InterAgentGateway,
  type DelegationSlackMessage,
} from "../src/inter-agent/gateway.js";
import type { IncomingDelegationResponse } from "../src/inter-agent/protocol.js";
import { createLogger } from "../src/observability/logger.js";
import { Registry, type ConversationKey } from "../src/storage/registry.js";

const temporaryDirectories: string[] = [];
const delegationPattern =
  /\[pi-slack-team:v1:request:([0-9a-f-]{36})\]/u;

function setup(timeoutMs = 30_000) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-slack-team-inter-agent-"),
  );
  temporaryDirectories.push(directory);
  const config = agentConfigSchema.parse({
    version: 1,
    agentId: "coordinator",
    role: "manager",
    expectedUnixUser: "manager-agent",
    stateDir: directory,
    slack: {
      teamId: "T01",
      appId: "A01",
      allowedUserIds: ["U01"],
    },
    interAgent: {
      peers: [
        {
          agentId: "specialist",
          role: "worker",
          appId: "A02",
          botUserId: "UWORKER",
        },
      ],
      requestTimeoutMs: timeoutMs,
      maxTaskChars: 10_000,
      maxResponseChars: 10_000,
    },
    pi: {
      cwd: directory,
      agentDir: directory,
      sessionDir: path.join(directory, "sessions"),
    },
  });
  const registry = new Registry(path.join(directory, "state.sqlite"));
  const conversation: ConversationKey = {
    teamId: "T01",
    appId: "A01",
    channelId: "C01",
    threadTs: "123.456",
  };
  registry.createConversation(conversation, "U01");
  const gateway = new InterAgentGateway(
    config,
    registry,
    createLogger(() => undefined),
  );
  return { config, conversation, directory, gateway, registry };
}

function response(
  delegationId: string,
  overrides: Partial<IncomingDelegationResponse> = {},
): IncomingDelegationResponse {
  return {
    delegationId,
    status: "ok",
    part: 1,
    total: 1,
    text: "worker result",
    peer: {
      agentId: "specialist",
      role: "worker",
      appId: "A02",
      botUserId: "UWORKER",
    },
    ...overrides,
  };
}

function delegationId(message: DelegationSlackMessage): string {
  const id = delegationPattern.exec(message.text)?.[1];
  if (!id) throw new Error("Delegation ID is missing");
  return id;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("InterAgentGateway", () => {
  it("sends a correlated request and aggregates out-of-order response chunks", async () => {
    const { conversation, gateway, registry } = setup();
    gateway.setSlackSender(async (message) => {
      const id = delegationId(message);
      gateway.acceptResponse(
        response(id, { part: 2, total: 2, text: "result" }),
      );
      gateway.acceptResponse(
        response(id, { part: 1, total: 2, text: "worker " }),
      );
    });

    await expect(
      gateway.delegate(conversation, "specialist", "Do the work"),
    ).resolves.toMatchObject({
      workerId: "specialist",
      text: "worker result",
    });
    await gateway.stop();
    registry.close();
  });

  it("propagates an explicit worker failure", async () => {
    const { conversation, gateway, registry } = setup();
    gateway.setSlackSender(async (message) => {
      gateway.acceptResponse(
        response(delegationId(message), {
          status: "error",
          text: "worker failed safely",
        }),
      );
    });

    await expect(
      gateway.delegate(conversation, "specialist", "Do the work"),
    ).rejects.toThrow("worker failed safely");
    await gateway.stop();
    registry.close();
  });

  it("fails closed for unknown workers and non-channel conversations", async () => {
    const { conversation, gateway, registry } = setup();
    gateway.setSlackSender(async () => undefined);

    await expect(
      gateway.delegate(conversation, "unknown-worker", "Do the work"),
    ).rejects.toThrow("Unknown or unauthorized worker");
    await expect(
      gateway.delegate(
        { ...conversation, channelId: "D01" },
        "specialist",
        "Do the work",
      ),
    ).rejects.toThrow("shared Slack channel thread");
    await gateway.stop();
    registry.close();
  });

  it("serves one bounded delegation request over private Unix IPC", async () => {
    const { conversation, gateway, registry, config } = setup();
    gateway.setSlackSender(async (message) => {
      gateway.acceptResponse(response(delegationId(message)));
    });
    await gateway.start();

    const requestId = "ipc-request-1";
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const socket = net.createConnection(interAgentSocketPath(config));
        let buffer = "";
        socket.once("connect", () => {
          socket.write(
            `${JSON.stringify({
              requestId,
              conversation,
              workerId: "specialist",
              task: "Do the work",
            })}\n`,
          );
        });
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const newline = buffer.indexOf("\n");
          if (newline === -1) return;
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        });
        socket.once("error", reject);
      },
    );

    expect(fs.statSync(interAgentSocketPath(config)).mode & 0o777).toBe(0o600);
    expect(result).toMatchObject({
      requestId,
      ok: true,
      result: { workerId: "specialist", text: "worker result" },
    });
    await gateway.stop();
    registry.close();
  });
});
