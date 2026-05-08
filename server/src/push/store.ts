import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type { PushDevice } from "@claudex/shared";

// -----------------------------------------------------------------------------
// PushSubscriptionStore
//
// CRUD around `push_subscriptions`. Kept deliberately narrow: upsert by
// endpoint (so re-subscribing from the same browser doesn't grow the table),
// list-all for the Settings device list, delete by id for per-device revoke,
// delete-all for the "disable notifications" button, and `touchLastUsed` for
// the delivery side to bump the recency timestamp.
// -----------------------------------------------------------------------------

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface DbRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

function toRow(r: DbRow): PushSubscriptionRow {
  return {
    id: r.id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export interface PushSubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export class PushSubscriptionStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new subscription or refresh an existing one keyed on endpoint.
   * Returns the row in either case so callers always get a usable id.
   *
   * The "refresh" case also rotates `p256dh` / `auth` / `user_agent` and
   * nudges `last_used_at` forward — mirroring what a browser does when it
   * rotates keys (iOS Safari renews them occasionally).
   */
  upsert(input: PushSubscribeInput): PushSubscriptionRow {
    const existing = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
      .get(input.endpoint) as DbRow | undefined;

    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE push_subscriptions
           SET p256dh = ?, auth = ?, user_agent = ?, last_used_at = ?
           WHERE id = ?`,
        )
        .run(
          input.p256dh,
          input.auth,
          input.userAgent ?? existing.user_agent,
          now,
          existing.id,
        );
      return toRow({
        ...existing,
        p256dh: input.p256dh,
        auth: input.auth,
        user_agent: input.userAgent ?? existing.user_agent,
        last_used_at: now,
      });
    }

    const id = nanoid(12);
    this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.userAgent ?? null,
        now,
      );

    return {
      id,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastUsedAt: null,
    };
  }

  list(): PushSubscriptionRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM push_subscriptions ORDER BY created_at DESC",
      )
      .all() as DbRow[];
    return rows.map(toRow);
  }

  /** Subset shape for `GET /api/push/state.devices`. Drops keys so we don't
   * ship secrets to the UI. */
  listDevices(): PushDevice[] {
    return this.list().map((r) => ({
      id: r.id,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  }

  findById(id: string): PushSubscriptionRow | null {
    const row = this.db
      .prepare("SELECT * FROM push_subscriptions WHERE id = ?")
      .get(id) as DbRow | undefined;
    return row ? toRow(row) : null;
  }

  deleteById(id: string): boolean {
    const info = this.db
      .prepare("DELETE FROM push_subscriptions WHERE id = ?")
      .run(id);
    return info.changes > 0;
  }

  /**
   * Delete by endpoint URL. Used by the push-delivery path to prune
   * subscriptions that come back 404 / 410 Gone from the push service.
   */
  deleteByEndpoint(endpoint: string): boolean {
    const info = this.db
      .prepare("DELETE FROM push_subscriptions WHERE endpoint = ?")
      .run(endpoint);
    return info.changes > 0;
  }

  deleteAll(): number {
    const info = this.db.prepare("DELETE FROM push_subscriptions").run();
    return info.changes;
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM push_subscriptions")
      .get() as { n: number };
    return row.n;
  }

  touchLastUsed(id: string): void {
    this.db
      .prepare("UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}
