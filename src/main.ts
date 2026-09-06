#!/usr/bin/env node

import path from "node:path";
import { loadConfig, loadSlackCredentials } from "./config/load-config.js";
import { runDoctor } from "./cli/doctor.js";
import { InterAgentGateway } from "./inter-agent/gateway.js";
import { createLogger } from "./observability/logger.js";
import { PiSessionPool, type PiUiHandler } from "./pi/session-pool.js";
import { ChatService } from "./routing/chat-service.js";
import { assertRuntimeIdentity } from "./security/runtime-identity.js";
import { SlackBridge } from "./slack/slack-bridge.js";
import { Registry } from "./storage/registry.js";
import { TmuxAgentRunner } from "./tmux/agent-runner.js";

function usage(): never {
  process.stderr.write(
    "Usage: pi-slack-team <start|doctor> --config /absolute/path/agent.yaml\n",
  );
  process.exit(64);
}

function parseArguments(argv: string[]): { command: string; configPath: string } {
  const command = argv[0];
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
  if (!command || !configPath || !path.isAbsolute(configPath)) usage();
  return { command, configPath };
}

async function start(configPath: string): Promise<void> {
  const config = loadConfig(configPath);
  assertRuntimeIdentity(config);
  const credentials = loadSlackCredentials(config);
  const logger = createLogger();
  const registry = new Registry(path.join(config.stateDir, "state.sqlite"));
  const interAgent = new InterAgentGateway(config, registry, logger);
  const slackReference: { bridge?: SlackBridge } = {};
  const uiHandler: PiUiHandler = async (context) =>
    slackReference.bridge ? slackReference.bridge.handlePiUiRequest(context) : { cancelled: true };
  const pool = config.pi.transport === "tmux"
    ? new TmuxAgentRunner(config, configPath, registry, logger, uiHandler)
    : new PiSessionPool(config, registry, logger, uiHandler);
  const chatService = new ChatService(config, registry, pool, logger);
  let stopping = false;
  let healthTimer: NodeJS.Timeout | undefined;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (healthTimer) clearInterval(healthTimer);
    logger.info("runtime_stopping", { agentId: config.agentId, signal });
    await bridge.stop().catch(() => undefined);
    await interAgent.stop().catch(() => undefined);
    await pool.shutdown();
    registry.close();
  };

  const failRuntime = (error: Error) => {
    if (stopping) return;
    logger.error("runtime_connection_failure", {
      agentId: config.agentId,
      error,
    });
    void shutdown("slack_connection_failure").finally(() => process.exit(1));
  };

  const bridge = new SlackBridge(
    config,
    credentials,
    chatService,
    interAgent,
    logger,
    failRuntime,
  );
  slackReference.bridge = bridge;

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("uncaughtException", (error) => {
    logger.error("uncaught_exception", { agentId: config.agentId, error });
    void shutdown("uncaughtException").finally(() => process.exit(1));
  });
  process.once("unhandledRejection", (error) => {
    logger.error("unhandled_rejection", { agentId: config.agentId, error });
    void shutdown("unhandledRejection").finally(() => process.exit(1));
  });

  try {
    if (pool instanceof TmuxAgentRunner) await pool.start();
    await interAgent.start();
    await bridge.start();
    if (pool instanceof TmuxAgentRunner) {
      healthTimer = setInterval(() => {
        void pool.health().catch(() => failRuntime(new Error("tmux agent is no longer healthy")));
      }, 5_000);
      healthTimer.unref();
    }
  } catch (error) {
    await shutdown("startup_failure");
    throw error;
  }
  logger.info("runtime_started", {
    agentId: config.agentId,
    role: config.role,
    unixUser: config.expectedUnixUser,
    transport: config.pi.transport,
  });
}

async function main(): Promise<void> {
  const { command, configPath } = parseArguments(process.argv.slice(2));
  if (command === "doctor") {
    const config = loadConfig(configPath);
    const checks = runDoctor(config);
    process.stdout.write(`${JSON.stringify({ ok: checks.every((item) => item.ok), checks }, null, 2)}\n`);
    process.exit(checks.every((item) => item.ok) ? 0 : 1);
  }
  if (command === "start") {
    await start(configPath);
    return;
  }
  usage();
}

await main();
