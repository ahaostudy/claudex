import type { FastifyBaseLogger } from "fastify";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
} from "./runner.js";
import type { SessionStore } from "./store.js";
import type { ProjectStore } from "./projects.js";

type Broadcaster = (sessionId: string, event: RunnerEvent) => void;

export interface SessionManagerDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  runnerFactory: RunnerFactory;
  broadcast: Broadcaster;
  logger?: FastifyBaseLogger;
}

interface SessionEntry {
  runner: Runner;
  off: () => void;
}

/**
 * Holds one Runner per live session. Persists every translated event into
 * session_events and bumps session status + stats. Broadcaster is the hook
 * the WS transport subscribes to.
 */
export class SessionManager {
  private runners = new Map<string, SessionEntry>();

  constructor(private readonly deps: SessionManagerDeps) {}

  getOrCreate(sessionId: string): Runner {
    const existing = this.runners.get(sessionId);
    if (existing) return existing.runner;

    const session = this.deps.sessions.findById(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const project = this.deps.projects.findById(session.projectId);
    if (!project)
      throw new Error(`project ${session.projectId} gone for session ${sessionId}`);

    const opts: RunnerInitOptions = {
      sessionId,
      cwd: session.worktreePath ?? project.path,
      model: session.model,
      permissionMode: session.mode,
    };
    const runner = this.deps.runnerFactory.create(opts);
    const off = runner.on((event) => this.handleEvent(sessionId, event));
    this.runners.set(sessionId, { runner, off });
    return runner;
  }

  private handleEvent(sessionId: string, event: RunnerEvent) {
    // Persist (most) events for later replay. status pings stay in memory.
    try {
      switch (event.type) {
        case "assistant_text":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "assistant_text",
            payload: {
              messageId: event.messageId,
              text: event.text,
              done: event.done,
            },
          });
          break;
        case "thinking":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "assistant_thinking",
            payload: { text: event.text },
          });
          break;
        case "tool_use":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "tool_use",
            payload: {
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input,
            },
          });
          break;
        case "tool_result":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "tool_result",
            payload: {
              toolUseId: event.toolUseId,
              content: event.content,
              isError: event.isError,
            },
          });
          break;
        case "permission_request":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "permission_request",
            payload: {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
              title: event.title,
            },
          });
          this.deps.sessions.setStatus(sessionId, "awaiting");
          break;
        case "turn_end":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "turn_end",
            payload: {
              stopReason: event.stopReason,
              usage: event.usage ?? null,
            },
          });
          this.deps.sessions.bumpStats(sessionId, { messages: 1 });
          this.deps.sessions.touchLastMessage(sessionId);
          this.deps.sessions.setStatus(sessionId, "idle");
          break;
        case "status":
          if (event.status === "running")
            this.deps.sessions.setStatus(sessionId, "running");
          else if (event.status === "idle")
            this.deps.sessions.setStatus(sessionId, "idle");
          else if (event.status === "terminated")
            this.deps.sessions.setStatus(sessionId, "idle");
          break;
        case "error":
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "error",
            payload: { code: event.code, message: event.message },
          });
          this.deps.sessions.setStatus(sessionId, "error");
          break;
      }
    } catch (err) {
      this.deps.logger?.error(
        { err, sessionId, event: event.type },
        "failed to persist runner event",
      );
    }
    this.deps.broadcast(sessionId, event);
  }

  async sendUserMessage(sessionId: string, content: string): Promise<void> {
    const runner = this.getOrCreate(sessionId);
    this.deps.sessions.appendEvent({
      sessionId,
      kind: "user_message",
      payload: { text: content },
    });
    this.deps.sessions.touchLastMessage(sessionId);
    await runner.sendUserMessage(content);
  }

  async interrupt(sessionId: string): Promise<void> {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    await entry.runner.interrupt();
  }

  resolvePermission(
    sessionId: string,
    toolUseId: string,
    decision: { behavior: "allow" | "deny"; reason?: string },
  ): void {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    entry.runner.resolvePermission(toolUseId, decision);
    this.deps.sessions.appendEvent({
      sessionId,
      kind: "permission_decision",
      payload: { toolUseId, decision: decision.behavior, reason: decision.reason ?? null },
    });
    this.deps.sessions.setStatus(sessionId, "running");
  }

  async disposeAll(): Promise<void> {
    const entries = Array.from(this.runners.values());
    this.runners.clear();
    await Promise.all(
      entries.map(async (e) => {
        e.off();
        await e.runner.dispose();
      }),
    );
  }
}
