import { create } from "zustand";
import { api } from "@/api/client";
import { createWsClient, type WsClient } from "@/api/ws";
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
  | { kind: "user"; id: string; text: string; at: string }
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
    };

interface SessionState {
  ws: WsClient | null;
  connected: boolean;
  sessions: Session[];
  // sessionId → pieces in order
  transcripts: Record<string, UIPiece[]>;
  loadingSessions: boolean;
  init: () => void;
  refreshSessions: () => Promise<void>;
  ensureTranscript: (sessionId: string) => Promise<void>;
  subscribeSession: (sessionId: string) => void;
  sendUserMessage: (sessionId: string, text: string) => void;
  resolvePermission: (
    sessionId: string,
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
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

export const useSessions = create<SessionState>((set, get) => ({
  ws: null,
  connected: false,
  sessions: [],
  transcripts: {},
  loadingSessions: false,

  init() {
    if (get().ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const client = createWsClient(url);
    client.subscribe((frame) => {
      // Connection liveness tracked via hello_ack
      if (frame.type === "hello_ack") set({ connected: true });
      if (frame.type === "session_update") {
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === frame.sessionId
              ? { ...x, status: frame.status }
              : x,
          ),
        }));
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
    // Optimistic local echo
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
          },
        ],
      },
    }));
    get().ws?.send({
      type: "user_message",
      sessionId,
      content: text,
    } satisfies ClientFrame);
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
  },
}));
