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

/**
 * Max length (code units) of an auto-generated session title before we
 * truncate + ellipsize. 60 is the Claude Code CLI feel: long enough to
 * recognize a prompt at a glance on mobile, short enough not to wrap.
 */
const AUTO_TITLE_MAX_LEN = 60;

/**
 * Should the session's current title be overwritten by an auto-title
 * derived from the user's first message?
 *
 * Heuristic: empty / whitespace-only, OR a "placeholder" single-word
 * blob of ≤3 words. Anything with 4+ words we treat as user-chosen
 * and leave alone. Mirrors how people actually fill the New Session
 * sheet: they either skip it (→ "Untitled" default), type a few
 * letters ("t", "demo", "test 1"), or write a real title.
 */
function shouldAutoRetitle(current: string): boolean {
  const trimmed = current.trim();
  if (trimmed.length === 0) return true;
  // "Untitled" is the server default when title is omitted on create.
  if (trimmed === "Untitled") return true;
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  return words.length <= 3;
}

/**
 * Turn a user's first message into a session title.
 *
 * Rules:
 *   1. trim leading/trailing whitespace
 *   2. take only up to the first newline (titles are one-line)
 *   3. if that's ≤ AUTO_TITLE_MAX_LEN chars, use it verbatim
 *   4. otherwise truncate to AUTO_TITLE_MAX_LEN, back up to the last
 *      whole-word boundary (whitespace), and append a single-char
 *      ellipsis "…". We back up at most ~15 chars to avoid
 *      pathological "one giant word" inputs producing a title of just
 *      the ellipsis; if no good boundary exists, truncate hard.
 */
function deriveTitleFromMessage(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "";
  if (firstLine.length <= AUTO_TITLE_MAX_LEN) return firstLine;

  const hard = firstLine.slice(0, AUTO_TITLE_MAX_LEN);
  const lastSpace = hard.lastIndexOf(" ");
  // Require the word boundary to leave us with at least ~45 chars of
  // title — otherwise we'd rather truncate mid-word than produce a
  // uselessly short title.
  const cut = lastSpace >= AUTO_TITLE_MAX_LEN - 15 ? lastSpace : AUTO_TITLE_MAX_LEN;
  return hard.slice(0, cut).trimEnd() + "…";
}

// Exposed for unit tests — these are intentionally pure helpers so they
// can be tested without spinning up a full SessionManager harness.
export const __testables = { shouldAutoRetitle, deriveTitleFromMessage };

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

    // Auto-title from the first user message, mirroring Claude Code CLI
    // behavior. Snapshot the session + count prior user_messages *before*
    // appending so "is this the very first user message?" is unambiguous.
    //
    // Skip retitle when:
    //   - session is a side chat (parentSessionId set) — those already
    //     have a deliberate "Side chat" title from routes.ts
    //   - the session already has a substantive user-chosen title
    //     (>3 words is our "looks deliberate" heuristic)
    //   - there are already prior user_message events (retitle is
    //     strictly a first-message thing)
    //
    // Intentionally NOT broadcast: the sibling agent is reshaping ws.ts
    // and adding a global session channel that will make live title
    // updates trivial. Until that lands, the new title persists to
    // SQLite only and surfaces on the next Home refresh.
    const beforeAppend = this.deps.sessions.findById(sessionId);
    const priorUserMessages = beforeAppend
      ? this.countPriorUserMessages(sessionId)
      : 0;

    this.deps.sessions.appendEvent({
      sessionId,
      kind: "user_message",
      payload: { text: content },
    });
    this.deps.sessions.touchLastMessage(sessionId);

    if (
      beforeAppend &&
      priorUserMessages === 0 &&
      beforeAppend.parentSessionId === null &&
      shouldAutoRetitle(beforeAppend.title)
    ) {
      const newTitle = deriveTitleFromMessage(content);
      if (newTitle.length > 0) {
        this.deps.sessions.setTitle(sessionId, newTitle);
        // TODO(ws-refactor): once the sibling agent's global session
        // channel lands, broadcast a session_update with the new title
        // so Home updates live. For now Home re-fetches on mount which
        // is acceptable for the first-message retitle case.
      }
    }

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

  /**
   * Count how many `user_message` events are already persisted for this
   * session. Used by auto-title to detect "this is the first user_message
   * for this session". Linear scan over listEvents — session transcripts
   * are bounded by human attention span, so not worth a dedicated index.
   */
  private countPriorUserMessages(sessionId: string): number {
    let n = 0;
    for (const ev of this.deps.sessions.listEvents(sessionId)) {
      if (ev.kind === "user_message") n += 1;
    }
    return n;
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
