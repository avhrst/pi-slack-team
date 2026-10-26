import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentConfigSchema } from "../src/config/schema.js";
import type { InterAgentGateway } from "../src/inter-agent/gateway.js";
import type { Logger } from "../src/observability/logger.js";
import type { ChatService, MessageHooks } from "../src/routing/chat-service.js";
import type { IncomingSlackMessage } from "../src/routing/chat-key.js";

const slack = vi.hoisted(() => ({
  listeners: new Map<string, (args: Record<string, unknown>) => Promise<void>>(),
  postMessage: vi.fn(),
  update: vi.fn(),
  progressUpdate: vi.fn(),
}));

vi.mock("@slack/bolt", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeReceiver: class {
    client = { on: vi.fn(), off: vi.fn() };
  },
  App: class {
    client = { chat: { postMessage: slack.postMessage, update: slack.update } };
    event(name: string, listener: (args: Record<string, unknown>) => Promise<void>) {
      slack.listeners.set(name, listener);
    }
    error() {}
  },
}));

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { update: slack.progressUpdate };
  },
}));

const { SlackBridge } = await import("../src/slack/slack-bridge.js");

const config = agentConfigSchema.parse({
  version: 1,
  agentId: "deploy",
  expectedUnixUser: "deploy-agent",
  stateDir: "/tmp/pi-slack-bridge-test",
  slack: { teamId: "T01", appId: "A01", allowedUserIds: ["U01"] },
  pi: { cwd: "/tmp", agentDir: "/tmp", sessionDir: "/tmp/sessions" },
});

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function bridge(handle: (hooks: MessageHooks) => Promise<string>) {
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
    config,
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
});

afterEach(() => {
  slack.listeners.clear();
  vi.resetAllMocks();
});

describe("SlackBridge response delivery", () => {
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
