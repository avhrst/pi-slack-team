#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../config/load-config.js";
import { createLogger } from "../observability/logger.js";
import { TmuxMailbox, tmuxSocketPath } from "./mailbox.js";
import { TmuxRelay } from "./relay.js";
import { readySchema } from "./protocol.js";

const [command, name] = process.argv.slice(2);
const configDir = process.env.PI_TEAM_CONFIG_DIR ?? "/etc/pi-slack-team";
const configs = fs.readdirSync(configDir).filter((file) => file.endsWith(".yaml")).map((file) => {
  const configPath = path.join(configDir, file);
  if (command === "relay") {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("Relay configurations must be root-owned and not group/world writable");
  }
  return loadConfig(configPath);
}).filter((config) => config.pi.transport === "tmux");

if (command === "relay") {
  if (process.getuid?.() !== 0) throw new Error("Cross-user tmux relay must run as root");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  await new TmuxRelay(configs, createLogger()).run(controller.signal);
} else if (command === "list") {
  for (const config of configs) {
    const mailbox = new TmuxMailbox(config.pi.tmuxCommand, tmuxSocketPath(config));
    let status = "offline";
    try {
      const ready = readySchema.parse(await mailbox.read("pst-ready"));
      status = Date.now() - ready.updatedAt > 15_000 ? "stale" : ready.busy ? "busy" : "idle";
    } catch { /* offline/unreadable */ }
    process.stdout.write(`${config.expectedUnixUser.padEnd(18)} ${status.padEnd(8)} ${mailbox.socketPath}\n`);
  }
} else if (["watch", "attach", "capture"].includes(command ?? "")) {
  const config = configs.find((config) => config.agentId === name || config.expectedUnixUser === name);
  if (!config) throw new Error("Unknown tmux agent; use pi-team list");
  const args = ["-S", tmuxSocketPath(config)];
  if (command === "capture") args.push("capture-pane", "-p", "-S", "-200", "-t", `${config.expectedUnixUser}:pi.0`);
  else args.push("attach-session", ...(command === "watch" ? ["-r"] : []), "-t", config.expectedUnixUser);
  const env = { ...process.env };
  delete env.TMUX;
  const child = spawn(config.pi.tmuxCommand, args, { env, stdio: "inherit" });
  child.on("error", () => { process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  process.stderr.write("Usage: pi-team list | watch <agent> | attach <agent> | capture <agent> | relay\n");
  process.exitCode = 64;
}
