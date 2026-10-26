import { describe, expect, it } from "vitest";
import { chunkSlackText } from "../src/slack/chunk-text.js";

describe("chunkSlackText", () => {
  it("keeps short text as a single message", () => {
    expect(chunkSlackText("hello", 10)).toEqual(["hello"]);
  });

  it("prefers paragraph boundaries over line boundaries", () => {
    const text = "aaaa\nbbbb\n\ncccc\ndddd";
    expect(chunkSlackText(text, 12)).toEqual(["aaaa\nbbbb", "cccc\ndddd"]);
  });

  it("falls back to line boundaries", () => {
    expect(chunkSlackText("aaaa\nbbbb\ncccc", 10)).toEqual([
      "aaaa\nbbbb",
      "cccc",
    ]);
  });

  it("hard-splits text without usable boundaries", () => {
    const chunks = chunkSlackText("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("never cuts a surrogate pair", () => {
    const text = `${"x".repeat(9)}😀${"y".repeat(5)}`;
    const chunks = chunkSlackText(text, 10);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
      expect(chunk).not.toMatch(/[\ud800-\udbff]$/u);
    }
  });

  it("never exceeds the limit", () => {
    const text = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    for (const chunk of chunkSlackText(text, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});
