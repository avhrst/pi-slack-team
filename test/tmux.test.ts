import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentConfigSchema, type AgentConfig } from "../src/config/schema.js";
import { Registry } from "../src/storage/registry.js";
import type { PiUiRequestContext } from "../src/pi/session-pool.js";
import { ChatService } from "../src/routing/chat-service.js";
import { delegationRequestText } from "../src/inter-agent/protocol.js";
import { createLogger } from "../src/observability/logger.js";
import { TmuxMailbox, bufferName, tmuxSocketPath } from "../src/tmux/mailbox.js";
import { TmuxAgentRunner } from "../src/tmux/agent-runner.js";
import tmuxAgent from "../src/tmux/agent-extension.js";
import { TmuxRelay, authorizeRelay } from "../src/tmux/relay.js";
import { workerRunId, type Delegation, type RunRequest } from "../src/tmux/protocol.js";

const tmux = ["/usr/local/bin/tmux", "/usr/bin/tmux"].find((file) => fs.existsSync(file));
const available = Boolean(tmux && spawnSync(tmux, ["-V"]).status === 0);
const cleanup: Array<() => Promise<void> | void> = [];
const logger = createLogger(() => undefined);

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

function config(role: "worker" | "manager" = "worker", id = role): AgentConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return agentConfigSchema.parse({
    version: 1, agentId: id, role, expectedUnixUser: `${id}-agent`, stateDir: root,
    slack: { teamId: "TTEST", appId: role === "manager" ? "AMANAGER" : "AWORKER", allowedUserIds: ["UALICE", "UBOB"] },
    pi: { transport: "tmux", tmuxCommand: tmux ?? "/usr/bin/tmux", cwd: root, agentDir: root, sessionDir: root },
    interAgent: { peers: [{ agentId: role === "manager" ? "worker" : "manager", role: role === "manager" ? "worker" : "manager", appId: role === "manager" ? "AWORKER" : "AMANAGER", botUserId: role === "manager" ? "UWORKER" : "UMANAGER" }] },
  });
}

async function server(cfg: AgentConfig) {
  const mailbox = new TmuxMailbox(cfg.pi.tmuxCommand, tmuxSocketPath(cfg));
  await mailbox.exec(["-f", "/dev/null", "new-session", "-d", "-s", cfg.expectedUnixUser, "/usr/bin/sleep", "600"]);
  cleanup.push(async () => { await mailbox.exec(["kill-server"]).catch(() => undefined); });
  await mailbox.exec(["set-option", "-t", cfg.expectedUnixUser, "@pi-team-agent", cfg.agentId]);
  return mailbox;
}

async function until(check: () => Promise<boolean>, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for test condition");
}

interface TestTool {
  execute(id: string, params: { workerId: string; task: string }, signal: AbortSignal, onUpdate?: (result: unknown) => void): Promise<{ content: Array<{ text: string }> }>;
}

/** Real tmux transport + real extension/runner, but deterministic agent events: no API credentials or network. */
async function fakeAgent(cfg: AgentConfig, reply: (text: string, ctx: ExtensionContext) => Promise<string> = async (text) => `answer:${text}`) {
  const mailbox = await server(cfg);
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const tools = new Map<string, TestTool>();
  let busy = false;
  let aborted = false;
  const calls: string[] = [];
  const tasks: Promise<void>[] = [];
  const ctx = {
    mode: "tui", hasUI: true, cwd: cfg.pi.cwd,
    sessionManager: {
      getSessionFile: () => path.join(cfg.pi.sessionDir, "tmux-agent.jsonl"),
      getSessionId: () => `${cfg.agentId}-session`,
    },
    isIdle: () => !busy, hasPendingMessages: () => false,
    abort: () => { aborted = true; },
    ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(async () => "local-choice"), confirm: vi.fn(async () => false), input: vi.fn(), editor: vi.fn(), custom: vi.fn() },
  } as unknown as ExtensionContext;
  const emit = async (event: string, value: unknown = {}) => handlers.get(event)?.(value as never, ctx);
  const pi = {
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerTool: (tool: TestTool & { name: string }) => tools.set(tool.name, tool),
    setSessionName: vi.fn(),
    sendUserMessage: (text: string) => {
      if (busy) throw new Error("concurrent prompt");
      busy = true;
      aborted = false;
      calls.push(text);
      tasks.push((async () => {
        await emit("agent_start");
        const answer = await reply(text, ctx);
        await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: aborted ? "aborted" : "stop" } });
        busy = false;
        await emit("agent_settled");
      })());
    },
  } as unknown as ExtensionAPI;
  const configPath = path.join(cfg.stateDir, "config.yaml");
  fs.writeFileSync(configPath, YAML.stringify(cfg));
  vi.stubEnv("PI_TMUX_CONFIG", configPath);
  tmuxAgent(pi);
  await emit("session_start");
  cleanup.push(async () => { await Promise.all(tasks); await emit("session_shutdown"); });
  await until(async () => (await mailbox.list()).includes("pst-ready"));
  return { mailbox, configPath, ctx, emit, tools, calls };
}

function delegation(target: AgentConfig): Delegation {
  return { id: crypto.randomUUID(), to: target.agentId, task: "safe task", origin: { kind: "local" }, createdAt: Date.now(), expiresAt: Date.now() + 30_000 };
}

describe("tmux configuration and relay policy", () => {
  it("forces one resident process/turn while keeping legacy RPC defaults", () => {
    const cfg = config();
    expect(cfg.pi.maxConcurrentTurns).toBe(1);
    expect(cfg.pi.maxResidentProcesses).toBe(1);
    expect(agentConfigSchema.parse({ ...cfg, pi: { ...cfg.pi, transport: "rpc", maxConcurrentTurns: 4, maxResidentProcesses: 8 } }).pi.maxConcurrentTurns).toBe(4);
  });

  it("requires reciprocal peers, role direction and both human allowlists", () => {
    const manager = config("manager");
    const worker = config();
    const request = delegation(worker);
    expect(authorizeRelay(manager, worker, request)).toBe(true);
    expect(authorizeRelay(worker, manager, { ...request, to: manager.agentId })).toBe(false);
    expect(authorizeRelay(manager, { ...worker, interAgent: undefined }, request)).toBe(false);
    expect(authorizeRelay(manager, worker, { ...request, origin: { kind: "slack", teamId: "TTEST", appId: "AMANAGER", channelId: "DTEST", threadTs: "1.0", userId: "UALICE" } })).toBe(true);
    expect(authorizeRelay(manager, worker, { ...request, origin: { kind: "slack", teamId: "TTEST", appId: "AMANAGER", channelId: "DTEST", threadTs: "1.0", userId: "UEVIL" } })).toBe(false);
    expect(workerRunId("manager", request.id)).not.toBe(workerRunId("another", request.id));
  });

  it("rejects legacy Slack bot delegation envelopes in tmux mode", async () => {
    const cfg = config();
    const registry = new Registry(path.join(cfg.stateDir, "state.sqlite"));
    cleanup.push(() => registry.close());
    const prompt = vi.fn(async () => ({ text: "no", sessionFile: "/shared", sessionId: "shared" }));
    const service = new ChatService(cfg, registry, { prompt }, logger);
    const result = await service.handleMessage({
      kind: "app-mention", eventId: "EVBOT", teamId: "TTEST", appId: "AWORKER",
      channelId: "CTEST", channelType: "channel", userId: "UMANAGER", botId: "BMANAGER",
      ts: "1.0", text: delegationRequestText("UWORKER", crypto.randomUUID(), "task"), files: [],
    });
    expect(result).toEqual({ type: "ignored", reason: "bot-message" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("retains legacy session rows while binding all chats to a single agent record", () => {
    const cfg = config();
    const db = path.join(cfg.stateDir, "state.sqlite");
    const registry = new Registry(db);
    const alice = { teamId: "TTEST", appId: "AWORKER", channelId: "DALICE", threadTs: "1.0" };
    const bob = { ...alice, channelId: "DBOB", threadTs: "2.0" };
    registry.createConversation(alice, "UALICE");
    registry.setSession(alice, "/old.jsonl", "old");
    registry.createConversation(bob, "UBOB");
    registry.bindAgentSession(alice, "/shared.jsonl", "shared");
    registry.bindAgentSession(bob, "/shared.jsonl", "shared");
    expect(registry.getConversation(alice)?.sessionKey).toBe(registry.getConversation(bob)?.sessionKey);
    expect(registry.getPiSession("direct-user:TTEST:AWORKER:UALICE")?.piSessionFile).toBe("/old.jsonl");
    registry.close();
    const resumed = new Registry(db);
    expect(resumed.getConversation(bob)?.piSessionId).toBe("shared");
    resumed.close();
  });
});

describe.skipIf(!available)("real tmux mailbox integration", () => {
  it("round-trips Unicode/multiline data without executing shell syntax; bounds input", async () => {
    const cfg = config();
    const box = await server(cfg);
    const text = "Привіт\n$(touch /tmp/pi-tmux-should-not-exist)\n; \"quotes\" \u001b[31m";
    await box.put("pst-test", { text });
    expect(await box.read("pst-test")).toEqual({ text });
    expect(fs.existsSync("/tmp/pi-tmux-should-not-exist")).toBe(false);
    await expect(box.put("pst-test", "x".repeat(1_048_576))).rejects.toThrow("1 MiB");
    await expect(box.put("pst-;kill-server", {})).rejects.toThrow("name");
    const abort = new AbortController();
    abort.abort();
    await box.wait(abort.signal);
    await box.remove("pst-test");
    expect(await box.list()).not.toContain("pst-test");
  });

  it("serializes different Slack users in one Pi session and binds dialogs to the actual sender", async () => {
    const cfg = config();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent = await fakeAgent(cfg, async (text, ctx) => {
      if (text.includes("first-task")) await gate;
      if (text.includes("second-task")) return `selected:${await ctx.ui.select("Choose", ["A", "B"])}`;
      return "first-result";
    });
    const registry = new Registry(path.join(cfg.stateDir, "state.sqlite"));
    cleanup.push(() => registry.close());
    const ui = vi.fn<(context: PiUiRequestContext) => Promise<{ value: string }>>().mockResolvedValue({ value: "B" });
    const runner = new TmuxAgentRunner(cfg, agent.configPath, registry, logger, ui);
    await runner.start();
    // Stop the runner before the fake extension/server during teardown.
    cleanup.push(() => runner.shutdown());
    const key = { teamId: "TTEST", appId: "AWORKER", channelId: "CTEST", threadTs: "1.0" };
    const first = runner.prompt(key, "UALICE", "first-task");
    await until(async () => agent.calls.length === 1);
    const second = runner.prompt(key, "UALICE", "second-task", undefined, true, "UBOB");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(agent.calls).toHaveLength(1);
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a.sessionFile).toBe(b.sessionFile);
    expect(a.text).toBe("first-result");
    expect(b.text).toBe("selected:B");
    expect(ui.mock.calls[0]?.[0]).toMatchObject({ conversation: { ownerUserId: "UBOB" } });
    expect(agent.calls[1]).toContain('"userId":"UBOB"');
    expect(agent.calls[1]).toContain("NOT local/TUI");
  }, 20_000);

  it("does not replay a completed/interrupted request and rejects cancelled queued work", async () => {
    const cfg = config();
    const agent = await fakeAgent(cfg, async () => "safe-result");
    const request: RunRequest = { id: crypto.randomUUID(), text: "task", origin: { kind: "local" }, createdAt: Date.now(), expiresAt: Date.now() + 30_000 };
    const done = bufferName("done", request.id);
    await agent.mailbox.put(bufferName("run", request.id), request);
    await until(async () => (await agent.mailbox.list()).includes(done));
    await agent.mailbox.remove(done);
    await agent.mailbox.put(bufferName("run", request.id), request);
    await until(async () => (await agent.mailbox.list()).includes(done));
    expect(agent.calls).toHaveLength(1);
    expect(await agent.emit("tool_call", { toolName: "subagent" })).toMatchObject({ block: true });
    const interrupted = { ...request, id: crypto.randomUUID() };
    fs.writeFileSync(path.join(cfg.stateDir, "tmux-receipts", `${interrupted.id}.json`), "{}");
    await agent.mailbox.put(bufferName("run", interrupted.id), interrupted);
    await until(async () => (await agent.mailbox.list()).includes(bufferName("done", interrupted.id)));
    expect(await agent.mailbox.read(bufferName("done", interrupted.id))).toMatchObject({ ok: false });
    const cancelled = { ...request, id: crypto.randomUUID() };
    await agent.mailbox.put(bufferName("cancel", cancelled.id), {});
    await agent.mailbox.put(bufferName("run", cancelled.id), cancelled);
    await until(async () => (await agent.mailbox.list()).includes(bufferName("done", cancelled.id)));
    expect(await agent.mailbox.read(bufferName("done", cancelled.id))).toMatchObject({ ok: false });
    expect(agent.calls).toHaveLength(1);
  }, 20_000);

  it("correlates cancellation and keeps local input out of another user's response", async () => {
    const cfg = config();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const agent = await fakeAgent(cfg, async (text) => {
      if (text.includes("remote-task")) await gate;
      return text.includes("local-task") ? "local-result" : "remote-result";
    });
    const request: RunRequest = { id: crypto.randomUUID(), text: "remote-task", origin: { kind: "local" }, createdAt: Date.now(), expiresAt: Date.now() + 30_000 };
    await agent.mailbox.put(bufferName("run", request.id), request);
    await until(async () => agent.calls.length === 1);
    expect(await agent.emit("input", { source: "interactive", text: "local-task" })).toEqual({ action: "handled" });
    await agent.mailbox.put(bufferName("cancel", crypto.randomUUID()), {});
    await agent.mailbox.put(bufferName("cancel", request.id), {});
    await new Promise((resolve) => setTimeout(resolve, 600));
    release!();
    await until(async () => (await agent.mailbox.list()).includes(bufferName("done", request.id)));
    expect(await agent.mailbox.read(bufferName("done", request.id))).toMatchObject({ ok: false });
    await until(async () => agent.calls.length === 2);
    expect(agent.calls[1]).toBe("local-task");
  }, 20_000);

  it("delegates manager → worker → manager using tmux only, including a relay restart", async () => {
    const manager = config("manager");
    const worker = config();
    const managerAgent = await fakeAgent(manager);
    const workerAgent = await fakeAgent(worker, async () => "worker-result");
    const registry = new Registry(path.join(worker.stateDir, "state.sqlite"));
    cleanup.push(() => registry.close());
    const runner = new TmuxAgentRunner(worker, workerAgent.configPath, registry, logger);
    await runner.start();
    cleanup.push(() => runner.shutdown());
    const tool = managerAgent.tools.get("delegate_to_worker")!;
    const result = tool.execute("tool-1", { workerId: "worker", task: "test delegated task" }, new AbortController().signal);
    // Observe errors immediately, even if an assertion below fails.
    void result.catch(() => undefined);
    await until(async () => (await managerAgent.mailbox.list("pst-out-request-")).length === 1);
    await new TmuxRelay([manager, worker], logger).tick();
    const requestName = (await managerAgent.mailbox.list("pst-out-request-"))[0]!;
    expect(requestName).toBeDefined();
    // Recreated relay has no in-memory correlation state; the buffers carry it.
    const restarted = new TmuxRelay([manager, worker], logger);
    await until(async () => { await restarted.tick(); return (await managerAgent.mailbox.list("pst-out-request-")).length === 0; });
    expect((await result).content[0]?.text).toBe("worker-result");
    expect(workerAgent.calls).toHaveLength(1);
    expect(workerAgent.calls[0]).toContain("Delegated by trusted configured agent: manager");
  }, 20_000);

  it("refuses unrelated tmux sessions and never kills them on failed startup", async () => {
    const cfg = config();
    const box = await server(cfg);
    await box.exec(["rename-session", "-t", cfg.expectedUnixUser, "unrelated"]);
    const registry = new Registry(path.join(cfg.stateDir, "state.sqlite"));
    cleanup.push(() => registry.close());
    const runner = new TmuxAgentRunner(cfg, "/unused", registry, logger);
    await expect(runner.start()).rejects.toThrow("unrelated");
    await runner.shutdown();
    expect(await box.exec(["list-sessions", "-F", "#{session_name}"])).toContain("unrelated");
  });

  it("reports an offline worker without allocating an extra session", async () => {
    const manager = config("manager");
    const worker = config();
    const box = await server(manager);
    const request = delegation(worker);
    await box.put(bufferName("out-request", request.id), request);
    await new TmuxRelay([manager, worker], logger).tick();
    expect(await box.read(bufferName("peer-result", request.id))).toMatchObject({ ok: false, text: expect.stringContaining("offline") });
    expect(fs.existsSync(tmuxSocketPath(worker))).toBe(false);
  });
});
