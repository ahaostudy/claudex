import { z } from "zod";
import { PermissionMode, SessionStatus } from "./models.js";

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

export const ClientFrame = z.discriminatedUnion("type", [
  ClientHello,
  ClientSubscribe,
  ClientUnsubscribe,
  ClientUserMessage,
  ClientInterrupt,
  ClientPermissionDecision,
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
  ServerTurnEnd,
  ServerUserMessage,
  ServerError,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
