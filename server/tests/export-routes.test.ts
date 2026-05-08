import { describe, it, expect, afterEach } from "vitest";
import { bootstrapAuthedApp } from "./helpers.js";
import { ProjectStore } from "../src/sessions/projects.js";
import { SessionStore } from "../src/sessions/store.js";

describe("GET /api/sessions/:id/export", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (disposers.length) await disposers.pop()!();
  });

  it("rejects unauthenticated access", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions/unknown/export",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for an unknown session id", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/sessions/nope-nope/export",
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("markdown export of a session with no events returns header block only", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projects = new ProjectStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    const project = projects.create({
      name: "demo",
      path: ctx.tmpDir,
      trusted: true,
    });
    const session = sessions.create({
      id: "sess-export-1",
      title: "Empty session",
      projectId: project.id,
      model: "claude-opus-4-7",
      mode: "default",
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/export`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(
      "text/markdown; charset=utf-8",
    );
    const disp = res.headers["content-disposition"] as string;
    expect(disp).toContain("attachment;");
    expect(disp).toContain(`claudex-${session.id.slice(0, 8)}-`);
    expect(disp).toContain(".md");

    const body = res.body;
    expect(body).toContain("# Empty session");
    expect(body).toContain(`**Session**: ${session.id}`);
    expect(body).toContain("**Project**: demo");
    expect(body).toContain("**Model**: Opus 4.7");
    expect(body).toContain("**Mode**: default");
    // No event-derived content for an empty session.
    expect(body).not.toContain("**You:**");
    expect(body).not.toContain("**Claude:**");
  });

  it("markdown export renders user_message + assistant_text + tool_use + turn_end", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projects = new ProjectStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    const project = projects.create({
      name: "proj",
      path: ctx.tmpDir,
      trusted: true,
    });
    const session = sessions.create({
      id: "sess-export-2",
      title: "Hello world",
      projectId: project.id,
      model: "claude-sonnet-4-6",
      mode: "acceptEdits",
    });

    sessions.appendEvent({
      sessionId: session.id,
      kind: "user_message",
      payload: { content: "list files please" },
    });
    sessions.appendEvent({
      sessionId: session.id,
      kind: "assistant_text",
      payload: { text: "On it." },
    });
    sessions.appendEvent({
      sessionId: session.id,
      kind: "tool_use",
      payload: {
        toolName: "Bash",
        toolUseId: "t-1",
        input: { command: "ls" },
      },
    });
    sessions.appendEvent({
      sessionId: session.id,
      kind: "turn_end",
      payload: {
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 0,
        },
      },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/export?format=md`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).toContain("**You:** list files please");
    expect(body).toContain("**Claude:** On it.");
    expect(body).toContain("<tool: Bash>");
    expect(body).toContain('"command": "ls"');
    // turn_end emits the --- separator + usage line.
    expect(body).toContain(
      "_turn end · in 10 tok / out 20 tok · cache read 5 / create 0_",
    );
  });

  it("json export round-trips session + full event array", async () => {
    const ctx = await bootstrapAuthedApp();
    disposers.push(ctx.cleanup);
    const projects = new ProjectStore(ctx.dbh.db);
    const sessions = new SessionStore(ctx.dbh.db);
    const project = projects.create({
      name: "proj-j",
      path: ctx.tmpDir,
      trusted: true,
    });
    const session = sessions.create({
      id: "sess-export-3",
      title: "Json session",
      projectId: project.id,
      model: "claude-haiku-4-5",
      mode: "plan",
    });
    sessions.appendEvent({
      sessionId: session.id,
      kind: "user_message",
      payload: { content: "hi" },
    });
    sessions.appendEvent({
      sessionId: session.id,
      kind: "assistant_text",
      payload: { text: "hello" },
    });

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/export?format=json`,
      headers: { cookie: ctx.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    const disp = res.headers["content-disposition"] as string;
    expect(disp).toContain(".json");

    const body = JSON.parse(res.body) as {
      session: { id: string; title: string };
      events: Array<{ kind: string; payload: Record<string, unknown> }>;
    };
    expect(body.session.id).toBe(session.id);
    expect(body.session.title).toBe("Json session");
    expect(body.events).toHaveLength(2);
    expect(body.events[0].kind).toBe("user_message");
    expect(body.events[0].payload.content).toBe("hi");
    expect(body.events[1].kind).toBe("assistant_text");
    expect(body.events[1].payload.text).toBe("hello");
  });
});
