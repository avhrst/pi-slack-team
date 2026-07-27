import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import managerWorkerDelegationExtension from "../src/inter-agent/delegate-extension.js";
import {
  INTER_AGENT_CONVERSATION_ENV,
  INTER_AGENT_MAX_TASK_CHARS_ENV,
  INTER_AGENT_SOCKET_ENV,
  INTER_AGENT_WORKERS_ENV,
} from "../src/inter-agent/environment.js";

interface CapturedTool {
  name: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { workerId: string; task: string },
    signal: AbortSignal | undefined,
    onUpdate: ((result: unknown) => void) | undefined,
    context: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

const environmentKeys = [
  INTER_AGENT_SOCKET_ENV,
  INTER_AGENT_CONVERSATION_ENV,
  INTER_AGENT_WORKERS_ENV,
  INTER_AGENT_MAX_TASK_CHARS_ENV,
];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("manager delegation Pi extension", () => {
  it("registers only with bound manager context and returns the IPC result", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-slack-team-extension-"),
    );
    temporaryDirectories.push(directory);
    const socketPath = path.join(directory, "gateway.sock");
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          requestId: string;
          workerId: string;
        };
        socket.end(
          `${JSON.stringify({
            requestId: request.requestId,
            ok: true,
            result: {
              delegationId: "123e4567-e89b-12d3-a456-426614174000",
              workerId: request.workerId,
              text: "completed by worker",
            },
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    process.env[INTER_AGENT_SOCKET_ENV] = socketPath;
    process.env[INTER_AGENT_CONVERSATION_ENV] = Buffer.from(
      JSON.stringify({
        teamId: "T01",
        appId: "A01",
        channelId: "C01",
        threadTs: "123.456",
      }),
    ).toString("base64url");
    process.env[INTER_AGENT_WORKERS_ENV] = '["specialist"]';
    process.env[INTER_AGENT_MAX_TASK_CHARS_ENV] = "30000";

    let tool: CapturedTool | undefined;
    const registerTool = vi.fn((definition: unknown) => {
      tool = definition as CapturedTool;
    });
    managerWorkerDelegationExtension({
      registerTool,
    } as unknown as ExtensionAPI);

    expect(tool?.name).toBe("delegate_to_worker");
    expect(tool?.promptGuidelines?.join(" ")).toContain(
      "do not ask the human to mention",
    );
    const result = await tool!.execute(
      "tool-1",
      { workerId: "specialist", task: "Do the work" },
      undefined,
      undefined,
      {},
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "completed by worker" }],
      details: { workerId: "specialist", status: "completed" },
    });

    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("does not register outside a configured manager child process", () => {
    const registerTool = vi.fn();
    managerWorkerDelegationExtension({
      registerTool,
    } as unknown as ExtensionAPI);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
