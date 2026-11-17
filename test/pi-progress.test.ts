import { describe, expect, it } from "vitest";
import { deploymentSnapshot, toSlackMrkdwn } from "../src/slack/pi-progress.js";

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

describe("deploymentSnapshot", () => {
  const marker = { version: 1, stage: "apex", state: "running", planned: 5, completed: 2,
    pending: 3, ok: 2, warn: 0, fail: 0, skip: 0, current: "TT3" };

  function payload(value: object) {
    return { content: [{ type: "text", text: `PRIVATE_OUTPUT\nPI_DEPLOY_PROGRESS ${JSON.stringify(value)}` }] };
  }

  it("extracts the latest validated snapshot without including surrounding output", () => {
    const newest = { ...marker, completed: 3, pending: 2, warn: 1 };
    const result = { content: [...payload(marker).content, ...payload(newest).content] };
    expect(deploymentSnapshot(result)).toEqual({
      stage: "apex", state: "running", planned: 5, completed: 3, pending: 2, ok: 2,
      warn: 1, fail: 0, skip: 0, current: "TT3",
    });
  });

  it.each([{ pending: 5 }, { fail: 1 }, { version: 2 }, { current: "invalid <TT>" }, { completed: 6 }])(
    "rejects inconsistent or malformed markers (%j)", overrides => {
      expect(deploymentSnapshot(payload({ ...marker, ...overrides }))).toBeUndefined();
    },
  );
});
