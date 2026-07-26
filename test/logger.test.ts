import { describe, expect, it } from "vitest";
import { createLogger } from "../src/observability/logger.js";

describe("logger", () => {
  it("redacts secret and message-shaped fields recursively", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.info("test", {
      token: "xoxb-do-not-log",
      nested: { message: "private prompt", safe: "visible" },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("xoxb-do-not-log");
    expect(lines[0]).not.toContain("private prompt");
    expect(lines[0]).toContain("visible");
  });
});
