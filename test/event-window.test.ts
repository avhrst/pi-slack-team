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

  it("evicts partial results before tool start and end events", () => {
    const window = new RunEventWindow(4);
    window.push({ type: "tool_execution_start", toolCallId: "a" });
    window.push({ type: "tool_execution_update", toolCallId: "a" });
    window.push({ type: "tool_execution_start", toolCallId: "b" });
    window.push({ type: "tool_execution_update", toolCallId: "b" });
    window.push({ type: "tool_execution_end", toolCallId: "a" });

    expect(window.events.map((item) => `${item.event.type}:${String(item.event.toolCallId)}`)).toEqual([
      "tool_execution_start:a",
      "tool_execution_start:b",
      "tool_execution_update:b",
      "tool_execution_end:a",
    ]);
  });

  it("drops the oldest event once only start and end events remain", () => {
    const window = new RunEventWindow(2);
    window.push({ type: "tool_execution_start", toolCallId: "a" });
    window.push({ type: "tool_execution_end", toolCallId: "a" });
    window.push({ type: "tool_execution_start", toolCallId: "b" });

    expect(window.events.map((item) => item.sequence)).toEqual([2, 3]);
  });

  it("restarts sequences for a new run", () => {
    const window = new RunEventWindow();
    window.push({ type: "agent_start" });
    window.reset();
    window.push({ type: "agent_start" });

    expect(window.events).toEqual([{ sequence: 1, event: { type: "agent_start" } }]);
  });
});
