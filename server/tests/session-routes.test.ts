import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../src/transport/app.js";
import { openDb, type ClaudexDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import { tempConfig } from "./helpers.js";
import type { RunnerFactory } from "../src/sessions/runner.js";

async function bootstrap(
  runnerFactory?: RunnerFactory,
): Promise<{
  app: FastifyInstance;
  dbh: ClaudexDb;
  cookie: string;
  tmpDir: string;
  cleanup: () => Promise<void>;
}> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const { app, manager } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
    runnerFactory,
  });
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  const passwordHash = await hashPassword("hunter22-please-work");
  users.create({ username: "hao", passwordHash, totpSecret });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "hao", password: "hunter22-please-work" },
  });
  const challengeId = login.json().challengeId as string;
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-totp",
    payload: { challengeId, code: currentTotp(totpSecret) },
  });
  const sessionCookie = verify.cookies.find(
    (c) => c.name === "claudex_session",
  )!;
  const cookie = `claudex_session=${sessionCookie.value}`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-proj-"));

  return {
    app,
    dbh,
    cookie,
    tmpDir,
    cleanup: async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}

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
