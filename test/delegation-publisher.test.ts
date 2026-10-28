import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import { Registry } from "../src/storage/registry.js";
import { SlackDelegationPublisher } from "../src/slack/delegation-publisher.js";
import { SlackDeliveryQueue } from "../src/slack/console-reporter.js";
import { ConsoleTranscript } from "../src/slack/console-transcript.js";
import type { DelegationContext } from "../src/tmux/protocol.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
function setup(role: "manager" | "worker" = "worker") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pst-publish-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = agentConfigSchema.parse({ version: 1, agentId: role, role, expectedUnixUser: role, stateDir: root,
    slack: { teamId: "T01", appId: role === "worker" ? "AWORKER" : "AMANAGER", allowedUserIds: ["U01"] }, pi: { cwd: root, agentDir: root, sessionDir: root } });
  const registry = new Registry(path.join(root, "state.sqlite")); cleanup.push(() => registry.close());
  const messages = new Map<string, string>();
  let sequence = 0;
  const delivery = {
    post: vi.fn(async (text: string) => { const ts = String(++sequence); messages.set(ts, text); return ts; }),
    update: vi.fn(async (ts: string, text: string) => { messages.set(ts, text); }),
    remove: vi.fn(async (ts: string) => { messages.delete(ts); }),
  };
  const target = vi.fn(() => delivery);
  const queue = new SlackDeliveryQueue(0); cleanup.push(() => queue.close());
  const errors = vi.fn();
  const create = () => {
    const publisher = new SlackDelegationPublisher(cfg, registry, queue, target, errors);
    cleanup.push(() => publisher.close());
    return publisher;
  };
  const context: DelegationContext = { id: crypto.randomUUID(), parentRunId: crypto.randomUUID(), toolCallId: "call-1", from: "manager", workerId: "worker",
    origin: { kind: "slack", teamId: "T01", appId: "AMANAGER", channelId: "C01", threadTs: "1.0", userId: "U01" } };
  return { create, registry, delivery, target, context, messages, errors };
}
const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });

describe("delegated Slack publications", () => {
  it.each(["C01", "G01"])("uses the worker client and original %s thread; keeps full ordered console history", async channelId => {
    const { create, target, context, messages, delivery } = setup();
    context.origin = { ...context.origin, kind: "slack", teamId: "T01", appId: "AMANAGER", channelId, threadTs: "1.0", userId: "U01" };
    const publisher = create();
    expect(await publisher.begin(context)).toEqual({ route: "worker" });
    expect(target).toHaveBeenCalledWith(channelId, "1.0");
    expect([...messages.values()][0]).toContain("Очікую черги");
    publisher.record(context, 1, { type: "agent_start" });
    await vi.waitFor(() => expect(delivery.update).toHaveBeenCalledWith("1", "Виконую."));
    publisher.record(context, 2, message("Перевіряю."));
    publisher.record(context, 3, { type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "/tmp/<x>" } });
    publisher.record(context, 4, { type: "tool_execution_update", toolCallId: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
    publisher.record(context, 5, { type: "tool_execution_end", toolCallId: "read", result: { content: [{ type: "text", text: Array.from({ length: 13 }, (_, n) => `line ${n}`).join("\n") }] } });
    publisher.record(context, 6, message("Готово."));
    expect(await publisher.finish(context, true, "Готово.")).toBe(true);
    expect([...messages.values()]).toEqual(["Завдання завершено.", "Перевіряю.", expect.stringContaining("[3 more lines hidden]"), "Готово."]);
    expect([...messages.values()].join("\n")).not.toContain("partial");
    expect(await publisher.begin(context)).toEqual({ route: "worker" });
    expect(messages.size).toBe(4);
  });

  it("routes DMs and a rejected initial worker post through the manager", async () => {
    const { create, context, delivery } = setup();
    if (context.origin.kind === "slack") context.origin.channelId = "D01";
    expect(await create().begin(context)).toMatchObject({ route: "manager", reason: expect.stringContaining("DM") });
    expect(delivery.post).not.toHaveBeenCalled();
    const second = { ...context, id: crypto.randomUUID(), origin: { ...context.origin, channelId: "G01" } } as DelegationContext;
    delivery.post.mockRejectedValueOnce({ code: "slack_webapi_platform_error", data: { error: "not_in_channel" } });
    expect(await create().begin(second)).toMatchObject({ route: "manager", reason: expect.stringContaining("канал") });
    expect(delivery.post).toHaveBeenCalledTimes(1);
  });

  it("persists duplicate child packets, labels proxy output, and restores message IDs without repeating final text", async () => {
    const { create, context, messages, delivery } = setup("manager");
    const start = { ...context, events: [{ sequence: 1, event: { type: "delegation_start", route: "manager", reason: "DM" } }, { sequence: 2, event: { type: "agent_start" } }, { sequence: 3, event: message("Checking") }] };
    const end = { ...context, events: [{ sequence: 4, event: message("Done") }, { sequence: 5, event: { type: "delegation_end", ok: true, text: "Done" } }] };
    const first = create(); first.consume(start);
    await vi.waitFor(() => expect(messages.size).toBe(1));
    await first.close();
    const resumed = create(); resumed.consume(start); resumed.consume(end); resumed.consume(end);
    await resumed.finishParent(context.parentRunId);
    expect([...messages.values()]).toEqual([expect.stringContaining("Завдання завершено"), "*Worker worker*\nChecking", "*Worker worker*\nDone"]);
    const posts = delivery.post.mock.calls.length;
    await resumed.finishParent(context.parentRunId);
    expect(delivery.post).toHaveBeenCalledTimes(posts);
  });

  it("never retries an uncertain post, including after restart, and preserves delivered entries", async () => {
    const { create, context, delivery, messages } = setup();
    const publisher = create(); await publisher.begin(context);
    publisher.record(context, 1, message("Already delivered"));
    await vi.waitFor(() => expect(messages.size).toBe(2));
    delivery.post.mockRejectedValueOnce({ code: "slack_webapi_request_error" });
    publisher.record(context, 2, message("Uncertain final"));
    expect(await publisher.finish(context, true, "Uncertain final")).toBe(false);
    expect(delivery.post).toHaveBeenCalledTimes(3);
    const resumed = create(); await resumed.recover();
    expect(await resumed.finish(context, true, "Uncertain final")).toBe(false);
    expect(delivery.post).toHaveBeenCalledTimes(3);
    expect([...messages.values()]).toContain("Already delivered");
  });

  it("preserves failures across recovery without adding the error or final text twice", async () => {
    const { create, context, messages, delivery } = setup();
    const publisher = create(); await publisher.begin(context);
    publisher.record(context, 1, message("Before failure"));
    publisher.record(context, 2, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "false" } });
    expect(await publisher.finish(context, false, "Cancelled; effects remain")).toBe(true);
    const posts = delivery.post.mock.calls.length;
    const resumed = create(); await resumed.recover();
    await resumed.finish(context, false, "Cancelled; effects remain");
    expect(delivery.post).toHaveBeenCalledTimes(posts);
    expect([...messages.values()].filter(text => text === "Cancelled; effects remain")).toHaveLength(1);
    expect([...messages.values()].join("\n")).toContain("failed");
  });

  it("honors full Retry-After on a safe initial post", async () => {
    vi.useFakeTimers();
    const { create, context, delivery } = setup();
    delivery.post.mockRejectedValueOnce({ code: "slack_webapi_rate_limited_error", retryAfter: 30 });
    const beginning = create().begin(context);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(delivery.post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await beginning).toEqual({ route: "worker" });
    expect(delivery.post).toHaveBeenCalledTimes(2);
  });

  it("suppresses duplicated worker output in the manager delegation tool and survives snapshots", () => {
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "tool_execution_start", toolCallId: "d", toolName: "delegate_to_worker", args: { workerId: "worker" } });
    transcript.record({ type: "delegation_status", toolCallId: "d", text: "worker: completed; shown separately" });
    const restored = new ConsoleTranscript(transcript.snapshot());
    restored.record({ type: "tool_execution_end", toolCallId: "d", result: { content: [{ type: "text", text: "DUPLICATE RESULT" }] } });
    expect(restored.render()[0]?.text).toContain("shown separately");
    expect(restored.render()[0]?.text).not.toContain("DUPLICATE RESULT");
  });
});
