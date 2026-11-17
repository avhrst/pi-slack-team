import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentConfigSchema, type AgentConfig } from "../src/config/schema.js";
import type { InterAgentGateway } from "../src/inter-agent/gateway.js";
import type { Logger } from "../src/observability/logger.js";
import { ChatService, type PiPromptRunner } from "../src/routing/chat-service.js";
import { Registry } from "../src/storage/registry.js";

const slack = vi.hoisted(() => ({
  listeners: new Map<string, (args: Record<string, unknown>) => Promise<void>>(),
  post: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  apiCall: vi.fn(),
  startStream: vi.fn(),
  appendStream: vi.fn(),
  getPermalink: vi.fn(),
  replies: vi.fn(),
}));

vi.mock("@slack/bolt", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeReceiver: class {
    client = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  },
  App: class {
    client = {
      chat: { postMessage: slack.post, update: slack.update },
      auth: { test: async () => ({ team_id: "T01", user_id: "UBOT" }) },
      conversations: { replies: slack.replies },
    };
    async start() {}
    async stop() {}
    event(name: string, listener: (args: Record<string, unknown>) => Promise<void>) {
      slack.listeners.set(name, listener);
    }
    error() {}
  },
}));

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    apiCall = slack.apiCall;
    chat = {
      postMessage: slack.post, update: slack.update, delete: slack.delete,
      getPermalink: slack.getPermalink, startStream: slack.startStream, appendStream: slack.appendStream,
    };
  },
}));

const { SlackBridge } = await import("../src/slack/slack-bridge.js");
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const baseConfig = {
  version: 1, agentId: "deploy", expectedUnixUser: "deploy-agent",
  slack: { teamId: "T01", appId: "A01", allowedUserIds: ["U01"] },
  pi: { cwd: "/tmp", agentDir: "/tmp", sessionDir: "/tmp/sessions" },
};
const peers = {
  peers: [{ agentId: "manager", role: "manager", appId: "A02", botUserId: "UMANAGER" }],
  requestTimeoutMs: 60_000, maxTaskChars: 30_000, maxResponseChars: 50_000,
};
const client = { chat: { postMessage: slack.post, update: slack.update }, conversations: { replies: slack.replies } };
const cleanup: Array<() => void | Promise<void>> = [];

async function setup(prompt: PiPromptRunner["prompt"], overrides: Partial<AgentConfig> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pst-work-thread-"));
  const settings = agentConfigSchema.parse({ ...baseConfig, stateDir: directory, ...overrides });
  const registry = new Registry(path.join(directory, "state.sqlite"));
  const gateway = {
    setSlackSender: vi.fn(), parseResponse: () => undefined, isTrustedManagerUser: () => false,
  } as unknown as InterAgentGateway;
  const bridge = new SlackBridge(settings, { botToken: "xoxb-test", appToken: "xapp-test" },
    new ChatService(settings, registry, { prompt }, logger), gateway, logger, () => undefined, registry);
  cleanup.push(async () => {
    await bridge.stop();
    registry.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await bridge.start();
  return { bridge, registry };
}

function route(listener: "message" | "app_mention", eventId: string, event: Record<string, unknown> = {}) {
  return slack.listeners.get(listener)!({
    body: { event_id: eventId, team_id: "T01", api_app_id: "A01" },
    event: { channel: "D01", channel_type: "im", user: "U01", ts: "1.1", text: "Перевірка", ...event },
    client,
  });
}

async function delivered(action: Promise<void>) {
  await vi.advanceTimersByTimeAsync(40_000);
  await action;
}

function result(text: string) { return { text, sessionFile: "/tmp/s", sessionId: "s" }; }

beforeEach(() => {
  vi.useFakeTimers();
  let postCount = 0;
  slack.post.mockImplementation(async () => ({ ok: true, ts: `2.${++postCount}` }));
  slack.update.mockResolvedValue({ ok: true });
  slack.startStream.mockResolvedValue({ ok: true, ts: "3.1" });
  slack.appendStream.mockResolvedValue({ ok: true });
  slack.apiCall.mockImplementation(async (_method, args) => ({ ok: true, title: args.title }));
  slack.getPermalink.mockResolvedValue({ ok: true, permalink: "https://workspace.slack.com/archives/D01/p21?thread_ts=2.1&cid=D01" });
  slack.replies.mockResolvedValue({ ok: true, messages: [] });
});

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  slack.listeners.clear();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("Slack work threads", () => {
  it("creates one bot root, streams public commentary and posts the final once", async () => {
    const prompt = vi.fn<PiPromptRunner["prompt"]>(async (_key, _owner, _text, onEvent) => {
      onEvent?.({ type: "agent_progress", text: "Перевіряю налаштування." });
      onEvent?.({ type: "tool_execution_start", toolName: "read", toolCallId: "tool", args: { path: "PRIVATE_PATH" } });
      onEvent?.({ type: "tool_execution_end", toolName: "read", toolCallId: "tool", result: { content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } });
      return result("Результат перевірки.");
    });
    await setup(prompt);
    const channel = { channel: "C01", channel_type: "channel", text: "<@UBOT> Перевірка" };
    const initial = route("app_mention", "First", channel);
    await route("app_mention", "First", channel);
    await route("app_mention", "Unauthorized", { ...channel, user: "U99" });
    await delivered(initial);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ channelId: "C01", threadTs: "2.1" });
    const posts = slack.post.mock.calls.map(([payload]) => payload);
    expect(posts.filter(payload => payload.thread_ts === undefined)).toEqual([expect.objectContaining({ text: "🔄 Перевірка · У роботі" })]);
    expect(posts).toContainEqual(expect.objectContaining({ thread_ts: "1.1", text: expect.stringContaining("🧵") }));
    expect(posts.filter(payload => payload.text === "Результат перевірки.")).toEqual([expect.objectContaining({ thread_ts: "2.1" })]);
    expect(slack.apiCall).toHaveBeenCalledWith("agents.sessions.setStatus", expect.objectContaining({
      channel_id: "C01", thread_ts: "2.1", initiator_user_id: "U01", status: "processing",
    }));
    expect(slack.startStream).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C01", thread_ts: "2.1", recipient_team_id: "T01", recipient_user_id: "U01",
      chunks: [expect.objectContaining({ text: "💬 Перевіряю налаштування." })],
    }));
    expect(slack.update).toHaveBeenCalledWith(expect.objectContaining({
      ts: "2.1", text: expect.stringMatching(/^✅ .*Кроків виконано: 1/u),
    }));
    expect(JSON.stringify(slack.post.mock.calls)).not.toMatch(/PRIVATE_PATH|PRIVATE_OUTPUT/u);
  });

  it("acknowledges queued follow-ups early and keeps the original title and thread", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prompt = vi.fn<PiPromptRunner["prompt"]>(async (_key, _owner, text) => {
      if (text.includes("Перевірка")) await gate;
      return result(text.includes("Перевірка") ? "Перша відповідь." : "Друга відповідь.");
    });
    await setup(prompt);
    const first = route("message", "First");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prompt).toHaveBeenCalledTimes(1);
    const next = route("message", "Second", { thread_ts: "2.1", ts: "2.9", text: "Уточнення" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(slack.post).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: "2.1", text: expect.stringContaining("⏳ Уточнення"),
    }));
    release();
    await delivered(Promise.all([first, next]).then(() => undefined));
    expect(prompt.mock.calls.map(([key]) => key.threadTs)).toEqual(["2.1", "2.1"]);
    expect(slack.post.mock.calls.filter(([payload]) => !payload.thread_ts)).toHaveLength(1);
    expect(slack.update).toHaveBeenLastCalledWith(expect.objectContaining({
      ts: "2.1", text: "✅ Перевірка · Завершено",
    }));
  });

  it("routes a Pi confirmation through the new thread before queued work", async () => {
    const prompt = vi.fn<PiPromptRunner["prompt"]>(async (key, owner) => {
      if (key.channelId !== "C01") return result("Інший запит.");
      const response = await runtime.handlePiUiRequest({
        conversation: { ...key, ownerUserId: owner, sessionKey: "", status: "running",
          createdAt: "", lastActivityAt: "", piSessionFile: null, piSessionId: null },
        request: { type: "extension_ui_request", method: "confirm", id: "dialog", title: "Продовжити?" },
        signal: new AbortController().signal,
      });
      expect(response).toEqual({ confirmed: true });
      return result("Підтверджено.");
    });
    const runtime = (await setup(prompt)).bridge;
    const channel = { channel: "C01", channel_type: "channel" };
    const handling = route("app_mention", "First", { ...channel, text: "<@UBOT> Перевірка" });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(slack.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "2.1", text: expect.stringContaining("Продовжити?") }));
    const queued = route("message", "Other", { ...channel, thread_ts: "2.1", ts: "2.8", text: "так", user: "U99" });
    await queued;
    await route("message", "Answer", { ...channel, thread_ts: "2.1", ts: "2.9", text: "так" });
    await delivered(handling);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(slack.apiCall).toHaveBeenCalledWith("agents.sessions.setStatus", expect.objectContaining({ status: "suspended" }));
    expect(slack.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "2.1", text: "Підтверджено." }));
  });

  it("delivers a confirmation to Pi while the heading respects Slack Retry-After", async () => {
    let limited = false;
    slack.update.mockImplementation(async ({ text }: { text: string }) => {
      if (!limited && text.startsWith("🟡")) {
        limited = true;
        throw Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error", retryAfter: 30 });
      }
      return { ok: true };
    });
    const answered = vi.fn();
    const runtime = (await setup(async (key, owner) => {
      answered(await runtime.handlePiUiRequest({
        conversation: { ...key, ownerUserId: owner, sessionKey: "", status: "running",
          createdAt: "", lastActivityAt: "", piSessionFile: null, piSessionId: null },
        request: { type: "extension_ui_request", method: "confirm", id: "dialog", title: "Продовжити?" },
        signal: new AbortController().signal,
      }));
      return result("Підтверджено.");
    })).bridge;
    const action = route("message", "First");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(limited).toBe(true);
    await route("message", "Answer", { thread_ts: "2.1", ts: "2.9", text: "так" });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toHaveBeenCalledWith({ confirmed: true });
    await delivered(action);
  });

  it("keeps worker replies in their protocol and does not publish the result twice", async () => {
    const prompt = vi.fn<PiPromptRunner["prompt"]>(async (_key, _owner, _text, onEvent) => {
      onEvent?.({ type: "agent_progress", text: "Перевіряю." });
      return result("Результат профільного агента.");
    });
    await setup(prompt, { interAgent: agentConfigSchema.parse({ ...baseConfig, stateDir: "/tmp", interAgent: peers }).interAgent! });
    await delivered(route("app_mention", "Delegated", {
      channel: "C01", channel_type: "channel", user: "UMANAGER", bot_id: "BMANAGER", app_id: "A02",
      thread_ts: "1.0", text: "<@UBOT> [pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nПеревірка",
    }));
    const posts = slack.post.mock.calls.map(([payload]) => payload);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ thread_ts: "1.0", text: "💬 Перевіряю." });
    expect(posts[1].text).toContain("[pi-slack-team:v1:response:123e4567-e89b-12d3-a456-426614174000");
    expect(posts.filter(payload => payload.text.includes("Результат профільного агента."))).toHaveLength(1);
    expect(slack.startStream).not.toHaveBeenCalled();
  });

  it("uses the source thread for progress and final response when Slack rejects root creation", async () => {
    slack.post.mockRejectedValueOnce(Object.assign(new Error("Slack unavailable"), { code: "slack_webapi_request_error" }));
    await setup(async () => result("Результат у вихідному треді."));
    await delivered(route("message", "First"));
    expect(slack.post).toHaveBeenCalledTimes(2);
    expect(slack.post).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: "1.1", text: "Результат у вихідному треді." }));
    expect(slack.apiCall).not.toHaveBeenCalled();
  });

  it("marks a delivery error separately from a Pi failure and never reruns Pi", async () => {
    let posts = 0;
    slack.post.mockImplementation(async (payload) => {
      if (payload.text === "Фінальний результат.") throw new Error("ambiguous delivery");
      return { ok: true, ts: `2.${++posts}` };
    });
    const prompt = vi.fn(async () => result("Фінальний результат."));
    await setup(prompt);
    await delivered(route("message", "First"));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(slack.post.mock.calls.filter(([payload]) => payload.text === "Фінальний результат.")).toHaveLength(1);
    expect(slack.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "2.1", text: expect.stringContaining("Доставку результату в Slack перервано") }));
    expect(slack.update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: "2.1", text: expect.stringMatching(/^⚠️/u) }));
    expect(logger.error).not.toHaveBeenCalledWith("slack_message_failed", expect.anything());
  });

  it("keeps a real failure in the work thread without revealing its private exception", async () => {
    await setup(async () => { throw new Error("PRIVATE_EXCEPTION"); });
    await delivered(route("message", "Failed"));
    expect(slack.post).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "2.1", text: expect.stringContaining("Pi не завершив запит") }));
    expect(slack.update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: "2.1", text: expect.stringMatching(/^❌/u) }));
    expect(JSON.stringify(slack.post.mock.calls)).not.toContain("PRIVATE_EXCEPTION");
  });

  it("settles a failed turn before its follow-up takes over the same heading", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prompt = vi.fn<PiPromptRunner["prompt"]>(async (_key, _owner, text) => {
      if (text.includes("Перевірка")) {
        await gate;
        throw new Error("turn failed");
      }
      return result("Виконано після уточнення.");
    });
    await setup(prompt);
    const first = route("message", "First");
    await vi.advanceTimersByTimeAsync(10_000);
    const next = route("message", "Second", { thread_ts: "2.1", ts: "2.9", text: "Уточнення" });
    release();
    await delivered(Promise.all([first, next]).then(() => undefined));
    const titles = slack.update.mock.calls.filter(([payload]) => payload.ts === "2.1").map(([payload]) => payload.text);
    expect(titles).toEqual(["❌ Перевірка · Запит не завершено", "🔄 Перевірка · У роботі", "✅ Перевірка · Завершено"]);
  });
});
