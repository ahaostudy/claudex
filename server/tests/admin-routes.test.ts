import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";

// ---------------------------------------------------------------------------
// Admin routes — POST /api/admin/restart.
//
// In test mode (NODE_ENV=test, set by vitest) the handler short-circuits
// after writing an audit row: it returns `{ ok: true, dryRun: true }`
// without spawning a detached worker and without killing the process. So
// we can exercise auth + the audit write here without actually
// restarting vitest's worker.
//
// The real spawn/shutdown path is deliberately NOT unit-tested: it's
// exercised by the operator manually via `node scripts/restart.mjs` or
// by the running server receiving the POST. Mocking the detach primitives
// accurately is harder than just trying it live.
// ---------------------------------------------------------------------------

describe("admin routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("requires auth", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/restart",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns dryRun:true in test mode and records an audit event", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);

    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/admin/restart",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; dryRun?: boolean };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);

    // Audit row should exist. We read it directly from the DB so the test
    // doesn't depend on the audit HTTP surface.
    const row = ctx.dbh.db
      .prepare(
        "SELECT event, user_id FROM audit_events WHERE event = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get("server_restart") as { event: string; user_id: string | null } | undefined;
    expect(row?.event).toBe("server_restart");
    expect(typeof row?.user_id === "string").toBe(true);
  });
});
