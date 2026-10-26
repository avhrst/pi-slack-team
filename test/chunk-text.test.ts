import { describe, expect, it } from "vitest";
import { chunkSlackText } from "../src/slack/chunk-text.js";

describe("chunkSlackText", () => {
  it("keeps short text as a single message", () => {
    expect(chunkSlackText("hello", 16)).toEqual(["hello"]);
  });

  it("prefers paragraph boundaries over line boundaries", () => {
    const text = "aaaaaa\nbbbbbb\n\ncccccc\ndddddd";
    expect(chunkSlackText(text, 20)).toEqual(["aaaaaa\nbbbbbb", "cccccc\ndddddd"]);
  });

  it("falls back to line boundaries", () => {
    expect(chunkSlackText("aaaaaaa\nbbbbbbb\nccccccc", 16)).toEqual([
      "aaaaaaa\nbbbbbbb",
      "ccccccc",
    ]);
  });

  it("hard-splits text without usable boundaries", () => {
    const chunks = chunkSlackText("x".repeat(40), 16);
    expect(chunks).toEqual(["x".repeat(16), "x".repeat(16), "x".repeat(8)]);
  });

  it("never cuts a surrogate pair", () => {
    const text = `${"x".repeat(15)}😀${"y".repeat(5)}`;
    const chunks = chunkSlackText(text, 16);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(16);
      expect(chunk).not.toMatch(/[\ud800-\udbff]$/u);
    }
  });

  it("closes and reopens a code fence split across messages", () => {
    const code = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
    const text = `Intro\n\`\`\`\n${code}\n\`\`\`\nDone`;
    const chunks = chunkSlackText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
      expect(chunk.split("```").length % 2).toBe(1);
    }
    expect(chunks[1]?.startsWith("```\n")).toBe(true);
    expect(chunks.at(-1)?.endsWith("Done")).toBe(true);
  });

  it("never exceeds the limit", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    for (const chunk of chunkSlackText(text, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("rejects limits too small to hold a reopened fence", () => {
    expect(() => chunkSlackText("x".repeat(20), 8)).toThrow();
  });
});
