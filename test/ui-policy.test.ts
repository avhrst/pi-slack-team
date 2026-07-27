import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/config/schema.js";
import type { RpcRecord } from "../src/pi/rpc-client.js";
import { matchAutomaticSelect } from "../src/pi/ui-policy.js";

const rules: AgentConfig["pi"]["autoSelect"] = [
  { title: "Live check passed. Choose:", option: "Import existing" },
];

function request(overrides: Partial<RpcRecord> = {}): RpcRecord {
  return {
    type: "extension_ui_request",
    id: "dialog-1",
    method: "select",
    title: "Live check passed. Choose:",
    options: ["Check only", "Import existing"],
    ...overrides,
  };
}

describe("matchAutomaticSelect", () => {
  it("returns an exact configured option that is present in the request", () => {
    expect(matchAutomaticSelect(rules, request())).toEqual({
      response: { value: "Import existing" },
      ruleIndex: 0,
    });
  });

  it("fails closed for changed titles, missing options, and non-select dialogs", () => {
    expect(
      matchAutomaticSelect(rules, request({ title: "Live check passed" })),
    ).toBeUndefined();
    expect(
      matchAutomaticSelect(rules, request({ options: ["Check only"] })),
    ).toBeUndefined();
    expect(
      matchAutomaticSelect(rules, request({ method: "confirm" })),
    ).toBeUndefined();
    expect(
      matchAutomaticSelect(rules, request({ options: ["Import existing", 1] })),
    ).toBeUndefined();
  });
});
