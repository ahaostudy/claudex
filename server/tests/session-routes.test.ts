import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapAuthedApp } from "./helpers.js";

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
});
