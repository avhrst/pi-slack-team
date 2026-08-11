import { EventEmitter } from "node:events";
import type { SocketModeReceiver } from "@slack/bolt";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/observability/logger.js";
import { SlackConnectionMonitor } from "../src/slack/connection-monitor.js";

function recordingLogger() {
  const records: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: (event, fields) => records.push({ level: "debug", event, fields }),
    info: (event, fields) => records.push({ level: "info", event, fields }),
    warn: (event, fields) => records.push({ level: "warn", event, fields }),
    error: (event, fields) => records.push({ level: "error", event, fields }),
  };
  return { logger, records };
}

function socketClient(emitter: EventEmitter): SocketModeReceiver["client"] {
  return emitter as unknown as SocketModeReceiver["client"];
}

describe("SlackConnectionMonitor", () => {
  afterEach(() => vi.useRealTimers());

  it("allows automatic reconnect and records recovery", () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const { logger, records } = recordingLogger();
    const onFailure = vi.fn();
    const monitor = new SlackConnectionMonitor(
      socketClient(emitter),
      "deploy",
      logger,
      onFailure,
      1_000,
    );

    monitor.start();
    emitter.emit("error", new Error("socket failed"));
    vi.advanceTimersByTime(400);
    emitter.emit("connected");
    vi.advanceTimersByTime(1_000);

    expect(onFailure).not.toHaveBeenCalled();
    expect(records.map(({ event }) => event)).toEqual([
      "slack_connection_lost",
      "slack_connection_restored",
    ]);
    expect(records[1]?.fields?.outageMs).toBe(400);
  });

  it("fails the runtime when reconnect does not complete in time", () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const { logger, records } = recordingLogger();
    const onFailure = vi.fn();
    const monitor = new SlackConnectionMonitor(
      socketClient(emitter),
      "support",
      logger,
      onFailure,
      1_000,
    );

    monitor.start();
    emitter.emit("reconnecting");
    vi.advanceTimersByTime(1_000);

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(records.at(-1)).toMatchObject({
      level: "error",
      event: "slack_connection_unhealthy",
      fields: { agentId: "support", reason: "reconnecting", outageMs: 1_000 },
    });
  });

  it("does not fail during an intentional shutdown", () => {
    vi.useFakeTimers();
    const emitter = new EventEmitter();
    const { logger } = recordingLogger();
    const onFailure = vi.fn();
    const monitor = new SlackConnectionMonitor(
      socketClient(emitter),
      "dev",
      logger,
      onFailure,
      1_000,
    );

    monitor.start();
    emitter.emit("disconnected");
    monitor.stop();
    vi.advanceTimersByTime(1_000);

    expect(onFailure).not.toHaveBeenCalled();
    expect(emitter.listenerCount("connected")).toBe(0);
    expect(emitter.listenerCount("error")).toBe(0);
  });
});
