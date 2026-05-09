import Database, { type Database as Db } from "better-sqlite3";
import fs from "node:fs";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { stripHarnessNoise } from "../sessions/cli-text-filter.js";

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
  {
    id: 2,
    name: "session_sdk_id",
    // Persisted Agent SDK session_id so we can `resume` the same SDK-side
    // conversation across server restarts / session re-opens. First-write-wins
    // semantics live in the manager; NULL means "no SDK conversation yet".
    up: `
      ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;
    `,
  },
  {
    id: 3,
    name: "session_parent",
    // `/btw` side chats: a child session that reads its parent's transcript
    // for context on first spawn but never writes back into the parent. We
    // store the link on the child row so cascade-delete on the parent wipes
    // the side chat's events too. NULL = top-level session.
    //
    // Note: SQLite doesn't let us ADD COLUMN with a FK inline, so we attach
    // the constraint via a table rebuild. Cheaper than a full rewrite — just
    // the one column — but still transactional.
    up: `
      ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
      CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
    `,
  },
  {
    id: 4,
    name: "routines",
    // Scheduled "recipes": on each cron fire the scheduler creates a fresh
    // session (inheriting project/model/mode) and kicks it off with `prompt`.
    // FK to projects is ON DELETE RESTRICT — we refuse to delete a project
    // that still has routines hanging off it (same policy as sessions). We
    // deliberately don't link routines to the sessions they spawn: each fire
    // makes an independent session row, and the connection is conveyed in
    // the session's title ("<routine name> · <timestamp>").
    up: `
      CREATE TABLE routines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        prompt TEXT NOT NULL,
        cron_expr TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_routines_status ON routines(status);
      CREATE INDEX idx_routines_project ON routines(project_id);
    `,
  },
  {
    id: 5,
    name: "session_cli_jsonl_seq",
    // Tracks how many lines of the adopted CLI `<uuid>.jsonl` transcript we've
    // already imported into `session_events` for this session. Used by the
    // resync-on-open path (`cli-resync.ts`) to idempotently pick up new CLI
    // turns without re-importing lines we've already mapped. Zero means
    // either (a) never imported, or (b) pre-existing row from before this
    // column existed — in that case the resync path falls back to diffing
    // persisted-event count against JSONL line count.
    up: `
      ALTER TABLE sessions ADD COLUMN cli_jsonl_seq INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 6,
    name: "push_subscriptions",
    // Browser Web Push endpoints registered via the Settings "Enable
    // notifications" flow. Keyed on endpoint URL (UNIQUE) so a re-subscribe
    // from the same device upserts instead of duplicating. No user_id column
    // because claudex is single-user — every subscription is implicitly the
    // owner's. `user_agent` is stamped on create for the device list.
    // `last_used_at` is bumped every time we successfully deliver a push so
    // the UI can show "last notified 2m ago" honestly.
    up: `
      CREATE TABLE push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `,
  },
  {
    id: 7,
    name: "attachments",
    // Files attached to user messages via the composer "Attach" chip.
    // Two-phase lifecycle:
    //   1. Upload: POST /api/sessions/:id/attachments writes the file under
    //      ~/.claudex/uploads/<session-id>/ and inserts a row with
    //      `message_event_seq = NULL` (unlinked).
    //   2. Link: when the user sends the message, SessionManager stamps
    //      each row's `message_event_seq` with the user_message seq it just
    //      appended.
    // Unlinked rows can be deleted by the user (they changed their mind
    // before sending); linked rows refuse DELETE with 404 — once the
    // message is out, the attachment is history.
    up: `
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_event_seq INTEGER,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_attachments_session ON attachments(session_id);
    `,
  },
  {
    id: 8,
    name: "audit_events",
    // Security-relevant audit log. Drives Settings → Security → "Audit log"
    // card and the full-log sheet. We keep it intentionally thin:
    //   - `event` is a short lowercase identifier (see AuditStore.append
    //     caller enum in audit/store.ts — not an enum column so new events
    //     can land without a migration).
    //   - `user_id` is nullable so pre-login events (failed login attempts,
    //     TOTP failures without a valid challenge) can still be recorded.
    //   - `target` / `detail` are free-form short strings — UI composes the
    //     human sentence per event kind, we don't try to pre-render here.
    //   - `ip` / `user_agent` are best-effort and may be NULL when the call
    //     site can't thread a request in (e.g. manager permission decisions).
    //
    // No FK on `user_id` — audit rows must survive user deletion so the log
    // stays intact across credential rotations. The index on `created_at DESC`
    // is what the Security card's "past 30 days" query uses.
    up: `
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        event TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_events(created_at DESC);
      CREATE INDEX idx_audit_event ON audit_events(event);
    `,
  },
  {
    id: 9,
    name: "session_search_fts",
    // Server-side full-text search across session titles and text-bearing
    // message bodies. Uses SQLite FTS5 virtual tables (tokenize=unicode61,
    // which covers CJK and accented scripts adequately for a search-hint use
    // case — we're not building a linguist's tool).
    //
    // Two tables so a title match doesn't drown in message hits (and vice
    // versa): the route returns them in distinct "Sessions" and "Messages"
    // sections. Migration IDs 7 and 8 are reserved for sibling agents
    // landing in parallel; we jump to 9 to avoid conflicts.
    //
    // All lookup keys (session_id, event_seq, kind) are marked UNINDEXED so
    // FTS5 doesn't tokenize nanoid blobs / integers — we only search `body`
    // and `title`. Backfill walks existing rows at migration time so users
    // who upgrade an existing DB get their history indexed without a
    // separate step. Ongoing inserts happen in SessionStore.appendEvent and
    // SessionStore.setTitle/create — FTS5 has no natural upsert, so we do a
    // delete-then-insert pair for title updates.
    up: `
      CREATE VIRTUAL TABLE session_search USING fts5(
        session_id UNINDEXED,
        event_seq UNINDEXED,
        kind UNINDEXED,
        body,
        tokenize = 'unicode61'
      );

      CREATE VIRTUAL TABLE session_title_search USING fts5(
        session_id UNINDEXED,
        title,
        tokenize = 'unicode61'
      );

      -- Backfill titles from existing sessions.
      INSERT INTO session_title_search (session_id, title)
        SELECT id, title FROM sessions;

      -- Backfill text-bearing message bodies from existing events.
      -- We can extract JSON payload.text cheaply via SQLite's json1
      -- extension (bundled with better-sqlite3). Skip NULL/empty extracts.
      INSERT INTO session_search (session_id, event_seq, kind, body)
        SELECT
          session_id,
          seq,
          kind,
          json_extract(payload, '$.text')
        FROM session_events
        WHERE kind IN ('user_message', 'assistant_text', 'assistant_thinking')
          AND json_extract(payload, '$.text') IS NOT NULL
          AND length(json_extract(payload, '$.text')) > 0;
    `,
  },
  {
    id: 10,
    name: "queued_prompts",
    // Batch queue: the user composes several prompts ahead of time and the
    // queue runner dispatches them one at a time, spawning a real session per
    // run. Designed for "go fix these 4 issues while I'm away" — you don't
    // want them racing in parallel claude instances. IDs 7..9 are owned by
    // sibling lanes (attachments / FTS search etc.), hence this one lands on
    // id=10.
    //
    // `seq` is a hand-assigned monotonic integer within the queued set — the
    // runner picks the smallest. Reorder is a pair-swap on `seq`. We keep
    // done/failed/cancelled rows in the table as a simple audit trail: they
    // carry a `session_id` pointer the UI turns into an "Open session" link.
    //
    // `model`/`mode` are nullable — the runner falls back to opus-4-7 +
    // 'default' when the user didn't pin specific values. Matches how the
    // New Session sheet behaves today if fields are left unset.
    up: `
      CREATE TABLE queued_prompts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        title TEXT,
        model TEXT,
        mode TEXT,
        worktree INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        seq INTEGER NOT NULL
      );
      CREATE INDEX idx_queue_status_seq ON queued_prompts(status, seq);
    `,
  },
  {
    id: 11,
    name: "projects_trusted_default_zero",
    // Tighten the project trust gate: new rows going forward must be
    // explicitly confirmed via `POST /api/projects/:id/trust` before a
    // session can spawn against them. The `projects.trusted` column was
    // already DEFAULT 0 at the schema level (see migration 1), but the
    // application-layer INSERT in ProjectStore.create was unconditionally
    // writing `trusted:true` for the HTTP path. That's flipped — `create`
    // now defaults `trusted` to false and the route layer no longer passes
    // `trusted:true`.
    //
    // This migration exists as a marker so the application-layer change is
    // bolted to a bumpable id (siblings already claimed 5..10), and so that
    // pre-existing installations get exactly the behavior the task spec
    // asked for: new rows land untrusted, existing rows stay as-is (the
    // user has already trusted them by creating sessions there — flipping
    // them to 0 would wedge every project until re-confirmed).
    up: `
      -- Schema is already correct; marker-only migration.
      SELECT 1;
    `,
  },
  {
    id: 12,
    name: "recovery_codes",
    // One-time-use 2FA recovery codes. Ten bcrypt-hashed rows per user,
    // regenerated as a set (regenerate deletes the user's old rows before
    // inserting a fresh batch). `used_at` is NULL while the code is live;
    // a successful verify stamps it to the consumption timestamp so the
    // same code can't be replayed. Index is on `(user_id, used_at)` so the
    // hot "list my unused codes" query stays cheap as the table accumulates
    // used rows across regenerations.
    //
    // No FK on user_id — the rest of auth follows the same pattern (audit
    // events also skip the FK) so that rows survive credential rotations
    // that rebuild the users row.
    up: `
      CREATE TABLE recovery_codes (
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_recovery_codes_user ON recovery_codes(user_id, used_at);
    `,
  },
  {
    id: 13,
    name: "link_previews",
    // URL → OpenGraph-ish metadata cache for the chat bubble link-preview
    // cards. Successful fetches are cached for 24h (see fetch.ts); failures
    // are cached for 1h as a negative lookup so a bad URL doesn't hammer
    // upstream on every render. The `status` column carries the HTTP status
    // of the original fetch (or a fake 0 for network errors / aborts); the
    // route layer decides freshness based on (status < 400 ? 24h : 1h).
    //
    // `url` is the PRIMARY KEY — we don't canonicalize beyond "the exact
    // string the caller sent", matching the link-preview UX which only
    // ever feeds URLs lifted verbatim from message text. The index on
    // `fetched_at` is there for future pruning; nothing prunes today.
    up: `
      CREATE TABLE link_previews (
        url TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        image TEXT,
        site_name TEXT,
        fetched_at TEXT NOT NULL,
        status INTEGER NOT NULL
      );
      CREATE INDEX idx_link_previews_fetched ON link_previews(fetched_at);
    `,
  },
  {
    id: 14,
    name: "sessions_forked_from",
    // Track the source session a fork was branched from so the chat header
    // can render a "Forked" badge making the SDK-context-reset honest to
    // the user. Nullable: top-level sessions and CLI-imported sessions
    // have no parent fork. We intentionally do NOT add a FK ON DELETE
    // CASCADE — if the source session gets deleted, the fork should
    // survive (it's a standalone SDK conversation with its own events).
    up: `
      ALTER TABLE sessions ADD COLUMN forked_from_session_id TEXT;
    `,
  },
  {
    id: 15,
    name: "sessions_tags",
    // User-authored tags for filtering sessions from Home. Stored as a JSON
    // string array (TEXT). Kept denormalized rather than a join table — tag
    // lists are tiny (cap 8/session, 24 chars/tag), read on every Home
    // render, and we never query "every session with tag X" across all
    // users (single-user install). SQLite's json1 extension plus JS filter
    // handle every predicate we need without a second table.
    //
    // Validation lives at the HTTP route: `SessionTag` enforces
    // `[a-z0-9-]{1,24}` per tag and `UpdateSessionRequest` caps the array
    // at 8 entries. The column's only defense is NOT NULL DEFAULT '[]' so
    // a row missing the field round-trips as an empty array rather than
    // null.
    up: `
      ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 16,
    name: "sessions_pinned",
    // User-authored pin bit. Pinned rows sort to the top of Home's session
    // list regardless of activity recency. INTEGER + NOT NULL DEFAULT 0 so
    // pre-existing rows round-trip cleanly as unpinned. Flipped via
    // `PATCH /api/sessions/:id` with `{pinned: boolean}`. Not indexed — the
    // list is already tiny (we have an `updated_at DESC` index from migration
    // 1 but the pin-first sort happens in JS after the rowset lands).
    up: `
      ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    id: 17,
    name: "strip_harness_noise_from_user_messages",
    // Backfill for the harness-injection bug: before this migration the CLI
    // JSONL importer treated Claude Code harness pseudo-messages
    // (<task-notification>, <system-reminder>, <command-message>, …) as
    // real user turns, so long imported sessions grew dozens of junk
    // `user_message` rows. The importer has been fixed; this migration
    // rewrites existing rows so already-ingested sessions stop rendering
    // the junk too.
    //
    // Uses the `strip_harness_noise` SQL function registered by `openDb`
    // (wrapping the same JS helper the importer now calls). For each
    // `user_message` row:
    //   - compute cleaned := strip_harness_noise(payload.text)
    //   - if cleaned is empty → delete the row AND the mirrored
    //     session_search row (FTS5 keeps its own copy)
    //   - else if cleaned differs from the original → update payload.text
    //     and the mirrored FTS row body so search snippets stay honest
    //
    // Idempotent: running twice is a no-op because the filter is
    // idempotent and the WHERE-differs guard kicks in on the second pass.
    up: `
      DELETE FROM session_search
       WHERE (session_id, event_seq) IN (
         SELECT session_id, seq FROM session_events
          WHERE kind = 'user_message'
            AND length(strip_harness_noise(
                  coalesce(json_extract(payload, '$.text'), ''))) = 0
       );

      DELETE FROM session_events
       WHERE kind = 'user_message'
         AND length(strip_harness_noise(
               coalesce(json_extract(payload, '$.text'), ''))) = 0;

      UPDATE session_events
         SET payload = json_set(
               payload,
               '$.text',
               strip_harness_noise(json_extract(payload, '$.text'))
             )
       WHERE kind = 'user_message'
         AND json_extract(payload, '$.text') IS NOT NULL
         AND strip_harness_noise(json_extract(payload, '$.text'))
             <> json_extract(payload, '$.text');

      UPDATE session_search
         SET body = strip_harness_noise(body)
       WHERE kind = 'user_message'
         AND body IS NOT NULL
         AND strip_harness_noise(body) <> body;
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

  // Register a SQL wrapper around the CLI harness-noise stripper so migration
  // 17 (and any future backfill work) can run it inline from SQL. Declared
  // `deterministic` so SQLite is free to call it once per distinct input.
  // The SQL null-guard shows up as `null` on the JS side → we return "" and
  // let the migration's `coalesce(...)` handle it.
  db.function(
    "strip_harness_noise",
    { deterministic: true },
    (value: unknown) => {
      if (typeof value !== "string") return "";
      return stripHarnessNoise(value);
    },
  );

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
