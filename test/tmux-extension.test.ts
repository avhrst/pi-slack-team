import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { agentConfigSchema } from "../src/config/schema.js";
import tmuxAgent from "../src/tmux/agent-extension.js";
import { TmuxMailbox, bufferName } from "../src/tmux/mailbox.js";
import type { RunRequest, RunResult } from "../src/tmux/protocol.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-extension-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = agentConfigSchema.parse({
    version: 1, agentId: "review", expectedUnixUser: "review-agent", stateDir: root,
    slack: { teamId: "TTEST", appId: "ATEST", allowedUserIds: ["UALICE"] },
    pi: { transport: "tmux", cwd: root, agentDir: root, sessionDir: root },
  });
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  vi.stubEnv("PI_TMUX_CONFIG", configPath);
  return root;
}

function memoryMailbox() {
  const buffers = new Map<string, unknown>();
  vi.spyOn(TmuxMailbox.prototype, "put").mockImplementation(async (name, value) => { buffers.set(name, structuredClone(value)); });
  vi.spyOn(TmuxMailbox.prototype, "remove").mockImplementation(async (name) => { buffers.delete(name); });
  vi.spyOn(TmuxMailbox.prototype, "list").mockImplementation(async (prefix = "pst-") => [...buffers.keys()].filter(name => name.startsWith(prefix)));
  vi.spyOn(TmuxMailbox.prototype, "read").mockImplementation(async name => {
    if (!buffers.has(name)) throw new Error("tmux save-buffer failed");
    return structuredClone(buffers.get(name));
  });
  vi.spyOn(TmuxMailbox.prototype, "wait").mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  vi.spyOn(TmuxMailbox.prototype, "pruneExpired").mockResolvedValue();
  return buffers;
}

function request(text = "task"): RunRequest {
  return { id: crypto.randomUUID(), text, origin: { kind: "local" }, createdAt: Date.now(), expiresAt: Date.now() + 5_000 };
}

function ui() {
  return {
    setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false), input: vi.fn(async () => undefined),
    editor: vi.fn(async () => undefined), custom: vi.fn(async () => undefined),
  } as unknown as ExtensionUIContext;
}

async function sdkAgent(root: string, consumeInput = false) {
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true,
    extensionFactories: [tmuxAgent, ...(consumeInput ? [(pi: ExtensionAPI) => {
      pi.on("input", () => ({ action: "handled" as const }));
    }] : [])],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(root, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(root, "models-cache.json"), allowModelNetwork: false,
  });
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.create(root, root), noTools: "all",
    // Unknown provider guarantees preflight failure without credentials/network.
    model: { id: "test", name: "test", api: "openai-completions", provider: "test-no-auth",
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 16 },
  });
  const originalSender = AgentSession.prototype.sendUserMessage;
  cleanup.push(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
    session.dispose();
    expect(AgentSession.prototype.sendUserMessage).toBe(originalSender);
  });
  const errors: Array<{ event: string; error: string }> = [];
  await session.bindExtensions({ mode: "tui", uiContext: ui(), onError: error => errors.push(error) });
  return { session, modelRuntime, errors };
}

describe("tmux extension startup outcomes (real Pi SDK, in-memory transport)", () => {
  it("preserves successful results when the async sender returns after agent_settled", async () => {
    const root = setup();
    const buffers = memoryMailbox();
    const { session, modelRuntime, errors } = await sdkAgent(root);
    vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    const message = {
      role: "assistant" as const, content: [{ type: "text" as const, text: "success" }],
      api: "openai-completions" as const, provider: "test-no-auth", model: "test", stopReason: "stop" as const, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    session.agent.streamFunction = () => ({
      async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; },
      result: async () => message,
    }) as Awaited<ReturnType<typeof session.agent.streamFunction>>;
    for (const run of [request("first"), request("second")]) {
      buffers.set(bufferName("run", run.id), run);
      await vi.waitFor(() => expect(buffers.get(bufferName("done", run.id))).toMatchObject({ ok: true, text: "success" }));
    }
    expect(errors).toEqual([]);
  });

  it.each([false, true])("finishes preflight/handled-input failures and releases the queue (handled input: %s)", async consumeInput => {
    const root = setup();
    const buffers = memoryMailbox();
    const { session, errors } = await sdkAgent(root, consumeInput);
    for (const run of [request("first"), request("second")]) {
      buffers.set(bufferName("run", run.id), run);
      await vi.waitFor(() => expect(buffers.has(bufferName("done", run.id))).toBe(true));
      const result = buffers.get(bufferName("done", run.id)) as RunResult;
      expect(result).toMatchObject({ id: run.id, ok: false });
      expect(result.text).toContain(consumeInput ? "without starting" : "API key");
      expect(buffers.has(bufferName("run", run.id))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(root, "tmux-receipts", `${run.id}.json`), "utf8"))).toMatchObject({ ok: false });
    }
    expect(session.isIdle).toBe(true);
    expect(errors.filter(error => error.event === "send_user_message")).toHaveLength(consumeInput ? 0 : 2);
  });
});

describe("tmux queue cancellation race", () => {
  it("continues processing after a listed request disappears before it is read", async () => {
    const root = setup();
    const buffers = memoryMailbox();
    const cancelled = request("cancelled");
    const next = request("next");
    buffers.set(bufferName("run", cancelled.id), cancelled);
    buffers.set(bufferName("run", next.id), next);
    vi.mocked(TmuxMailbox.prototype.read).mockImplementation(async name => {
      if (name === bufferName("run", cancelled.id)) buffers.delete(name);
      if (!buffers.has(name)) throw new Error("tmux save-buffer failed");
      return structuredClone(buffers.get(name));
    });
    const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const context = {
      mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { getSessionFile: () => path.join(root, "session.jsonl"), getSessionId: () => "test" }, ui: ui(),
    } as unknown as ExtensionContext;
    const send = vi.fn(() => { throw new Error("Synchronous launch failure"); });
    tmuxAgent({
      on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
      setSessionName: vi.fn(), registerTool: vi.fn(), sendUserMessage: send,
    } as unknown as ExtensionAPI);
    cleanup.push(async () => { await handlers.get("session_shutdown")!({} as never, context); });
    await handlers.get("session_start")!({} as never, context);
    await vi.waitFor(() => expect(buffers.has(bufferName("done", next.id))).toBe(true));
    expect(send).toHaveBeenCalledOnce();
    expect(context.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("tmux transport failed"), "error");
  });
});

describe("optional tmux buffer reads", () => {
  it("ignores only buffers confirmed missing on a live server", async () => {
    const box = new TmuxMailbox("/usr/bin/tmux", "/unused.sock");
    const readError = new Error("save-buffer failed");
    const read = vi.spyOn(box, "read").mockRejectedValue(readError);
    const list = vi.spyOn(box, "list").mockResolvedValue([]);
    await expect(box.readIfPresent("pst-test")).resolves.toBeUndefined();
    list.mockResolvedValue(["pst-test"]);
    await expect(box.readIfPresent("pst-test")).rejects.toBe(readError);
    list.mockRejectedValue(new Error("server offline"));
    await expect(box.readIfPresent("pst-test")).rejects.toThrow("server offline");
    await expect(box.readIfPresent("bad;name")).rejects.toThrow("Invalid tmux buffer name");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not mask malformed JSON in an existing buffer", async () => {
    const box = new TmuxMailbox("/usr/bin/tmux", "/unused.sock");
    vi.spyOn(box, "exec").mockResolvedValueOnce("not JSON").mockResolvedValueOnce("pst-test\n");
    await expect(box.readIfPresent("pst-test")).rejects.toBeInstanceOf(SyntaxError);
  });
});
