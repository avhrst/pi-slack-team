import { spawn } from "node:child_process";
import path from "node:path";
import type { AgentConfig } from "../config/schema.js";

export const MAX_BUFFER_BYTES = 1_048_576;
export const WAKE_CHANNEL = "pst-wake";
export const bufferName = (kind: string, id: string) => `pst-${kind}-${id}`;
export const tmuxSocketPath = (config: AgentConfig) => path.join(config.stateDir, "tmux.sock");

export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "TMUX" || key === "TMUX_PANE" || key === "CREDENTIALS_DIRECTORY" ||
        key.startsWith("SLACK_") || key.startsWith("PI_SESSION_") ||
        ["PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"].includes(key)) delete env[key];
  }
  return env;
}

/** No shell, terminal keystrokes, or message text in argv/error messages. */
export class TmuxMailbox {
  constructor(readonly command: string, readonly socketPath: string) {}

  async exec(args: string[], input?: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["-S", this.socketPath, ...args], {
        env: cleanEnvironment(), stdio: ["pipe", "pipe", "pipe"],
      });
      let output = Buffer.alloc(0);
      let failed = false;
      const fail = () => { failed = true; child.kill("SIGKILL"); };
      const timer = setTimeout(fail, timeoutMs);
      signal?.addEventListener("abort", fail, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]);
        if (output.length > MAX_BUFFER_BYTES) fail();
      });
      child.stderr.resume();
      child.stdin.on("error", () => { /* close/error below owns completion */ });
      child.on("error", () => { failed = true; });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", fail);
        if (failed || code !== 0) reject(new Error(`tmux ${args[0] ?? "command"} failed`));
        else resolve(output.toString("utf8"));
      });
      child.stdin.end(input);
    });
  }

  async list(prefix = "pst-"): Promise<string[]> {
    return (await this.exec(["list-buffers", "-F", "#{buffer_name}"]))
      .split("\n").filter((name) => name.startsWith(prefix) && /^[a-zA-Z0-9_-]+$/.test(name));
  }

  async read(name: string): Promise<unknown> {
    this.#validateName(name);
    return JSON.parse(await this.exec(["save-buffer", "-b", name, "-"]));
  }

  async put(name: string, value: unknown, wake = true): Promise<void> {
    this.#validateName(name);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_BUFFER_BYTES) throw new Error("tmux message exceeds 1 MiB");
    await this.exec(["load-buffer", "-b", name, "-"], text);
    if (wake) await this.exec(["wait-for", "-S", WAKE_CHANNEL]);
  }

  async remove(name: string): Promise<void> {
    this.#validateName(name);
    await this.exec(["delete-buffer", "-b", name]).catch(() => undefined);
  }

  async pruneExpired(beforeMs: number): Promise<void> {
    const rows = await this.exec(["list-buffers", "-F", "#{buffer_name} #{buffer_created}"]);
    for (const row of rows.split("\n")) {
      const match = /^(pst-[a-zA-Z0-9_-]+) (\d{10,})$/.exec(row);
      if (!match || ["pst-ready", "pst-team-status"].includes(match[1]!)) continue;
      if (Number(match[2]) * 1_000 < beforeMs) await this.remove(match[1]!);
    }
  }

  async wait(signal: AbortSignal, timeoutMs = 1_000): Promise<void> {
    // Buffers are the source of truth. A bounded wait also covers lost/coalesced signals.
    await this.exec(["wait-for", WAKE_CHANNEL], undefined, timeoutMs, signal).catch(() => undefined);
  }

  #validateName(name: string): void {
    if (!/^pst-[a-zA-Z0-9_-]{1,180}$/.test(name)) throw new Error("Invalid tmux buffer name");
  }
}
