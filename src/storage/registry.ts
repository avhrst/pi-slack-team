import fs from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type StatementResultingChanges,
  type StatementSync,
} from "node:sqlite";
import {
  piSessionKey,
  serializePiSessionKey,
  type PiSessionKey,
} from "../routing/session-key.js";

export interface ConversationKey {
  teamId: string;
  appId: string;
  channelId: string;
  threadTs: string;
}

export interface ConversationRecord extends ConversationKey {
  ownerUserId: string;
  sessionKey: string;
  piSessionFile: string | null;
  piSessionId: string | null;
  status: "starting" | "idle" | "running" | "error";
  createdAt: string;
  lastActivityAt: string;
}

export interface PiSessionRecord {
  sessionKey: string;
  scope: PiSessionKey["scope"] | "agent";
  ownerUserId: string;
  piSessionFile: string | null;
  piSessionId: string | null;
  status: ConversationRecord["status"];
  createdAt: string;
  lastActivityAt: string;
}

interface ConversationRow {
  team_id: string;
  app_id: string;
  channel_id: string;
  thread_ts: string;
  owner_user_id: string;
  session_key: string;
  pi_session_file: string | null;
  pi_session_id: string | null;
  status: ConversationRecord["status"];
  created_at: string;
  last_activity_at: string;
}

interface PiSessionRow {
  session_key: string;
  scope: PiSessionRecord["scope"];
  owner_user_id: string;
  pi_session_file: string | null;
  pi_session_id: string | null;
  status: PiSessionRecord["status"];
  created_at: string;
  last_activity_at: string;
}

function toSessionRecord(row: PiSessionRow): PiSessionRecord {
  return {
    sessionKey: row.session_key,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    piSessionFile: row.pi_session_file,
    piSessionId: row.pi_session_id,
    status: row.status,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

function toRecord(row: ConversationRow): ConversationRecord {
  return {
    teamId: row.team_id,
    appId: row.app_id,
    channelId: row.channel_id,
    threadTs: row.thread_ts,
    ownerUserId: row.owner_user_id,
    sessionKey: row.session_key,
    piSessionFile: row.pi_session_file,
    piSessionId: row.pi_session_id,
    status: row.status,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };
}

export class Registry {
  readonly #database: DatabaseSync;
  // Hot-path queries run per Slack message; compile each SQL text once.
  readonly #statements = new Map<string, StatementSync>();

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

      CREATE TABLE IF NOT EXISTS pi_sessions (
        session_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('direct-user', 'channel-thread')),
        owner_user_id TEXT NOT NULL,
        pi_session_file TEXT,
        pi_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'idle', 'running', 'error')),
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS slack_threads (
        team_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        engaged INTEGER NOT NULL DEFAULT 0 CHECK (engaged IN (0, 1)),
        context_ts TEXT,
        PRIMARY KEY (team_id, app_id, channel_id, thread_ts)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS slack_publications (
        publication_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS processed_events_processed_at
        ON processed_events (processed_at);

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

    // Preserve legacy sessions; widen the CHECK without rewriting their history.
    const sessionTable = this.#database.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'pi_sessions'",
    ).get() as { sql: string };
    if (!sessionTable.sql.includes("'agent'")) {
      this.#transaction(() => this.#database.exec(`
        ALTER TABLE pi_sessions RENAME TO pi_sessions_legacy;
        CREATE TABLE pi_sessions (
          session_key TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('direct-user', 'channel-thread', 'agent')),
          owner_user_id TEXT NOT NULL,
          pi_session_file TEXT, pi_session_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('starting', 'idle', 'running', 'error')),
          created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO pi_sessions SELECT * FROM pi_sessions_legacy;
        DROP TABLE pi_sessions_legacy;
      `));
    }

    const columns = this.#database
      .prepare("PRAGMA table_info(conversations)")
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "session_key")) {
      this.#database.exec("ALTER TABLE conversations ADD COLUMN session_key TEXT");
    }

    const legacyRows = this.#database
      .prepare(
        `SELECT team_id, app_id, channel_id, thread_ts, owner_user_id,
                pi_session_file, pi_session_id, status, created_at, last_activity_at
           FROM conversations
          WHERE session_key IS NULL
          ORDER BY last_activity_at ASC`,
      )
      .all() as Array<Omit<ConversationRow, "session_key">>;
    const upsertSession = this.#database.prepare(`
      INSERT INTO pi_sessions (
        session_key, scope, owner_user_id, pi_session_file, pi_session_id,
        status, created_at, last_activity_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        pi_session_file = CASE
          WHEN excluded.pi_session_file IS NOT NULL THEN excluded.pi_session_file
          ELSE pi_sessions.pi_session_file
        END,
        pi_session_id = CASE
          WHEN excluded.pi_session_id IS NOT NULL THEN excluded.pi_session_id
          ELSE pi_sessions.pi_session_id
        END,
        status = excluded.status,
        last_activity_at = excluded.last_activity_at
    `);
    const bindConversation = this.#database.prepare(`
      UPDATE conversations SET session_key = ?
       WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?
    `);
    if (legacyRows.length === 0) return;
    this.#transaction(() => {
      for (const row of legacyRows) {
        const key: ConversationKey = {
          teamId: row.team_id,
          appId: row.app_id,
          channelId: row.channel_id,
          threadTs: row.thread_ts,
        };
        const session = piSessionKey(key, row.owner_user_id);
        const serialized = serializePiSessionKey(session);
        upsertSession.run(
          serialized,
          session.scope,
          row.owner_user_id,
          row.pi_session_file,
          row.pi_session_id,
          row.status,
          row.created_at,
          row.last_activity_at,
        );
        bindConversation.run(
          serialized,
          row.team_id,
          row.app_id,
          row.channel_id,
          row.thread_ts,
        );
      }
    });
  }

  #transaction(operation: () => void): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  claimEvent(eventId: string, now = new Date()): boolean {
    const result: StatementResultingChanges = this.#statement(
      "INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)",
    ).run(eventId, now.toISOString());
    return result.changes === 1;
  }

  pruneEvents(before: Date): number {
    const result = this.#statement("DELETE FROM processed_events WHERE processed_at < ?")
      .run(before.toISOString());
    return Number(result.changes);
  }

  getConversation(key: ConversationKey): ConversationRecord | undefined {
    const row = this.#statement(
      `SELECT c.team_id, c.app_id, c.channel_id, c.thread_ts, c.owner_user_id,
              c.session_key,
              COALESCE(s.pi_session_file, c.pi_session_file) AS pi_session_file,
              COALESCE(s.pi_session_id, c.pi_session_id) AS pi_session_id,
              COALESCE(s.status, c.status) AS status,
              c.created_at,
              COALESCE(s.last_activity_at, c.last_activity_at) AS last_activity_at
         FROM conversations c
         LEFT JOIN pi_sessions s ON s.session_key = c.session_key
        WHERE c.team_id = ? AND c.app_id = ? AND c.channel_id = ? AND c.thread_ts = ?`,
    ).get(
      key.teamId,
      key.appId,
      key.channelId,
      key.threadTs,
    ) as ConversationRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  getPiSession(sessionKey: string): PiSessionRecord | undefined {
    const row = this.#statement(
      `SELECT session_key, scope, owner_user_id, pi_session_file,
              pi_session_id, status, created_at, last_activity_at
         FROM pi_sessions WHERE session_key = ?`,
    ).get(sessionKey) as PiSessionRow | undefined;
    return row ? toSessionRecord(row) : undefined;
  }

  /** Old worker channel conversations could only originate from an invocation. */
  backfillWorkerThreads(): void {
    this.#database.exec(`
      INSERT OR IGNORE INTO slack_threads (team_id, app_id, channel_id, thread_ts, engaged)
      SELECT team_id, app_id, channel_id, thread_ts, 1 FROM conversations
       WHERE channel_id GLOB '[CG]*'
    `);
  }

  ensureDelegatedThread(key: ConversationKey): void {
    this.#statement(`INSERT OR IGNORE INTO slack_threads
      (team_id, app_id, channel_id, thread_ts, engaged) VALUES (?, ?, ?, ?, 0)`)
      .run(key.teamId, key.appId, key.channelId, key.threadTs);
  }

  savePublication(id: string, state: unknown): void {
    this.#statement(`INSERT INTO slack_publications VALUES (?, ?, ?)
      ON CONFLICT(publication_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .run(id, JSON.stringify(state), new Date().toISOString());
  }

  loadPublication<T>(id: string): T | undefined {
    const row = this.#statement("SELECT state_json FROM slack_publications WHERE publication_id=?").get(id) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as T : undefined;
  }

  publications<T>(): Array<{ id: string; state: T }> {
    return (this.#statement("SELECT publication_id, state_json FROM slack_publications").all() as Array<{ publication_id: string; state_json: string }>)
      .map(row => ({ id: row.publication_id, state: JSON.parse(row.state_json) as T }));
  }

  threadState(key: ConversationKey): { engaged: boolean; contextTs?: string } {
    const row = this.#statement(`
      SELECT engaged, context_ts FROM slack_threads
       WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?
    `).get(key.teamId, key.appId, key.channelId, key.threadTs) as
      { engaged: number; context_ts: string | null } | undefined;
    return {
      engaged: row?.engaged === 1,
      ...(row?.context_ts ? { contextTs: row.context_ts } : {}),
    };
  }

  engageThread(key: ConversationKey): void {
    this.#statement(`
      INSERT INTO slack_threads (team_id, app_id, channel_id, thread_ts, engaged)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(team_id, app_id, channel_id, thread_ts) DO UPDATE SET engaged = 1
    `).run(key.teamId, key.appId, key.channelId, key.threadTs);
  }

  advanceThreadContext(key: ConversationKey, throughTs: string): void {
    this.#statement(`
      INSERT INTO slack_threads (team_id, app_id, channel_id, thread_ts, context_ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, app_id, channel_id, thread_ts) DO UPDATE SET context_ts = excluded.context_ts
       WHERE context_ts IS NULL OR CAST(context_ts AS REAL) < CAST(excluded.context_ts AS REAL)
    `).run(key.teamId, key.appId, key.channelId, key.threadTs, throughTs);
  }

  createConversation(
    key: ConversationKey,
    ownerUserId: string,
    now = new Date(),
  ): ConversationRecord {
    const timestamp = now.toISOString();
    const session = piSessionKey(key, ownerUserId);
    const sessionKey = serializePiSessionKey(session);
    this.#statement(
      `INSERT OR IGNORE INTO pi_sessions (
         session_key, scope, owner_user_id, status, created_at, last_activity_at
       ) VALUES (?, ?, ?, 'starting', ?, ?)`,
    ).run(sessionKey, session.scope, ownerUserId, timestamp, timestamp);
    this.#statement(
      `INSERT OR IGNORE INTO conversations (
         team_id, app_id, channel_id, thread_ts, owner_user_id, session_key,
         status, created_at, last_activity_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
    ).run(
      key.teamId,
      key.appId,
      key.channelId,
      key.threadTs,
      ownerUserId,
      sessionKey,
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
    const result = this.#statement(
      `UPDATE conversations
          SET owner_user_id = ?, last_activity_at = ?
        WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?
          AND owner_user_id = ?
          AND COALESCE(
            (SELECT status FROM pi_sessions
              WHERE session_key = conversations.session_key),
            status
          ) IN ('idle', 'error')`,
    ).run(
      newOwnerUserId,
      now.toISOString(),
      key.teamId,
      key.appId,
      key.channelId,
      key.threadTs,
      expectedOwnerUserId,
    );
    if (result.changes !== 1) return undefined;
    const conversation = this.getConversation(key);
    if (!conversation) return undefined;
    this.#statement(
      `UPDATE pi_sessions
          SET owner_user_id = ?, last_activity_at = ?
        WHERE session_key = ?`,
    ).run(newOwnerUserId, now.toISOString(), conversation.sessionKey);
    return this.getConversation(key);
  }

  bindAgentSession(key: ConversationKey, sessionFile: string, sessionId: string): void {
    const sessionKey = `agent:${key.teamId}:${key.appId}`;
    const now = new Date().toISOString();
    this.#statement(`
      INSERT OR IGNORE INTO pi_sessions
        (session_key, scope, owner_user_id, status, created_at, last_activity_at)
      VALUES (?, 'agent', '', 'idle', ?, ?)
    `).run(sessionKey, now, now);
    this.#statement(`
      UPDATE conversations SET session_key = ?
      WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?
    `).run(sessionKey, key.teamId, key.appId, key.channelId, key.threadTs);
    this.setSession(key, sessionFile, sessionId);
  }

  setSession(
    key: ConversationKey,
    sessionFile: string,
    sessionId: string,
    now = new Date(),
  ): void {
    const conversation = this.getConversation(key);
    if (!conversation) throw new Error("Conversation does not exist");
    const timestamp = now.toISOString();
    this.#statement(
      `UPDATE pi_sessions
          SET pi_session_file = ?, pi_session_id = ?, status = 'idle',
              last_activity_at = ?
        WHERE session_key = ?`,
    ).run(sessionFile, sessionId, timestamp, conversation.sessionKey);
    this.#statement(
      `UPDATE conversations
          SET pi_session_file = ?, pi_session_id = ?, status = 'idle',
              last_activity_at = ?
        WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?`,
    ).run(
      sessionFile,
      sessionId,
      timestamp,
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
    const conversation = this.getConversation(key);
    if (!conversation) throw new Error("Conversation does not exist");
    const timestamp = now.toISOString();
    this.#statement(
      `UPDATE pi_sessions SET status = ?, last_activity_at = ?
        WHERE session_key = ?`,
    ).run(status, timestamp, conversation.sessionKey);
    this.#statement(
      `UPDATE conversations
          SET status = ?, last_activity_at = ?
        WHERE team_id = ? AND app_id = ? AND channel_id = ? AND thread_ts = ?`,
    ).run(
      status,
      timestamp,
      key.teamId,
      key.appId,
      key.channelId,
      key.threadTs,
    );
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  close(): void {
    this.#statements.clear();
    this.#database.close();
  }
}
