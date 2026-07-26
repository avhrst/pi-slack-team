import { describe, expect, it } from "vitest";
import { PiProgressTranscript } from "../src/slack/pi-progress.js";

function event(type: string, fields: Record<string, unknown> = {}) {
  return { type, ...fields };
}

describe("PiProgressTranscript", () => {
  it("renders visible assistant text and tool lifecycle summaries", () => {
    const transcript = new PiProgressTranscript();

    transcript.record(
      event("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: "Checking logs. " },
      }),
    );
    transcript.record(
      event("tool_execution_start", {
        toolName: "bash",
        args: { command: "secret command" },
      }),
    );
    transcript.record(
      event("tool_execution_end", {
        toolName: "bash",
        result: { content: [{ type: "text", text: "secret output" }] },
        isError: false,
      }),
    );

    const rendered = transcript.render("working");
    expect(rendered).toContain("Checking logs.");
    expect(rendered).toContain("Running `bash`");
    expect(rendered).toContain("`bash` finished");
    expect(rendered).not.toContain("secret command");
    expect(rendered).not.toContain("secret output");
  });

  it("never renders thinking deltas or tool call arguments", () => {
    const transcript = new PiProgressTranscript();

    expect(
      transcript.record(
        event("message_update", {
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "private chain of thought",
          },
        }),
      ),
    ).toBe(false);
    expect(
      transcript.record(
        event("message_update", {
          assistantMessageEvent: {
            type: "toolcall_delta",
            delta: "private tool arguments",
          },
        }),
      ),
    ).toBe(false);

    const rendered = transcript.render("completed");
    expect(rendered).toBe(":white_check_mark: *Pi completed*");
    expect(rendered).not.toContain("private");
  });

  it("bounds long progress transcripts for Slack updates", () => {
    const transcript = new PiProgressTranscript();
    transcript.record(
      event("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: "x".repeat(20_000) },
      }),
    );

    const rendered = transcript.render("working");
    expect(rendered.length).toBeLessThanOrEqual(12_000);
    expect(rendered).toContain("Pi is working");
  });
});
