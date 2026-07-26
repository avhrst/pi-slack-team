import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Registry, type ConversationKey } from "../src/storage/registry.js";

const temporaryDirectories: string[] = [];

function createRegistry(): Registry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-team-db-"));
  temporaryDirectories.push(directory);
  return new Registry(path.join(directory, "state.sqlite"));
}

const key: ConversationKey = {
  teamId: "T01",
  appId: "A01",
  channelId: "D01",
  threadTs: "123.456",
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Registry", () => {
  it("claims each Slack event only once", () => {
    const registry = createRegistry();
    expect(registry.claimEvent("Ev01")).toBe(true);
    expect(registry.claimEvent("Ev01")).toBe(false);
    registry.close();
  });

  it("persists conversation ownership and Pi session metadata", () => {
    const registry = createRegistry();
    const created = registry.createConversation(key, "U01");
    expect(created.status).toBe("starting");
    expect(created.ownerUserId).toBe("U01");

    registry.setSession(key, "/tmp/session.jsonl", "session-01");
    expect(registry.getConversation(key)).toMatchObject({
      ownerUserId: "U01",
      piSessionFile: "/tmp/session.jsonl",
      piSessionId: "session-01",
      status: "idle",
    });
    expect(() => registry.createConversation(key, "U02")).toThrow(
      "Conversation belongs to another Slack user",
    );
    registry.close();
  });
});
