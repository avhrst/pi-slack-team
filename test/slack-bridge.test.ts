import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentConfigSchema, type AgentConfig } from "../src/config/schema.js";
import type { InterAgentGateway } from "../src/inter-agent/gateway.js";
import type { Logger } from "../src/observability/logger.js";
import { ChatService, type MessageHooks, type PiPromptRunner } from "../src/routing/chat-service.js";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";
import { Registry } from "../src/storage/registry.js";
import type { ProgressMode } from "../src/slack/pi-progress.js";

const slack = vi.hoisted(() => ({
  listeners: new Map<string, (args: Record<string, unknown>) => Promise<void>>(),
  postMessage: vi.fn(),
  update: vi.fn(),
  progressUpdate: vi.fn(),
  progressPost: vi.fn(),
  progressDelete: vi.fn(),
  replies: vi.fn(),
}));

vi.mock("@slack/bolt", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeReceiver: class {
    client = { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() };
  },
  App: class {
    client = {
      chat: { postMessage: slack.postMessage, update: slack.update },
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
    chat = { update: slack.progressUpdate, postMessage: slack.progressPost, delete: slack.progressDelete };
  },
}));

const { SlackBridge } = await import("../src/slack/slack-bridge.js");

const config = agentConfigSchema.parse({
  version: 1,
  agentId: "deploy",
  expectedUnixUser: "deploy-agent",
  stateDir: "/tmp/pi-slack-bridge-test",
  slack: { teamId: "T01", appId: "A01", allowedUserIds: ["U01"], progressMode: "summary" },
  pi: { cwd: "/tmp", agentDir: "/tmp", sessionDir: "/tmp/sessions" },
});

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function bridge(handle: (hooks: MessageHooks) => Promise<string>, settings: AgentConfig | ProgressMode = config) {
  const chatService = {
    claimEvent: () => true,
    handleMessage: async (_message: IncomingSlackMessage, hooks: MessageHooks) => {
      await hooks.onAccepted?.();
      const result = { text: await handle(hooks), sessionFile: "/tmp/s", sessionId: "s" };
      return { type: "completed" as const, result };
    },
  } as unknown as ChatService;
  const interAgent = {
    setSlackSender: vi.fn(),
    parseResponse: () => undefined,
    isTrustedManagerUser: () => false,
  } as unknown as InterAgentGateway;
  return new SlackBridge(
    typeof settings === "string" ? { ...config, slack: { ...config.slack, progressMode: settings } } : settings,
    { botToken: "xoxb-test", appToken: "xapp-test" },
    chatService,
    interAgent,
    logger,
    () => undefined,
  );
}

async function directMessage(): Promise<void> {
  const listener = slack.listeners.get("message");
  if (!listener) throw new Error("message listener was not registered");
  await listener({
    body: { event_id: "Ev01", team_id: "T01", api_app_id: "A01" },
    event: { channel: "D01", channel_type: "im", user: "U01", ts: "1.1", text: "deploy" },
    client: { chat: { postMessage: slack.postMessage, update: slack.update } },
  });
}

beforeEach(() => {
  slack.update.mockResolvedValue({ ok: true });
  slack.progressUpdate.mockResolvedValue({ ok: true });
  slack.replies.mockResolvedValue({ ok: true, messages: [] });
});

afterEach(() => {
  slack.listeners.clear();
  vi.resetAllMocks();
});

describe("SlackBridge response delivery", () => {
  it("streams delegated work but posts the final answer only in its correlated response", async () => {
    vi.useFakeTimers();
    const messages = new Map<string, string>();
    slack.progressPost.mockImplementation(async ({ text }: { text: string }) => {
      const ts = String(messages.size + 1);
      messages.set(ts, text);
      return { ts };
    });
    slack.progressUpdate.mockImplementation(async ({ ts, text }: { ts: string; text: string }) => { messages.set(ts, text); return { ok: true }; });
    slack.progressDelete.mockImplementation(async ({ ts }: { ts: string }) => { messages.delete(ts); return { ok: true }; });
    const runtime = bridge(async (hooks) => {
      hooks.onPiEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking." }] } });
      hooks.onPiEvent?.({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: { path: "/tmp/report" } });
      hooks.onPiEvent?.({ type: "tool_execution_end", toolCallId: "tool", result: { content: [{ type: "text", text: "ok" }] } });
      hooks.onPiEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final delegated answer." }] } });
      return "Final delegated answer.";
    }, {
      ...config, slack: { ...config.slack, progressMode: "console" },
      interAgent: { peers: [{ agentId: "manager", role: "manager", appId: "A02", botUserId: "UMANAGER" }],
        requestTimeoutMs: 60_000, maxTaskChars: 30_000, maxResponseChars: 50_000 },
    });
    try {
      await runtime.start();
      const handling = slack.listeners.get("app_mention")!({
        body: { event_id: "EvDelegate", team_id: "T01", api_app_id: "A01" },
        event: { channel: "C01", channel_type: "channel", user: "UMANAGER", bot_id: "BMANAGER", app_id: "A02",
          ts: "1.3", thread_ts: "1.1", text: "<@UBOT> [pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nInspect report" },
        client: { chat: { postMessage: slack.postMessage, update: slack.update } },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await handling;
      const visible = [...messages.values()];
      expect(visible).toHaveLength(3);
      expect(visible[0]).toBe("Checking.");
      expect(visible[1]).toContain("ok");
      expect(visible[2]).toContain("<@UMANAGER>");
      expect(visible[2]).toContain("[pi-slack-team:v1:response:123e4567-e89b-12d3-a456-426614174000");
      expect(visible[2]).toContain("Final delegated answer.");
      expect(visible.filter((text) => text.includes("Final delegated answer."))).toHaveLength(1);
      expect(slack.postMessage).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
      vi.useRealTimers();
    }
  });

  it("delivers the default console as a persistent sequence without a second final answer", async () => {
    vi.useFakeTimers();
    const messages = new Map<string, string>();
    slack.progressPost.mockImplementation(async ({ text }: { text: string }) => {
      const ts = String(messages.size + 1);
      messages.set(ts, text);
      return { ts };
    });
    slack.progressUpdate.mockImplementation(async ({ ts, text }: { ts: string; text: string }) => { messages.set(ts, text); return { ok: true }; });
    const runtime = bridge(async (hooks) => {
      hooks.onPiEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking." }] } });
      hooks.onPiEvent?.({ type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: { path: "/tmp/report" } });
      hooks.onPiEvent?.({ type: "tool_execution_end", toolCallId: "tool", result: { content: [{ type: "text", text: "ok" }] } });
      hooks.onPiEvent?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
      return "Done.";
    }, { ...config, slack: { ...config.slack, progressMode: "console" } });
    try {
      const handling = directMessage();
      await vi.advanceTimersByTimeAsync(10_000);
      await handling;
      expect([...messages.values()]).toEqual(["Checking.", expect.stringContaining("ok"), "Done."]);
      expect(slack.postMessage).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalledWith("slack_message_failed", expect.anything());
    } finally {
      await runtime.stop();
      vi.useRealTimers();
    }
  });

  it.each([false, true])("routes a plain reply into a Pi dialog before queued work (delegation queued: %s)", async (delegationQueued) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pst-bridge-dialog-"));
    const registry = new Registry(path.join(root, "state.sqlite"));
    const settings = { ...config, stateDir: root,
      interAgent: { peers: [{ agentId: "manager", role: "manager" as const, appId: "A02", botUserId: "UMANAGER" }],
        requestTimeoutMs: 60_000, maxTaskChars: 30_000, maxResponseChars: 50_000 },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    slack.postMessage.mockResolvedValue({ ts: "posted" });
    const prompt = vi.fn<PiPromptRunner["prompt"]>(async (key, owner, _text, _onEvent, _shared, sender) => {
      if (sender === "UMANAGER") return { text: "Delegated result.", sessionFile: path.join(root, "session.jsonl"), sessionId: "session" };
      registry.createConversation(key, owner);
      await gate;
      const response = await runtime.handlePiUiRequest({
        conversation: { ...registry.getConversation(key)!, ownerUserId: sender ?? owner },
        request: { type: "extension_ui_request", method: "confirm", id: "dialog", title: "Continue?" },
        signal: new AbortController().signal,
      });
      expect(response).toEqual({ confirmed: true });
      registry.setSession(key, path.join(root, "session.jsonl"), "session");
      return { text: "Confirmed.", sessionFile: path.join(root, "session.jsonl"), sessionId: "session" };
    });
    const runtime = new SlackBridge(settings, { botToken: "xoxb-test", appToken: "xapp-test" },
      new ChatService(settings, registry, { prompt }, logger), {
        setSlackSender: vi.fn(), parseResponse: () => undefined, isTrustedManagerUser: () => false,
      } as unknown as InterAgentGateway, logger, () => undefined);
    try {
      await runtime.start();
      const client = { chat: { postMessage: slack.postMessage, update: slack.update }, conversations: { replies: slack.replies } };
      const handling = slack.listeners.get("app_mention")!({
        body: { event_id: "Ev1", team_id: "T01", api_app_id: "A01" },
        event: { channel: "C01", user: "U01", ts: "1.1", text: "<@UBOT> start" }, client,
      });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      const delegated = delegationQueued ? slack.listeners.get("app_mention")!({
        body: { event_id: "EvDelegate", team_id: "T01", api_app_id: "A01" },
        event: { channel: "C01", channel_type: "channel", user: "UMANAGER", bot_id: "BMANAGER", app_id: "A02",
          ts: "1.3", thread_ts: "1.1", text: "<@UBOT> [pi-slack-team:v1:request:123e4567-e89b-12d3-a456-426614174000]\nLater delegated work" }, client,
      }) : Promise.resolve();
      release();
      await vi.waitFor(() => expect(slack.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Continue?") })));
      await slack.listeners.get("message")!({
        body: { event_id: "Ev2", team_id: "T01", api_app_id: "A01" },
        event: { channel: "C01", channel_type: "channel", user: "U01", ts: "1.2", thread_ts: "1.1", text: "yes" }, client,
      });
      await Promise.all([handling, delegated]);
      expect(prompt).toHaveBeenCalledTimes(delegationQueued ? 2 : 1);
      expect(slack.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Confirmed." }));
    } finally {
      await runtime.stop();
      registry.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["balanced", "informative"] as const)("preserves %s receipts on delivery failure without replaying work", async mode => {
    slack.postMessage.mockResolvedValueOnce({ ts: "working-ts" }).mockRejectedValueOnce(new Error("msg_too_long"));
    const handle = vi.fn(async (hooks: MessageHooks) => {
      hooks.onPiEvent?.({ type: "agent_progress", text: "Локальну перевірку завершено; production не змінював." });
      hooks.onPiEvent?.({ type: "tool_execution_end", toolCallId: "read", toolName: "read" });
      return "Final answer <!channel>";
    });
    bridge(handle, mode);
    await directMessage();
    expect(handle).toHaveBeenCalledOnce();
    expect(slack.postMessage).toHaveBeenCalledTimes(2);
    const receipt = (slack.progressUpdate.mock.lastCall?.[0] as { text: string }).text;
    expect(receipt).toContain("Pi завершив роботу, але Slack не прийняв частину 1 з 1");
    expect(receipt).toContain("Локальну перевірку завершено");
    expect(receipt).toContain("Код звернення:");
    expect(receipt).not.toContain("Запит не завершено");
    expect(slack.update).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("slack_response_delivery_failed", expect.anything());
    expect(logger.error).not.toHaveBeenCalledWith("slack_message_failed", expect.anything());
  });

  it.each(["balanced", "informative"] as const)("retains %s milestones for actual turn failures without leaking traces", async mode => {
    slack.postMessage.mockResolvedValue({ ts: "working-ts" });
    bridge(async hooks => {
      hooks.onPiEvent?.({ type: "agent_progress", text: "Потрібно уточнити цілі." });
      throw new Error("PRIVATE_EXCEPTION_TRACE");
    }, mode);
    await directMessage();
    const receipt = (slack.progressUpdate.mock.lastCall?.[0] as { text: string }).text;
    expect(receipt).toContain("Потрібно уточнити цілі");
    expect(receipt).toContain("Код звернення:");
    expect(receipt).not.toContain("PRIVATE_EXCEPTION_TRACE");
    expect(slack.update).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("slack_message_failed", expect.anything());
  });

  it("reports a delivery failure in the receipt without claiming that Pi failed", async () => {
    slack.postMessage
      .mockResolvedValueOnce({ ts: "working-ts" })
      .mockRejectedValueOnce(new Error("msg_too_long"))
      .mockResolvedValue({ ts: "notice-ts" });
    bridge(async (hooks) => {
      hooks.onPiEvent?.({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
      hooks.onPiEvent?.({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash" });
      return "Deployment finished.";
    });

    await directMessage();

    expect(slack.update).not.toHaveBeenCalled();
    const receipt = (slack.progressUpdate.mock.lastCall?.[0] as { text: string }).text;
    expect(receipt).toMatch(
      /^:warning: Pi completed, but Slack rejected part 1 of 1 · `bash` × 1\n\n_Reference: [0-9a-f-]{36}_$/u,
    );
    expect(receipt).not.toContain("could not complete");
    expect(logger.error).toHaveBeenCalledWith(
      "slack_response_delivery_failed",
      expect.objectContaining({ postedParts: 0, totalParts: 1 }),
    );
  });

  it("still reports a real Pi failure as a failed request", async () => {
    slack.postMessage.mockResolvedValue({ ts: "working-ts" });
    bridge(async () => {
      throw new Error("model unavailable");
    });

    await directMessage();

    const updates = slack.update.mock.calls.map(([call]) => (call as { text: string }).text);
    expect(updates).toEqual([
      expect.stringContaining("Pi could not complete this request."),
    ]);
  });

  it("posts the final answer before settling the placeholder", async () => {
    slack.postMessage.mockResolvedValue({ ts: "working-ts" });
    bridge(async () => "All green.");

    await directMessage();

    expect(slack.progressUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ ts: "working-ts", text: ":white_check_mark: *Pi completed*" }),
    );
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: "All green.",
        thread_ts: "1.1",
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
    const answerOrder = slack.postMessage.mock.invocationCallOrder.at(-1)!;
    const receiptOrder = slack.progressUpdate.mock.invocationCallOrder.at(-1)!;
    expect(answerOrder).toBeLessThan(receiptOrder);
    expect(slack.update).not.toHaveBeenCalled();
  });

  it("delivers the answer before waiting for a rate-limited receipt", async () => {
    vi.useFakeTimers();
    try {
      slack.postMessage.mockResolvedValue({ ts: "working-ts" });
      slack.progressUpdate.mockRejectedValueOnce(Object.assign(new Error("rate limited"), {
        code: "slack_webapi_rate_limited_error",
        retryAfter: 30,
      }));
      bridge(async () => "All green.");

      const handling = directMessage();
      await vi.advanceTimersByTimeAsync(0);
      expect(slack.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "All green." }),
      );
      expect(slack.progressUpdate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(slack.progressUpdate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await handling;
      expect(slack.progressUpdate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still delivers the answer when the placeholder post fails", async () => {
    slack.postMessage
      .mockRejectedValueOnce(new Error("ratelimited"))
      .mockResolvedValue({ ts: "answer-ts" });
    bridge(async () => "All green.");

    await directMessage();

    expect(logger.warn).toHaveBeenCalledWith(
      "slack_placeholder_failed",
      expect.objectContaining({ agentId: "deploy", eventId: "Ev01" }),
    );
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "All green.", thread_ts: "1.1" }),
    );
    expect(slack.progressUpdate).not.toHaveBeenCalled();
  });

  it("posts a thread line for a Pi failure without a placeholder", async () => {
    slack.postMessage
      .mockRejectedValueOnce(new Error("ratelimited"))
      .mockResolvedValue({ ts: "failure-ts" });
    bridge(async () => {
      throw new Error("model unavailable");
    });

    await directMessage();

    expect(slack.update).not.toHaveBeenCalled();
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        thread_ts: "1.1",
        text: expect.stringMatching(/^:x: Pi could not complete this request\. Reference: /u),
      }),
    );
  });
});
