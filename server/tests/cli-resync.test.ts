import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db/index.js";
import { SessionStore } from "../src/sessions/store.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { resyncCliSession } from "../src/sessions/cli-resync.js";
import { importCliSessionEvents } from "../src/sessions/cli-events-import.js";
import { tempConfig } from "./helpers.js";

/**
 * CLI JSONL incremental resync — we lay down a fake `~/.claude/projects`
 * hierarchy with a matching `<sdkSessionId>.jsonl`, simulate the CLI growing
 * the file, and verify the resync path picks up only the new lines.
 */

function setup() {
  const { config, log, cleanup } = tempConfig();
  const { db, close } = openDb(config, log);
  const sessions = new SessionStore(db);
  const projects = new ProjectStore(db);
  const project = projects.create({
    name: "demo",
    path: "/tmp/demo",
    trusted: true,
  });

  // Fake CLI projects root.
  const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cli-root-"));
  const slug = "-Users-hao-demo"; // arbitrary; only file-layout matters
  const dir = path.join(cliRoot, slug);
  fs.mkdirSync(dir, { recursive: true });

  const sdkId = "7a4f3e2d-1111-2222-3333-444455556666";
  const jsonlPath = path.join(dir, `${sdkId}.jsonl`);

  const session = sessions.create({
    title: "test",
    projectId: project.id,
    model: "claude-opus-4-7",
    mode: "default",
  });
  sessions.setSdkSessionId(session.id, sdkId);

  return {
    sessions,
    sessionId: session.id,
    sdkId,
    cliRoot,
    jsonlPath,
    writeJsonl(lines: unknown[]) {
      const body = lines
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n");
      fs.writeFileSync(jsonlPath, body + "\n");
    },
    appendJsonl(lines: unknown[]) {
      const body = lines
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n");
      fs.appendFileSync(jsonlPath, body + "\n");
    },
    cleanup: () => {
      fs.rmSync(cliRoot, { recursive: true, force: true });
      close();
      cleanup();
    },
  };
}

describe("resyncCliSession", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("is a no-op when the session has no sdkSessionId", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    // Synthesize a non-CLI session (no sdk id).
    const noSdk = ctx.sessions.create({
      title: "bare",
      projectId: ctx.sessions.findById(ctx.sessionId)!.projectId,
      model: "claude-opus-4-7",
      mode: "default",
    });
    const row = ctx.sessions.findById(noSdk.id)!;
    const res = await resyncCliSession(
      { sessions: ctx.sessions, cliProjectsRoot: ctx.cliRoot },
      row,
    );
    expect(res.added).toBe(0);
  });

  it("is a no-op when cli_jsonl_seq already matches the JSONL line count", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    ctx.writeJsonl([
      { type: "user", message: { role: "user", content: "hi" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);
    // Seed normally.
    await importCliSessionEvents(
      { sessionEvents: ctx.sessions },
      { sessionId: ctx.sessionId, filePath: ctx.jsonlPath },
    );
    // Stamp cli_jsonl_seq as if the importer had done it.
    ctx.sessions.setCliJsonlSeq(ctx.sessionId, 2);

    const row = ctx.sessions.findById(ctx.sessionId)!;
    const res = await resyncCliSession(
      { sessions: ctx.sessions, cliProjectsRoot: ctx.cliRoot },
      row,
    );
    expect(res.added).toBe(0);
    expect(res.newJsonlSeq).toBe(2);
  });

  it("imports only new lines on append, bumps cli_jsonl_seq, and is idempotent", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    ctx.writeJsonl([
      { type: "user", message: { role: "user", content: "turn 1" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      },
      { type: "user", message: { role: "user", content: "turn 2" } },
    ]);
    await importCliSessionEvents(
      { sessionEvents: ctx.sessions },
      { sessionId: ctx.sessionId, filePath: ctx.jsonlPath },
    );
    ctx.sessions.setCliJsonlSeq(ctx.sessionId, 3);
    const beforeCount = ctx.sessions.countEvents(ctx.sessionId);

    // CLI appends 2 more lines (a reply + a follow-up user turn).
    ctx.appendJsonl([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "reply 2" }] },
      },
      { type: "user", message: { role: "user", content: "turn 3" } },
    ]);

    const row = ctx.sessions.findById(ctx.sessionId)!;
    const res = await resyncCliSession(
      { sessions: ctx.sessions, cliProjectsRoot: ctx.cliRoot },
      row,
    );
    // We added events for the 2 new JSONL lines (assistant text → 1 event,
    // user message → 1 event; no usage so no turn_end).
    expect(res.added).toBeGreaterThan(0);
    expect(res.newJsonlSeq).toBe(5);
    const afterCount = ctx.sessions.countEvents(ctx.sessionId);
    expect(afterCount).toBe(beforeCount + res.added);
    expect(ctx.sessions.getCliJsonlSeq(ctx.sessionId)).toBe(5);

    // Second call with no JSONL changes → no-op.
    const row2 = ctx.sessions.findById(ctx.sessionId)!;
    const res2 = await resyncCliSession(
      { sessions: ctx.sessions, cliProjectsRoot: ctx.cliRoot },
      row2,
    );
    expect(res2.added).toBe(0);
    expect(res2.newJsonlSeq).toBe(5);
    expect(ctx.sessions.countEvents(ctx.sessionId)).toBe(afterCount);
  });

  it("no-ops when the JSONL file cannot be located under cliProjectsRoot", async () => {
    const ctx = setup();
    cleanups.push(ctx.cleanup);
    // Don't create any JSONL file — locateJsonl will fail.
    const row = ctx.sessions.findById(ctx.sessionId)!;
    const res = await resyncCliSession(
      { sessions: ctx.sessions, cliProjectsRoot: ctx.cliRoot },
      row,
    );
    expect(res.added).toBe(0);
  });
});
