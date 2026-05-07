import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { tempConfig } from "./helpers.js";

describe("db migrations", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("runs migrations and creates every expected table", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r: any) => r.name);

    for (const expected of [
      "_migrations",
      "pending_approvals",
      "projects",
      "session_events",
      "sessions",
      "tool_grants",
      "users",
    ]) {
      expect(tables).toContain(expected);
    }

    // Foreign keys must be on (otherwise ON DELETE CASCADE breaks later tests).
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
  });

  it("is idempotent — re-opening does not reapply migrations", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);

    const first = openDb(config, log);
    first.close();

    const second = openDb(config, log);
    cleanups.push(second.close);

    const rows = second.db.prepare("SELECT * FROM _migrations").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("init");
  });

  it("cascades session_events on session delete", () => {
    const { config, log, cleanup } = tempConfig();
    cleanups.push(cleanup);
    const { db, close } = openDb(config, log);
    cleanups.push(close);

    db.prepare(
      `INSERT INTO projects (id, name, path, trusted, created_at)
       VALUES ('p1', 'demo', '/tmp/demo', 1, '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, model, mode, created_at, updated_at)
       VALUES ('s1', 'Demo', 'p1', 'idle', 'claude-opus-4-7', 'default', '2026-05-08T00:00:00Z', '2026-05-08T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
       VALUES ('e1', 's1', 'user_message', 0, '2026-05-08T00:00:00Z', '{}')`,
    ).run();

    db.prepare("DELETE FROM sessions WHERE id='s1'").run();
    const remaining = db.prepare("SELECT COUNT(*) as c FROM session_events").get() as { c: number };
    expect(remaining.c).toBe(0);
  });
});
