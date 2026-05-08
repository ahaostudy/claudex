import type { FastifyBaseLogger } from "fastify";
import type {
  Runner,
  RunnerEvent,
  RunnerFactory,
  RunnerInitOptions,
} from "./runner.js";
import type { SessionStore } from "./store.js";
import type { ProjectStore } from "./projects.js";
import { ToolGrantStore, signatureFor } from "./grants.js";
import { summarizePermission } from "./permission-summary.js";

type Broadcaster = (sessionId: string, event: RunnerEvent) => void;

export interface SessionManagerDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  grants: ToolGrantStore;
  runnerFactory: RunnerFactory;
  broadcast: Broadcaster;
  logger?: FastifyBaseLogger;
}

interface SessionEntry {
  runner: Runner;
  off: () => void;
  // Side-chat context seed: a synthetic user message to send to the SDK
  // before the user's *first* real message. Captures the main thread so
  // claude has grounding, but we explicitly don't persist it into
  // `session_events` — the transcript should only show what the user
  // actually typed into the side chat.
  pendingSeed: string | null;
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export class SessionManager {
  private runners = new Map<string, SessionEntry>();
  // Track pending permission requests by toolUseId so we can look up the tool
  // name / input when the user sends back a decision (for "allow_always").
  private pendingByApproval = new Map<
    string,
    { sessionId: string; toolName: string; input: Record<string, unknown> }
  >();

  constructor(private readonly deps: SessionManagerDeps) {}

  getOrCreate(sessionId: string): Runner {
    const existing = this.runners.get(sessionId);
    if (existing) return existing.runner;

    const session = this.deps.sessions.findById(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const project = this.deps.projects.findById(session.projectId);
    if (!project)
      throw new Error(
        `project ${session.projectId} gone for session ${sessionId}`,
      );

    const opts: RunnerInitOptions = {
      sessionId,
      cwd: session.worktreePath ?? project.path,
      model: session.model,
      permissionMode: session.mode,
      // Resume the SDK-side conversation if we've seen one before. Null on
      // first ever spawn; set after the SDK's system/init echoes its id back.
      resumeSdkSessionId: session.sdkSessionId ?? undefined,
    };
    const runner = this.deps.runnerFactory.create(opts);
    const off = runner.on((event) => this.handleEvent(sessionId, event));

    // Side chat: on *first* spawn (no SDK session id yet, so we haven't talked
    // to the CLI about this conversation), prepend a synthetic context message
    // summarizing the parent thread. Resumes skip this — the SDK already has
    // the history persisted on its side.
    let pendingSeed: string | null = null;
    if (session.parentSessionId && !session.sdkSessionId) {
      pendingSeed = this.buildSideChatSeed(session.parentSessionId);
    }

    this.runners.set(sessionId, { runner, off, pendingSeed });
    return runner;
  }

  /**
   * Build the synthetic seed prompt that gives a side-chat claude the main
   * thread's context without handing it tool-call noise.
   *
   * Rules (intentional, documented):
   *   - only `user_message` and `assistant_text` events — tool_use /
   *     tool_result / thinking / permission_* are stripped; the point of
   *     /btw is to ask a quick lateral question, not re-audit the run
   *   - multi-line text is preserved verbatim — we never truncate or
   *     summarize, mirroring claudex's general "don't silently truncate"
   *     rule. The user can archive+start-new if the context grows unwieldy.
   *   - the seed ends with an explicit instruction reminding the model it
   *     must not imply action on the main thread from this side lane.
   */
  private buildSideChatSeed(parentId: string): string {
    const events = this.deps.sessions.listEvents(parentId);
    const lines: string[] = [];
    for (const ev of events) {
      const p = ev.payload as Record<string, unknown>;
      if (ev.kind === "user_message") {
        const text = typeof p.text === "string" ? p.text : "";
        if (text.length > 0) lines.push(`user: ${text}`);
      } else if (ev.kind === "assistant_text") {
        const text = typeof p.text === "string" ? p.text : "";
        if (text.length > 0) lines.push(`assistant: ${text}`);
      }
    }
    const transcript = lines.length > 0 ? lines.join("\n") : "(no messages yet)";
    return (
      "The user is asking a side question. Answer without implying any " +
      "action on the main thread — no tool calls unless the user explicitly " +
      "asks for one, no file edits, no commits.\n\n" +
      "Here's the conversation so far:\n" +
      transcript
    );
  }

  private handleEvent(sessionId: string, event: RunnerEvent) {
    try {
      switch (event.type) {
        case "sdk_session_id":
          // First-write-wins: setSdkSessionId only updates NULL rows. On resume
          // the SDK re-emits the same id, and we intentionally skip that write.
          this.deps.sessions.setSdkSessionId(sessionId, event.sdkSessionId);
          break;
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
        case "permission_request": {
          // Auto-approve if an existing grant matches. "allow_once" here because
          // the grant itself already represents the "always" decision.
          const sig = signatureFor(event.toolName, event.input);
          if (sig && this.deps.grants.has(sessionId, event.toolName, sig)) {
            const entry = this.runners.get(sessionId);
            entry?.runner.resolvePermission(event.toolUseId, {
              behavior: "allow",
              reason: "auto-approved by saved grant",
            });
            // Don't persist this as a user-facing permission_request.
            return;
          }

          // Enrich with a summary for the UI.
          const { summary, blastRadius } = summarizePermission(
            event.toolName,
            event.input,
          );
          this.deps.sessions.appendEvent({
            sessionId,
            kind: "permission_request",
            payload: {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
              title: summary,
              blastRadius,
            },
          });
          this.pendingByApproval.set(event.toolUseId, {
            sessionId,
            toolName: event.toolName,
            input: event.input,
          });
          this.deps.sessions.setStatus(sessionId, "awaiting");
          // Propagate enriched event to subscribers.
          this.deps.broadcast(sessionId, {
            ...event,
            title: summary,
          });
          return;
        }
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
    // If this is a side chat whose runner has a pending context seed,
    // flush it to the SDK first. We do NOT append the seed to
    // session_events — the transcript only shows what the user typed.
    const entry = this.runners.get(sessionId);
    if (entry?.pendingSeed) {
      const seed = entry.pendingSeed;
      entry.pendingSeed = null;
      await runner.sendUserMessage(seed);
    }
    this.deps.sessions.appendEvent({
      sessionId,
      kind: "user_message",
      payload: { text: content },
    });
    this.deps.sessions.touchLastMessage(sessionId);
    // Broadcast the user message to every subscriber — including the tab
    // that sent it. Multi-tab sees the message show up instantly; the
    // sending tab reconciles against its local optimistic echo using
    // content + createdAt proximity (see web/src/state/sessions.ts).
    this.deps.broadcast(sessionId, {
      type: "user_message",
      text: content,
      at: new Date().toISOString(),
    });
    await runner.sendUserMessage(content);
  }

  async interrupt(sessionId: string): Promise<void> {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    await entry.runner.interrupt();
  }

  /**
   * Propagate a permission-mode change to the live runner, if any.
   * The caller is expected to have already persisted the new mode to the DB.
   * Returns true when a running runner got the call, false otherwise.
   */
  async applyPermissionMode(
    sessionId: string,
    mode: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions",
  ): Promise<boolean> {
    const entry = this.runners.get(sessionId);
    if (!entry) return false;
    await entry.runner.setPermissionMode(mode);
    return true;
  }

  /** Is a live runner attached for this session? */
  hasRunner(sessionId: string): boolean {
    return this.runners.has(sessionId);
  }

  resolvePermission(
    sessionId: string,
    toolUseId: string,
    decision: PermissionDecision,
  ): void {
    const entry = this.runners.get(sessionId);
    if (!entry) return;

    const pending = this.pendingByApproval.get(toolUseId);
    this.pendingByApproval.delete(toolUseId);

    if (decision === "allow_always" && pending) {
      const sig = signatureFor(pending.toolName, pending.input);
      if (sig) {
        this.deps.grants.addSessionGrant(sessionId, pending.toolName, sig);
      }
    }

    const behavior = decision === "deny" ? "deny" : "allow";
    entry.runner.resolvePermission(toolUseId, { behavior });

    this.deps.sessions.appendEvent({
      sessionId,
      kind: "permission_decision",
      payload: { toolUseId, decision, toolName: pending?.toolName ?? null },
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
