import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { AuditStore } from "../src/audit/store.js";
import { bootstrapAuthedApp } from "./helpers.js";

// -----------------------------------------------------------------------------
// Audit-route tests
//
// We lean on bootstrapAuthedApp (which wires AuditStore via buildApp) so the
// store is the same instance the routes see. Direct `audit.append` calls stand
// in for wiring that lives in auth/session/push routes — those paths are
// covered by their own suites, here we just verify the GET route returns what
// was appended.
// -----------------------------------------------------------------------------

describe("audit routes", () => {
  let env: Awaited<ReturnType<typeof bootstrapAuthedApp>>;
  let audit: AuditStore;

  beforeEach(async () => {
    env = await bootstrapAuthedApp();
    // bootstrapAuthedApp performs a real login which writes an audit row
    // before every `it` block. Start from a clean slate so row counts match
    // what each test explicitly appended.
    env.dbh.db.prepare("DELETE FROM audit_events").run();
    // Same db handle buildApp used — the store is stateless other than the
    // db pointer, so a fresh instance here writes to the same table.
    audit = new AuditStore(env.dbh.db);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("rejects GET without auth cookie", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/audit" });
    expect(res.statusCode).toBe(401);
  });

  it("returns appended rows newest-first", async () => {
    audit.append({ event: "login_failed", detail: "a", ip: "1.1.1.1" });
    audit.append({ event: "login", detail: "b" });
    audit.append({ event: "logout", detail: "c" });

    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCount).toBe(3);
    expect(body.events).toHaveLength(3);
    // Newest-first — last appended (`logout`) comes first.
    expect(body.events.map((e: { event: string }) => e.event)).toEqual([
      "logout",
      "login",
      "login_failed",
    ]);
    // The login_failed row preserved its ip.
    const failed = body.events.find(
      (e: { event: string }) => e.event === "login_failed",
    );
    expect(failed.ip).toBe("1.1.1.1");
    expect(failed.user).toBeNull();
  });

  it("filters by the events query parameter", async () => {
    audit.append({ event: "login", detail: "a" });
    audit.append({ event: "logout", detail: "b" });
    audit.append({ event: "password_changed", detail: "c" });

    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit?events=login,password_changed",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.events.map((e: { event: string }) => e.event).sort();
    expect(names).toEqual(["login", "password_changed"]);
    // totalCount respects the filter — the Security card's header renders
    // "N events · past 30 days" for whatever filter the UI currently
    // applies, so totalCount is the match count for that filter (2 here),
    // not the table-wide row count (3).
    expect(body.totalCount).toBe(2);
  });

  it("countFiltered on a bulk-seeded table returns the filtered total, not the table size", async () => {
    // Seed 10 A events + 5 B events; ?events=A should return 10 rows inline
    // (all fit under the 200 cap) and totalCount=10 (NOT 15).
    for (let i = 0; i < 10; i += 1) {
      audit.append({ event: "login", detail: `a-${i}` });
    }
    for (let i = 0; i < 5; i += 1) {
      audit.append({ event: "logout", detail: `b-${i}` });
    }
    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit?events=login",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(10);
    expect(body.totalCount).toBe(10);
  });

  it("caps limit at 200 even when a bigger value is requested", async () => {
    // Seed 205 rows — tight loop, SQLite handles this in <100ms.
    for (let i = 0; i < 205; i += 1) {
      audit.append({ event: "login", detail: `burst-${i}` });
    }
    const res = await env.app.inject({
      method: "GET",
      url: "/api/audit?limit=500",
      headers: { cookie: env.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(200);
    expect(body.totalCount).toBe(205);
  });

  it("records a password_changed row after a real change-password call", async () => {
    // Drive the actual route rather than calling .append directly — we want
    // to confirm the wire-in in auth/routes.ts fires. bootstrapAuthedApp
    // left the user with password "hunter22-please-work".
    const res = await env.app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: env.cookie },
      payload: {
        currentPassword: "hunter22-please-work",
        newPassword: "brand-new-pass-9",
      },
    });
    expect(res.statusCode).toBe(200);

    const list = await env.app.inject({
      method: "GET",
      url: "/api/audit?events=password_changed",
      headers: { cookie: env.cookie },
    });
    const body = list.json();
    expect(body.events.length).toBeGreaterThanOrEqual(1);
    const row = body.events[0];
    expect(row.event).toBe("password_changed");
    // userId was threaded in by the route — the user object is resolved via
    // UserStore.findById so this hits the lookup path too.
    expect(row.user).not.toBeNull();
    expect(row.user.username).toBe("hao");
  });
});
