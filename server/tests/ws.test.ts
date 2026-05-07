import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../src/transport/app.js";
import { openDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerListener,
} from "../src/sessions/runner.js";
import type { ClientFrame, ServerFrame } from "@claudex/shared";
import { tempConfig } from "./helpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class MockRunner implements Runner {
  sessionId: string;
  sdkSessionId: string | null = null;
  private listeners = new Set<RunnerListener>();
  sent: string[] = [];
  interrupted = 0;
  permissions: Array<{ id: string; behavior: string }> = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
  async start(p?: string) {
    if (p) this.sent.push(p);
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
  async setPermissionMode() {}
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

function makeFactory(hub: {
  runners: MockRunner[];
}): RunnerFactory {
  return {
    create(opts) {
      const r = new MockRunner(opts.sessionId);
      hub.runners.push(r);
      return r;
    },
  };
}

interface WsHarness {
  app: FastifyInstance;
  url: string;
  cookie: string;
  sessionId: string;
  hub: { runners: MockRunner[] };
  cleanup: () => Promise<void>;
}

async function harness(): Promise<WsHarness> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const hub: { runners: MockRunner[] } = { runners: [] };
  const { app, manager } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
    runnerFactory: makeFactory(hub),
  });

  // admin user
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  users.create({
    username: "hao",
    passwordHash: await hashPassword("hunter22-please-work"),
    totpSecret,
  });
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
  const sessionCookieHdr = verify.cookies.find(
    (c) => c.name === "claudex_session",
  )!;
  const cookie = `claudex_session=${sessionCookieHdr.value}`;

  // project + session
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-ws-"));
  const proj = (
    await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "demo", path: tmpDir },
    })
  ).json().project;
  const session = (
    await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie },
      payload: {
        projectId: proj.id,
        title: "t",
        model: "claude-opus-4-7",
        mode: "default",
        worktree: false,
      },
    })
  ).json().session;

  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr !== "object") throw new Error("no address");
  const url = `ws://127.0.0.1:${addr.port}/ws`;

  return {
    app,
    url,
    cookie,
    sessionId: session.id,
    hub,
    cleanup: async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}

interface Ws {
  socket: WebSocket;
  frames: ServerFrame[];
  send: (frame: ClientFrame) => void;
  waitFor: (predicate: (f: ServerFrame) => boolean, timeout?: number) => Promise<ServerFrame>;
  close: () => Promise<void>;
}

function openSocket(url: string, cookie: string): Promise<Ws> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    const frames: ServerFrame[] = [];
    const waiters: Array<{
      predicate: (f: ServerFrame) => boolean;
      resolve: (f: ServerFrame) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];
    socket.on("open", () =>
      resolve({
        socket,
        frames,
        send: (frame) => socket.send(JSON.stringify(frame)),
        waitFor: (predicate, timeout = 2000) =>
          new Promise((res, rej) => {
            const matched = frames.find(predicate);
            if (matched) return res(matched);
            const timer = setTimeout(() => {
              rej(new Error(`timeout waiting for frame`));
            }, timeout);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          }),
        close: () =>
          new Promise((res) => {
            socket.once("close", () => res());
            socket.close();
          }),
      }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.predicate(frame)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(frame);
        }
      }
    });
    socket.on("error", (err) => {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      reject(err);
    });
  });
}

describe("WebSocket transport", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("closes sockets without an auth cookie", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    await new Promise<void>((resolve, reject) => {
      const s = new WebSocket(ctx.url);
      const timer = setTimeout(
        () => reject(new Error("timeout")),
        2000,
      );
      s.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        if (frame.type === "error" && frame.code === "unauthenticated") {
          clearTimeout(timer);
        }
      });
      s.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      s.on("error", (err) => {
        clearTimeout(timer);
        // Some stacks close with a 4xx and emit an error. Either is fine.
        resolve();
      });
    });
  });

  it("hello_ack on successful auth", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    const ack = await ws.waitFor((f) => f.type === "hello_ack");
    expect(ack).toMatchObject({ type: "hello_ack" });
  });

  it("pipes user_message through to the runner", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "hello claude",
    });

    // Give the server a tick to spawn the runner via the SessionManager.
    await new Promise((r) => setTimeout(r, 150));
    expect(ctx.hub.runners).toHaveLength(1);
    expect(ctx.hub.runners[0].sent).toContain("hello claude");
  });

  it("relays assistant_text and turn_end to subscribers", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");

    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "yo",
    });
    await new Promise((r) => setTimeout(r, 100));

    const runner = ctx.hub.runners[0];
    runner.emit({
      type: "assistant_text",
      messageId: "m1",
      text: "hi there",
      done: true,
    });
    runner.emit({ type: "turn_end", stopReason: "success" });

    const text = await ws.waitFor((f) => f.type === "assistant_text_delta");
    expect((text as any).text).toBe("hi there");
    const end = await ws.waitFor((f) => f.type === "turn_end");
    expect((end as any).stopReason).toBe("success");
  });

  it("unsubscribe stops delivery to that client", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const a = await openSocket(ctx.url, ctx.cookie);
    const b = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => a.close());
    disposers.push(() => b.close());

    await Promise.all([
      a.waitFor((f) => f.type === "hello_ack"),
      b.waitFor((f) => f.type === "hello_ack"),
    ]);

    a.send({ type: "subscribe", sessionId: ctx.sessionId });
    b.send({ type: "subscribe", sessionId: ctx.sessionId });
    // Kick the runner awake via a message.
    a.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "hi",
    });
    await new Promise((r) => setTimeout(r, 100));

    // b unsubscribes before the next emit
    b.send({ type: "unsubscribe", sessionId: ctx.sessionId });
    await new Promise((r) => setTimeout(r, 50));

    ctx.hub.runners[0].emit({
      type: "assistant_text",
      messageId: "m1",
      text: "pong",
      done: true,
    });

    await a.waitFor((f) => f.type === "assistant_text_delta");
    expect(b.frames.some((f) => f.type === "assistant_text_delta")).toBe(false);
  });

  it("permission_decision reaches the runner", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");
    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "please",
    });
    await new Promise((r) => setTimeout(r, 100));

    const runner = ctx.hub.runners[0];
    runner.emit({
      type: "permission_request",
      toolUseId: "tu-1",
      toolName: "Bash",
      input: { command: "ls" },
      title: "use Bash",
    });

    const prompt = await ws.waitFor((f) => f.type === "permission_request");
    expect((prompt as any).approvalId).toBe("tu-1");

    ws.send({
      type: "permission_decision",
      sessionId: ctx.sessionId,
      approvalId: "tu-1",
      decision: "allow_once",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(runner.permissions).toEqual([{ id: "tu-1", behavior: "allow" }]);
  });

  it("rejects malformed frames with an error response, socket stays open", async () => {
    const ctx = await harness();
    disposers.push(ctx.cleanup);
    const ws = await openSocket(ctx.url, ctx.cookie);
    disposers.push(() => ws.close());
    await ws.waitFor((f) => f.type === "hello_ack");
    ws.socket.send("not-json");
    const err = await ws.waitFor((f) => f.type === "error");
    expect((err as any).code).toBe("bad_frame");

    // Socket should still work after a bad frame.
    ws.send({ type: "subscribe", sessionId: ctx.sessionId });
    await new Promise((r) => setTimeout(r, 50));
    // no crash; next call should still go through
    ws.send({
      type: "user_message",
      sessionId: ctx.sessionId,
      content: "still here",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.hub.runners[0].sent).toContain("still here");
  });
});
