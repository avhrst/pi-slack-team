import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

export interface ConversationKey {
  teamId: string;
  appId: string;
  channelId: string;
  threadTs: string;
}

export interface ConversationRecord extends ConversationKey {
  ownerUserId: string;
  piSessionFile: string | null;
  piSessionId: string | null;
  status: "starting" | "idle" | "running" | "error";
  createdAt: string;
  lastActivityAt: string;
}

interface ConversationRow {
  team_id: string;
  app_id: string;
  channel_id: string;
  thread_ts: string;
  owner_user_id: string;
  pi_session_file: string | null;
  pi_session_id: string | null;
  status: ConversationRecord["status"];
  created_at: string;
  last_activity_at: string;
}

function toRecord(row: ConversationRow): ConversationRecord {
  return {
    teamId: row.team_id,
    appId: row.app_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    ownerUserId: row.owner_user_id,
    piSessionFile: row.pi_session_file,
    piSessionId: row.pi_session_id,
    status: row.status,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

export class Registry {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        team_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        pi_session_file TEXT,
        pi_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'idle', 'running', 'error')),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        PRIMARY KEY (team_id, app_id, channel_id, thread_ts)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS pending_actions (
        action_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        pi_request_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;
    `);
  }

  claimEvent(eventId: string, now = new Date()): boolean {
    const result: StatementResultingChanges = this.#database
      .prepare(
        "INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)",
      )
      .run(eventId, now.toISOString());
    return result.changes === 1;
  }

  pruneEvents(before: Date): number {
    const result = this.#database
      .prepare("DELETE FROM processed_events WHERE processed_at < ?")
      .run(before.toISOString());
    return Number(result.changes);
  }

  getConversation(key: ConversationKey): ConversationRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT team_id, app_id, channel_id, thread_ts, owner_user_id,
                pi_session_file, pi_session_id, status, created_at, last_activity_at
           FROM conversations
          WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?`,
      )
      .get(
        key.teamId,
        key.appId,
        key.channelId,
        key.threadTs,
      ) as ConversationRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  createConversation(
    key: ConversationKey,
    ownerUserId: string,
    now = new Date(),
  ): ConversationRecord {
    const timestamp = now.toISOString();
    this.#database
      .prepare(
        `INSERT OR IGNORE INTO conversations (
           team_id, app_id, channel_id, thread_ts, owner_user_id,
           status, created_at, last_activity_at
         ) VALUES (?, ?, ?, ?, ?, 'starting', ?, ?)`,
      )
      .run(
        key.teamId,
        key.appId,
        key.channelId,
        key.threadTs,
        ownerUserId,
        timestamp,
        timestamp,
      );

    const conversation = this.getConversation(key);
    if (!conversation) throw new Error("Failed to create conversation");
    if (conversation.ownerUserId !== ownerUserId) {
      throw new Error("Conversation belongs to another Slack user");
    }
    return conversation;
  }

  transferConversationOwner(
    key: ConversationKey,
    expectedOwnerUserId: string,
    newOwnerUserId: string,
    now = new Date(),
  ): ConversationRecord | undefined {
    const result = this.#database
      .prepare(
        `UPDATE conversations
            SET owner_user_id = ?, last_activity_at = ?
          WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?
            AND owner_user_id = ? AND status IN ('idle', 'error')`,
      )
      .run(
        newOwnerUserId,
        now.toISOString(),
        key.teamId,
        key.appId,
        key.channelId,
        key.threadTs,
        expectedOwnerUserId,
      );
    return result.changes === 1 ? this.getConversation(key) : undefined;
  }

  setSession(
    key: ConversationKey,
    sessionFile: string,
    sessionId: string,
    now = new Date(),
  ): void {
    this.#database
      .prepare(
        `UPDATE conversations
            SET pi_session_file = ?, pi_session_id = ?, status = 'idle',
                last_activity_at = ?
          WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?`,
      )
      .run(
        sessionFile,
        sessionId,
        now.toISOString(),
        key.teamId,
        key.appId,
        key.channelId,
        key.threadTs,
      );
  }

  setStatus(
    key: ConversationKey,
    status: ConversationRecord["status"],
    now = new Date(),
  ): void {
    this.#database
      .prepare(
        `UPDATE conversations
            SET status = ?, last_activity_at = ?
          WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?`,
      )
      .run(
        status,
        now.toISOString(),
        key.teamId,
        key.appId,
        key.channelId,
        key.threadTs,
      );
  }

  close(): void {
    this.#database.close();
  }
}
