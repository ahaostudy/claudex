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
  // Agent SDK session_id captured on first system/init; persisted so we can
  // `resume` the same SDK conversation after a server restart. Null means the
  // SDK has not yet initialized for this session.
  sdkSessionId: z.string().nullable(),
  // If this session is a `/btw` side chat, the id of the main session it
  // branches off. Side chats read the parent's transcript for context on
  // first spawn but never write back into the parent's event log. Null for
  // top-level sessions. Enforced ON DELETE CASCADE so removing the parent
  // cleans up every child.
  parentSessionId: z.string().nullable(),
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

// Change-password flow. Requires the caller's current password (so a stolen
// JWT cookie alone can't rotate the password and lock the owner out) plus
// the new password, which is min-8 for parity with bcrypt setup.
export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

// Read-only reflection of the user's Claude CLI environment: which plugins
// are installed, which are flagged as enabled in `settings.json`. We don't
// let the UI mutate any of this — the CLI owns those files, we just surface
// them so the settings page isn't lying about what's loaded.
export const UserEnvPlugin = z.object({
  key: z.string(), // e.g. "skill-creator@claude-plugins-official"
  name: z.string(), // e.g. "skill-creator"
  marketplace: z.string().nullable(), // e.g. "claude-plugins-official" (null if the key has no @)
  version: z.string().nullable(),
  installPath: z.string().nullable(),
  enabled: z.boolean(),
});
export type UserEnvPlugin = z.infer<typeof UserEnvPlugin>;

export const UserEnvResponse = z.object({
  user: User,
  // Absolute path to `~/.claude` as the server sees it (informational only).
  claudeDir: z.string(),
  // Whether `~/.claude/settings.json` was readable. False means the panel
  // should show a "no settings file" note instead of claiming everything's
  // disabled.
  settingsReadable: z.boolean(),
  plugins: z.array(UserEnvPlugin),
});
export type UserEnvResponse = z.infer<typeof UserEnvResponse>;

export const CreateSessionRequest = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  model: ModelId,
  mode: PermissionMode,
  worktree: z.boolean().default(true),
  initialPrompt: z.string().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

// Body of `POST /api/sessions/:id/side` — spawns a /btw side chat that reads
// the parent's transcript for context but never writes back. Everything on
// the child (model / mode / project) is copied from the parent by default.
// Only the optional initial prompt is carried in the body.
export const CreateSideSessionRequest = z.object({
  initialPrompt: z.string().optional(),
  title: z.string().min(1).optional(),
});
export type CreateSideSessionRequest = z.infer<typeof CreateSideSessionRequest>;

export const UpdateProjectRequest = z.object({
  // Only `name` is mutable. Changing `path` would effectively be a different
  // project — adding a new one is the correct way to express that.
  name: z.string().min(1),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

// Partial update for a session. At least one field must be present — the
// server uses `.refine()` to reject empty bodies (otherwise a no-op PATCH
// would still bump updated_at).
export const UpdateSessionRequest = z
  .object({
    title: z.string().min(1).optional(),
    model: ModelId.optional(),
    mode: PermissionMode.optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.model !== undefined || v.mode !== undefined,
    { message: "at least one of title, model, or mode is required" },
  );
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

// Scope of a tool grant: session-only or global across all sessions.
export const ToolGrantScope = z.enum(["session", "global"]);
export type ToolGrantScope = z.infer<typeof ToolGrantScope>;

export const ToolGrant = z.object({
  id: z.string(),
  toolName: z.string(),
  signature: z.string(),
  scope: ToolGrantScope,
  createdAt: z.string(),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

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

// ============================================================================
// CLI session discovery & import
// ============================================================================

// Summary of a `claude` CLI session discovered on disk at
// ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. We don't parse the whole
// transcript — just enough metadata to render a "pick which ones to adopt"
// list. `title` is derived from the first user message (word-boundary
// truncated to ~60 chars) so the list looks like the other session lists.
export const CliSessionSummary = z.object({
  sessionId: z.string(),
  cwd: z.string(), // decoded from the slug; best-effort (see decodeSlug)
  title: z.string(),
  firstUserMessage: z.string().nullable(),
  lineCount: z.number().int().nonnegative(), // bounded: we only read ~head
  fileSize: z.number().int().nonnegative(),
  lastModified: z.string(), // ISO 8601
});
export type CliSessionSummary = z.infer<typeof CliSessionSummary>;

export const ListCliSessionsResponse = z.object({
  sessions: z.array(CliSessionSummary),
});
export type ListCliSessionsResponse = z.infer<typeof ListCliSessionsResponse>;

export const ImportCliSessionsRequest = z.object({
  sessionIds: z.array(z.string().min(1)).min(1),
});
export type ImportCliSessionsRequest = z.infer<typeof ImportCliSessionsRequest>;

export const ImportCliSessionsResponse = z.object({
  imported: z.array(Session),
});
export type ImportCliSessionsResponse = z.infer<
  typeof ImportCliSessionsResponse
>;

// ============================================================================
// Slash commands (composer `/` picker)
// ============================================================================

// Where a slash command came from. `built-in` is hard-coded in the server
// (the `claude` CLI owns the actual behavior); `user` comes from
// `~/.claude/commands/`; `project` from `<project>/.claude/commands/`;
// `plugin` is reserved for a future scanner — not emitted today.
export const SlashCommandKind = z.enum([
  "built-in",
  "user",
  "project",
  "plugin",
]);
export type SlashCommandKind = z.infer<typeof SlashCommandKind>;

export const SlashCommand = z.object({
  // Bare command name, without the leading `/`.
  name: z.string(),
  // One-line description; null when we couldn't extract one from the file.
  description: z.string().nullable(),
  kind: SlashCommandKind,
  // Absolute path to the source file for user/project/plugin entries; omitted
  // for built-ins.
  source: z.string().optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const ListSlashCommandsResponse = z.object({
  commands: z.array(SlashCommand),
});
export type ListSlashCommandsResponse = z.infer<
  typeof ListSlashCommandsResponse
>;

// ============================================================================
// Routines (scheduled sessions)
// ============================================================================

// A routine is a cron-scheduled recipe: at each fire, the scheduler creates a
// fresh session (with the routine's project/model/mode) and kicks it off with
// `prompt` as the first user message. Independent conversation history per run.
// `paused` routines stay in the list but skip scheduling.
export const RoutineStatus = z.enum(["active", "paused"]);
export type RoutineStatus = z.infer<typeof RoutineStatus>;

export const Routine = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  prompt: z.string(),
  // Five-field cron expression (min hr dom mon dow). Evaluated in the host's
  // local timezone by the scheduler.
  cronExpr: z.string(),
  model: ModelId,
  mode: PermissionMode,
  status: RoutineStatus,
  lastRunAt: z.string().nullable(),
  // ISO timestamp of the next scheduled fire; null when paused or the
  // expression no longer yields future dates (shouldn't happen for 5-field).
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Routine = z.infer<typeof Routine>;

export const CreateRoutineRequest = z.object({
  name: z.string().min(1),
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  cronExpr: z.string().min(1),
  model: ModelId,
  mode: PermissionMode,
});
export type CreateRoutineRequest = z.infer<typeof CreateRoutineRequest>;

// Partial update. At least one field must be present — the route rejects
// empty bodies rather than bumping `updated_at` for nothing.
export const UpdateRoutineRequest = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    cronExpr: z.string().min(1).optional(),
    model: ModelId.optional(),
    mode: PermissionMode.optional(),
    status: RoutineStatus.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.prompt !== undefined ||
      v.cronExpr !== undefined ||
      v.model !== undefined ||
      v.mode !== undefined ||
      v.status !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateRoutineRequest = z.infer<typeof UpdateRoutineRequest>;
