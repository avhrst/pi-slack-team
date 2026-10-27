import { describe, expect, it } from "vitest";
import { RunEventWindow } from "../src/tmux/event-window.js";

describe("RunEventWindow", () => {
  it("keeps only the latest partial result per tool call", () => {
    const window = new RunEventWindow();
    window.push({ type: "tool_execution_start", toolCallId: "a" });
    window.push({ type: "tool_execution_update", toolCallId: "a", partialResult: 1 });
    window.push({ type: "tool_execution_update", toolCallId: "a", partialResult: 2 });

    expect(window.events.map((item) => item.event)).toEqual([
      { type: "tool_execution_start", toolCallId: "a" },
      { type: "tool_execution_update", toolCallId: "a", partialResult: 2 },
    ]);
    expect(window.events.map((item) => item.sequence)).toEqual([1, 3]);
  });

  it("retains structural events and bounds publication batches instead of evicting history", () => {
    const window = new RunEventWindow(4);
    window.push({ type: "tool_execution_start", toolCallId: "a" });
    window.push({ type: "tool_execution_update", toolCallId: "a" });
    window.push({ type: "tool_execution_start", toolCallId: "b" });
    window.push({ type: "tool_execution_update", toolCallId: "b" });
    window.push({ type: "tool_execution_end", toolCallId: "a" });

    expect(window.events.map((item) => `${item.event.type}:${String(item.event.toolCallId)}`)).toEqual([
      "tool_execution_start:a",
      "tool_execution_update:a",
      "tool_execution_start:b",
      "tool_execution_update:b",
      "tool_execution_end:a",
    ]);
    expect(window.batch()).toHaveLength(4);
    window.published(window.batch().at(-1)!.sequence);
    expect(window.events.map((item) => item.event.type)).toEqual(["tool_execution_end"]);
  });

  it("keeps all starts and ends until published, including more than 16 fast events", () => {
    const window = new RunEventWindow(2);
    window.push({ type: "tool_execution_start", toolCallId: "a" });
    window.push({ type: "tool_execution_end", toolCallId: "a" });
    window.push({ type: "tool_execution_start", toolCallId: "b" });

    expect(window.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    for (let i = 0; i < 50; i++) window.push({ type: "tool_execution_end", toolCallId: String(i) });
    const seen: number[] = [];
    while (window.events.length) {
      const batch = window.batch();
      seen.push(...batch.map((item) => item.sequence));
      window.published(batch.at(-1)!.sequence);
    }
    expect(seen).toEqual(Array.from({ length: 53 }, (_, i) => i + 1));
    expect(window.sequence).toBe(53);
  });

  it("preserves public milestones separately while retaining start/end events over updates", () => {
    const window = new RunEventWindow(4, 2);
    for (let i = 0; i < 5; i++) window.push({ type: "agent_progress", text: `Phase ${i}` });
    window.push({ type: "tool_execution_start", toolCallId: "a" });
    for (let i = 0; i < 40; i++) window.push({ type: "tool_execution_update", toolCallId: "a", partialResult: i });
    window.push({ type: "tool_execution_end", toolCallId: "a" });
    window.push({ type: "tool_execution_start", toolCallId: "b" });
    window.push({ type: "tool_execution_end", toolCallId: "b" });
    expect(window.events.filter(item => item.event.type === "agent_progress").map(item => item.event.text)).toEqual(["Phase 3", "Phase 4"]);
    expect(window.events.filter(item => item.event.type !== "agent_progress").map(item => item.event.type)).toEqual([
      "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_execution_start", "tool_execution_end",
    ]);
    expect(window.events.map(item => item.sequence)).toEqual([...window.events.map(item => item.sequence)].sort((a, b) => a - b));
    expect(window.events).toHaveLength(7);
  });

  it("restarts sequences for a new run", () => {
    const window = new RunEventWindow();
    window.push({ type: "agent_start" });
    window.reset();
    window.push({ type: "agent_start" });

    expect(window.events).toEqual([{ sequence: 1, event: { type: "agent_start" } }]);
  });
});
