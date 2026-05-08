import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { AuditEvent } from "@claudex/shared";
import { UserStore } from "../auth/index.js";
import { AuditStore } from "./store.js";

// -----------------------------------------------------------------------------
// Audit routes
//
//   GET /api/audit?limit=50&since=<iso>&events=login,password_changed
//
// Login-gated. Surfaces an audit snapshot for the Settings → Security tab. The
// UI composes the human-readable sentence per row from `event` + `target` +
// `detail` + `userAgent` — this route just returns the raw rows plus a total
// count so the card can show "N events · past 30 days" honestly.
// -----------------------------------------------------------------------------

export interface AuditRoutesDeps {
  db: Database.Database;
  audit: AuditStore;
}

function parseEventsParam(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export async function registerAuditRoutes(
  app: FastifyInstance,
  deps: AuditRoutesDeps,
): Promise<void> {
  const users = new UserStore(deps.db);

  app.get(
    "/api/audit",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as {
        limit?: string;
        since?: string;
        events?: string;
      };
      const rawLimit = q?.limit ? Number(q.limit) : undefined;
      const limit =
        rawLimit !== undefined && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(rawLimit, 200))
          : 50;
      const events = parseEventsParam(q?.events);
      const since = q?.since;
      const rows = deps.audit.list({ limit, since, events });

      // Resolve userIds lazily — most events will share a handful of ids in
      // a single-user deployment, but we still memoize to avoid N lookups for
      // N rows.
      const userCache = new Map<string, { id: string; username: string } | null>();
      const lookup = (id: string | null) => {
        if (!id) return null;
        if (userCache.has(id)) return userCache.get(id) ?? null;
        const row = users.findById(id);
        const out = row ? { id: row.id, username: row.username } : null;
        userCache.set(id, out);
        return out;
      };

      const out: AuditEvent[] = rows.map((r) => ({
        id: r.id,
        event: r.event,
        target: r.target,
        detail: r.detail,
        ip: r.ip,
        userAgent: r.userAgent,
        createdAt: r.createdAt,
        user: lookup(r.userId),
      }));
      // totalCount must respect the filter so the Security card's
      // "N events · past 30 days" (or equivalent filtered header) is
      // honest. `list` caps at 200 but totalCount is the unpaginated
      // match count for the same WHERE.
      return {
        events: out,
        totalCount: deps.audit.countFiltered({ since, events }),
      };
    },
  );
}
