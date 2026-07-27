import fs from "node:fs";
import { describe, expect, it } from "vitest";

const publicFiles = [
  "README.md",
  "SECURITY.md",
  "config/README.md",
  "manifests/README.md",
  ...fs
    .readdirSync("config")
    .filter((file) => file.endsWith(".example.yaml"))
    .map((file) => `config/${file}`),
  ...fs
    .readdirSync("manifests")
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => `manifests/${file}`),
  ...fs
    .readdirSync("docs")
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/${file}`),
  ...fs
    .readdirSync("docs/adr")
    .filter((file) => file.endsWith(".md"))
    .map((file) => `docs/adr/${file}`),
];

const slackToken = /\b(?:xox[baprs]|xapp|xoxe\.xoxp)-[A-Za-z0-9-]{16,}\b/gu;
const slackId = /\b[TAUWB][A-Z0-9]{10,}\b/gu;

function source(file: string): string {
  return fs.readFileSync(file, "utf8");
}

describe("public examples", () => {
  it("contains no token-shaped values or webhook URLs", () => {
    for (const file of publicFiles) {
      const text = source(file);
      expect(text.match(slackToken), file).toBeNull();
      expect(text, file).not.toContain(
        ["hooks.slack.com", "services/"].join("/"),
      );
    }
  });

  it("uses only visibly synthetic long Slack IDs", () => {
    for (const file of publicFiles) {
      for (const id of source(file).match(slackId) ?? []) {
        expect(id, `${file}: ${id}`).toMatch(/^[TAUWB]0+$/u);
      }
    }
  });

  it("ignores common local credential and runtime artifacts", () => {
    const ignore = source(".gitignore");
    for (const pattern of [
      ".env",
      "*.token",
      "*.sqlite",
      "*.jsonl",
      "credentials/",
      "uploads/",
      "sessions/",
    ]) {
      expect(ignore).toContain(pattern);
    }
  });
});
