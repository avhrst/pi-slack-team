import { describe, expect, it } from "vitest";
import {
  PiProgressTranscript,
  toSlackMrkdwn,
} from "../src/slack/pi-progress.js";

function event(type: string, fields: Record<string, unknown> = {}) {
  return { type, ...fields };
}

describe("PiProgressTranscript", () => {
  it("compacts parallel tool activity into counts", () => {
    const transcript = new PiProgressTranscript();

    transcript.record(
      event("message_update", {
        assistantMessageEvent: { type: "text_delta", delta: "Checking logs." },
      }),
    );
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "secret command" },
      }),
    );
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-2",
        toolName: "read",
      }),
    );
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-3",
        toolName: "read",
      }),
    );
    transcript.record(
      event("tool_execution_end", {
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "secret output" }] },
        isError: false,
      }),
    );

    const rendered = transcript.render("working");
    expect(rendered).toContain("Checking logs.");
    expect(rendered).toContain("`bash` × 1");
    expect(rendered).toContain("`read` × 2");
    expect(rendered).toContain("2 running");
    expect(rendered).not.toContain("Running `bash`");
    expect(rendered).not.toContain("finished");
    expect(rendered).not.toContain("secret command");
    expect(rendered).not.toContain("secret output");
  });

  it("reports the first agent start once so a queued placeholder turns into working", () => {
    const transcript = new PiProgressTranscript();

    expect(transcript.record(event("agent_start"))).toBe(true);
    expect(transcript.record(event("agent_start"))).toBe(false);
    expect(transcript.render("working")).toBe(
      ":hourglass_flowing_sand: *Pi is working…*",
    );
  });

  it("removes the duplicated final answer from completed progress", () => {
    const transcript = new PiProgressTranscript();
    transcript.record(
      event("message_update", {
        assistantMessageEvent: {
          type: "text_delta",
          delta: "I’ll inspect the database.",
        },
      }),
    );
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "bash",
      }),
    );
    transcript.record(
      event("tool_execution_end", {
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
      }),
    );
    transcript.record(
      event("message_update", {
        assistantMessageEvent: {
          type: "text_delta",
          delta: "**Database is operational.**",
        },
      }),
    );

    const rendered = transcript.render(
      "completed",
      "**Database is operational.**",
    );
    expect(rendered).toContain("I’ll inspect the database.");
    expect(rendered).toContain("*Tools:* `bash` × 1");
    expect(rendered).not.toContain("Database is operational");
  });

  it("renders raw tool arguments and live results only in raw mode", () => {
    const transcript = new PiProgressTranscript("raw");
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "printf direct-output" },
      }),
    );
    transcript.record(
      event("tool_execution_update", {
        toolCallId: "call-1",
        toolName: "bash",
        partialResult: {
          content: [{ type: "text", text: "partial output" }],
        },
      }),
    );

    const working = transcript.render("working");
    expect(working).toContain("*Command*");
    expect(working).toContain("$ printf direct-output");
    expect(working).toContain("partial output");
    expect(working).not.toContain('"command"');
    expect(working).not.toContain("{\n");

    transcript.record(
      event("tool_execution_end", {
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "final output" }] },
        isError: false,
      }),
    );
    const completed = transcript.render("completed");
    expect(completed).toContain("Tool `bash`");
    expect(completed).toContain("completed");
    expect(completed).toContain("final output");
    expect(completed).not.toContain("partial output");
  });

  it("renders validated deployment markers without exposing partial tool output", () => {
    const transcript = new PiProgressTranscript("summary");
    const first = {
      version: 1,
      stage: "apex",
      state: "running",
      planned: 50,
      completed: 10,
      pending: 40,
      ok: 10,
      warn: 0,
      fail: 0,
      skip: 0,
      current: "CHERNOVTSI",
      updatedAtUtc: "2026-08-05T14:00:00+00:00",
    };
    expect(
      transcript.record(
        event("tool_execution_update", {
          toolCallId: "call-1",
          toolName: "bash",
          partialResult: {
            content: [{
              type: "text",
              text: `raw password output\nPI_DEPLOY_PROGRESS ${JSON.stringify(first)}\nmore raw output`,
            }],
          },
        }),
      ),
    ).toBe(true);

    const rendered = transcript.render("working");
    expect(rendered).toContain("*APEX:* 10/50");
    expect(rendered).toContain("OK 10");
    expect(rendered).toContain("current `CHERNOVTSI`");
    expect(rendered).not.toContain("password");
    expect(rendered).not.toContain("raw output");
    expect(rendered).not.toContain("updatedAtUtc");

    const invalid = { ...first, current: "unsafe value with spaces" };
    expect(
      transcript.record(
        event("tool_execution_update", {
          partialResult: {
            content: [{
              type: "text",
              text: `PI_DEPLOY_PROGRESS ${JSON.stringify(invalid)}`,
            }],
          },
        }),
      ),
    ).toBe(false);
  });

  it("replaces deployment status with the newest valid marker", () => {
    const transcript = new PiProgressTranscript("summary");
    const progress = (completed: number, current: string | null) => ({
      version: 1,
      stage: "sql-files",
      state: completed === 3 ? "completed" : "running",
      planned: 3,
      completed,
      pending: 3 - completed,
      ok: completed,
      warn: 0,
      fail: 0,
      skip: 0,
      current,
    });
    for (const payload of [progress(1, "TT1"), progress(3, null)]) {
      transcript.record(
        event("tool_execution_update", {
          partialResult: {
            content: [{
              type: "text",
              text: `PI_DEPLOY_PROGRESS ${JSON.stringify(payload)}`,
            }],
          },
        }),
      );
    }
    const rendered = transcript.render("working");
    expect(rendered).toContain("*SQL file:* 3/3");
    expect(rendered).not.toContain("1/3");
    expect(rendered).not.toContain("current");
  });

  it("renders file arguments as compact labeled fields", () => {
    const transcript = new PiProgressTranscript("raw");
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "/srv/app/config.ts", offset: 20, limit: 50 },
      }),
    );

    const rendered = transcript.render("working");
    expect(rendered).toContain("*Path*\n`/srv/app/config.ts`");
    expect(rendered).toContain("• *offset:* `20`");
    expect(rendered).toContain("• *limit:* `50`");
  });

  it("never renders thinking deltas", () => {
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
    expect(rendered.length).toBeLessThanOrEqual(3_500);
    expect(rendered).toContain("Pi is working");
  });
});

describe("toSlackMrkdwn", () => {
  it("converts common Markdown without changing code", () => {
    expect(
      toSlackMrkdwn(
        "## Status\n**Healthy** — [details](https://example.com)\n`**literal**`",
      ),
    ).toBe(
      "*Status*\n*Healthy* — <https://example.com|details>\n`**literal**`",
    );
  });

  it("escapes Slack control sequences in model prose", () => {
    const rendered = toSlackMrkdwn(
      "Ping <!channel> in <#C01> via <https://evil.example|docs>",
    );
    expect(rendered).toBe(
      "Ping &lt;!channel&gt; in &lt;#C01&gt; via &lt;https://evil.example|docs&gt;",
    );
    expect(rendered).not.toMatch(/<[!#h]/u);
  });

  it("keeps generic types intact in prose and code", () => {
    expect(toSlackMrkdwn("Returns Promise<string> and `Map<K, V>`")).toBe(
      "Returns Promise&lt;string&gt; and `Map&lt;K, V&gt;`",
    );
    expect(toSlackMrkdwn("```\nconst x: Promise<string> = f();\n```")).toBe(
      "```\nconst x: Promise&lt;string&gt; = f();\n```",
    );
  });

  it("preserves existing entities instead of double-escaping them", () => {
    expect(toSlackMrkdwn("a &amp; b & c &lt;tag&gt; &#169;")).toBe(
      "a &amp; b &amp; c &lt;tag&gt; &#169;",
    );
  });

  it("drops the info string from a fenced code block", () => {
    expect(toSlackMrkdwn("```ts\nconst a = b && c;\n```")).toBe(
      "```\nconst a = b &amp;&amp; c;\n```",
    );
  });

  it("treats an unclosed streamed fence as code", () => {
    expect(toSlackMrkdwn("Before\n```sh\n**not bold** <!here>")).toBe(
      "Before\n```\n**not bold** &lt;!here&gt;",
    );
  });

  it("escapes link URLs and rejects invalid ones", () => {
    expect(toSlackMrkdwn("[q](https://example.com/?a=1&b=2)")).toBe(
      "<https://example.com/?a=1&amp;b=2|q>",
    );
    expect(toSlackMrkdwn("[x](https://exa|mple.com)")).toBe(
      "[x](https://exa|mple.com)",
    );
    expect(toSlackMrkdwn("[x](https://<!channel>)")).toBe(
      "[x](https://&lt;!channel&gt;)",
    );
  });
});

describe("raw progress escaping", () => {
  it("escapes the single-line query primary and argument keys", () => {
    const transcript = new PiProgressTranscript("raw");
    transcript.record(
      event("tool_execution_start", {
        toolCallId: "call-1",
        toolName: "search",
        args: { query: "<!channel> & co", "<!here>": "x<y" },
      }),
    );

    const rendered = transcript.render("working");
    expect(rendered).toContain("*Query*\n&lt;!channel&gt; &amp; co");
    expect(rendered).toContain("• *&lt;!here&gt;:* `x&lt;y`");
    expect(rendered).not.toContain("<!");
  });

  it("escapes the tail of a bounded working transcript", () => {
    const transcript = new PiProgressTranscript();
    transcript.record(
      event("message_update", {
        assistantMessageEvent: {
          type: "text_delta",
          delta: `${"x".repeat(20_000)} <!channel>`,
        },
      }),
    );

    const rendered = transcript.render("working");
    expect(rendered.length).toBeLessThanOrEqual(3_500);
    expect(rendered.endsWith("&lt;!channel&gt;")).toBe(true);
  });
});
