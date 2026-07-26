import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  RpcClient,
  type RpcRecord,
  type RpcSpawner,
} from "../src/pi/rpc-client.js";

class FakeRpcProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  #inputBuffer = Buffer.alloc(0);

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.#consume(chunk));
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }

  #consume(chunk: Buffer): void {
    this.#inputBuffer = Buffer.concat([this.#inputBuffer, chunk]);
    let newline = this.#inputBuffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.#inputBuffer.subarray(0, newline);
      this.#inputBuffer = this.#inputBuffer.subarray(newline + 1);
      if (line.length > 0) {
        const record = JSON.parse(line.toString("utf8")) as RpcRecord;
        this.#handle(record);
      }
      newline = this.#inputBuffer.indexOf(0x0a);
    }
  }

  #send(record: RpcRecord, split = false): void {
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (!split) {
      this.stdout.write(encoded);
      return;
    }
    const middle = Math.floor(encoded.length / 2);
    this.stdout.write(encoded.subarray(0, middle));
    queueMicrotask(() => this.stdout.write(encoded.subarray(middle)));
  }

  #handle(record: RpcRecord): void {
    const id = record.id;
    if (record.type === "get_session_stats") {
      this.#send(
        {
          type: "response",
          id,
          success: true,
          data: {
            sessionFile: "/tmp/fake-session.jsonl",
            sessionId: "fake-session-id",
          },
        },
        true,
      );
      return;
    }
    if (record.type === "prompt") {
      this.#send({ type: "response", id, success: true });
      this.#send({ type: "agent_start" });
      this.#send({
        type: "message_update",
        text: "unicode separators stay inside JSON: \u2028 \u2029",
      });
      this.#send({ type: "agent_settled" });
      return;
    }
    if (record.type === "emit_malformed") {
      this.#send({ type: "response", id, success: true });
      this.stdout.write("not-json\n");
      return;
    }
    this.#send({
      type: "response",
      id,
      success: false,
      error: "unsupported command",
    });
  }
}

function setup(): { rpc: RpcClient; process: FakeRpcProcess } {
  const fakeProcess = new FakeRpcProcess();
  const spawner: RpcSpawner = () =>
    fakeProcess as unknown as ChildProcessWithoutNullStreams;
  return {
    process: fakeProcess,
    rpc: new RpcClient(
      {
        command: "/usr/bin/pi",
        cwd: "/tmp",
        agentDir: "/tmp/fake-agent",
        sessionDir: "/tmp/fake-sessions",
        sessionName: "test",
        requestTimeoutMs: 2_000,
      },
      spawner,
    ),
  };
}

describe("RpcClient", () => {
  it("parses split JSONL records and preserves Unicode separators", async () => {
    const { rpc } = setup();
    const events: RpcRecord[] = [];
    rpc.on("event", (event: RpcRecord) => events.push(event));
    await rpc.start();

    const stats = await rpc.request({ type: "get_session_stats" });
    expect(stats.data).toMatchObject({ sessionId: "fake-session-id" });
    const prompt = await rpc.request({ type: "prompt", message: "hello" });
    expect(prompt.success).toBe(true);
    expect(events.some((event) => event.type === "agent_settled")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "message_update" &&
          typeof event.text === "string" &&
          event.text.includes("\u2028"),
      ),
    ).toBe(true);
    await rpc.stop();
  });

  it("reports malformed protocol records without logging their content", async () => {
    const { rpc } = setup();
    const protocolError = new Promise<Error>((resolve) =>
      rpc.once("protocolError", resolve),
    );
    await rpc.start();
    await rpc.request({ type: "emit_malformed" });
    await expect(protocolError).resolves.toMatchObject({
      message: "Invalid Pi RPC JSONL record",
    });
    await rpc.stop();
  });
});
