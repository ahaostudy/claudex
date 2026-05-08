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
import type { AuditStore } from "../audit/store.js";
import type { AttachmentStore } from "../uploads/store.js";

type Broadcaster = (sessionId: string, event: RunnerEvent) => void;

/**
 * Narrow surface the manager needs from the push module. Accepts the full
 * payload shape used by `sendToAll` over in `push/routes.ts`. Kept as a
 * separate interface so we don't have to import the routes module (which
 * pulls in fastify) from the manager — and so tests can stub it with a plain
 * spy.
 */
export interface ManagerPushSender {
  sendToAll(payload: {
    title: string;
    body: string;
    data: { sessionId: string; url: string };
  }): Promise<{ sent: number; pruned: number }>;
}

export interface SessionManagerDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  grants: ToolGrantStore;
  runnerFactory: RunnerFactory;
  broadcast: Broadcaster;
  logger?: FastifyBaseLogger;
  /**
   * Optional audit sink. The manager is reachable from non-HTTP paths (WS
   * handlers, scheduler) so a user id can't always be threaded in — we
   * append with userId=null in those cases and the Security card still
   * shows "Granted: Bash <cmd>" / "Denied: …" honestly.
   */
  audit?: AuditStore;
  /**
   * Optional attachment store + uploads root. When both are provided, the
   * manager resolves `attachmentIds` passed to `sendUserMessage`, prefixes
   * the outgoing SDK prompt with `@<absolute-path>` tokens so the SDK's
   * Read tool can pick up the files, and stamps each row's
   * `message_event_seq` with the user_message seq that was just appended.
   * Missing / empty is a no-op — matches the contract in tests that don't
   * need uploads.
   */
  attachments?: AttachmentStore;
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

/**
 * Pick the "most relevant" field from a tool-use input to show on a push
 * notification body. Covers every tool we currently summarize for
 * permission requests — extend here when new tool shapes land. Returns
 * null when nothing useful is present; caller falls back to the tool name.
 */
function pickPushSubject(input: Record<string, unknown>): string | null {
  const order = [
    "command", // Bash
    "file_path", // Edit / Write / MultiEdit / Read
    "path",
    "pattern", // Glob / Grep
    "url", // WebFetch
    "query", // WebSearch
  ];
  for (const key of order) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * Clip a string to `max` code units for push-notification body text, adding
 * a single-char ellipsis when clipping. Kept intentionally simple — we
 * don't try to respect word boundaries because many push subjects are paths
 * or commands where a word boundary isn't well-defined.
 */
function truncateForPush(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(1, max - 1)) + "…";
}

export class SessionManager {
  private runners = new Map<string, SessionEntry>();
  // Track pending permission requests by toolUseId so we can look up the tool
  // name / input when the user sends back a decision (for "allow_always").
  private pendingByApproval = new Map<
    string,
    { sessionId: string; toolName: string; input: Record<string, unknown> }
  >();
  // Optional: attached by the server on boot so every `permission_request`
  // fires a Web Push to the user's paired phone. Null in tests and when VAPID
  // keys aren't configured — the rest of the manager must keep working.
  private pushSender: ManagerPushSender | null = null;

  constructor(private readonly deps: SessionManagerDeps) {}

  /**
   * Install (or clear, when `null`) the push sender. See the
   * `permission_request` branch in `handleEvent` for the one call site.
   */
  setPushSender(sender: ManagerPushSender | null): void {
    this.pushSender = sender;
  }

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
      logger: this.deps.logger,
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
          // Fire a web push so the user's phone lights up even when the
          // tab is backgrounded / the PWA is closed. Fire-and-forget —
          // any failure inside the sender is caught here so runtime is
          // never held up on a flaky push service.
          this.firePermissionPush(sessionId, event.toolName, event.input);
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

  /**
   * Fire-and-forget Web Push when a session starts awaiting user input.
   * Skips cleanly when no push sender is attached (tests, no VAPID config).
   *
   * Body text mirrors what the Permission card shows inline: tool name +
   * truncated primary argument (command / file_path / pattern / url) so the
   * user sees "what's claude trying to do" without opening the app. 60 chars
   * because iOS lock-screen notifications collapse at ~90 and we still want
   * the tool name legible at the front.
   */
  private firePermissionPush(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    const sender = this.pushSender;
    if (!sender) return;
    const session = this.deps.sessions.findById(sessionId);
    const title =
      session && session.title.trim().length > 0
        ? session.title
        : "Claude wants permission";
    const primary =
      pickPushSubject(input) ?? `${toolName}`;
    const body = `${toolName} · ${truncateForPush(primary, 60)}`;
    sender
      .sendToAll({
        title,
        body,
        data: { sessionId, url: `/session/${sessionId}` },
      })
      .catch((err) => {
        this.deps.logger?.warn?.(
          { err, sessionId, toolName },
          "firePermissionPush failed",
        );
      });
  }


  async sendUserMessage(
    sessionId: string,
    content: string,
    attachmentIds: string[] = [],
  ): Promise<void> {
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

    // Resolve attachments against this session only — cross-session ids get
    // silently dropped, which is the correct permission boundary. An id that
    // was already linked to a previous message also drops here because we
    // filter on `messageEventSeq === null`. The resulting rows are what the
    // UI chose to send *this* turn.
    const resolvedAttachments = this.resolveAttachments(
      sessionId,
      attachmentIds,
    );

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

    // Stamp the user_message payload with attachment metadata so the web
    // transcript can render the chips alongside the text. Keep it minimal:
    // the raw bytes are served by the /api/attachments/:id/raw endpoint.
    const payload: Record<string, unknown> = { text: content };
    if (resolvedAttachments.length > 0) {
      payload.attachments = resolvedAttachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mime: a.mime,
        size: a.sizeBytes,
      }));
    }
    const appended = this.deps.sessions.appendEvent({
      sessionId,
      kind: "user_message",
      payload,
    });
    this.deps.sessions.touchLastMessage(sessionId);

    // Link the attachments to the just-appended user_message seq so the UI
    // can no longer delete them and so cleanup knows they're owned. Batched
    // in a single transaction inside AttachmentStore.linkToMessage.
    if (resolvedAttachments.length > 0 && this.deps.attachments) {
      this.deps.attachments.linkToMessage(
        resolvedAttachments.map((a) => a.id),
        appended.seq,
      );
    }

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

    // Build the outgoing SDK prompt by prefixing `@<absolute-path>` tokens
    // so the SDK's Read tool picks the files up in-line — this is how the
    // `claude` CLI handles `@path` references, and the SDK inherits that
    // behavior. Using an absolute path under `~/.claudex/uploads/<session>/`
    // means the Read tool resolves them regardless of the session's cwd.
    // When the user's message is empty but attachments are present, we
    // still send the prefix so the model has something to reason about.
    const sdkPrompt =
      resolvedAttachments.length > 0
        ? resolvedAttachments
            .map((a) => `@${a.path}`)
            .join("\n") +
          (content.length > 0 ? `\n\n${content}` : "")
        : content;
    await runner.sendUserMessage(sdkPrompt);
  }

  /**
   * Re-trigger the SDK runner for a session whose most recent user_message
   * was edited in-place (by `POST /api/sessions/:id/edit-last-user-message`).
   * Unlike `sendUserMessage`, this does NOT append a new `user_message` event
   * — the edit path has already rewritten the existing row's payload, so
   * appending again would duplicate it in the transcript.
   *
   * Flips the session to `running`, broadcasts a `refresh_transcript` so
   * every subscribed tab refetches the now-truncated transcript, then pushes
   * the edited prompt into the SDK's async input queue so a fresh assistant
   * turn follows.
   *
   * Caveat (mirrored in docs/FEATURES.md): the SDK's own persisted history
   * under `~/.claude/projects/` still contains the pre-edit message and any
   * assistant reply. When the SDK formulates the next reply it will see both
   * the old exchange and the edited message. We ship it anyway — the web UX
   * win (typo recovery without resending) outweighs the CLI-side divergence.
   */
  async rerunFromEditedMessage(
    sessionId: string,
    editedText: string,
  ): Promise<void> {
    const runner = this.getOrCreate(sessionId);
    // Side-chat seed edge case: a brand-new side chat with a pending seed
    // can't have been edited (nothing to edit yet). Guard anyway — flushing
    // the seed first is cheap and preserves the one-time-seed invariant.
    const entry = this.runners.get(sessionId);
    if (entry?.pendingSeed) {
      const seed = entry.pendingSeed;
      entry.pendingSeed = null;
      await runner.sendUserMessage(seed);
    }
    this.deps.sessions.setStatus(sessionId, "running");
    this.deps.broadcast(sessionId, { type: "refresh_transcript" });
    await runner.sendUserMessage(editedText);
  }

  /**
   * Look up `ids` in the attachment store, keeping only rows whose session
   * matches and that are still unlinked. Empty + no-op when the store wasn't
   * wired (tests, legacy).
   */
  private resolveAttachments(sessionId: string, ids: string[]) {
    if (!this.deps.attachments || ids.length === 0) return [];
    return this.deps.attachments
      .findManyForSession(sessionId, ids)
      .filter((a) => a.messageEventSeq === null);
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

  /**
   * Broadcast a `refresh_transcript` signal to every WS subscriber for this
   * session. Used by out-of-band appenders (e.g. CLI JSONL resync) that
   * don't go through the live runner and therefore aren't on the runner
   * event bus. The web client reacts by refetching `/events?limit=200`.
   */
  notifyTranscriptRefresh(sessionId: string): void {
    this.deps.broadcast(sessionId, { type: "refresh_transcript" });
  }

  /**
   * Broadcast a `queue_update` frame to every authenticated tab via the
   * global WS channel. The queue runner and HTTP routes call this through
   * the QueueStore `onChange` hook; callers here pass the current timestamp
   * so clients can display "just now" in the Queue screen without an extra
   * round-trip. Not tied to any session — uses empty-string `sessionId`
   * because the frame is cross-session by design (see ws.ts
   * GLOBAL_FRAME_TYPES).
   */
  notifyQueueUpdate(): void {
    this.deps.broadcast("", {
      type: "queue_update",
      at: new Date().toISOString(),
    });
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
    // Audit: every permission decision is security-relevant — the user just
    // authorized (or refused) claude touching the host. userId is null
    // because decisions arrive over WS with no FastifyRequest in scope; the
    // audit column is nullable for exactly this reason.
    this.deps.audit?.append({
      userId: null,
      event: decision === "deny" ? "permission_denied" : "permission_granted",
      target: sessionId,
      detail: `${pending?.toolName ?? "tool"} ${decision}`,
    });
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

  /**
   * Tear down the live runner (if any) for a single session. Used by the
   * DELETE route before dropping the session row so we don't keep a dangling
   * SDK process around writing events for a session that no longer exists.
   * No-op when no runner is attached.
   */
  async dispose(sessionId: string): Promise<void> {
    const entry = this.runners.get(sessionId);
    if (!entry) return;
    this.runners.delete(sessionId);
    entry.off();
    try {
      await entry.runner.dispose();
    } catch {
      // Best-effort: if the runner already exited we don't want the route
      // to fail on a secondary cleanup error.
    }
  }
}
