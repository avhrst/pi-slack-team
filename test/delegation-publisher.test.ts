import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/storage/registry.js";
import { SlackDelegationPublisher } from "../src/slack/delegation-publisher.js";
import { SlackDeliveryQueue } from "../src/slack/console-reporter.js";
import { ConsoleTranscript } from "../src/slack/console-transcript.js";
import type { DelegationContext } from "../src/tmux/protocol.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pst-publish-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
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
    const publisher = new SlackDelegationPublisher(registry, queue, target, errors);
    cleanup.push(() => publisher.close());
    return publisher;
  };
  const context: DelegationContext = { id: crypto.randomUUID(), parentRunId: crypto.randomUUID(), toolCallId: "call-1", from: "manager", workerId: "worker",
    origin: { kind: "slack", teamId: "T01", appId: "AMANAGER", channelId: "C01", threadTs: "1.0", userId: "U01" } };
  return { create, registry, delivery, target, context, messages, errors };
}
const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
const note = (text: string) => ({ type: "agent_progress", text });

describe("delegated Slack publications", () => {
  it.each(["C01", "G01"])("uses the worker client and shows safe ordered progress in the %s thread", async channelId => {
    const { create, target, context, messages, delivery, registry } = setup();
    context.origin = { ...context.origin, kind: "slack", teamId: "T01", appId: "AMANAGER", channelId, threadTs: "1.0", userId: "U01" };
    const publisher = create();
    expect(await publisher.begin(context)).toEqual({ route: "worker" });
    expect(target).toHaveBeenCalledWith(channelId, "1.0");
    expect([...messages.values()][0]).toContain("Очікую черги");
    publisher.record(context, 1, { type: "agent_start" });
    await vi.waitFor(() => expect(delivery.update).toHaveBeenCalledWith("1", "🔄 Виконую."));
    publisher.record(context, 2, note("Перевіряю."));
    publisher.record(context, 3, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_TRACE" } });
    publisher.record(context, 4, { type: "tool_execution_start", toolCallId: "deploy", toolName: "bash", args: { command: "PRIVATE_COMMAND" } });
    const marker = { version: 1, stage: "apex", state: "running", planned: 5, completed: 2, pending: 3, ok: 2, warn: 0, fail: 0, skip: 0, current: "TT3" };
    publisher.record(context, 5, { type: "tool_execution_update", toolCallId: "deploy",
      partialResult: { content: [{ type: "text", text: `PRIVATE_OUTPUT\nORA-00942\nPI_DEPLOY_PROGRESS ${JSON.stringify(marker)}` }] } });
    await vi.waitFor(() => expect([...messages.values()][2]).toContain("⚙️ Виконується"));
    publisher.record(context, 6, { type: "tool_execution_end", toolCallId: "deploy", isError: true });
    publisher.record(context, 7, message("Готово."));
    expect(await publisher.finish(context, true, "Готово.")).toBe(true);
    expect([...messages.values()]).toEqual(["✅ Завдання завершено.", "💬 Перевіряю.", expect.stringContaining("⚠️ Крок із помилкою"), "Готово."]);
    expect([...messages.values()][2]).toContain("APEX: 2/5 операцій");
    expect([...messages.values()][2]).toContain("ORA-00942");
    expect([...messages.values()].join("\n")).not.toMatch(/PRIVATE_(COMMAND|OUTPUT|TRACE)/);
    expect(JSON.stringify(registry.publications())).not.toMatch(/PRIVATE_(COMMAND|OUTPUT|TRACE)/);
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
    const { create, context, messages, delivery } = setup();
    const start = { ...context, events: [{ sequence: 1, event: { type: "delegation_start", route: "manager", reason: "DM" } }, { sequence: 2, event: { type: "agent_start" } }, { sequence: 3, event: note("Checking") }] };
    const end = { ...context, events: [{ sequence: 4, event: message("Done") }, { sequence: 5, event: { type: "delegation_end", ok: true, text: "Done" } }] };
    const first = create(); first.consume(start);
    await vi.waitFor(() => expect(messages.size).toBe(1));
    await first.close();
    const resumed = create(); resumed.consume(start); resumed.consume(end); resumed.consume(end);
    await resumed.finishParent(context.parentRunId);
    expect([...messages.values()]).toEqual([expect.stringContaining("Завдання завершено"), "🤖 *Профільний агент worker*\n💬 Checking", "🤖 *Профільний агент worker*\nDone"]);
    const posts = delivery.post.mock.calls.length;
    await resumed.finishParent(context.parentRunId);
    expect(delivery.post).toHaveBeenCalledTimes(posts);
  });

  it("never retries an uncertain post, including after restart, and preserves delivered entries", async () => {
    const { create, context, delivery, messages } = setup();
    const publisher = create(); await publisher.begin(context);
    publisher.record(context, 1, note("Already delivered"));
    await vi.waitFor(() => expect(messages.size).toBe(2));
    delivery.post.mockRejectedValueOnce({ code: "slack_webapi_request_error" });
    publisher.record(context, 2, message("Uncertain final"));
    expect(await publisher.finish(context, true, "Uncertain final")).toBe(false);
    expect(delivery.post).toHaveBeenCalledTimes(3);
    const resumed = create(); await resumed.recover();
    expect(await resumed.finish(context, true, "Uncertain final")).toBe(false);
    expect(delivery.post).toHaveBeenCalledTimes(3);
    expect([...messages.values()]).toContain("💬 Already delivered");
  });

  it("preserves failures across recovery without adding the error or final text twice", async () => {
    const { create, context, messages, delivery } = setup();
    const publisher = create(); await publisher.begin(context);
    publisher.record(context, 1, note("Before failure"));
    publisher.record(context, 2, { type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "false" } });
    expect(await publisher.finish(context, false, "Cancelled; effects remain")).toBe(true);
    const posts = delivery.post.mock.calls.length;
    const resumed = create(); await resumed.recover();
    await resumed.finish(context, false, "Cancelled; effects remain");
    expect(delivery.post).toHaveBeenCalledTimes(posts);
    expect([...messages.values()].filter(text => text === "🛑 Профільний агент не завершив завдання.")).toHaveLength(1);
    expect([...messages.values()].join("\n")).toContain("Завершення кроку не підтверджено.");
    expect([...messages.values()].join("\n")).not.toContain("Cancelled; effects remain");
  });

  it("migrates an unfinished legacy delivery without replaying its raw tool output or final answer", async () => {
    const { create, context, messages, delivery, registry } = setup();
    const id = `delegation:worker:${context.from}:${context.id}`;
    const transcript = new ConsoleTranscript();
    transcript.record({ type: "tool_execution_start", toolCallId: "old-tool", toolName: "bash",
      args: { command: "OLD_COMMAND" } });
    transcript.record({ type: "tool_execution_update", toolCallId: "old-tool",
      partialResult: { content: [{ type: "text", text: "OLD_STDOUT" }] } });
    transcript.record(message("UNVERIFIED_DRAFT"));
    transcript.record(message("Завершено"));
    messages.set("100", "Running");
    messages.set("101", "OLD_COMMAND\nOLD_STDOUT");
    messages.set("102", "Завершено");
    registry.savePublication(id, {
      context, route: "worker", proxy: false, sequence: 4,
      stage: "completed", finalText: "Завершено", headerTs: "100", headerText: "Running",
      console: { transcript: transcript.snapshot(), posted: [
        ["tool-old-tool:0", { ts: "101", text: "OLD_COMMAND\nOLD_STDOUT" }],
        ["assistant-2:0", { ts: "102", text: "Завершено" }],
      ], pending: [] },
    });

    await create().recover();

    expect(delivery.post).not.toHaveBeenCalled();
    expect(messages.get("100")).toBe("✅ Завдання завершено.");
    expect(messages.get("101")).toContain("Завершення кроку не підтверджено.");
    expect([...messages.values()].filter(text => text === "Завершено")).toHaveLength(1);
    expect([...messages.values()].join("\n")).not.toMatch(/OLD_COMMAND|OLD_STDOUT|UNVERIFIED_DRAFT/);
    expect(JSON.stringify(registry.loadPublication(id))).not.toMatch(/OLD_COMMAND|OLD_STDOUT|UNVERIFIED_DRAFT/);
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
