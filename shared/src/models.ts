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
  // Number of `claude` CLI JSONL transcript lines we've already imported into
  // this session's `session_events`. Incremented by the resync-on-open path
  // in `server/src/sessions/cli-resync.ts`. Zero when this session wasn't
  // adopted from the CLI (or when the row predates the column). Internal to
  // the server; clients can ignore it.
  cliJsonlSeq: z.number().int().nonnegative().default(0),
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

/**
 * Usage payload attached to a persisted `turn_end` SessionEvent.
 *
 * The Agent SDK's `result` message reports four relevant token counts:
 *   - `inputTokens` — *new* (uncached) input tokens for this turn. Tiny once
 *     the prompt cache is warm
 *   - `cacheReadInputTokens` — cached input tokens replayed into the turn
 *   - `cacheCreationInputTokens` — input tokens entering the cache this turn
 *   - `outputTokens` — assistant output tokens
 *
 * The "context body shipped to the model" for this turn is the sum
 * `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`. The Usage
 * panel's "how full is my context window" ring uses that sum, not
 * `inputTokens` alone — otherwise every turn after the first looks like it
 * used almost no context.
 *
 * All fields are optional on the schema because older persisted rows (from
 * before the cache fields existed) don't carry them.
 */
export const TurnEndUsage = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
});
export type TurnEndUsage = z.infer<typeof TurnEndUsage>;

// Response for `GET /api/sessions/:id/usage-summary` — lightweight per-session
// usage rollup that replaces places on the web that used to refetch the full
// `/events` payload just to compute last-turn context. Computed server-side
// by scanning `session_events WHERE kind='turn_end'`.
export const UsageSummaryResponse = z.object({
  totalInput: z.number().int().nonnegative(),
  totalOutput: z.number().int().nonnegative(),
  /** inp + cacheRead + cacheCreation from the most recent `turn_end`. */
  lastTurnInput: z.number().int().nonnegative(),
  /** Mirrors `computeSessionUsage.lastTurnContextKnown`. */
  lastTurnContextKnown: z.boolean(),
  turnCount: z.number().int().nonnegative(),
  perModel: z.array(
    z.object({
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
});
export type UsageSummaryResponse = z.infer<typeof UsageSummaryResponse>;

// ============================================================================
// Diff primitives — shared by server aggregation and web rendering.
//
// The web bundle has its own `web/src/lib/diff.ts` that computes these shapes
// directly from a tool_use input. The server full-screen review page
// (mockup s-06) aggregates across a session's event log and ships the pre-
// computed `FileDiff` hunks over the wire, which means both ends must agree
// on the shape.
// ============================================================================

export const DiffLineKind = z.enum(["ctx", "add", "del"]);
export type DiffLineKind = z.infer<typeof DiffLineKind>;

export const DiffLine = z.object({
  kind: DiffLineKind,
  oldNum: z.number().int().nullable(),
  newNum: z.number().int().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLine>;

export const DiffHunk = z.object({
  header: z.string(),
  lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const DiffKind = z.enum(["create", "edit", "overwrite"]);
export type DiffKind = z.infer<typeof DiffKind>;

export const FileDiff = z.object({
  path: z.string(),
  kind: DiffKind,
  addCount: z.number().int().nonnegative(),
  delCount: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
});
export type FileDiff = z.infer<typeof FileDiff>;

// One entry in the `/api/sessions/:id/pending-diffs` response.
//
// `approvalId` is set when this diff is backed by a still-pending
// `permission_request` — the UI can surface an Approve button and pipe it
// through the same `permission_decision` WS frame. When undefined, the diff
// is from an in-flight `tool_use` with no matching `tool_result` yet
// (rarely happens for Edit/Write under the default permission mode, but the
// UI still wants to show it so the user isn't blind).
export const PendingDiffEntry = z.object({
  toolUseId: z.string(),
  filePath: z.string(),
  // Matches the broad semantics of the original diff but keeps the labels
  // the UI wants ("MultiEdit" is its own bucket rather than a sub-kind of
  // Edit). `write` covers both create and overwrite at this level.
  kind: z.enum(["edit", "write", "multiedit"]),
  addCount: z.number().int().nonnegative(),
  delCount: z.number().int().nonnegative(),
  hunks: z.array(DiffHunk),
  approvalId: z.string().optional(),
  // Human-readable summary from the permission request's `title` field
  // (populated by summarizePermission). Null when there's no matching
  // permission_request — in-flight tool_use events have no such title.
  title: z.string().nullable(),
});
export type PendingDiffEntry = z.infer<typeof PendingDiffEntry>;

export const PendingDiffsResponse = z.object({
  diffs: z.array(PendingDiffEntry),
});
export type PendingDiffsResponse = z.infer<typeof PendingDiffsResponse>;

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

// Alternate second-factor path when the user's authenticator is unavailable:
// redeem one of the 10 single-use recovery codes that were issued at `init`
// (or later, via the Regenerate flow on the Security tab). Same
// challenge-then-cookie shape as `/verify-totp`. The `code` field accepts the
// user-visible `xxxx-xxxx-xxxx-xxxx` spelling and also tolerates whitespace
// or case variation — normalization happens server-side before bcrypt
// comparison — so the schema only enforces a coarse length bound.
export const VerifyRecoveryCodeRequest = z.object({
  challengeId: z.string(),
  // Min 16 (bare chars) / max 32 (with separators) gives us some slack for
  // users who paste extra whitespace.
  code: z.string().min(16).max(64),
});
export type VerifyRecoveryCodeRequest = z.infer<
  typeof VerifyRecoveryCodeRequest
>;

export const VerifyRecoveryCodeResponse = z.object({
  ok: z.literal(true),
  /** How many unused codes remain after this consumption. Useful for UIs
   * that want to nag the user to regenerate before they run out. */
  remaining: z.number().int().nonnegative(),
});
export type VerifyRecoveryCodeResponse = z.infer<
  typeof VerifyRecoveryCodeResponse
>;

export const RecoveryCodesStateResponse = z.object({
  remaining: z.number().int().nonnegative(),
  /** ISO timestamp of the most recent regenerate. Absent if the user has
   * never generated any codes (shouldn't happen for installs created after
   * migration 12 — init.ts seeds them — but the field is optional so the
   * UI can render a degrade gracefully for older installs). */
  generatedAt: z.string().optional(),
});
export type RecoveryCodesStateResponse = z.infer<
  typeof RecoveryCodesStateResponse
>;

export const RegenerateRecoveryCodesResponse = z.object({
  /** The plaintext codes, exactly 10 entries, rendered as
   * `xxxx-xxxx-xxxx-xxxx`. Returned to the client **exactly once** — the
   * server only stores hashes, so there is no "show them again" endpoint. */
  codes: z.array(z.string()).length(10),
  generatedAt: z.string(),
});
export type RegenerateRecoveryCodesResponse = z.infer<
  typeof RegenerateRecoveryCodesResponse
>;

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
  // Absolute path to the underlying <uuid>.jsonl. The server uses this on
  // import to seed `session_events` from the CLI's transcript. Shipped to
  // the UI for transparency but the UI has no reason to render it.
  filePath: z.string(),
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

// How the composer should treat a slash command when the user picks it.
//
// Motivated by a concrete bug: many of the `claude` CLI's `/` commands are
// REPL-only (`/login`, `/doctor`, `/init`, …) and the Agent SDK rejects them
// with "isn't available in this environment". Rather than let the user paste
// one of those into the composer and get that error, the picker now knows
// which entries are:
//
//   - `native`:         the SDK forwards the `/x` token through — just send
//   - `claudex-action`: the token is intercepted client-side and mapped to a
//                       claudex UI action (open model picker, open usage,
//                       etc.) instead of going over the wire
//   - `unsupported`:    REPL-only, no claudex equivalent — show a dimmed row
//                       with a short reason, and block sends that start with
//                       this exact token
//
// Custom `user`/`project`/`plugin` commands are always `native` — the SDK
// resolves the prompt template from disk the same way the CLI does. Only
// `built-in` entries vary.
export const SlashBehaviorKind = z.enum([
  "native",
  "claudex-action",
  "unsupported",
]);
export type SlashBehaviorKind = z.infer<typeof SlashBehaviorKind>;

// The set of client-side actions the web composer knows how to dispatch when
// the user picks a `claudex-action` command. Keeping this as a closed enum
// (rather than a free-form string) lets TypeScript keep the Chat screen
// exhaustive when we add a mapping later.
export const SlashClaudexAction = z.enum([
  "open-model-picker",
  "open-session-settings",
  "open-usage",
  "open-plugins-settings",
  "open-slash-help",
  "clear-transcript",
]);
export type SlashClaudexAction = z.infer<typeof SlashClaudexAction>;

export const SlashBehavior = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("native") }),
  z.object({
    kind: z.literal("claudex-action"),
    action: SlashClaudexAction,
  }),
  z.object({ kind: z.literal("unsupported"), reason: z.string() }),
]);
export type SlashBehavior = z.infer<typeof SlashBehavior>;

export const SlashCommand = z.object({
  // Bare command name, without the leading `/`.
  name: z.string(),
  // One-line description; null when we couldn't extract one from the file.
  description: z.string().nullable(),
  kind: SlashCommandKind,
  // Absolute path to the source file for user/project/plugin entries; omitted
  // for built-ins.
  source: z.string().optional(),
  // Composer triage — see SlashBehavior. Always set on built-ins; for
  // user/project/plugin entries the server stamps `{ kind: "native" }`.
  behavior: SlashBehavior,
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

// ============================================================================
// Usage analytics (full-screen `/usage` page)
//
// These endpoints aggregate `turn_end` payloads across non-archived sessions.
// They intentionally do NOT try to mirror Claude's subscription-plan quota —
// claudex doesn't see that data; it lives inside the `claude` CLI itself. The
// UI surfaces an empty state for plan-period usage rather than faking a bar.
//
// Token math: per-turn tokens = `inputTokens + outputTokens +
// cacheReadInputTokens + cacheCreationInputTokens`. Missing fields (older
// rows) contribute zero rather than crashing the sum. See `usage.ts` / the
// `TurnEndUsage` schema above for the "why cache fields are load-bearing"
// discussion.
// ============================================================================

// Per-model breakdown for the "Today · tokens" tile and the stacked bars.
export const UsagePerModel = z.object({
  // The raw model id as persisted on sessions.model (no translation).
  model: z.string(),
  tokens: z.number().int().nonnegative(),
});
export type UsagePerModel = z.infer<typeof UsagePerModel>;

// One entry in "Top sessions" — enough to render title + project + tokens
// without the web bundle having to match these up against its own sessions
// store.
export const UsageTopSession = z.object({
  sessionId: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string().nullable(), // null if the project row is gone
  tokens: z.number().int().nonnegative(),
});
export type UsageTopSession = z.infer<typeof UsageTopSession>;

// Response for `GET /api/usage/today` — everything the three-tile header +
// "Top sessions" card on the Usage screen needs. `windowStart` is ISO and
// lets the UI show "Today · since 00:00" honestly.
export const UsageTodayResponse = z.object({
  windowStart: z.string(),
  totalTokens: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  perModel: z.array(UsagePerModel),
  topSessions: z.array(UsageTopSession),
});
export type UsageTodayResponse = z.infer<typeof UsageTodayResponse>;

// One day's stacked token breakdown — drives the 7-day bar chart. `date` is
// `YYYY-MM-DD` in the server's local timezone so the x-axis labels line up
// with what the user considers "today".
export const UsageRangeDay = z.object({
  date: z.string(),
  totalTokens: z.number().int().nonnegative(),
  perModel: z.array(UsagePerModel),
});
export type UsageRangeDay = z.infer<typeof UsageRangeDay>;

// Response for `GET /api/usage/range?days=N`. `byDay` is always exactly N
// entries, oldest first, including days with zero tokens — so the chart
// doesn't have to pad missing days client-side.
export const UsageRangeResponse = z.object({
  days: z.number().int().positive(),
  byDay: z.array(UsageRangeDay),
});
export type UsageRangeResponse = z.infer<typeof UsageRangeResponse>;

// ============================================================================
// Push notifications
//
// claudex fires a Web Push notification every time a session enters the
// `awaiting` state because the CLI asked for tool-use permission — that's the
// whole reason this surface exists. The user reaches claudex from their phone
// over frpc; without push they have to keep the tab open to see a request.
//
// Subscriptions are per device, not per user: claudex is single-user, and we
// want every browser that's installed claudex as a PWA to get notified.
// ============================================================================

// Body of `POST /api/push/subscriptions` — the serialized browser
// PushSubscription plus the user-agent string we stamp onto the stored row so
// Settings can render an honest device list.
export const PushSubscribeRequest = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;

export const PushSubscribeResponse = z.object({
  id: z.string(),
  enabled: z.literal(true),
});
export type PushSubscribeResponse = z.infer<typeof PushSubscribeResponse>;

// One registered device. `userAgent` can be null on rows imported before we
// captured it; the UI renders "Unknown device" then.
export const PushDevice = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type PushDevice = z.infer<typeof PushDevice>;

// `GET /api/push/state` — snapshot for the Settings Notifications tab.
// `enabled` is "does at least one subscription exist on this server"; it does
// NOT imply the *current* browser is subscribed — the UI separately consults
// `Notification.permission` and the in-memory `PushSubscription` from the
// service worker registration for that.
export const PushStateResponse = z.object({
  enabled: z.boolean(),
  devices: z.array(PushDevice),
});
export type PushStateResponse = z.infer<typeof PushStateResponse>;

// `GET /api/push/vapid-public` — VAPID public key for
// `PushManager.subscribe({ applicationServerKey })`. Generated on first boot
// and persisted at `~/.claudex/vapid.json`.
export const VapidPublicResponse = z.object({
  publicKey: z.string(),
});
export type VapidPublicResponse = z.infer<typeof VapidPublicResponse>;

// Response for `POST /api/push/test` — fires a test push to every stored
// subscription. `sent` counts subscriptions we handed to web-push; `pruned`
// counts subscriptions that came back 404/410 (browser unsubscribed) and were
// deleted as a side-effect.
export const PushTestResponse = z.object({
  sent: z.number().int().nonnegative(),
  pruned: z.number().int().nonnegative(),
});
export type PushTestResponse = z.infer<typeof PushTestResponse>;

// ============================================================================
// Attachments (composer "Attach" chip)
//
// Two-phase model: uploads land unlinked (`message_event_seq = null`) via
// `POST /api/sessions/:id/attachments`, then get stamped onto the user's
// `user_message` event seq when they hit Send. A user can delete an unlinked
// attachment (they changed their mind); linked attachments are immutable.
// The file itself lives under `~/.claudex/uploads/<session-id>/`. The raw
// file is served by a login-gated endpoint at `/api/attachments/:id/raw`;
// for image attachments this is also the `previewUrl` the composer uses to
// render an inline thumbnail.
// ============================================================================

export const Attachment = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** Absolute URL path (same origin) that serves the raw bytes. Only populated
   * for image attachments today — the composer uses it for inline thumbnails.
   * The server route exists for every mime type; the client just chooses not
   * to fetch non-images. */
  previewUrl: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const UploadAttachmentResponse = Attachment;
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponse>;

// ============================================================================
// Full-text search across sessions + messages
//
// Backed by SQLite FTS5 (see server migration id=9). The server returns two
// buckets: `titleHits` (session titles that matched) and `messageHits`
// (user_message / assistant_text / assistant_thinking bodies that matched).
// Each capped at the `limit` query param (default 20, max 50 server-side).
//
// Snippets embed `<mark>…</mark>` HTML around the matched fragment. Clients
// must either sanitize-and-map those to styled spans (preferred) or, if they
// really do need to render as HTML, do so with the understanding that the
// server controls that output and will never emit anything other than
// literal `<mark>` / `</mark>` around tokenizer matches.
// ============================================================================

export const SearchTitleHit = z.object({
  sessionId: z.string(),
  title: z.string(),
  // The FTS `snippet()` for the matched title. Short (≤16 tokens). Optional
  // because a literal one-word title match may return an empty snippet.
  snippet: z.string().optional(),
});
export type SearchTitleHit = z.infer<typeof SearchTitleHit>;

export const SearchMessageHit = z.object({
  sessionId: z.string(),
  // Parent session's current title (JOINed server-side so clients don't
  // need a second round-trip to resolve it).
  title: z.string(),
  eventSeq: z.number().int().nonnegative(),
  kind: z.string(),
  snippet: z.string(),
  createdAt: z.string(),
});
export type SearchMessageHit = z.infer<typeof SearchMessageHit>;

export const SearchResponse = z.object({
  titleHits: z.array(SearchTitleHit),
  messageHits: z.array(SearchMessageHit),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

// ============================================================================
// Batch queue
//
// A queue of prompts the user wants run sequentially, each as its own fresh
// session. The runner picks the lowest-seq `queued` row, spawns a session,
// sends the prompt, then waits for the session to settle (idle or error)
// before moving on. Crash-resilient: every transition is persisted; a restart
// mid-run picks up with whatever row is still marked `running`.
// ============================================================================

export const QueueStatus = z.enum([
  "queued",
  "running",
  "done",
  "cancelled",
  "failed",
]);
export type QueueStatus = z.infer<typeof QueueStatus>;

export const QueuedPrompt = z.object({
  id: z.string(),
  projectId: z.string(),
  prompt: z.string(),
  // Short user label; falls back to first 60 chars of the prompt at render
  // time. Nullable so the API body can omit it.
  title: z.string().nullable(),
  // Null → runner falls back to the project/user default (claude-opus-4-7 /
  // 'default'). Non-null entries pin the choice.
  model: ModelId.nullable(),
  mode: PermissionMode.nullable(),
  worktree: z.boolean(),
  status: QueueStatus,
  // Set when the runner promotes the row to `running` (or later). Lets the
  // UI render "Open session →" once a real session exists.
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  seq: z.number().int().nonnegative(),
});
export type QueuedPrompt = z.infer<typeof QueuedPrompt>;

export const CreateQueuedPromptRequest = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  model: ModelId.optional(),
  mode: PermissionMode.optional(),
  worktree: z.boolean().optional(),
});
export type CreateQueuedPromptRequest = z.infer<
  typeof CreateQueuedPromptRequest
>;

export const UpdateQueuedPromptRequest = z
  .object({
    prompt: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    model: ModelId.optional(),
    mode: PermissionMode.optional(),
    worktree: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.prompt !== undefined ||
      v.title !== undefined ||
      v.model !== undefined ||
      v.mode !== undefined ||
      v.worktree !== undefined,
    { message: "at least one field is required" },
  );
export type UpdateQueuedPromptRequest = z.infer<
  typeof UpdateQueuedPromptRequest
>;

export const ListQueuedPromptsResponse = z.object({
  queue: z.array(QueuedPrompt),
});
export type ListQueuedPromptsResponse = z.infer<
  typeof ListQueuedPromptsResponse
>;

// ============================================================================
// Audit log
//
// Security-relevant events visible to the logged-in operator. The server
// writes rows fire-and-forget from auth, session, manager, and push call
// sites (see server/src/audit/); the web Security tab renders a rolling list
// plus a full-log sheet. `event` is an open string rather than a closed enum
// so new call sites can land without a shared-schema bump — the UI falls back
// to a generic "<event>" sentence when it doesn't have a mapping.
// ============================================================================

export const AuditEvent = z.object({
  id: z.string(),
  event: z.string(),
  target: z.string().nullable(),
  detail: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  // Populated by the route via userStore lookup when `user_id` is non-null.
  // Null for pre-login events (failed login / invalid challenge).
  user: z
    .object({ id: z.string(), username: z.string() })
    .nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditListResponse = z.object({
  events: z.array(AuditEvent),
  totalCount: z.number().int().nonnegative(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;

// ============================================================================
// Project memory (CLAUDE.md preview)
//
// Returned by `GET /api/projects/:id/memory` — read-only surfacing of the
// CLAUDE.md files the `claude` CLI treats as ambient memory. Up to two entries:
// one project-scoped (<project>/CLAUDE.md or <project>/.claude/CLAUDE.md, first
// match wins) and one user-scoped (~/.claude/CLAUDE.md). `content` is capped at
// 64 KB server-side; `truncated: true` signals the UI should say so.
// ============================================================================

export const MemoryFile = z.object({
  scope: z.enum(["project", "user"]),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean().optional(),
});
export type MemoryFile = z.infer<typeof MemoryFile>;

export const MemoryResponse = z.object({
  files: z.array(MemoryFile),
});
export type MemoryResponse = z.infer<typeof MemoryResponse>;
