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
  it("reports a delivery failure without claiming that Pi failed", async () => {
    slack.postMessage
      .mockResolvedValueOnce({ ts: "working-ts" })
      .mockRejectedValueOnce(new Error("msg_too_long"))
      .mockResolvedValue({ ts: "notice-ts" });
    bridge(async () => "Deployment finished.");

    await directMessage();

    const updates = slack.update.mock.calls.map(([call]) => (call as { text: string }).text);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("Pi completed this request");
    expect(updates[0]).toContain("part 1 of 1");
    expect(updates[0]).not.toContain("could not complete");
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

  it("posts the final answer after marking progress completed", async () => {
    slack.postMessage.mockResolvedValue({ ts: "working-ts" });
    bridge(async () => "All green.");

    await directMessage();

    expect(slack.progressUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ ts: "working-ts", text: expect.stringContaining("Pi completed") }),
    );
    expect(slack.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "All green.", thread_ts: "1.1" }),
    );
    expect(slack.update).not.toHaveBeenCalled();
  });
});
