import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerListener,
} from "../src/sessions/runner.js";
import { tempConfig } from "./helpers.js";

// ---- Mock runner ------------------------------------------------------------

class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  sent: string[] = [];
  interrupted = 0;
  permissions: Array<{ id: string; behavior: string }> = [];
  disposed = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  async start(initial?: string) {
    if (initial) this.sent.push(initial);
  }
  async sendUserMessage(c: string) {
    this.sent.push(c);
  }
  resolvePermission(id: string, d: { behavior: string }) {
    this.permissions.push({ id, behavior: d.behavior });
  }
  async interrupt() {
    this.interrupted += 1;
  }
  async setPermissionMode() {
    /* noop */
  }
  async dispose() {
    this.disposed = true;
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

function createFactory(): { factory: RunnerFactory; last: () => MockRunner | null } {
  let last: MockRunner | null = null;
  return {
    factory: {
      create(opts) {
        last = new MockRunner(opts.sessionId);
        return last;
      },
    },
    last: () => last,
  };
}

// ---- Harness ----------------------------------------------------------------

function setupManager() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const projects = new ProjectStore(db);
  const sessions = new SessionStore(db);
  const project = projects.create({
    name: "spindle",
    path: "/p/spindle",
    trusted: true,
  });
  const session = sessions.create({
    title: "t",
    projectId: project.id,
    model: "claude-opus-4-7",
    mode: "default",
  });
  const { factory, last } = createFactory();
  const broadcasts: Array<{ sessionId: string; event: RunnerEvent }> = [];
  const manager = new SessionManager({
    sessions,
    projects,
    runnerFactory: factory,
    broadcast: (sessionId, event) => broadcasts.push({ sessionId, event }),
  });
  return {
    manager,
    sessions,
    projects,
    session,
    project,
    broadcasts,
    last,
    cleanup: () => {
      close();
      cleanup();
    },
  };
}

describe("SessionManager", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("creates one runner per session and reuses it", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    const r1 = s.manager.getOrCreate(s.session.id);
    const r2 = s.manager.getOrCreate(s.session.id);
    expect(r1).toBe(r2);
  });

  it("throws for unknown session", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    expect(() => s.manager.getOrCreate("bogus")).toThrow(/not found/);
  });

  it("persists user messages and forwards them to the runner", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(s.session.id, "hi");
    const mock = s.last()!;
    expect(mock.sent).toEqual(["hi"]);
    const evs = s.sessions.listEvents(s.session.id);
    expect(evs).toHaveLength(1);
    expect(evs[0].kind).toBe("user_message");
    expect(evs[0].payload).toEqual({ text: "hi" });
  });

  it("persists assistant_text and bumps stats on turn_end", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "hi there",
      done: true,
    });
    mock.emit({
      type: "turn_end",
      stopReason: "success",
    });

    const evs = s.sessions.listEvents(s.session.id);
    expect(evs.map((e) => e.kind)).toEqual(["assistant_text", "turn_end"]);
    const fresh = s.sessions.findById(s.session.id)!;
    expect(fresh.stats.messages).toBe(1);
    expect(fresh.lastMessageAt).not.toBeNull();
    expect(fresh.status).toBe("idle");
  });

  it("flips status to awaiting on permission_request and back to running on decision", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "use Bash",
    });
    expect(s.sessions.findById(s.session.id)!.status).toBe("awaiting");

    s.manager.resolvePermission(s.session.id, "tu-1", { behavior: "allow" });
    expect(mock.permissions).toEqual([{ id: "tu-1", behavior: "allow" }]);
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");

    const kinds = s.sessions.listEvents(s.session.id).map((e) => e.kind);
    expect(kinds).toContain("permission_request");
    expect(kinds).toContain("permission_decision");
  });

  it("broadcasts every event to subscribers", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "status", status: "running" });
    mock.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "ok",
      done: true,
    });
    expect(s.broadcasts.map((b) => b.event.type)).toEqual([
      "status",
      "assistant_text",
    ]);
  });

  it("error events persist and flip session to error status", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "error", code: "boom", message: "oops" });
    const fresh = s.sessions.findById(s.session.id)!;
    expect(fresh.status).toBe("error");
    const ev = s.sessions.listEvents(s.session.id).find((e) => e.kind === "error");
    expect(ev?.payload).toMatchObject({ code: "boom", message: "oops" });
  });

  it("disposeAll cleans up all runners", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    await s.manager.disposeAll();
    expect(mock.disposed).toBe(true);
  });

  it("resolvePermission is a no-op on a stopped session", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Don't create the runner — just try to resolve
    expect(() =>
      s.manager.resolvePermission(s.session.id, "tu-1", { behavior: "allow" }),
    ).not.toThrow();
  });
});
