import { z } from "zod";
import {
  AskUserQuestionAnnotation,
  AskUserQuestionItem,
  PermissionMode,
  SessionStatus,
} from "./models.js";

// ============================================================================
// WebSocket protocol
//
// A single WS connection carries events for any number of sessions. Every
// frame is one of these discriminated union variants. The client subscribes
// to sessions explicitly; the server pushes events only for subscribed ids.
// ============================================================================

// ---------- Client → Server ----------

export const ClientHello = z.object({
  type: z.literal("hello"),
  // last seq the client has already seen per session, for resume on reconnect
  resume: z.record(z.string(), z.number().int().nonnegative()).default({}),
});

export const ClientSubscribe = z.object({
  type: z.literal("subscribe"),
  sessionId: z.string(),
});

export const ClientUnsubscribe = z.object({
  type: z.literal("unsubscribe"),
  sessionId: z.string(),
});

export const ClientUserMessage = z.object({
  type: z.literal("user_message"),
  sessionId: z.string(),
  content: z.string(),
  // Optional list of attachment ids (from `POST /api/sessions/:id/attachments`)
  // that should be linked to this user_message. On receipt, SessionManager
  // stamps each row's `message_event_seq` with the seq of the user_message
  // event it just appended, and prefixes the outgoing SDK prompt with
  // `@<absolute-path>` tokens so the SDK's Read tool can pick the files up.
  attachmentIds: z.array(z.string()).optional(),
  // Opaque nonce the client generates per-send so the originating tab can
  // match the server's echoed `user_message` broadcast back to its local
  // optimistic piece without relying on the fragile text+3s-timestamp
  // heuristic. The server relays this value back verbatim; other tabs have
  // no local piece with this echoId and simply insert the broadcast as a
  // fresh piece (their match falls back to the legacy heuristic or nothing).
  // Omitted by legacy clients; server tolerates absence.
  echoId: z.string().optional(),
});

export const ClientInterrupt = z.object({
  type: z.literal("interrupt"),
  sessionId: z.string(),
});

export const ClientPermissionDecision = z.object({
  type: z.literal("permission_decision"),
  sessionId: z.string(),
  approvalId: z.string(),
  decision: z.enum(["allow_once", "allow_always", "deny"]),
});

// User-submitted answers for an `AskUserQuestion` tool call. Routed to
// `SessionManager.resolveAskUserQuestion`, which resolves the corresponding
// `canUseTool` promise with `{ behavior: "allow", updatedInput: { answers,
// annotations? } }` (matching the SDK's `AskUserQuestionOutput`).
export const ClientAskUserAnswer = z.object({
  type: z.literal("ask_user_answer"),
  sessionId: z.string(),
  askId: z.string(),
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), AskUserQuestionAnnotation).optional(),
});

export const ClientFrame = z.discriminatedUnion("type", [
  ClientHello,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientUserMessage,
  ClientInterrupt,
  ClientPermissionDecision,
  ClientAskUserAnswer,
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------- Server → Client ----------

export const ServerHelloAck = z.object({
  type: z.literal("hello_ack"),
  serverVersion: z.string(),
});

export const ServerSessionUpdate = z.object({
  type: z.literal("session_update"),
  sessionId: z.string(),
  status: SessionStatus,
  mode: PermissionMode.optional(),
  title: z.string().optional(),
  lastMessageAt: z.string().nullable().optional(),
});

export const ServerAssistantTextDelta = z.object({
  type: z.literal("assistant_text_delta"),
  sessionId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
});

export const ServerAssistantTextEnd = z.object({
  type: z.literal("assistant_text_end"),
  sessionId: z.string(),
  messageId: z.string(),
  seq: z.number().int().nonnegative(),
});

export const ServerThinking = z.object({
  type: z.literal("thinking"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  text: z.string(),
});

export const ServerToolUse = z.object({
  type: z.literal("tool_use"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const ServerToolResult = z.object({
  type: z.literal("tool_result"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().default(false),
  // Set when the WS mapper clipped `content` to the per-frame size budget
  // (see `TOOL_RESULT_WS_LIMIT` in `server/src/transport/ws.ts`). The full
  // payload is still persisted in `session_events` — clients can refetch
  // via `GET /api/sessions/:id/events` to see the untruncated content.
  truncated: z.boolean().optional(),
});

export const ServerPermissionRequest = z.object({
  type: z.literal("permission_request"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  approvalId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  summary: z.string(),
  blastRadius: z.string().nullable(),
});

// Broadcast when the SDK's `AskUserQuestion` tool fires. The client renders an
// in-transcript multiple-choice card (see `AskUserQuestionCard`) and replies
// with a `ClientAskUserAnswer` frame once the user submits. `askId` is the
// SDK `toolUseID` — we reuse it as the correlation id.
export const ServerAskUserQuestion = z.object({
  type: z.literal("ask_user_question"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  askId: z.string(),
  questions: z.array(AskUserQuestionItem),
});

export const ServerTurnEnd = z.object({
  type: z.literal("turn_end"),
  sessionId: z.string(),
  seq: z.number().int().nonnegative(),
  stopReason: z.string(),
});

// Broadcast when a user message lands in a session — including the tab that
// sent it. Other tabs subscribed to the same session use this to surface
// the message immediately, instead of waiting until `turn_end` to refresh.
// The originating tab uses `content` + `createdAt` to reconcile its local
// optimistic echo (see web/src/state/sessions.ts for the de-dupe rule).
export const ServerUserMessage = z.object({
  type: z.literal("user_message"),
  sessionId: z.string(),
  content: z.string(),
  createdAt: z.string(),
  // Relayed verbatim from the originating `ClientUserMessage.echoId`. The
  // originating tab matches its optimistic piece against this nonce instead
  // of the legacy text+3s heuristic. Other tabs won't have a local piece
  // with a matching echoId and insert a fresh piece. Undefined for messages
  // sent by legacy clients that didn't supply an echoId.
  echoId: z.string().optional(),
});

// Broadcast when the queued_prompts table changes in any way (create, patch,
// delete, reorder, or runner-driven status transitions). Payload-free beyond
// a server-side timestamp — clients refetch `/api/queue` to reconcile. This
// replaces the 5s poll on the Queue screen; any authenticated tab receives
// it via the global channel (see ws.ts GLOBAL_FRAME_TYPES).
export const ServerQueueUpdate = z.object({
  type: z.literal("queue_update"),
  at: z.string(),
});

// Broadcast when the server has appended events to a session out-of-band —
// notably the CLI-JSONL resync-on-open path, which discovers new CLI turns
// and streams them into `session_events` without going through the live
// runner. The web client handles this by refetching the tail
// (`/events?limit=200`) and merging with any lazily-loaded older pages.
// Intentionally payload-free beyond the session id — the client's existing
// fetch path is simpler to drive than a per-event replay channel.
export const ServerRefreshTranscript = z.object({
  type: z.literal("refresh_transcript"),
  sessionId: z.string(),
});

export const ServerError = z.object({
  type: z.literal("error"),
  sessionId: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

export const ServerFrame = z.discriminatedUnion("type", [
  ServerHelloAck,
  ServerSessionUpdate,
  ServerAssistantTextDelta,
  ServerAssistantTextEnd,
  ServerThinking,
  ServerToolUse,
  ServerToolResult,
  ServerPermissionRequest,
  ServerAskUserQuestion,
  ServerTurnEnd,
  ServerUserMessage,
  ServerRefreshTranscript,
  ServerQueueUpdate,
  ServerError,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
