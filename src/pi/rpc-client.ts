import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { TextDecoder } from "node:util";

export type RpcRecord = Record<string, unknown> & { type: string };

export interface RpcClientOptions {
  command: string;
  commandPrefixArgs?: string[];
  cwd: string;
  agentDir: string;
  sessionDir: string;
  sessionFile?: string;
  sessionName?: string;
  requestTimeoutMs: number;
}

export type RpcSpawner = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

interface PendingRequest {
  resolve: (record: RpcRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isRpcRecord(value: unknown): value is RpcRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

export class RpcClient extends EventEmitter {
  readonly #options: RpcClientOptions;
  readonly #spawnProcess: RpcSpawner;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #stdoutBuffer = Buffer.alloc(0);
  #requestSequence = 0;
  #stopping = false;

  constructor(
    options: RpcClientOptions,
    spawnProcess: RpcSpawner = (command, args, options) =>
      spawn(command, args, {
        ...options,
        stdio: ["pipe", "pipe", "pipe"],
      }),
  ) {
    super();
    this.#options = options;
    this.#spawnProcess = spawnProcess;
  }

  get running(): boolean {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error("RPC client has already been started");

    const args = ["--mode", "rpc"];
    if (this.#options.sessionFile) {
      args.push("--session", this.#options.sessionFile);
    } else {
      args.push("--session-dir", this.#options.sessionDir);
      if (this.#options.sessionName) {
        args.push("--name", this.#options.sessionName);
      }
    }

    const child = this.#spawnProcess(
      this.#options.command,
      [...(this.#options.commandPrefixArgs ?? []), ...args],
      {
        cwd: this.#options.cwd,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: this.#options.agentDir,
          PI_CODING_AGENT_SESSION_DIR: this.#options.sessionDir,
        },
      },
    );
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    child.on("exit", (code, signal) => this.#handleExit(code, signal));

    await Promise.race([
      once(child, "spawn").then(() => undefined),
      once(child, "error").then(([error]) => {
        throw error;
      }),
    ]);
  }

  async request(
    command: Record<string, unknown>,
    timeoutMs = this.#options.requestTimeoutMs,
  ): Promise<RpcRecord> {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      throw new Error("Pi RPC process is not running");
    }

    const id = `rpc-${++this.#requestSequence}`;
    const record = { ...command, id };
    const response = new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC request timed out: ${String(command.type)}`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
    });

    child.stdin.write(`${JSON.stringify(record)}\n`, "utf8", (error) => {
      if (!error) return;
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    });

    const result = await response;
    if (result.success === false) {
      throw new Error(
        typeof result.error === "string" ? result.error : "Pi RPC request failed",
      );
    }
    return result;
  }

  sendUiResponse(record: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || child.exitCode !== null) {
      throw new Error("Pi RPC process is not running");
    }
    child.stdin.write(
      `${JSON.stringify({ type: "extension_ui_response", ...record })}\n`,
      "utf8",
    );
  }

  async stop(graceMs = 5_000): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null) return;
    this.#stopping = true;
    const exited = once(child, "exit").then(() => true);
    child.kill("SIGTERM");

    const timedOut = new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref();
    });
    if (!(await Promise.race([exited, timedOut])) && child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
  }

  #consumeStdout(chunk: Buffer): void {
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    let newline = this.#stdoutBuffer.indexOf(0x0a);
    while (newline !== -1) {
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length > 0) this.#parseLine(line);
      newline = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  #parseLine(line: Buffer): void {
    try {
      const decoded = this.#decoder.decode(line);
      const parsed: unknown = JSON.parse(decoded);
      if (!isRpcRecord(parsed)) throw new Error("record has no string type");

      if (parsed.type === "response" && typeof parsed.id === "string") {
        const pending = this.#pending.get(parsed.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pending.delete(parsed.id);
          pending.resolve(parsed);
          return;
        }
      }
      this.emit("event", parsed);
    } catch {
      this.emit("protocolError", new Error("Invalid Pi RPC JSONL record"));
    }
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#stdoutBuffer.length > 0) {
      this.#stdoutBuffer = Buffer.alloc(0);
      this.emit("protocolError", new Error("Incomplete Pi RPC JSONL record"));
    }
    const error = new Error(
      `Pi RPC process exited (code=${String(code)}, signal=${String(signal)})`,
    );
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (!this.#stopping) this.emit("unexpectedExit", { code, signal });
    this.emit("stopped");
  }
}
