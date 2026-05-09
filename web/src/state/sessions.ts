import { create } from "zustand";
import { api } from "@/api/client";
import { createWsClient, type WsClient, type WsDiagnostics } from "@/api/ws";
import { toast } from "@/lib/toast";
import { flashTitle } from "@/lib/title-flash";
import type {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  ClientFrame,
  Session,
  SessionEvent,
  ServerFrame,
  SessionStatus,
} from "@claudex/shared";

// ---------------------------------------------------------------------------
// Session-completion notifier (client-only, dedup'd per session).
//
// When a session transitions to a terminal-ish status (`idle` — Claude's
// turn ended — or `error` — terminal failure) we surface a toast + a
// document.title flash so the user knows to look. Web Push isn't an
// option on claudex because the user runs HTTP through frpc, so this is
// our in-app fallback.
//
// Dedup is by sessionId → lastNotifiedStatus. We only fire when the
// observed status actually differs from the last one we notified on
// (or there is no prior entry). The map is seeded from the REST
// /sessions payload on first load so nothing fires retroactively for
// sessions that were already idle when the app booted.
//
// Lives at module scope (not in the zustand store) because it's pure
// side-effect bookkeeping — no component needs to render off of it and
// keeping it out of state avoids spurious re-renders.
// ---------------------------------------------------------------------------
const notifiedStatus = new Map<string, SessionStatus>();

function shouldNotifyCompletion(
  prev: SessionStatus | undefined,
  next: SessionStatus,
): boolean {
  // Only `idle` (turn ended) and `error` (terminal failure) count as
  // "session finished" for the user-facing alert. `archived` is a user
  // action, `awaiting` is already surfaced on the Alerts screen, and
  // `running` is a start-of-turn transition.
  if (next !== "idle" && next !== "error") return false;
  if (prev === next) return false;
  // `cli_running` is a purely external-process observation; when it flips
  // back to idle the user's SDK-side turn was already over before it ever
  // entered cli_running, so treating the demotion as a "session finished"
  // would spam the user every time their external `claude` CLI exits.
  if (prev === "cli_running") return false;
  return true;
}

// Cap the completion map so a long-running client doesn't accumulate
// unbounded entries. When we overflow the cap we prefer to evict a
// `seen: true` row (the user has already acked it) by oldest `at`; if
// nothing is seen we fall back to evicting the globally oldest entry.
// One pass. Called from both the session_update handler and any future
// writer — kept small enough to inline but pulled out so the policy is
// in one place.
const COMPLETIONS_CAP = 50;
function capCompletions(
  map: Record<string, { status: "idle" | "error"; at: string; seen: boolean }>,
): Record<string, { status: "idle" | "error"; at: string; seen: boolean }> {
  const keys = Object.keys(map);
  if (keys.length <= COMPLETIONS_CAP) return map;
  let victim: string | null = null;
  let victimAt = Infinity;
  // Prefer oldest seen.
  for (const k of keys) {
    const v = map[k];
    if (!v.seen) continue;
    const t = Date.parse(v.at) || 0;
    if (t < victimAt) {
      victimAt = t;
      victim = k;
    }
  }
  // Fall back to oldest overall if no seen entry exists.
  if (!victim) {
    victimAt = Infinity;
    for (const k of keys) {
      const t = Date.parse(map[k].at) || 0;
      if (t < victimAt) {
        victimAt = t;
        victim = k;
      }
    }
  }
  if (!victim) return map;
  const { [victim]: _drop, ...rest } = map;
  void _drop;
  return rest;
}

// A streamed turn is rendered as a list of UI "pieces": text, tool_use,
// tool_result, thinking. We build these up from both persisted events (on
// load) and live WS frames.

export type UIPiece =
  | {
      kind: "user";
      id: string;
      text: string;
      at: string;
      // ISO timestamp of the persisted event. Mirrors `at` on user
      // pieces for consistency with other piece kinds, all of which
      // carry `createdAt` so the Chat + rails can render timestamps
      // uniformly without caring which kind of piece is in hand.
      createdAt?: string;
      // Persisted event seq when this piece came off the server. Undefined
      // for optimistic echoes that haven't been acked yet. Used by
      // MessageActions to build permalinks (`#seq-<n>`).
      seq?: number;
      // True once we've matched this piece against a server-broadcast
      // `user_message` frame (or it came straight from the server in the
      // first place). Used by the multi-tab de-dupe rule — a tab's locally
      // echoed user piece is `serverAcked=false` until its own ws receives
      // the matching broadcast, at which point we flip the flag rather
      // than push a second copy.
      serverAcked?: boolean;
      // Opaque nonce generated per-send. Stamped onto the optimistic piece
      // AND the outgoing WS `user_message` frame, and relayed back on the
      // server's echoed broadcast. The reconciliation handler matches on
      // echoId first (stable, collision-free) and only falls back to the
      // legacy text+3s heuristic for echoes that don't carry one (e.g.
      // messages sent by another tab / legacy client).
      echoId?: string;
      // Shallow list of attachment metadata from the original user_message
      // payload. Populated from persisted events only — optimistic echoes
      // skip it. Drives the "edit disabled because attachments" hint in
      // the Chat bubble; payload stays authoritative server-side.
      attachments?: Array<{
        id: string;
        filename: string;
        mime: string;
        size: number;
      }>;
    }
  | { kind: "assistant_text"; id: string; text: string; seq?: number; createdAt?: string }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      seq?: number;
      createdAt?: string;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
      seq?: number;
      createdAt?: string;
    }
  | { kind: "thinking"; text: string; seq?: number; createdAt?: string }
  | {
      kind: "permission_request";
      approvalId: string;
      toolName: string;
      input: Record<string, unknown>;
      summary: string;
      seq?: number;
      createdAt?: string;
    }
  // SDK's AskUserQuestion tool — rendered as an in-transcript multiple-choice
  // card. Distinct from permission_request because it's an interaction, not a
  // security gate. `answers` is set once the user submits; until then the
  // card is pending. `answerSeq` tracks the seq of the sibling
  // `ask_user_answer` event so we can dedupe on refetch.
  | {
      kind: "ask_user_question";
      askId: string;
      questions: AskUserQuestionItem[];
      seq?: number;
      createdAt?: string;
      answers?: Record<string, string>;
      annotations?: Record<string, AskUserQuestionAnnotation>;
      answerSeq?: number;
    }
  // SDK's ExitPlanMode tool — rendered as a dedicated "commit to this plan?"
  // card. Like ask_user_question, it's not a security gate; accept lets the
  // model proceed, reject sends it back for revisions. `decision` is set
  // once the user has clicked one of the buttons (or on refetch from a
  // persisted `plan_accept_decision` sibling event), at which point the card
  // renders read-only with an accepted / rejected pill.
  | {
      kind: "plan_accept_request";
      planId: string;
      plan: string;
      seq?: number;
      createdAt?: string;
      decision?: "accept" | "reject";
      decisionSeq?: number;
    }
  // `pending` is a UI-only piece (never persisted, never comes off the wire).
  // Inserted right after a user_message echo to give the user immediate
  // feedback that claude is processing. Removed as soon as any substantive
  // runner event lands (assistant_text, thinking, tool_use, tool_result,
  // permission_request, turn_end, error). If nothing arrives within ~30s the
  // piece flips into a "stalled" red state but stays on screen so the user
  // knows something's off without blocking further input.
  //
  // NB: we explicitly do NOT try to synthesize partial assistant text here.
  // The Agent SDK doesn't surface content_block_delta — the first thing the
  // UI sees for a reply is the *whole* message after message_stop. See
  // memory/project_streaming_deferred.md.
  | { kind: "pending"; id: string; startedAt: number; stalled: boolean };

// Transcript view mode — controls how much detail the Chat screen shows.
// Mirrors mockup s-07:
//   - normal  (default): user, assistant text, tool_use chips/diffs,
//                        tool_result. Thinking blocks hidden.
//   - verbose : everything, including thinking.
//   - summary : only user messages + the *final* assistant_text of each
//                assistant turn, plus a Changes card synthesized from
//                Edit/Write/MultiEdit tool calls.
export type ViewMode = "normal" | "verbose" | "summary";

/**
 * Per-session pagination bookkeeping for the transcript. Kept in a parallel
 * map so the main `transcripts[id]` UIPiece array stays the same shape.
 *
 *   - `hasMore`: true when there are older events on the server we haven't
 *     loaded yet. Drives the "Loading older messages…" trigger at the top
 *     of the scroller.
 *   - `lowestSeq`: the smallest `seq` in the loaded tail; used as the
 *     `beforeSeq` when requesting the next older page.
 *   - `loadingOlder`: re-entrancy guard so a fast scrollTop doesn't fire
 *     multiple overlapping requests.
 *   - `initialLoading`: true between `ensureTranscript` start and the
 *     first `/events?limit=200` resolving. The Chat screen shows a
 *     skeleton while this is true, instead of a blank canvas.
 */
export interface TranscriptMeta {
  hasMore: boolean;
  lowestSeq: number | null;
  loadingOlder: boolean;
  initialLoading: boolean;
}

interface SessionState {
  ws: WsClient | null;
  connected: boolean;
  wsDiag: WsDiagnostics;
  sessions: Session[];
  // sessionId → pieces in order
  transcripts: Record<string, UIPiece[]>;
  transcriptMeta: Record<string, TranscriptMeta>;
  loadingSessions: boolean;
  // Per-session "recently completed" marker. A session lands here when a
  // live WS `session_update` flips it into `idle` or `error` — i.e. the
  // turn just finished or blew up. Once the user opens the session we
  // flip `seen: true` (not delete) so the entry stays visible on the
  // Alerts screen as an archival row the user can still click back
  // into. One entry per session; re-completing resets seen=false.
  completions: Record<
    string,
    { status: "idle" | "error"; at: string; seen: boolean }
  >;
  // Current transcript view mode — session-scoped in spirit but not yet
  // persisted per-session or to localStorage (intentional for first pass).
  viewMode: ViewMode;
  // The session the user is currently looking at (Chat screen). Set by
  // `subscribeSession` (called from Chat.tsx on mount) and cleared by
  // `clearActiveSession` (called on unmount). Used by the WS `acked`
  // handler so, on reconnect, we can re-`subscribe` to the active
  // session AND pull any events that landed during the downtime via
  // `refetchTail`. Nullable — screens that don't own a single session
  // (Home, Settings) leave it null.
  activeSessionId: string | null;
  init: () => void;
  refreshSessions: () => Promise<void>;
  ensureTranscript: (sessionId: string) => Promise<void>;
  loadOlderTranscript: (sessionId: string) => Promise<void>;
  refetchTail: (sessionId: string) => Promise<void>;
  subscribeSession: (sessionId: string) => void;
  clearActiveSession: (sessionId: string) => void;
  sendUserMessage: (
    sessionId: string,
    text: string,
    attachmentIds?: string[],
  ) => void;
  interruptSession: (sessionId: string) => void;
  ensurePendingFor: (sessionId: string) => void;
  resolvePermission: (
    sessionId: string,
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
  resolveAskUserQuestion: (
    sessionId: string,
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ) => void;
  resolvePlanAccept: (
    sessionId: string,
    planId: string,
    decision: "accept" | "reject",
  ) => void;
  setViewMode: (mode: ViewMode) => void;
  forgetSession: (id: string) => void;
}

function eventToPiece(ev: SessionEvent): UIPiece | null {
  const p = ev.payload as Record<string, any>;
  switch (ev.kind) {
    case "user_message":
      return {
        kind: "user",
        id: ev.id,
        text: String(p.text ?? ""),
        at: ev.createdAt,
        createdAt: ev.createdAt,
        seq: ev.seq,
        serverAcked: true,
        // Pass attachments straight through from the persisted payload.
        // Undefined when the message was plain text (the common case).
        attachments: Array.isArray(p.attachments)
          ? (p.attachments as Array<{
              id: string;
              filename: string;
              mime: string;
              size: number;
            }>)
          : undefined,
      };
    case "assistant_text":
      return {
        kind: "assistant_text",
        id: String(p.messageId ?? ev.id),
        text: String(p.text ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "assistant_thinking":
      return { kind: "thinking", text: String(p.text ?? ""), seq: ev.seq, createdAt: ev.createdAt };
    case "tool_use":
      return {
        kind: "tool_use",
        id: String(p.toolUseId ?? ev.id),
        name: String(p.name ?? "unknown"),
        input: (p.input as Record<string, unknown>) ?? {},
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: String(p.toolUseId ?? ""),
        content: String(p.content ?? ""),
        isError: Boolean(p.isError),
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "permission_request":
      return {
        kind: "permission_request",
        approvalId: String(p.toolUseId ?? ""),
        toolName: String(p.toolName ?? ""),
        input: (p.input as Record<string, unknown>) ?? {},
        summary: String(p.title ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "ask_user_question":
      return {
        kind: "ask_user_question",
        askId: String(p.askId ?? ""),
        questions: Array.isArray(p.questions)
          ? (p.questions as AskUserQuestionItem[])
          : [],
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "ask_user_answer":
      // Answers land as a sibling event; we don't render them as a
      // standalone piece. The reducer (see `eventsToPieces` below)
      // folds them into the matching `ask_user_question` piece. Return null
      // here so the default piece builder skips it.
      return null;
    case "plan_accept_request":
      return {
        kind: "plan_accept_request",
        planId: String(p.planId ?? ""),
        plan: String(p.plan ?? ""),
        seq: ev.seq,
        createdAt: ev.createdAt,
      };
    case "plan_accept_decision":
      // Decisions land as a sibling event; the reducer folds them into the
      // matching plan_accept_request piece. Skip in the default builder.
      return null;
    default:
      return null;
  }
}

function frameToPiece(frame: ServerFrame): UIPiece | null {
  switch (frame.type) {
    case "assistant_text_delta":
      return {
        kind: "assistant_text",
        id: frame.messageId,
        text: frame.text,
      };
    case "thinking":
      return { kind: "thinking", text: frame.text };
    case "tool_use":
      return {
        kind: "tool_use",
        id: frame.toolUseId,
        name: frame.name,
        input: frame.input,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: frame.toolUseId,
        content: frame.content,
        isError: frame.isError,
      };
    case "permission_request":
      return {
        kind: "permission_request",
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        input: frame.toolInput,
        summary: frame.summary,
      };
    case "ask_user_question":
      return {
        kind: "ask_user_question",
        askId: frame.askId,
        questions: frame.questions,
      };
    case "plan_accept_request":
      return {
        kind: "plan_accept_request",
        planId: frame.planId,
        plan: frame.plan,
      };
    default:
      return null;
  }
}

/**
 * Build UIPieces from a list of persisted SessionEvents, folding any
 * `ask_user_answer` events into the matching `ask_user_question` piece so the
 * card renders in its resolved (read-only) state after refetch.
 */
function eventsToPieces(events: SessionEvent[]): UIPiece[] {
  const pieces: UIPiece[] = [];
  // Map askId → index into `pieces` for fast answer-fold.
  const askIdx = new Map<string, number>();
  // Map planId → index into `pieces` for fast decision-fold.
  const planIdx = new Map<string, number>();
  // Collect toolUseIds for any `permission_decision` event so we can drop
  // the matching `permission_request` piece — once decided, the card
  // disappears (live behavior via resolvePermission). Mirrors
  // server/src/sessions/diffs.ts::aggregatePendingDiffs.
  const decidedApprovalIds = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "permission_decision") {
      const p = ev.payload as Record<string, any>;
      const id = String(p.toolUseId ?? p.approvalId ?? "");
      if (id) decidedApprovalIds.add(id);
    }
  }
  for (const ev of events) {
    if (ev.kind === "ask_user_answer") {
      const p = ev.payload as Record<string, any>;
      const askId = String(p.askId ?? "");
      const idx = askIdx.get(askId);
      if (idx !== undefined) {
        const existing = pieces[idx];
        if (existing.kind === "ask_user_question") {
          pieces[idx] = {
            ...existing,
            answers: (p.answers as Record<string, string>) ?? {},
            annotations:
              (p.annotations as Record<string, AskUserQuestionAnnotation>) ??
              undefined,
            answerSeq: ev.seq,
          };
        }
      }
      continue;
    }
    if (ev.kind === "plan_accept_decision") {
      const p = ev.payload as Record<string, any>;
      const planId = String(p.planId ?? "");
      const idx = planIdx.get(planId);
      if (idx !== undefined) {
        const existing = pieces[idx];
        if (existing.kind === "plan_accept_request") {
          const decision =
            p.decision === "accept" || p.decision === "reject"
              ? (p.decision as "accept" | "reject")
              : undefined;
          pieces[idx] = {
            ...existing,
            decision,
            decisionSeq: ev.seq,
          };
        }
      }
      continue;
    }
    const piece = eventToPiece(ev);
    if (!piece) continue;
    // Drop persisted permission_request pieces that already have a decision
    // recorded. Matches live behavior where the card disappears on decide.
    if (
      piece.kind === "permission_request" &&
      decidedApprovalIds.has(piece.approvalId)
    ) {
      continue;
    }
    if (piece.kind === "ask_user_question") {
      askIdx.set(piece.askId, pieces.length);
    } else if (piece.kind === "plan_accept_request") {
      planIdx.set(piece.planId, pieces.length);
    }
    pieces.push(piece);
  }
  return pieces;
}

export const useSessions = create<SessionState>((set, get) => {
  // Per-session "stall watchdog" timers. The *first* substantive WS frame
  // clears the timer; if nothing arrives in STALL_MS we flip the pending
  // piece to `stalled: true` (renders red) but we DON'T remove it — the
  // user still needs to know claude never replied so they can retry / stop.
  const STALL_MS = 30_000;
  const stallTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearStallTimer(sessionId: string) {
    const t = stallTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      stallTimers.delete(sessionId);
    }
  }

  function armStallTimer(sessionId: string, pendingId: string) {
    clearStallTimer(sessionId);
    const t = setTimeout(() => {
      stallTimers.delete(sessionId);
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionId]: (s.transcripts[sessionId] ?? []).map((p) =>
            p.kind === "pending" && p.id === pendingId
              ? { ...p, stalled: true }
              : p,
          ),
        },
      }));
    }, STALL_MS);
    stallTimers.set(sessionId, t);
  }

  // Remove the *first* pending piece for a session. Called when a meaningful
  // runner frame arrives — thinking / assistant_text / tool_use / tool_result /
  // permission_request / turn_end / error — meaning claude has started
  // producing output (or hit a terminal state) and the placeholder has done
  // its job.
  function dropFirstPending(sessionId: string) {
    clearStallTimer(sessionId);
    set((s) => {
      const list = s.transcripts[sessionId];
      if (!list) return s;
      const idx = list.findIndex((p) => p.kind === "pending");
      if (idx === -1) return s;
      return {
        transcripts: {
          ...s.transcripts,
          [sessionId]: [...list.slice(0, idx), ...list.slice(idx + 1)],
        },
      };
    });
  }

  return {
  ws: null,
  connected: false,
  wsDiag: { phase: "connecting", attempts: 0 },
  sessions: [],
  transcripts: {},
  transcriptMeta: {},
  loadingSessions: false,
  viewMode: "normal",
  activeSessionId: null,
  completions: {},

  setViewMode(mode) {
    set({ viewMode: mode });
  },

  init() {
    if (get().ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const client = createWsClient(url);
    client.onState((diag) => {
      set({ wsDiag: diag, connected: diag.phase === "acked" });
    });
    // Recovery hook: every time the socket reaches `acked` (initial connect
    // AND every reconnect), re-subscribe the active session and refetch its
    // event tail. This is how we recover frames dropped while the socket
    // was down — the server paginates `/events` cheaply, so pulling the
    // last 200 on every ack is fine. Testing deterministically would need
    // vi fake timers + a mock socket; skipped intentionally.
    client.onAcked(() => {
      const sid = get().activeSessionId;
      if (!sid) return;
      // Resubscribe first so any frames arriving mid-refetch still land in
      // the store; refetchTail's merge handles the overlap.
      client.send({ type: "subscribe", sessionId: sid } satisfies ClientFrame);
      void get().refetchTail(sid);
    });
    client.subscribe((frame) => {
      // Connection liveness tracked via hello_ack
      if (frame.type === "hello_ack") set({ connected: true });
      if (frame.type === "session_update") {
        const sid = frame.sessionId;
        // Snapshot pre-transition state so we can decide whether to fire a
        // completion toast. We deliberately look at the session BEFORE
        // applying the new status; the dedup map uses "last notified" as
        // its key, but the session row's own previous status is what tells
        // us whether this frame represents a real transition.
        const prevSession = get().sessions.find((x) => x.id === sid);
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === sid ? { ...x, status: frame.status } : x,
          ),
        }));
        // When a session drops back to idle/error without having produced any
        // assistant output (e.g. user interrupted immediately), still clear
        // the placeholder so it doesn't linger.
        if (
          frame.status === "idle" ||
          frame.status === "error" ||
          frame.status === "archived"
        ) {
          dropFirstPending(sid);
        }
        // Session-completion alert. Only fire on real transitions into
        // `idle` / `error`, skip child (side-chat) sessions so Task-spawned
        // subagents don't spam the parent's completion signal, and dedup
        // per-session via the module-level `notifiedStatus` map so a repeat
        // `session_update` frame for the same status doesn't re-fire.
        const lastNotified = notifiedStatus.get(sid);
        if (
          prevSession &&
          !prevSession.parentSessionId &&
          shouldNotifyCompletion(lastNotified, frame.status)
        ) {
          notifiedStatus.set(sid, frame.status);
          const title = prevSession.title || "Session";
          const msg =
            frame.status === "error"
              ? `${title} — session error`
              : `${title} — session finished`;
          toast(msg);
          flashTitle();
          // Also surface this on the Alerts screen as a "recently
          // completed" entry. One slot per session; re-completing
          // overwrites. Cleared when the user opens that session via
          // subscribeSession, so the surface acts like "unread" signals.
          // `shouldNotifyCompletion` above already narrowed the status,
          // but TS can't carry that through the closure — re-narrow here.
          const completionStatus: "idle" | "error" =
            frame.status === "error" ? "error" : "idle";
          set((s) => {
            const activeId = s.activeSessionId;
            // If the user is currently looking at this session, don't
            // even add the completion — they've already seen it.
            if (activeId === sid) return s;
            const nextEntry = {
              status: completionStatus,
              at: new Date().toISOString(),
              // New completions always start unseen — even if a previous
              // completion for this session was already marked seen, a
              // re-completion should bubble the row back up.
              seen: false,
            };
            const merged = { ...s.completions, [sid]: nextEntry };
            // Cap total completions at 50 per client so the map doesn't grow
            // forever. Drop the oldest `seen: true` entry first; if none are
            // seen, drop the oldest overall.
            return { completions: capCompletions(merged) };
          });
        } else {
          // Always keep the dedup map in sync with the current status so
          // re-transitions (idle → running → idle) fire exactly once per
          // completion edge.
          notifiedStatus.set(sid, frame.status);
        }
      }
      // Multi-tab: a user_message broadcast can land in any subscribed tab —
      // including the one that sent it. De-dupe rule (in order):
      //   1. If the broadcast carries an `echoId`, try to find a local user
      //      piece with the same `echoId` in this session — that's the
      //      originating tab's own optimistic echo. Upgrade it to
      //      `serverAcked=true` and stamp the authoritative `createdAt`.
      //   2. Otherwise fall back to the legacy heuristic — match on content
      //      and a 3s timestamp window. This covers broadcasts from OTHER
      //      tabs (which carry an echoId this tab didn't generate, so the
      //      nonce match misses) and legacy clients that didn't stamp one
      //      at all — those are simply inserted as fresh pieces.
      //   3. Insert a fresh piece otherwise.
      if (frame.type === "user_message") {
        const sid = frame.sessionId;
        const ts = Date.parse(frame.createdAt) || Date.now();
        const frameEchoId = frame.echoId;
        set((s) => {
          const list = s.transcripts[sid] ?? [];
          let matchIdx = -1;
          // 1. Stable echoId match — only if the frame and a local piece
          //    both carry the same nonce. Other tabs have no such piece,
          //    so this deliberately fails for their broadcasts.
          if (frameEchoId) {
            for (let i = list.length - 1; i >= 0; i--) {
              const piece = list[i];
              if (piece.kind !== "user") continue;
              if (piece.echoId && piece.echoId === frameEchoId) {
                matchIdx = i;
                break;
              }
            }
          }
          // 2. Legacy text+3s heuristic — only consulted when the echoId
          //    match failed. Handles broadcasts from legacy clients.
          if (matchIdx === -1) {
            for (let i = list.length - 1; i >= 0; i--) {
              const piece = list[i];
              if (piece.kind !== "user") continue;
              if (piece.text !== frame.content) continue;
              // Skip pieces that already carry a different echoId — they
              // belong to a distinct local send, not this broadcast.
              if (piece.echoId && piece.echoId !== frameEchoId) continue;
              if (piece.serverAcked) {
                matchIdx = i;
                break;
              }
              const pTs = Date.parse(piece.at) || 0;
              if (Math.abs(ts - pTs) <= 3000) {
                matchIdx = i;
                break;
              }
            }
          }
          if (matchIdx !== -1) {
            const existing = list[matchIdx];
            if (existing.kind === "user" && existing.serverAcked) {
              return s; // already acked, nothing to do
            }
            const next = [...list];
            next[matchIdx] = {
              ...(existing as UIPiece & { kind: "user" }),
              at: frame.createdAt,
              createdAt: frame.createdAt,
              serverAcked: true,
            };
            return { transcripts: { ...s.transcripts, [sid]: next } };
          }
          // No local echo to reconcile — a *different* tab sent this. Insert
          // before any trailing `pending` placeholder so the UI keeps its
          // "claude is thinking" bubble at the very bottom.
          const piece: UIPiece = {
            kind: "user",
            id: `remote-${ts}`,
            text: frame.content,
            at: frame.createdAt,
            createdAt: frame.createdAt,
            serverAcked: true,
          };
          const tailIsPending =
            list.length > 0 && list[list.length - 1].kind === "pending";
          const next = tailIsPending
            ? [...list.slice(0, -1), piece, list[list.length - 1]]
            : [...list, piece];
          return { transcripts: { ...s.transcripts, [sid]: next } };
        });
        return;
      }
      // Server appended events out-of-band (CLI resync). Refetch the tail
      // so the transcript reflects whatever the CLI added. Only act on the
      // currently-cached session to avoid surprise fetches for sessions the
      // user isn't looking at.
      //
      // We also fan this out as a window event so screens that aggregate
      // across sessions (e.g. the Subagent monitor at /agents) can refresh
      // themselves without caring which session changed.
      if (frame.type === "refresh_transcript") {
        const sid = frame.sessionId;
        if (get().transcripts[sid]) {
          void get().refetchTail(sid);
        }
        try {
          window.dispatchEvent(
            new CustomEvent("claudex:refresh_transcript", {
              detail: { sessionId: sid },
            }),
          );
        } catch {
          // SSR / no-window: ignore.
        }
        return;
      }
      // Queue table changed somewhere on the server — forward to any
      // screen that cares via a plain window event. We don't keep queue
      // state in this store (it's screen-local to QueueScreen), so a
      // custom event is the lightest-weight bridge. Replaces the 5s
      // poll in Queue.tsx.
      if (frame.type === "queue_update") {
        try {
          window.dispatchEvent(new CustomEvent("claudex:queue_update"));
        } catch {
          // SSR / no-window: ignore.
        }
        return;
      }
      // Any substantive reply frame means the pending placeholder did its job.
      if (
        frame.type === "assistant_text_delta" ||
        frame.type === "thinking" ||
        frame.type === "tool_use" ||
        frame.type === "tool_result" ||
        frame.type === "permission_request" ||
        frame.type === "ask_user_question" ||
        frame.type === "plan_accept_request" ||
        frame.type === "turn_end"
      ) {
        // Every variant above carries a non-null `sessionId` per protocol.ts —
        // narrowing via the discriminated union means no cast is needed.
        dropFirstPending(frame.sessionId);
      } else if (frame.type === "error") {
        // `error` uniquely carries `sessionId: string | null` — a null means
        // the failure wasn't session-scoped (e.g. a handshake-level rejection)
        // and we must skip session-routed effects entirely.
        if (frame.sessionId) dropFirstPending(frame.sessionId);
      }
      const piece = frameToPiece(frame);
      if (piece) {
        // `frameToPiece` only returns non-null for frame types that carry a
        // required string `sessionId` (assistant_text_delta, thinking,
        // tool_use, tool_result, permission_request, ask_user_question).
        // None of those allow a null sessionId, so a discriminant check
        // picks the correct narrowing without a cast.
        if (
          frame.type !== "assistant_text_delta" &&
          frame.type !== "thinking" &&
          frame.type !== "tool_use" &&
          frame.type !== "tool_result" &&
          frame.type !== "permission_request" &&
          frame.type !== "ask_user_question" &&
          frame.type !== "plan_accept_request"
        ) {
          return;
        }
        const sid = frame.sessionId;
        set((s) => ({
          transcripts: {
            ...s.transcripts,
            [sid]: [...(s.transcripts[sid] ?? []), piece],
          },
        }));
      }
    });
    set({ ws: client });
  },

  async refreshSessions() {
    set({ loadingSessions: true });
    try {
      const res = await api.listSessions();
      // Seed the completion-notify dedup map so that sessions already in a
      // terminal state when the app boots (or when Home re-fetches) don't
      // retroactively fire a toast. We only want notifications for live
      // transitions observed over the WS after this point.
      for (const s of res.sessions) {
        if (!notifiedStatus.has(s.id)) {
          notifiedStatus.set(s.id, s.status);
        }
      }
      set({ sessions: res.sessions });
    } finally {
      set({ loadingSessions: false });
    }
  },

  async ensureTranscript(sessionId) {
    if (get().transcripts[sessionId]) return;
    // Flag the session as "initial loading" so Chat can render a skeleton
    // instead of a blank canvas while the first 200 events resolve. We set
    // this synchronously so the first render already knows.
    set((s) => ({
      transcriptMeta: {
        ...s.transcriptMeta,
        [sessionId]: {
          hasMore: false,
          lowestSeq: null,
          loadingOlder: false,
          initialLoading: true,
        },
      },
    }));
    try {
      const res = await api.listEvents(sessionId, { limit: 200 });
      const pieces = eventsToPieces(res.events);
      set((s) => ({
        transcripts: { ...s.transcripts, [sessionId]: pieces },
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: {
            hasMore: res.hasMore,
            lowestSeq: res.events.length > 0 ? res.events[0].seq : null,
            loadingOlder: false,
            initialLoading: false,
          },
        },
      }));
    } catch (err) {
      // Leave transcripts[id] empty so a retry (e.g. on nav back) fires a
      // fresh ensureTranscript. Clear the loading flag so the skeleton
      // doesn't stick.
      set((s) => ({
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: {
            ...(s.transcriptMeta[sessionId] ?? {
              hasMore: false,
              lowestSeq: null,
              loadingOlder: false,
              initialLoading: false,
            }),
            initialLoading: false,
          },
        },
      }));
      throw err;
    }
  },

  async loadOlderTranscript(sessionId) {
    const meta = get().transcriptMeta[sessionId];
    if (!meta || !meta.hasMore || meta.loadingOlder) return;
    const lowest = meta.lowestSeq;
    if (lowest === null) return;
    set((s) => ({
      transcriptMeta: {
        ...s.transcriptMeta,
        [sessionId]: { ...meta, loadingOlder: true },
      },
    }));
    try {
      const res = await api.listEvents(sessionId, {
        beforeSeq: lowest,
        limit: 200,
      });
      const older = eventsToPieces(res.events);
      set((s) => ({
        transcripts: {
          ...s.transcripts,
          [sessionId]: [...older, ...(s.transcripts[sessionId] ?? [])],
        },
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: {
            hasMore: res.hasMore,
            lowestSeq:
              res.events.length > 0 ? res.events[0].seq : lowest,
            loadingOlder: false,
            initialLoading: false,
          },
        },
      }));
    } catch {
      set((s) => ({
        transcriptMeta: {
          ...s.transcriptMeta,
          [sessionId]: { ...meta, loadingOlder: false },
        },
      }));
    }
  },

  async refetchTail(sessionId) {
    // Server appended events out-of-band (CLI resync). Re-fetch the last 200
    // and merge with what we already have. Any lazily-loaded older pages
    // stay intact — we only touch the tail.
    try {
      const res = await api.listEvents(sessionId, { limit: 200 });
      const freshTail = eventsToPieces(res.events);
      const oldestInTail =
        res.events.length > 0 ? res.events[0].seq : null;
      set((s) => {
        const existing = s.transcripts[sessionId] ?? [];
        // Keep any loaded pieces from BEFORE the refetched tail window —
        // we determine that by matching piece-level identity from
        // `eventToPiece`, but we don't store `seq` on UIPiece. Fallback:
        // if there's nothing older loaded locally than the tail's oldest
        // seq, just replace the whole transcript. Otherwise, keep the
        // leading slice and replace the trailing portion.
        // Heuristic: existing length > freshTail length and tail hasMore
        // was false for "first page" → the existing array has a prefix of
        // older-loaded pages we want to keep. We append freshTail after
        // the prefix (approximated as everything up to existing.length -
        // freshTail.length).
        const prefixLen = Math.max(0, existing.length - freshTail.length);
        const merged = [...existing.slice(0, prefixLen), ...freshTail];
        const prevMeta = s.transcriptMeta[sessionId];
        return {
          transcripts: { ...s.transcripts, [sessionId]: merged },
          transcriptMeta: {
            ...s.transcriptMeta,
            [sessionId]: {
              hasMore: prevMeta?.hasMore ?? res.hasMore,
              lowestSeq: prevMeta?.lowestSeq ?? oldestInTail,
              loadingOlder: false,
              initialLoading: false,
            },
          },
        };
      });
    } catch {
      /* ignore — a live WS event will catch us up eventually */
    }
  },

  subscribeSession(sessionId) {
    // Chat.tsx calls this on mount. Treat it as a declaration of "this is the
    // session the user is looking at" — so on WS reconnect we can resubscribe
    // and refetch its tail automatically. If the user navigates from one
    // chat to another, the newer subscribe wins. `clearActiveSession` resets
    // to null on Chat unmount.
    set((s) => {
      // Demote any "recently completed" marker for this session from unseen
      // to seen — the user is now looking at it, so the Alerts screen should
      // show it as an archival row (muted) instead of a pending signal. We
      // deliberately do NOT delete the entry so the user can still see the
      // history of completed turns. If the entry is already seen, leave it
      // alone so re-navigating doesn't re-stamp it.
      const entry = s.completions[sessionId];
      if (!entry) return { activeSessionId: sessionId };
      if (entry.seen) return { activeSessionId: sessionId };
      return {
        activeSessionId: sessionId,
        completions: {
          ...s.completions,
          [sessionId]: { ...entry, seen: true },
        },
      };
    });
    get().ws?.send({ type: "subscribe", sessionId } satisfies ClientFrame);
  },

  clearActiveSession(sessionId) {
    // Only clear if we still think this session is active — guards against a
    // stale unmount racing a fast nav (A mount → B mount → A unmount) from
    // wiping B's activeSessionId.
    if (get().activeSessionId === sessionId) {
      set({ activeSessionId: null });
    }
  },

  sendUserMessage(sessionId, text, attachmentIds) {
    const pendingId = `pending-${Date.now()}`;
    // Per-send nonce for stable de-dupe against the server's echoed
    // `user_message` broadcast. `crypto.randomUUID` is only available in
    // secure contexts (HTTPS/localhost) — over plain HTTP through frp it's
    // undefined, so fall back to a time+random composite that's unique
    // enough for broadcast matching.
    const echoId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
    // Optimistic local echo + a pending placeholder so the user sees that
    // claude received the message and is thinking. We intentionally do NOT
    // wait for the first WS frame before showing this — the goal is to fill
    // the "what's happening?" gap between send and first assistant chunk.
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "user",
            id: `local-${Date.now()}`,
            text,
            at: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            serverAcked: false,
            echoId,
          },
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
    get().ws?.send({
      type: "user_message",
      sessionId,
      content: text,
      echoId,
      ...(attachmentIds && attachmentIds.length > 0
        ? { attachmentIds }
        : {}),
    } satisfies ClientFrame);
  },

  interruptSession(sessionId) {
    get().ws?.send({ type: "interrupt", sessionId } satisfies ClientFrame);
  },

  ensurePendingFor(sessionId) {
    const list = get().transcripts[sessionId] ?? [];
    // If there's already a pending piece at the tail, don't duplicate.
    if (list.length > 0 && list[list.length - 1].kind === "pending") return;
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    // No stall timer here — the session was already running before we
    // arrived, so we can't usefully claim "30s since user typed". We'll
    // clear this piece naturally when the next WS frame shows up.
  },

  resolvePermission(sessionId, approvalId, decision) {
    // Clear the pending card locally
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: (s.transcripts[sessionId] ?? []).filter(
          (p) =>
            !(
              p.kind === "permission_request" && p.approvalId === approvalId
            ),
        ),
      },
    }));
    get().ws?.send({
      type: "permission_decision",
      sessionId,
      approvalId,
      decision,
    } satisfies ClientFrame);
    // After deciding, claude's about to continue — re-arm a pending placeholder
    // so the user doesn't stare at an empty thread while the next reply cooks.
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
  },

  resolveAskUserQuestion(sessionId, askId, answers, annotations) {
    // Mark the matching question piece as answered in place — we DON'T
    // filter it out (unlike permission_request, which gets removed on
    // decide). The card stays in the transcript and renders read-only.
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: (s.transcripts[sessionId] ?? []).map((p) =>
          p.kind === "ask_user_question" && p.askId === askId
            ? { ...p, answers, annotations }
            : p,
        ),
      },
    }));
    get().ws?.send({
      type: "ask_user_answer",
      sessionId,
      askId,
      answers,
      ...(annotations ? { annotations } : {}),
    } satisfies ClientFrame);
    // Re-arm a pending placeholder so the next assistant turn isn't silent.
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
  },

  resolvePlanAccept(sessionId, planId, decision) {
    // Mark the matching plan card as decided in place — like
    // ask_user_question, the card stays in the transcript and renders
    // read-only afterwards with an accepted / rejected pill.
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: (s.transcripts[sessionId] ?? []).map((p) =>
          p.kind === "plan_accept_request" && p.planId === planId
            ? { ...p, decision }
            : p,
        ),
      },
    }));
    get().ws?.send({
      type: "plan_accept_decision",
      sessionId,
      planId,
      decision,
    } satisfies ClientFrame);
    // Re-arm a pending placeholder so the next assistant turn isn't silent.
    const pendingId = `pending-${Date.now()}`;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [sessionId]: [
          ...(s.transcripts[sessionId] ?? []),
          {
            kind: "pending",
            id: pendingId,
            startedAt: Date.now(),
            stalled: false,
          },
        ],
      },
    }));
    armStallTimer(sessionId, pendingId);
  },

  forgetSession(id) {
    clearStallTimer(id);
    set((s) => {
      const { [id]: _gone, ...rest } = s.transcripts;
      const { [id]: _meta, ...restMeta } = s.transcriptMeta;
      void _gone;
      void _meta;
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        transcripts: rest,
        transcriptMeta: restMeta,
      };
    });
  },
  };
});
