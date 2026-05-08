import { create } from "zustand";
import { api } from "@/api/client";
import { createWsClient, type WsClient, type WsDiagnostics } from "@/api/ws";
import type {
  ClientFrame,
  Session,
  SessionEvent,
  ServerFrame,
} from "@claudex/shared";

// A streamed turn is rendered as a list of UI "pieces": text, tool_use,
// tool_result, thinking. We build these up from both persisted events (on
// load) and live WS frames.

export type UIPiece =
  | {
      kind: "user";
      id: string;
      text: string;
      at: string;
      // True once we've matched this piece against a server-broadcast
      // `user_message` frame (or it came straight from the server in the
      // first place). Used by the multi-tab de-dupe rule — a tab's locally
      // echoed user piece is `serverAcked=false` until its own ws receives
      // the matching broadcast, at which point we flip the flag rather
      // than push a second copy.
      serverAcked?: boolean;
    }
  | { kind: "assistant_text"; id: string; text: string }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      isError: boolean;
    }
  | { kind: "thinking"; text: string }
  | {
      kind: "permission_request";
      approvalId: string;
      toolName: string;
      input: Record<string, unknown>;
      summary: string;
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

interface SessionState {
  ws: WsClient | null;
  connected: boolean;
  wsDiag: WsDiagnostics;
  sessions: Session[];
  // sessionId → pieces in order
  transcripts: Record<string, UIPiece[]>;
  loadingSessions: boolean;
  // Current transcript view mode — session-scoped in spirit but not yet
  // persisted per-session or to localStorage (intentional for first pass).
  viewMode: ViewMode;
  init: () => void;
  refreshSessions: () => Promise<void>;
  ensureTranscript: (sessionId: string) => Promise<void>;
  subscribeSession: (sessionId: string) => void;
  sendUserMessage: (sessionId: string, text: string) => void;
  interruptSession: (sessionId: string) => void;
  // Push a pending piece onto a session's transcript if there isn't already one
  // at the tail. Used when the Chat screen mounts with session.status==="running"
  // so the user sees "claude is processing" even without a fresh user_message.
  ensurePendingFor: (sessionId: string) => void;
  resolvePermission: (
    sessionId: string,
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
  setViewMode: (mode: ViewMode) => void;
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
        serverAcked: true,
      };
    case "assistant_text":
      return {
        kind: "assistant_text",
        id: String(p.messageId ?? ev.id),
        text: String(p.text ?? ""),
      };
    case "assistant_thinking":
      return { kind: "thinking", text: String(p.text ?? "") };
    case "tool_use":
      return {
        kind: "tool_use",
        id: String(p.toolUseId ?? ev.id),
        name: String(p.name ?? "unknown"),
        input: (p.input as Record<string, unknown>) ?? {},
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolUseId: String(p.toolUseId ?? ""),
        content: String(p.content ?? ""),
        isError: Boolean(p.isError),
      };
    case "permission_request":
      return {
        kind: "permission_request",
        approvalId: String(p.toolUseId ?? ""),
        toolName: String(p.toolName ?? ""),
        input: (p.input as Record<string, unknown>) ?? {},
        summary: String(p.title ?? ""),
      };
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
    default:
      return null;
  }
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
  loadingSessions: false,
  viewMode: "normal",

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
    client.subscribe((frame) => {
      // Connection liveness tracked via hello_ack
      if (frame.type === "hello_ack") set({ connected: true });
      if (frame.type === "session_update") {
        const sid = frame.sessionId;
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
      }
      // Multi-tab: a user_message broadcast can land in any subscribed tab —
      // including the one that sent it. De-dupe rule: if an existing user
      // piece with the same text and a close-enough `at` is already in the
      // transcript (either a local optimistic echo or a prior persisted copy
      // we loaded from /events), upgrade it to `serverAcked=true` rather than
      // push a duplicate. Otherwise append a fresh piece.
      if (frame.type === "user_message") {
        const sid = frame.sessionId;
        const ts = Date.parse(frame.createdAt) || Date.now();
        set((s) => {
          const list = s.transcripts[sid] ?? [];
          // Scan newest → oldest; match on content first, then ensure the
          // timestamps are within 3s (covers optimistic echoes whose `at` is
          // generated client-side and won't be identical to the server's).
          let matchIdx = -1;
          for (let i = list.length - 1; i >= 0; i--) {
            const piece = list[i];
            if (piece.kind !== "user") continue;
            if (piece.text !== frame.content) continue;
            if (piece.serverAcked) {
              // Already reconciled for an earlier broadcast; don't flip again.
              matchIdx = i;
              break;
            }
            const pTs = Date.parse(piece.at) || 0;
            if (Math.abs(ts - pTs) <= 3000) {
              matchIdx = i;
              break;
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
      // Any substantive reply frame means the pending placeholder did its job.
      if (
        frame.type === "assistant_text_delta" ||
        frame.type === "thinking" ||
        frame.type === "tool_use" ||
        frame.type === "tool_result" ||
        frame.type === "permission_request" ||
        frame.type === "turn_end" ||
        frame.type === "error"
      ) {
        const sid = (frame as any).sessionId as string | undefined;
        if (sid) dropFirstPending(sid);
      }
      const piece = frameToPiece(frame);
      if (piece) {
        const sid =
          (frame as any).sessionId as string | undefined;
        if (!sid) return;
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
      set({ sessions: res.sessions });
    } finally {
      set({ loadingSessions: false });
    }
  },

  async ensureTranscript(sessionId) {
    if (get().transcripts[sessionId]) return;
    const res = await api.listEvents(sessionId);
    const pieces = res.events
      .map(eventToPiece)
      .filter((p): p is UIPiece => p != null);
    set((s) => ({
      transcripts: { ...s.transcripts, [sessionId]: pieces },
    }));
  },

  subscribeSession(sessionId) {
    get().ws?.send({ type: "subscribe", sessionId } satisfies ClientFrame);
  },

  sendUserMessage(sessionId, text) {
    const pendingId = `pending-${Date.now()}`;
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
            serverAcked: false,
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
  };
});
