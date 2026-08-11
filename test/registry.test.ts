import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("transfers an idle conversation owner with compare-and-set semantics", () => {
    const registry = createRegistry();
    const channelKey = { ...key, channelId: "C01" };
    registry.createConversation(channelKey, "UMANAGER");

    expect(
      registry.transferConversationOwner(channelKey, "UMANAGER", "U01"),
    ).toBeUndefined();

    registry.setSession(channelKey, "/tmp/session.jsonl", "session-01");
    expect(
      registry.transferConversationOwner(
        channelKey,
        "UMANAGER",
        "U01",
        new Date("2026-07-27T10:00:00.000Z"),
      ),
    ).toMatchObject({
      ownerUserId: "U01",
      status: "idle",
      lastActivityAt: "2026-07-27T10:00:00.000Z",
    });
    expect(
      registry.transferConversationOwner(channelKey, "UMANAGER", "U02"),
    ).toBeUndefined();

    registry.setStatus(channelKey, "running");
    expect(
      registry.transferConversationOwner(channelKey, "U01", "U02"),
    ).toBeUndefined();
    registry.close();
  });

  it("shares one direct-user session across DM roots", () => {
    const registry = createRegistry();
    const first = registry.createConversation(key, "U01");
    registry.setSession(key, "/tmp/direct.jsonl", "direct-session");
    const secondKey = { ...key, threadTs: "789.000" };
    const second = registry.createConversation(secondKey, "U01");

    expect(second.sessionKey).toBe(first.sessionKey);
    expect(second).toMatchObject({
      piSessionFile: "/tmp/direct.jsonl",
      piSessionId: "direct-session",
    });

    const otherUser = registry.createConversation(
      { ...key, channelId: "D02", threadTs: "999.000" },
      "U02",
    );
    expect(otherUser.sessionKey).not.toBe(first.sessionKey);
    registry.close();
  });

  it("keeps channel threads in separate sessions", () => {
    const registry = createRegistry();
    const first = registry.createConversation(
      { ...key, channelId: "C01" },
      "U01",
    );
    const second = registry.createConversation(
      { ...key, channelId: "C01", threadTs: "789.000" },
      "U01",
    );
    expect(second.sessionKey).not.toBe(first.sessionKey);
    registry.close();
  });

  it("migrates legacy DM rows to the most recent user session", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slack-team-db-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "state.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE conversations (
        team_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        pi_session_file TEXT,
        pi_session_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        PRIMARY KEY (team_id, app_id, channel_id, thread_ts)
      ) STRICT;
      INSERT INTO conversations VALUES
        ('T01', 'A01', 'D01', '111.000', 'U01', '/tmp/old.jsonl', 'old', 'idle',
         '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        ('T01', 'A01', 'D01', '222.000', 'U01', '/tmp/new.jsonl', 'new', 'idle',
         '2026-01-02T00:00:00.000Z', '2026-01-02T01:00:00.000Z');
    `);
    legacy.close();

    const registry = new Registry(databasePath);
    expect(
      registry.getConversation({ ...key, threadTs: "111.000" }),
    ).toMatchObject({
      piSessionFile: "/tmp/new.jsonl",
      piSessionId: "new",
    });
    expect(
      registry.getConversation({ ...key, threadTs: "222.000" })?.sessionKey,
    ).toBe(
      registry.getConversation({ ...key, threadTs: "111.000" })?.sessionKey,
    );
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
