import { describe, it, expect, afterEach } from "vitest";
import { openDb } from "../src/db/index.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";
import { SessionManager } from "../src/sessions/manager.js";
import { ToolGrantStore } from "../src/sessions/grants.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
  RunnerListener,
} from "../src/sessions/runner.js";
import { tempConfig } from "./helpers.js";

// ---- Mock runner ------------------------------------------------------------

class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  // Stashed init options so tests can assert what the factory passed in.
  // This is test-only — we don't want to leak the full RunnerInitOptions into
  // the Runner contract.
  initOpts: RunnerInitOptions;
  private listeners = new Set<RunnerListener>();
  sent: string[] = [];
  interrupted = 0;
  permissions: Array<{ id: string; behavior: string }> = [];
  permissionModes: string[] = [];
  disposed = false;

  constructor(opts: RunnerInitOptions) {
    this.sessionId = opts.sessionId;
    this.initOpts = opts;
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
  async setPermissionMode(mode: import("@claudex/shared").PermissionMode) {
    this.permissionModes.push(mode);
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
        last = new MockRunner(opts);
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
  const grants = new ToolGrantStore(db);
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
    grants,
    runnerFactory: factory,
    broadcast: (sessionId, event) => broadcasts.push({ sessionId, event }),
  });
  return {
    manager,
    sessions,
    projects,
    grants,
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

    s.manager.resolvePermission(s.session.id, "tu-1", "allow_once");
    expect(mock.permissions).toEqual([{ id: "tu-1", behavior: "allow" }]);
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");

    const kinds = s.sessions.listEvents(s.session.id).map((e) => e.kind);
    expect(kinds).toContain("permission_request");
    expect(kinds).toContain("permission_decision");
  });

  it("allow_always records a tool grant that auto-approves next matching call", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;

    mock.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "pnpm vitest run" },
      title: "use Bash",
    });
    s.manager.resolvePermission(s.session.id, "tu-1", "allow_always");

    // Second request with the same command should be auto-allowed
    // (resolved without flipping status or emitting a permission_request)
    s.sessions.setStatus(s.session.id, "running");
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-2",
      toolName: "Bash",
      input: { command: "pnpm vitest run" },
      title: "use Bash",
    });
    expect(mock.permissions).toEqual([
      { id: "tu-1", behavior: "allow" },
      { id: "tu-2", behavior: "allow" },
    ]);
    // Auto-approved requests do not persist a permission_request event.
    const kinds = s.sessions.listEvents(s.session.id).map((e) => e.kind);
    const permReqs = kinds.filter((k) => k === "permission_request");
    expect(permReqs).toHaveLength(1);
    expect(s.sessions.findById(s.session.id)!.status).toBe("running");
  });

  it("deny decision still resolves and does not grant", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Edit",
      input: { file_path: "/x/y.ts" },
      title: "Edit",
    });
    s.manager.resolvePermission(s.session.id, "tu-1", "deny");
    expect(mock.permissions).toEqual([{ id: "tu-1", behavior: "deny" }]);
    expect(s.grants.has(s.session.id, "Edit", "/x/y.ts")).toBe(false);
  });

  it("sendUserMessage broadcasts a user_message event to subscribers", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    await s.manager.sendUserMessage(s.session.id, "hey");
    const userBroadcasts = s.broadcasts.filter(
      (b) => b.event.type === "user_message",
    );
    expect(userBroadcasts).toHaveLength(1);
    const ev = userBroadcasts[0].event as {
      type: "user_message";
      text: string;
      at: string;
    };
    expect(ev.text).toBe("hey");
    // ISO 8601 timestamp.
    expect(Number.isNaN(Date.parse(ev.at))).toBe(false);
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
      s.manager.resolvePermission(s.session.id, "tu-1", "allow_once"),
    ).not.toThrow();
  });

  it("applyPermissionMode forwards to the live runner and is a no-op when none attached", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // Nothing attached yet → returns false and doesn't throw.
    const beforeAttach = await s.manager.applyPermissionMode(
      s.session.id,
      "plan",
    );
    expect(beforeAttach).toBe(false);

    // Attach a runner and flip the mode.
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    const afterAttach = await s.manager.applyPermissionMode(
      s.session.id,
      "acceptEdits",
    );
    expect(afterAttach).toBe(true);
    expect(mock.permissionModes).toEqual(["acceptEdits"]);
    expect(s.manager.hasRunner(s.session.id)).toBe(true);
  });

  // ---- SDK session resume --------------------------------------------------

  it("first getOrCreate has no resumeSdkSessionId when DB row is NULL", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    expect(mock.initOpts.resumeSdkSessionId).toBeUndefined();
    // DB should still be NULL (nothing has emitted sdk_session_id yet).
    expect(s.sessions.findById(s.session.id)!.sdkSessionId).toBeNull();
  });

  it("sdk_session_id event persists the id to the DB row", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "sdk_session_id", sdkSessionId: "sdk-abc-123" });
    expect(s.sessions.findById(s.session.id)!.sdkSessionId).toBe("sdk-abc-123");
  });

  it("subsequent getOrCreate (after disposeAll) passes resumeSdkSessionId from the DB", async () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    // First spawn + emit sdk_session_id.
    s.manager.getOrCreate(s.session.id);
    s.last()!.emit({ type: "sdk_session_id", sdkSessionId: "sdk-persisted" });
    // Simulate a server restart: tear down all live runners, then re-create.
    await s.manager.disposeAll();

    s.manager.getOrCreate(s.session.id);
    const second = s.last()!;
    expect(second.initOpts.resumeSdkSessionId).toBe("sdk-persisted");
    expect(second.initOpts.sessionId).toBe(s.session.id);
  });

  it("repeated sdk_session_id events are first-write-wins (DB not overwritten)", () => {
    const s = setupManager();
    cleanups.push(s.cleanup);
    s.manager.getOrCreate(s.session.id);
    const mock = s.last()!;
    mock.emit({ type: "sdk_session_id", sdkSessionId: "sdk-first" });
    // A second emit — shouldn't happen in practice (resume echoes the same id)
    // but guard against the SDK changing ids mid-session.
    mock.emit({ type: "sdk_session_id", sdkSessionId: "sdk-second" });
    expect(s.sessions.findById(s.session.id)!.sdkSessionId).toBe("sdk-first");
  });
});
