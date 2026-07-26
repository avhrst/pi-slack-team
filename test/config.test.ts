import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSlackCredentials,
  resolveCredentialFiles,
} from "../src/config/load-config.js";
import { agentConfigSchema } from "../src/config/schema.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-team-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validConfig() {
  return agentConfigSchema.parse({
    version: 1,
    agentId: "support",
    expectedUnixUser: "support-agent",
    stateDir: "/home/support-agent/.local/state/pi-slack-team",
    slack: {
      teamId: "T0123456789",
      appId: "A0123456789",
      allowedUserIds: ["U0123456789"],
    },
    pi: {
      cwd: "/home/support-agent",
      agentDir: "/home/support-agent/.pi/agent",
      sessionDir: "/home/support-agent/.pi/agent/sessions",
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent config", () => {
  it("applies safe runtime defaults", () => {
    const config = validConfig();
    expect(config.pi.command).toBe("/usr/bin/pi");
    expect(config.pi.maxActiveSessions).toBe(1);
    expect(config.pi.idleTimeoutMs).toBe(300_000);
  });

  it("requires at least one allowed Slack user", () => {
    const input = structuredClone(validConfig());
    input.slack.allowedUserIds = [];
    expect(() => agentConfigSchema.parse(input)).toThrow();
  });

  it("loads owner-only token files without exposing values", () => {
    const directory = temporaryDirectory();
    const botTokenFile = path.join(directory, "bot");
    const appTokenFile = path.join(directory, "app");
    const botToken = ["xoxb", "unit-test-only-abcdefghijklmnop"].join("-");
    const appToken = ["xapp", "unit-test-only-abcdefghijklmnop"].join("-");
    fs.writeFileSync(botTokenFile, `${botToken}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(appTokenFile, `${appToken}\n`, {
      mode: 0o600,
    });
    const config = {
      ...validConfig(),
      credentials: { botTokenFile, appTokenFile },
    };

    expect(resolveCredentialFiles(config)).toEqual({
      botTokenFile,
      appTokenFile,
    });
    expect(loadSlackCredentials(config)).toEqual({
      botToken,
      appToken,
    });
  });

  it("rejects placeholder and broadly readable credentials", () => {
    const directory = temporaryDirectory();
    const botTokenFile = path.join(directory, "bot");
    const appTokenFile = path.join(directory, "app");
    fs.writeFileSync(
      botTokenFile,
      ["xoxb", "REPLACE_THIS_TOKEN_VALUE"].join("-"),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      appTokenFile,
      ["xapp", "unit-test-only-abcdefghijklmnop"].join("-"),
      {
      mode: 0o644,
      },
    );
    const config = {
      ...validConfig(),
      credentials: { botTokenFile, appTokenFile },
    };
    expect(() => loadSlackCredentials(config)).toThrow();
  });
});
