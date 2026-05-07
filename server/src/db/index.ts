import Database, { type Database as Db } from "better-sqlite3";
import fs from "node:fs";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";

export interface ClaudexDb {
  db: Db;
  close(): void;
}

// Hand-rolled migrations. Each entry is a (id, up) pair. ID must be monotonic.
// Do NOT rewrite history — add a new entry.
const MIGRATIONS: { id: number; name: string; up: string }[] = [
  {
    id: 1,
    name: "init",
    up: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        totp_secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        trusted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        branch TEXT,
        worktree_path TEXT,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT,
        archived_at TEXT,
        -- aggregate stats, kept in sync server-side
        stats_messages INTEGER NOT NULL DEFAULT 0,
        stats_files_changed INTEGER NOT NULL DEFAULT 0,
        stats_lines_added INTEGER NOT NULL DEFAULT 0,
        stats_lines_removed INTEGER NOT NULL DEFAULT 0,
        stats_context_pct REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_sessions_project ON sessions(project_id);
      CREATE INDEX idx_sessions_status ON sessions(status);
      CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

      CREATE TABLE session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL  -- JSON-encoded
      );
      CREATE INDEX idx_events_session_seq ON session_events(session_id, seq);

      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,    -- JSON
        summary TEXT NOT NULL,
        blast_radius TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        decision TEXT               -- allow_once | allow_always | deny
      );
      CREATE INDEX idx_approvals_session ON pending_approvals(session_id, resolved_at);

      CREATE TABLE tool_grants (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        -- NULL session_id = global grant
        tool_name TEXT NOT NULL,
        input_signature TEXT NOT NULL,  -- e.g. "pnpm vitest *"; tool-specific
        created_at TEXT NOT NULL,
        UNIQUE(session_id, tool_name, input_signature)
      );
    `,
  },
];

export function openDb(config: Config, log: Logger): ClaudexDb {
  // Touch the file with tight perms before sqlite opens it.
  if (!fs.existsSync(config.dbPath)) {
    fs.writeFileSync(config.dbPath, "");
    fs.chmodSync(config.dbPath, 0o600);
  }
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 2000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    db.prepare("SELECT id FROM _migrations").all().map((r: any) => r.id),
  );
  const insertMigration = db.prepare(
    "INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    log.info({ id: m.id, name: m.name }, "applying migration");
    db.transaction(() => {
      db.exec(m.up);
      insertMigration.run(m.id, m.name, new Date().toISOString());
    })();
  }

  return {
    db,
    close: () => db.close(),
  };
}
