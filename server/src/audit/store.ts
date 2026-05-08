import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

// -----------------------------------------------------------------------------
// AuditStore
//
// Thin wrapper around the `audit_events` table. Write path is deliberately
// fire-and-forget: every call site in routes + SessionManager wraps append in
// a try/catch so a disk-full / constraint error never surfaces as a failed
// login or a stuck permission prompt. Read path is used only by the Security
// tab and is capped (200) well under anything a single-user SQLite cares
// about.
// -----------------------------------------------------------------------------

export interface AuditRow {
  id: string;
  userId: string | null;
  event: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface DbRow {
  id: string;
  user_id: string | null;
  event: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

function toRow(r: DbRow): AuditRow {
  return {
    id: r.id,
    userId: r.user_id,
    event: r.event,
    target: r.target,
    detail: r.detail,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at,
  };
}

export interface AuditAppendInput {
  userId?: string | null;
  event: string;
  target?: string | null;
  detail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditListOpts {
  limit?: number;
  since?: string;
  events?: string[];
}

// Keep free-form strings from ballooning the table. 140 mirrors the
// AuditEvent.detail constraint on the wire and is plenty for a human sentence.
const DETAIL_MAX = 140;
const UA_MAX = 200;
const TARGET_MAX = 200;

function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length === 0) return null;
  return one.length <= max ? one : one.slice(0, max);
}

/**
 * Narrow logger contract — matches pino + FastifyBaseLogger. Only `warn`
 * is used; everything else the AuditStore does is silent by design so a
 * chatty audit path doesn't drown out real logs.
 */
type WarnLogger = { warn: (obj: unknown, msg?: string) => void } | undefined;

export class AuditStore {
  constructor(
    private readonly db: Database.Database,
    private readonly logger?: WarnLogger,
  ) {}

  /**
   * Insert one audit row. Swallows every error — callers never need to
   * handle a failure here because a failed audit write must not block the
   * action it describes.
   */
  append(input: AuditAppendInput): void {
    try {
      const row = {
        id: nanoid(16),
        user_id: input.userId ?? null,
        event: input.event,
        target: clip(input.target, TARGET_MAX),
        detail: clip(input.detail, DETAIL_MAX),
        ip: clip(input.ip, 64),
        user_agent: clip(input.userAgent, UA_MAX),
        created_at: new Date().toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO audit_events
             (id, user_id, event, target, detail, ip, user_agent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.user_id,
          row.event,
          row.target,
          row.detail,
          row.ip,
          row.user_agent,
          row.created_at,
        );
    } catch (err) {
      this.logger?.warn?.({ err, event: input.event }, "audit append failed");
    }
  }

  /**
   * Most-recent-first list. Caller is responsible for any per-event pretty
   * rendering — we just return rows.
   */
  list(opts: AuditListOpts = {}): AuditRow[] {
    // Cap at 200 — the UI shows 6 inline and up to 200 in the full-log sheet.
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.since) {
      clauses.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.events && opts.events.length > 0) {
      const placeholders = opts.events.map(() => "?").join(",");
      clauses.push(`event IN (${placeholders})`);
      params.push(...opts.events);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM audit_events
         ${where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as DbRow[];
    return rows.map(toRow);
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM audit_events")
      .get() as { c: number };
    return row.c;
  }

  /**
   * Count events since the given ISO timestamp. Used by the Security card's
   * "N events · past 30 days" header so the UI doesn't have to post-filter
   * a list query it already paginated.
   */
  countSince(since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM audit_events WHERE created_at >= ?")
      .get(since) as { c: number };
    return row.c;
  }
}
