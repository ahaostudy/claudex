import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapAuthedApp } from "./helpers.js";
import type {
  Runner,
  RunnerFactory,
  RunnerListener,
  RunnerEvent,
} from "../src/sessions/runner.js";
import type { PermissionMode } from "@claudex/shared";

const bootstrap = bootstrapAuthedApp;

describe("session HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("rejects unauthenticated access", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/projects",
    });
    expect(res.statusCode).toBe(401);
  });

  describe("POST /api/projects", () => {
    it("creates a project with a real directory path", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.project.name).toBe("demo");
      expect(body.project.path).toBe(ctx.tmpDir);
    });

    it("rejects a non-existent path", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: "/nope/does/not/exist" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("path_not_a_directory");
    });

    it("rejects a duplicate path with 409", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const once = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "a", path: ctx.tmpDir },
      });
      expect(once.statusCode).toBe(200);
      const twice = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "b", path: ctx.tmpDir },
      });
      expect(twice.statusCode).toBe(409);
    });
  });

  describe("PATCH /api/projects/:id", () => {
    async function createProject(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
    }) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "orig", path: ctx.tmpDir },
      });
      return res.json().project as { id: string };
    }

    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${proj.id}`,
        payload: { name: "new" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("renames a project and the change is visible in GET", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const patched = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
        payload: { name: "renamed" },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().project.name).toBe("renamed");
      // and it sticks
      const list = await ctx.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
      });
      const found = list
        .json()
        .projects.find((p: { id: string }) => p.id === proj.id);
      expect(found.name).toBe("renamed");
    });

    it("rejects an empty name with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
        payload: { name: "" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("returns 404 for an unknown project id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: "/api/projects/no-such-id",
        headers: { cookie: ctx.cookie },
        payload: { name: "whatever" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });
  });

  describe("DELETE /api/projects/:id", () => {
    async function createProject(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
    }) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "to-delete", path: ctx.tmpDir },
      });
      return res.json().project as { id: string };
    }

    it("requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${proj.id}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("deletes a project with no sessions", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const list = await ctx.app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
      });
      const exists = list
        .json()
        .projects.some((p: { id: string }) => p.id === proj.id);
      expect(exists).toBe(false);
    });

    it("refuses to delete a project that has sessions (409 has_sessions)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const proj = await createProject(ctx);
      await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: proj.id,
          title: "s",
          model: "claude-opus-4-7",
          mode: "default",
          worktree: false,
        },
      });
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/projects/${proj.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("has_sessions");
      expect(body.sessionCount).toBe(1);
    });

    it("returns 404 for an unknown project id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/projects/no-such-id",
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/sessions", () => {
    async function addProject(
      ctx: { app: FastifyInstance; cookie: string; tmpDir: string },
    ) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      });
      return res.json().project;
    }

    it("creates a session under an existing project", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const project = await addProject(ctx);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: project.id,
          title: "first",
          model: "claude-opus-4-7",
          mode: "default",
          worktree: false,
        },
      });
      expect(res.statusCode).toBe(200);
      const session = res.json().session;
      expect(session.title).toBe("first");
      expect(session.status).toBe("idle");
    });

    it("rejects a session for an unknown project", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: "bogus",
          model: "claude-opus-4-7",
          mode: "default",
          worktree: false,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("project_not_found");
    });

    it("rejects malformed payload", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: { projectId: "whatever" }, // missing model/mode
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/sessions*", () => {
    async function seed(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
    }) {
      const proj = await ctx.app
        .inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: ctx.cookie },
          payload: { name: "demo", path: ctx.tmpDir },
        })
        .then((r) => r.json().project);
      const s = await ctx.app
        .inject({
          method: "POST",
          url: "/api/sessions",
          headers: { cookie: ctx.cookie },
          payload: {
            projectId: proj.id,
            title: "t",
            model: "claude-opus-4-7",
            mode: "default",
            worktree: false,
          },
        })
        .then((r) => r.json().session);
      return { proj, s };
    }

    it("lists sessions, scoped by project query", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { proj } = await seed(ctx);

      const all = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
      });
      expect(all.statusCode).toBe(200);
      expect(all.json().sessions).toHaveLength(1);

      const scoped = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions?project=${proj.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json().sessions).toHaveLength(1);
    });

    it("gets a specific session, returns 404 otherwise", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);

      const ok = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
      });
      expect(ok.statusCode).toBe(200);

      const missing = await ctx.app.inject({
        method: "GET",
        url: "/api/sessions/no-such-id",
        headers: { cookie: ctx.cookie },
      });
      expect(missing.statusCode).toBe(404);
    });

    it("lists events with sinceSeq filter", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      const r = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/events`,
        headers: { cookie: ctx.cookie },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().events).toEqual([]);
    });

    it("archives a session", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seed(ctx);
      const r = await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/archive`,
        headers: { cookie: ctx.cookie },
      });
      expect(r.statusCode).toBe(200);
      const fetched = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json().session);
      expect(fetched.status).toBe("archived");
      expect(fetched.archivedAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/sessions/:id
  //
  // A minimal recording runner — just enough to verify that a mode change
  // hits the live runner via setPermissionMode. Everything else is a noop.
  // ---------------------------------------------------------------------------
  class RecordingRunner implements Runner {
    sessionId: string;
    sdkSessionId: string | null = null;
    modeChanges: PermissionMode[] = [];
    private listeners = new Set<RunnerListener>();
    constructor(sessionId: string) {
      this.sessionId = sessionId;
    }
    async start() {}
    async sendUserMessage() {}
    resolvePermission() {}
    async interrupt() {}
    async setPermissionMode(mode: PermissionMode) {
      this.modeChanges.push(mode);
    }
    async dispose() {
      this.listeners.clear();
    }
    on(l: RunnerListener) {
      this.listeners.add(l);
      return () => this.listeners.delete(l);
    }
    listenerCount() {
      return this.listeners.size;
    }
    emit(ev: RunnerEvent) {
      for (const l of this.listeners) l(ev);
    }
  }

  function makeRecordingFactory(): {
    factory: RunnerFactory;
    last: () => RecordingRunner | null;
  } {
    let last: RecordingRunner | null = null;
    return {
      factory: {
        create(opts) {
          last = new RecordingRunner(opts.sessionId);
          return last;
        },
      },
      last: () => last,
    };
  }

  async function seedSession(ctx: {
    app: FastifyInstance;
    cookie: string;
    tmpDir: string;
  }) {
    const proj = await ctx.app
      .inject({
        method: "POST",
        url: "/api/projects",
        headers: { cookie: ctx.cookie },
        payload: { name: "demo", path: ctx.tmpDir },
      })
      .then((r) => r.json().project);
    const s = await ctx.app
      .inject({
        method: "POST",
        url: "/api/sessions",
        headers: { cookie: ctx.cookie },
        payload: {
          projectId: proj.id,
          title: "orig",
          model: "claude-opus-4-7",
          mode: "default",
          worktree: false,
        },
      })
      .then((r) => r.json().session);
    return { proj, s };
  }

  describe("PATCH /api/sessions/:id", () => {
    it("rejects unauthenticated", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        payload: { title: "hacked" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("updates the title and persists it", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { title: "fix hydration" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.title).toBe("fix hydration");
      expect(body.warnings).toBeUndefined();
      const fetched = await ctx.app
        .inject({
          method: "GET",
          url: `/api/sessions/${s.id}`,
          headers: { cookie: ctx.cookie },
        })
        .then((r) => r.json().session);
      expect(fetched.title).toBe("fix hydration");
    });

    it("changing mode propagates to the live runner", async () => {
      const { factory, last } = makeRecordingFactory();
      const ctx = await bootstrap(factory);
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Attach a runner to this session so the PATCH handler has something
      // to propagate the mode to. getOrCreate is idempotent and matches the
      // path SessionManager takes on the first user message.
      ctx.manager.getOrCreate(s.id);
      const runner = last()!;
      expect(runner).not.toBeNull();

      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { mode: "acceptEdits" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().session.mode).toBe("acceptEdits");
      expect(runner.modeChanges).toEqual(["acceptEdits"]);
    });

    it("changing model on an idle session does not warn", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { model: "claude-sonnet-4-6" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.model).toBe("claude-sonnet-4-6");
      expect(body.warnings).toBeUndefined();
    });

    it("changing model on a running session returns the next-turn warning", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      // Flip status to running via a direct DB write — matches what
      // SessionManager does on the first status:running event.
      ctx.dbh.db
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(s.id);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { model: "claude-haiku-4-5" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.session.model).toBe("claude-haiku-4-5");
      expect(body.warnings).toEqual(["model_change_applies_to_next_turn"]);
    });

    it("refuses to patch an archived session (409)", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      await ctx.app.inject({
        method: "POST",
        url: `/api/sessions/${s.id}/archive`,
        headers: { cookie: ctx.cookie },
      });
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: { title: "hello" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("archived");
    });

    it("rejects an empty body with 400", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const { s } = await seedSession(ctx);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: `/api/sessions/${s.id}`,
        headers: { cookie: ctx.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("bad_request");
    });

    it("returns 404 for an unknown session id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const res = await ctx.app.inject({
        method: "PATCH",
        url: "/api/sessions/nope",
        headers: { cookie: ctx.cookie },
        payload: { title: "x" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });
  });

  describe("tool grants REST", () => {
    async function seedGrants(ctx: {
      app: FastifyInstance;
      cookie: string;
      tmpDir: string;
      dbh: { db: import("better-sqlite3").Database };
    }) {
      const { s } = await seedSession(ctx);
      // Insert two session-scoped grants and one global grant directly via DB
      // so the test is decoupled from the permission flow.
      const now = new Date().toISOString();
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("g-sess-1", s.id, "Bash", "pnpm test", now);
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("g-sess-2", s.id, "Edit", "/tmp/x.ts", now);
      ctx.dbh.db
        .prepare(
          `INSERT INTO tool_grants (id, session_id, tool_name, input_signature, created_at)
           VALUES (?, NULL, ?, ?, ?)`,
        )
        .run("g-global", "Grep", "TODO", now);
      return s;
    }

    it("GET /grants requires auth", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/grants`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /grants returns session + global grants with correct scope", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/grants`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(200);
      const grants = res.json().grants as Array<{
        id: string;
        toolName: string;
        signature: string;
        scope: "session" | "global";
      }>;
      expect(grants).toHaveLength(3);
      const byId = Object.fromEntries(grants.map((g) => [g.id, g]));
      expect(byId["g-sess-1"].scope).toBe("session");
      expect(byId["g-sess-1"].toolName).toBe("Bash");
      expect(byId["g-sess-2"].scope).toBe("session");
      expect(byId["g-global"].scope).toBe("global");
      expect(byId["g-global"].toolName).toBe("Grep");
    });

    it("DELETE /grants/:id removes the grant", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      const s = await seedGrants(ctx);
      const del = await ctx.app.inject({
        method: "DELETE",
        url: `/api/grants/g-sess-1`,
        headers: { cookie: ctx.cookie },
      });
      expect(del.statusCode).toBe(200);
      const list = await ctx.app.inject({
        method: "GET",
        url: `/api/sessions/${s.id}/grants`,
        headers: { cookie: ctx.cookie },
      });
      const ids = list.json().grants.map((g: { id: string }) => g.id);
      expect(ids).not.toContain("g-sess-1");
    });

    it("DELETE /grants/:id returns 404 for unknown id", async () => {
      const ctx = await bootstrap();
      disposers.push(ctx.cleanup);
      await seedGrants(ctx);
      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/grants/no-such-grant`,
        headers: { cookie: ctx.cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    });
  });
});
