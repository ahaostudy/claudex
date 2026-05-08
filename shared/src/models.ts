import { z } from "zod";

// ============================================================================
// Core enums
// ============================================================================

export const PermissionMode = z.enum([
  "default", // ask before every tool use
  "acceptEdits", // auto-accept file edits + safe filesystem ops
  "plan", // read-only exploration
  "auto", // autonomous with server-side safety classifier
  "bypassPermissions", // no prompts — sandboxed use only
]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const ModelId = z.enum([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);
export type ModelId = z.infer<typeof ModelId>;

export const SessionStatus = z.enum([
  "idle", // no turn in progress
  "running", // claude is working
  "awaiting", // waiting on user (permission / input)
  "archived", // closed, read-only
  "error", // terminal error state
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// ============================================================================
// Persistence-shaped DTOs
// ============================================================================

export const Project = z.object({
  id: z.string(), // slug (e.g. "spindle")
  name: z.string(),
  path: z.string(), // absolute host path
  trusted: z.boolean(), // user confirmed trust for this folder
  createdAt: z.string(), // ISO 8601
});
export type Project = z.infer<typeof Project>;

export const Session = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  status: SessionStatus,
  model: ModelId,
  mode: PermissionMode,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  // aggregate counters, cheap to read
  stats: z.object({
    messages: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
    linesAdded: z.number().int().nonnegative(),
    linesRemoved: z.number().int().nonnegative(),
    contextPct: z.number().min(0).max(1),
  }),
});
export type Session = z.infer<typeof Session>;

// A single turn event as we persist it. Subset of the SDK's stream types,
// remapped to what the UI actually renders.
export const EventKind = z.enum([
  "user_message",
  "assistant_text",
  "assistant_thinking",
  "tool_use",
  "tool_result",
  "permission_request",
  "permission_decision",
  "turn_end",
  "error",
]);
export type EventKind = z.infer<typeof EventKind>;

export const SessionEvent = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: EventKind,
  seq: z.number().int().nonnegative(), // ordering within a session
  createdAt: z.string(),
  // shape depends on kind; parsers in server/web narrow via kind
  payload: z.record(z.string(), z.unknown()),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const PendingApproval = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  // concise user-facing summary, prepared server-side
  summary: z.string(),
  // optional rendered "blast radius" hint shown in the UI
  blastRadius: z.string().nullable(),
  createdAt: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

export const User = z.object({
  id: z.string(),
  username: z.string(),
  createdAt: z.string(),
  twoFactorEnabled: z.boolean(),
});
export type User = z.infer<typeof User>;

// ============================================================================
// HTTP request/response shapes
// ============================================================================

export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  // whether the caller must now submit a TOTP code
  requireTotp: z.boolean(),
  // short-lived challenge id, stored in cookie too
  challengeId: z.string().nullable(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const VerifyTotpRequest = z.object({
  challengeId: z.string(),
  code: z.string().regex(/^\d{6}$/),
});
export type VerifyTotpRequest = z.infer<typeof VerifyTotpRequest>;

export const VerifyTotpResponse = z.object({
  ok: z.literal(true),
});
export type VerifyTotpResponse = z.infer<typeof VerifyTotpResponse>;

export const WhoAmIResponse = z.object({
  user: User,
});
export type WhoAmIResponse = z.infer<typeof WhoAmIResponse>;

export const CreateSessionRequest = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  model: ModelId,
  mode: PermissionMode,
  worktree: z.boolean().default(true),
  initialPrompt: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const UpdateProjectRequest = z.object({
  // Only `name` is mutable. Changing `path` would effectively be a different
  // project — adding a new one is the correct way to express that.
  name: z.string().min(1),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// ============================================================================
// Filesystem browse (for the FolderPicker UI)
// ============================================================================

export const BrowseEntry = z.object({
  name: z.string(),
  path: z.string(), // absolute host path
  isDir: z.boolean(),
  isHidden: z.boolean(), // leading-dot entries; UI decides whether to show
});
export type BrowseEntry = z.infer<typeof BrowseEntry>;

export const BrowseResponse = z.object({
  path: z.string(), // the (resolved) directory that was listed
  parent: z.string().nullable(), // absolute parent path, or null at the root
  entries: z.array(BrowseEntry),
});
export type BrowseResponse = z.infer<typeof BrowseResponse>;
