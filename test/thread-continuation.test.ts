import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import { createLogger } from "../src/observability/logger.js";
import { ChatService, type PiPromptRunner } from "../src/routing/chat-service.js";
import { conversationKey, type IncomingSlackMessage } from "../src/routing/chat-key.js";
import { Registry } from "../src/storage/registry.js";

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
function setup(role: "worker" | "manager" = "worker") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pst-thread-"));
  dispose.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = agentConfigSchema.parse({
    version: 1, agentId: "test-agent", role, expectedUnixUser: "test-agent", stateDir: root,
    slack: { teamId: "T01", appId: "A01", allowedUserIds: ["U01", "U02"] },
    pi: { cwd: root, agentDir: root, sessionDir: root },
  });
  const registry = new Registry(path.join(root, "state.sqlite"));
  dispose.push(() => registry.close());
  const prompt = vi.fn<PiPromptRunner["prompt"]>(async (key, owner) => {
    if (!registry.getConversation(key)) registry.createConversation(key, owner);
    registry.setSession(key, path.join(root, "session.jsonl"), "session");
    return { text: "done", sessionFile: path.join(root, "session.jsonl"), sessionId: "session" };
  });
  const service = () => new ChatService(config, registry, { prompt }, createLogger(() => undefined));
  return { registry, prompt, service, config };
}
function message(overrides: Partial<IncomingSlackMessage> = {}): IncomingSlackMessage {
  return { kind: "app-mention", eventId: "Ev1", teamId: "T01", appId: "A01", channelId: "C01",
    channelType: "channel", userId: "U01", ts: "100.000", text: "start", files: [], ...overrides };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("engaged Slack threads", () => {
  it.each(["worker", "manager"] as const)("continues a private %s thread for another authorized participant and survives service restart", async (role) => {
    const { registry, prompt, service } = setup(role);
    const first = message({ channelId: "G01", channelType: "group" });
    const key = conversationKey(first);
    const accepted = vi.fn(async () => undefined);
    await service().handleMessage(first, {
      preparePrompt: async () => ({ text: "start", contextThroughTs: first.ts }), onAccepted: accepted,
    });
    expect(registry.threadState(key)).toEqual({ engaged: true, contextTs: first.ts });
    const preparePrompt = vi.fn(async () => ({ text: "continue", contextThroughTs: "102.000" }));
    const restarted = service();
    const reply = message({ kind: "channel-message", eventId: "Ev2", channelId: "G01", channelType: "group",
      threadTs: first.ts, ts: "102.000", userId: "U02", text: "continue" });
    await expect(restarted.handleMessage(reply, { preparePrompt, onAccepted: accepted })).resolves.toMatchObject({ type: "completed" });
    expect(preparePrompt).toHaveBeenCalledWith({ isNewConversation: false, afterTs: first.ts });
    expect(accepted).toHaveBeenLastCalledWith({ isObservation: false });
    expect(prompt).toHaveBeenLastCalledWith(key, "U01", "continue", undefined, true, "U02");
    await expect(restarted.handleMessage(reply)).resolves.toEqual({ type: "duplicate" });
    await expect(restarted.handleMessage({ ...reply, eventId: "Ev3", userId: "U99" })).resolves.toMatchObject({ reason: "unauthorized-user" });
    await expect(restarted.handleMessage({ ...reply, eventId: "Ev4", botId: "B01" })).resolves.toMatchObject({ reason: "bot-message" });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("engages before awaits and serializes preparation, Pi and final delivery in arrival order", async () => {
    const { registry, prompt, service } = setup();
    const chat = service();
    const preparing = gate();
    const delivering = gate();
    const first = message();
    const secondPreparation = vi.fn(async () => "second");
    const running = chat.handleMessage(first, {
      preparePrompt: async () => { await preparing.promise; return { text: "first", contextThroughTs: first.ts }; },
      onCompleted: async () => { await delivering.promise; },
    });
    expect(registry.threadState(conversationKey(first)).engaged).toBe(true);
    const queued = chat.handleMessage(message({ kind: "channel-message", eventId: "Ev2", threadTs: first.ts,
      ts: "101.000", userId: "U02" }), { preparePrompt: secondPreparation });
    await Promise.resolve();
    expect(secondPreparation).not.toHaveBeenCalled();
    preparing.release();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(secondPreparation).not.toHaveBeenCalled();
    delivering.release();
    await Promise.all([running, queued]);
    expect(secondPreparation).toHaveBeenCalledWith({ isNewConversation: false, afterTs: first.ts });
    expect(prompt.mock.calls.map((call) => call[2])).toEqual(["first", "second"]);
  });

  it("backfills only legacy worker conversations and does not engage ambient manager conversations", async () => {
    for (const role of ["worker", "manager"] as const) {
      const { registry, service } = setup(role);
      const first = message();
      registry.createConversation(conversationKey(first), "U01");
      service();
      expect(registry.threadState(conversationKey(first)).engaged).toBe(role === "worker");
    }
    const { service, registry } = setup("manager");
    const chat = service();
    const accepted = vi.fn(async () => undefined);
    const ambient = message({ kind: "channel-message" });
    await chat.handleMessage(ambient, { onAccepted: accepted });
    expect(accepted).toHaveBeenCalledWith({ isObservation: true });
    expect(registry.threadState(conversationKey(ambient)).engaged).toBe(false);
    await chat.handleMessage(message({ eventId: "Ev2", threadTs: ambient.ts, ts: "101.000" }), { onAccepted: accepted });
    expect(accepted).toHaveBeenLastCalledWith({ isObservation: false });
  });

  it("does not activate rejected requests or accept unrelated worker threads", async () => {
    const { service, registry, prompt } = setup();
    const chat = service();
    const unauthorized = message({ userId: "U99" });
    await chat.handleMessage(unauthorized);
    expect(registry.threadState(conversationKey(unauthorized)).engaged).toBe(false);
    await chat.handleMessage(message());
    await expect(chat.handleMessage(message({ kind: "channel-message", eventId: "Ev2", threadTs: "999.000" })))
      .resolves.toMatchObject({ reason: "unsupported-conversation" });
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps delegated worker threads inactive through backfill and activates only on a human mention", async () => {
    const { registry, prompt, service } = setup();
    const first = message();
    const key = conversationKey(first);
    registry.ensureDelegatedThread(key);
    registry.createConversation(key, "U01");
    const restarted = service();
    expect(registry.threadState(key).engaged).toBe(false);
    await expect(restarted.handleMessage(message({ kind: "channel-message", eventId: "Ev2", threadTs: first.ts }))).resolves.toMatchObject({ reason: "unsupported-conversation" });
    expect(prompt).not.toHaveBeenCalled();
    await restarted.handleMessage(message({ eventId: "Ev3", threadTs: first.ts }));
    registry.ensureDelegatedThread(key);
    expect(registry.threadState(key).engaged).toBe(true);
    await service().handleMessage(message({ kind: "channel-message", eventId: "Ev4", threadTs: first.ts }));
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("lets only the addressed peer handle explicit peer mentions, while the manager keeps plain followups", async () => {
    const { config, service, prompt } = setup("manager");
    config.interAgent = { peers: [{ agentId: "worker", role: "worker", botUserId: "UWORKER", appId: "AWORKER" }], maxTaskChars: 30000, maxResponseChars: 50000, requestTimeoutMs: 60000 };
    const chat = service();
    await chat.handleMessage(message());
    await expect(chat.handleMessage(message({ kind: "channel-message", eventId: "Ev2", threadTs: "100.000", mentionedUserIds: ["UWORKER"], text: "<@UWORKER> task" }))).resolves.toMatchObject({ reason: "addressed-to-peer" });
    await chat.handleMessage(message({ kind: "channel-message", eventId: "Ev3", threadTs: "100.000", mentionedUserIds: [], text: "literal <@UWORKER>" }));
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("keeps the history cursor on failure and never rewinds it on a delayed event", async () => {
    const { registry, prompt, service } = setup();
    const first = message();
    registry.advanceThreadContext(conversationKey(first), "100.000");
    registry.advanceThreadContext(conversationKey(first), "99.000");
    prompt.mockRejectedValueOnce(new Error("provider failed"));
    await expect(service().handleMessage(first, {
      preparePrompt: async () => ({ text: "task", contextThroughTs: "102.000" }),
    })).rejects.toThrow("provider failed");
    expect(registry.threadState(conversationKey(first)).contextTs).toBe("100.000");
  });

  it("does not download files in an engaged manager thread when uploads are disabled", async () => {
    const { service } = setup("manager");
    const chat = service();
    await chat.handleMessage(message());
    await expect(chat.handleMessage(message({ kind: "channel-message", eventId: "Ev2", threadTs: "100.000", ts: "101.000",
      files: [{ id: "F01", name: "test", size: 1, urlPrivateDownload: "https://files.slack.com/test" }],
    }))).resolves.toMatchObject({ reason: "file-uploads-disabled" });
  });
});
