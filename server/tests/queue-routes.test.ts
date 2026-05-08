import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootstrapAuthedApp, tempConfig } from "./helpers.js";
import type {
  Runner,
  RunnerFactory,
  RunnerListener,
  RunnerInitOptions,
} from "../src/sessions/runner.js";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import { QueueStore } from "../src/queue/store.js";
import { QueueRunner } from "../src/queue/runner.js";

// Minimal recording runner shared with routines tests — stubs out the Agent
// SDK so tests never spawn a real `claude` subprocess.
class RecordingRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  sent: string[] = [];
  disposed = false;
  private listeners = new Set<RunnerListener>();

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
  }

  async start() {}
  async sendUserMessage(c: string) {
    this.sent.push(c);
  }
  resolvePermission() {}
  async interrupt() {}
  async setPermissionMode() {}
  async dispose() {
    this.disposed = true;
  }
  on(l: RunnerListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  listenerCount() {
    return this.listeners.size;
  }
}

function recordingFactory(): {
  factory: RunnerFactory;
  runners: RecordingRunner[];
} {
  const runners: RecordingRunner[] = [];
  return {
    factory: {
      create(opts) {
        const r = new RecordingRunner(opts);
        runners.push(r);
        return r;
      },
    },
    runners,
  };
}

// ---- HTTP routes -----------------------------------------------------------

describe("queue HTTP routes", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  async function seedProject(ctx: {
    app: FastifyInstance;
    cookie: string;
    tmpDir: string;
  }) {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: ctx.cookie },
      payload: { name: "spindle", path: ctx.tmpDir },
    });
    return res.json().project.id as string;
  }

  async function bootstrap() {
    const { factory, runners } = recordingFactory();
    const ctx = await bootstrapAuthedApp(factory);
    return { ...ctx, runners };
  }

  it("requires auth on every route", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);

    const endpoints: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string }> = [
      { method: "GET", url: "/api/queue" },
      { method: "POST", url: "/api/queue" },
      { method: "PATCH", url: "/api/queue/anything" },
      { method: "DELETE", url: "/api/queue/anything" },
      { method: "POST", url: "/api/queue/anything/up" },
      { method: "POST", url: "/api/queue/anything/down" },
    ];
    for (const ep of endpoints) {
      const res = await ctx.app.inject({ method: ep.method, url: ep.url });
      expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(401);
    }
  });

  it("POST creates a row with seq = max+1 above existing rows", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);

    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId, prompt: "first" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().queued.seq).toBe(1);

    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId, prompt: "second", title: "Second" },
    });
    expect(second.json().queued.seq).toBe(2);

    const third = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId, prompt: "third" },
    });
    expect(third.json().queued.seq).toBe(3);

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
    });
    expect(listed.json().queue.map((r: any) => r.seq)).toEqual([1, 2, 3]);
  });

  it("rejects unknown project with 400 project_not_found", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId: "does-not-exist", prompt: "p" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("project_not_found");
  });

  it("PATCH only works on queued rows; 409 on running", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId, prompt: "a" },
    });
    const id = created.json().queued.id as string;

    const patched = await ctx.app.inject({
      method: "PATCH",
      url: `/api/queue/${id}`,
      headers: { cookie: ctx.cookie },
      payload: { prompt: "b", title: "B", worktree: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().queued.prompt).toBe("b");
    expect(patched.json().queued.title).toBe("B");
    expect(patched.json().queued.worktree).toBe(true);

    // Flip the row to running out-of-band so we can verify the 409.
    const store = new QueueStore(ctx.dbh.db);
    store.setStatus(id, "running", {
      sessionId: "fake",
      startedAt: new Date().toISOString(),
    });

    const locked = await ctx.app.inject({
      method: "PATCH",
      url: `/api/queue/${id}`,
      headers: { cookie: ctx.cookie },
      payload: { prompt: "c" },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe("not_editable");
  });

  it("DELETE cancels a queued row", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);

    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId, prompt: "a" },
    });
    const id = created.json().queued.id as string;

    const cancelled = await ctx.app.inject({
      method: "DELETE",
      url: `/api/queue/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(cancelled.statusCode).toBe(200);

    const listed = await ctx.app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
    });
    const row = listed.json().queue.find((r: any) => r.id === id);
    expect(row.status).toBe("cancelled");
    expect(row.finishedAt).toBeTruthy();
  });

  it("DELETE on done rows returns 409 not_cancellable", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
      payload: { projectId, prompt: "a" },
    });
    const id = created.json().queued.id as string;

    const store = new QueueStore(ctx.dbh.db);
    store.setStatus(id, "done", {
      finishedAt: new Date().toISOString(),
    });

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/api/queue/${id}`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_cancellable");
  });

  it("reorder up/down swaps seq with the adjacent queued neighbour", async () => {
    const ctx = await bootstrap();
    disposers.push(ctx.cleanup);
    const projectId = await seedProject(ctx);

    const mk = async (prompt: string) =>
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/queue",
          headers: { cookie: ctx.cookie },
          payload: { projectId, prompt },
        })
      ).json().queued.id as string;
    const a = await mk("a");
    const b = await mk("b");
    const c = await mk("c");

    // a=1, b=2, c=3. Move b up → a=2, b=1, c=3.
    let res = await ctx.app.inject({
      method: "POST",
      url: `/api/queue/${b}/up`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toBe(true);

    let listed = await ctx.app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
    });
    const byId = new Map(
      listed.json().queue.map((r: any) => [r.id, r.seq as number]),
    );
    expect(byId.get(a)).toBe(2);
    expect(byId.get(b)).toBe(1);
    expect(byId.get(c)).toBe(3);

    // Move b down twice: first swap with a (now seq=2) → back to original,
    // then swap with c.
    res = await ctx.app.inject({
      method: "POST",
      url: `/api/queue/${b}/down`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.json().moved).toBe(true);
    res = await ctx.app.inject({
      method: "POST",
      url: `/api/queue/${b}/down`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.json().moved).toBe(true);

    listed = await ctx.app.inject({
      method: "GET",
      url: "/api/queue",
      headers: { cookie: ctx.cookie },
    });
    const byIdAfter = new Map(
      listed.json().queue.map((r: any) => [r.id, r.seq as number]),
    );
    expect(byIdAfter.get(b)).toBe(3);

    // Reorder on a non-queued row → 409.
    const store = new QueueStore(ctx.dbh.db);
    store.setStatus(a, "done", {
      finishedAt: new Date().toISOString(),
    });
    const conflict = await ctx.app.inject({
      method: "POST",
      url: `/api/queue/${a}/up`,
      headers: { cookie: ctx.cookie },
    });
    expect(conflict.statusCode).toBe(409);
  });
});

// ---- Runner ----------------------------------------------------------------

describe("QueueRunner", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const { config, log, cleanup } = tempConfig();
    const { db, close } = openDb(config, log);
    const projects = new ProjectStore(db);
    const sessions = new SessionStore(db);
    const grants = new ToolGrantStore(db);
    const queue = new QueueStore(db);

    const project = projects.create({
      name: "p",
      path: "/tmp/does-not-need-to-exist",
      trusted: true,
    });

    const runners: RecordingRunner[] = [];
    const factory: RunnerFactory = {
      create(opts) {
        const r = new RecordingRunner(opts);
        runners.push(r);
        return r;
      },
    };
    const manager = new SessionManager({
      sessions,
      projects,
      grants,
      runnerFactory: factory,
      broadcast: () => {},
    });

    const runner = new QueueRunner({
      queue,
      sessions,
      projects,
      manager,
    });

    cleanups.push(() => {
      runner.dispose();
      close();
      cleanup();
    });

    return { db, projects, sessions, queue, manager, runner, project, runners };
  }

  it("picks the lowest-seq queued row on first tick", async () => {
    const s = setup();
    const a = s.queue.create({ projectId: s.project.id, prompt: "a" });
    const b = s.queue.create({ projectId: s.project.id, prompt: "b" });
    const c = s.queue.create({ projectId: s.project.id, prompt: "c" });

    expect(a.seq).toBeLessThan(b.seq);
    expect(b.seq).toBeLessThan(c.seq);

    await s.runner.tick();
    // Let the fire-and-forget sendUserMessage microtask settle.
    await new Promise((r) => setImmediate(r));

    const aNow = s.queue.findById(a.id)!;
    expect(aNow.status).toBe("running");
    expect(aNow.sessionId).toBeTruthy();
    expect(s.sessions.findById(aNow.sessionId!)).not.toBeNull();
    // The later rows remain queued — one at a time.
    expect(s.queue.findById(b.id)!.status).toBe("queued");
    expect(s.queue.findById(c.id)!.status).toBe("queued");

    // The RecordingRunner should have received the prompt on the new session.
    const sent = s.runners.flatMap((r) => r.sent);
    expect(sent).toContain("a");
  });

  it("does not dispatch a second row while the first is still running", async () => {
    const s = setup();
    s.queue.create({ projectId: s.project.id, prompt: "first" });
    s.queue.create({ projectId: s.project.id, prompt: "second" });

    await s.runner.tick();
    await new Promise((r) => setImmediate(r));
    const countAfterFirst = s.sessions.list().length;
    expect(countAfterFirst).toBe(1);

    // Second tick — the first row is still `running` (RecordingRunner never
    // drives the session toward idle on its own), so nothing new should fire.
    await s.runner.tick();
    await new Promise((r) => setImmediate(r));
    expect(s.sessions.list().length).toBe(countAfterFirst);
  });

  it("marks a row done when its session transitions to idle", async () => {
    const s = setup();
    const row = s.queue.create({ projectId: s.project.id, prompt: "x" });

    await s.runner.tick();
    await new Promise((r) => setImmediate(r));
    const running = s.queue.findById(row.id)!;
    expect(running.status).toBe("running");
    expect(running.sessionId).toBeTruthy();

    // Simulate the session settling to idle (as SessionManager does on
    // turn_end).
    s.sessions.setStatus(running.sessionId!, "idle");

    await s.runner.tick();
    const done = s.queue.findById(row.id)!;
    expect(done.status).toBe("done");
    expect(done.finishedAt).toBeTruthy();

    // With the slot free, the next tick can dispatch the next row.
    const y = s.queue.create({ projectId: s.project.id, prompt: "y" });
    await s.runner.tick();
    await new Promise((r) => setImmediate(r));
    const yRow = s.queue.findById(y.id)!;
    expect(yRow.status).toBe("running");
  });

  it("marks a row failed when its session enters the error state", async () => {
    const s = setup();
    const row = s.queue.create({ projectId: s.project.id, prompt: "x" });
    await s.runner.tick();
    await new Promise((r) => setImmediate(r));
    const running = s.queue.findById(row.id)!;
    s.sessions.setStatus(running.sessionId!, "error");
    await s.runner.tick();
    expect(s.queue.findById(row.id)!.status).toBe("failed");
  });

  it("ordering is deterministic when two rows carry the same seq", () => {
    // Direct DB insert lets us fabricate a tied-seq pair (the public
    // store.create() auto-increments seq, so we can't produce this via the
    // API). pickNextQueued sorts by seq ASC, created_at ASC — the earlier
    // created_at wins.
    const s = setup();
    const now = new Date();
    const older = new Date(now.getTime() - 1000).toISOString();
    const newer = now.toISOString();
    s.db
      .prepare(
        `INSERT INTO queued_prompts (
          id, project_id, prompt, title, model, mode, worktree, status,
          session_id, created_at, started_at, finished_at, seq
        ) VALUES
          ('q-newer', ?, 'newer', NULL, NULL, NULL, 0, 'queued', NULL, ?, NULL, NULL, 5),
          ('q-older', ?, 'older', NULL, NULL, NULL, 0, 'queued', NULL, ?, NULL, NULL, 5)`,
      )
      .run(s.project.id, newer, s.project.id, older);
    const next = s.queue.pickNextQueued();
    expect(next!.id).toBe("q-older");
  });
});
