# claudex · Features

> Living ledger of what actually ships. Updated in the **same commit** as the
> feature that changes it. If a behavior exists in code but isn't reflected
> here, that's a bug — either the doc or the code is wrong.

Three status tiers:

- ✅ **Ready** — end-to-end working, accessible from the UI a user sees.
- 🟡 **Partial** — backend or scaffold exists, UI is missing or thin. Safe to
  use from the API; users won't see it yet.
- ⬜ **Planned** — listed so nobody re-plans it from scratch, but not started.

Last updated: see the git log of this file. Current revision lists **72 shipped
behaviors** and **169 backend tests**.

---

## Install & bootstrap

| Status | Feature | Where |
|---|---|---|
| ✅ | First-run admin creation via `pnpm init`, interactive or env-driven (`CLAUDEX_INIT_USERNAME` / `CLAUDEX_INIT_PASSWORD` / `--username=` / `--password=`) | `server/src/bin/init.ts` |
| ✅ | Generates TOTP secret, prints ASCII-art QR code and the secret string, sets the Issuer/Account to `claudex / <username>` | same |
| ✅ | Refuses to re-run if a user already exists (manual DB delete required to reset) | same |
| ✅ | `pnpm reset-credentials` — rotate username and/or password in place while keeping the TOTP secret (so the authenticator entry keeps working). Flags: `--username=`, `--password=`, `--match=<current-username>` for multi-user disambiguation; env vars `CLAUDEX_RESET_USERNAME` / `CLAUDEX_RESET_PASSWORD` / `CLAUDEX_RESET_MATCH` work too | `server/src/bin/reset-credentials.ts` |
| ✅ | All runtime state under `~/.claudex/` (DB, logs, JWT secret); override via `CLAUDEX_STATE_DIR` | `server/src/lib/config.ts` |
| ✅ | SQLite DB with hand-rolled migrations, WAL mode, foreign keys on, cascade on session delete | `server/src/db/index.ts` |
| ✅ | Refuses to bind anything other than `127.0.0.1` / `::1` / `localhost` — public exposure is the user's responsibility (frp / Cloudflare Tunnel / Tailscale / Caddy) | `server/src/lib/config.ts` |

## Server shape

| Status | Feature | Where |
|---|---|---|
| ✅ | Fastify 5 + `@fastify/cookie` + `@fastify/websocket` | `server/src/transport/app.ts` |
| ✅ | `GET /api/health` — liveness probe | same |
| ✅ | Single-port mode: server hosts the built web bundle at `/` alongside `/api` and `/ws`. `/assets/*` gets `Cache-Control: immutable`, `index.html` gets `no-cache` | same |
| ✅ | SPA fallback: any non-`/api`, non-`/ws` GET falls through to `index.html` so React Router survives a refresh on deep links | same |
| ✅ | `/api/*` and `/ws` 404s return JSON (not swallowed by the HTML fallback) | same |
| ✅ | `CLAUDEX_WEB_DIST=<path>` override; `CLAUDEX_WEB_DIST=none` disables the static mount (use for Vite dev on 5173) | `server/src/index.ts` |
| ✅ | pino logger to `~/.claudex/logs/server.log`, pretty to stdout in dev | `server/src/lib/logger.ts` |
| ✅ | Graceful shutdown on SIGINT/SIGTERM — disposes session runners, closes app, closes DB | `server/src/index.ts` |

## Auth

| Status | Feature | Where |
|---|---|---|
| ✅ | `POST /api/auth/login` — username + password, returns a short-lived `challengeId` (not yet logged in). Case-insensitive username. Uniform timing regardless of whether the user exists (always runs bcrypt) | `server/src/auth/routes.ts` |
| ✅ | `POST /api/auth/verify-totp` — six-digit TOTP with ±1 step tolerance (accounts for clock skew). On success, issues a JWT (HS256, 30-day TTL) in an httpOnly session cookie | same |
| ✅ | Peek-then-consume: a wrong TOTP **does not** burn the challenge — the user can retry without going back to the password screen | same |
| ✅ | Cookie `Secure` attribute auto-detected from request protocol and `X-Forwarded-Proto`; override with `CLAUDEX_COOKIE_SECURE=1/0`. `SameSite=Lax`, `HttpOnly`, `Path=/` | same |
| ✅ | `GET /api/auth/whoami` — returns the logged-in user or 401 | same |
| ✅ | `POST /api/auth/logout` — clears the session cookie | same |
| ✅ | JWT signed with a 48-byte random secret persisted at `~/.claudex/jwt.secret` (mode 0600) | `server/src/auth/index.ts` |
| ✅ | Bcrypt password hashing (12 rounds); rejects passwords under 8 chars | same |
| ✅ | `otplib` TOTP with issuer `claudex`; current-code helper exposed for tests | same |
| ✅ | Short-lived login challenge store (5 min TTL) with peek + consume semantics | same |

## Projects

| Status | Feature | Where |
|---|---|---|
| ✅ | Login-gated REST CRUD | `server/src/sessions/routes.ts` |
| ✅ | `GET /api/projects` — list | same |
| ✅ | `POST /api/projects` — add. Rejects non-existent paths (400) and duplicate paths (409). Paths are resolved to absolute and stored verbatim | same |
| ✅ | `PATCH /api/projects/:id` — rename (only `name` is mutable; `path` changes would be a different project and are rejected at the schema level) | same |
| ✅ | `DELETE /api/projects/:id` — delete. Returns `409 has_sessions` with `{sessionCount}` if the project still owns any session (archived included) — FK is `ON DELETE RESTRICT` | same |
| ✅ | `ProjectStore.setTrusted` + `.setName` + `.countSessions` + `.delete` | `server/src/sessions/projects.ts` |
| 🟡 | `setTrusted` is not yet exposed as a REST endpoint or UI action — all projects are trusted on create today | same |

## Filesystem browse

| Status | Feature | Where |
|---|---|---|
| ✅ | `GET /api/browse?path=<abs>` — lists immediate children. Entries are `{name, path, isDir, isHidden}` sorted dirs-first then by name. Hidden (leading-dot) entries are returned with `isHidden: true` so the UI chooses visibility. Symlinks are classified via `lstat` and never followed; dangling symlinks show up as non-dirs instead of crashing the listing | `server/src/sessions/browse.ts` |
| ✅ | `GET /api/browse/home` — returns `{path: os.homedir()}` for a "back to home" shortcut | same |
| ✅ | Errors: `400 not_absolute`, `404 not_found`, `403 not_a_directory`, `403 permission_denied` (EACCES/EPERM). Never reads file contents | same |
| ✅ | Login-gated alongside the rest of `/api/*` | same |

## Slash commands

| Status | Feature | Where |
|---|---|---|
| ✅ | `GET /api/slash-commands?projectId=<id>` — returns the merged list that powers the composer's `/` picker: curated CLI built-ins, then `~/.claude/commands/*.md` (kind `user`), then `<project>/.claude/commands/*.md` (kind `project`, only when `projectId` is given). Each entry is `{name, description, kind, source?}`. Descriptions are parsed from YAML frontmatter (`description:`), a leading `# Heading`, or the first non-empty line — whichever lands first in the first 1 KB / 10 lines. Top-level `.md` only; dotfiles skipped; unreadable files are quietly skipped rather than 500-ing. Unknown `projectId` is soft-ignored (still returns built-in + user) | `server/src/sessions/slash-commands.ts` |
| ✅ | Built-ins are a curated list (`add-dir`, `bug`, `clear`, `compact`, `config`, `continue`, `cost`, `doctor`, `help`, `init`, `login`, `logout`, `mcp`, `model`, `plugin`, `pr-comments`, `resume`, `review`, `status`) — the `claude` CLI owns the real behavior, we just surface the token so the picker isn't empty | same |
| ⚠ | Plugin commands (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/*.md`) are **not** scanned — the versioned cache layout has multiple valid entries per plugin and we don't guess. Revisit once the CLI exposes a canonical listing | — |

## Sessions

| Status | Feature | Where |
|---|---|---|
| ✅ | `POST /api/sessions` — create. Body: `projectId`, `model`, `mode`, `title?`, `worktree` (currently a flag only; worktree wiring is planned) | `server/src/sessions/routes.ts` |
| ✅ | `GET /api/sessions` — list. `?project=<id>` scopes to one project; `?archived=1` includes archived | same |
| ✅ | `GET /api/sessions/:id` — fetch one | same |
| ✅ | `GET /api/sessions/:id/events?sinceSeq=N` — replay persisted events | same |
| ✅ | `POST /api/sessions/:id/archive` — mark read-only | same |
| ✅ | `PATCH /api/sessions/:id` — partial update (`title`, `model`, `mode`). `mode` changes are pushed into the live runner via `setPermissionMode`; `model` changes are DB-only and the response carries `warnings: ["model_change_applies_to_next_turn"]` when a runner is already attached. Refuses `409 archived` on archived sessions and `400 bad_request` on empty bodies (at least one field required) | same |
| ✅ | Every event gets a monotonic per-session `seq` and is written to `session_events` (payload as JSON) | `server/src/sessions/store.ts` |
| ✅ | Aggregate stats on the session row (messages, files changed, +/− lines, contextPct) bumpable via `bumpStats` | same |
| 🟡 | Worktree flag accepted by the API but the server never creates a worktree yet — planned in P4 | same |
| 🟡 | `filesChanged` / `linesAdded` / `linesRemoved` plumbing exists but isn't populated — counters will always read 0 until wired into tool_result parsing | same |

## Chat loop (Claude Agent SDK)

| Status | Feature | Where |
|---|---|---|
| ✅ | One `AgentRunner` per live session, spawned on first message. Spawns the user's local `claude` CLI via `@anthropic-ai/claude-agent-sdk` — no direct Anthropic API call | `server/src/sessions/agent-runner.ts` |
| ✅ | Inherits `~/.claude/` settings, MCP servers, skills, plugins, CLAUDE.md from the user's config | SDK default behavior |
| ✅ | `env` merged with `process.env` on spawn (workaround for SDK v0.2.113 breaking change that made env replace rather than extend) | `server/src/sessions/agent-runner.ts` |
| ✅ | Async-iterable input queue — follow-up user messages don't restart the subprocess | same |
| ✅ | Captures the SDK's `session_id` from the first `system/init` message (stored on the runner; used for resume design) | same |
| ✅ | Translates SDK `assistant` / `user` / `result` / `system` messages into typed `RunnerEvent`s (text, thinking, tool_use, tool_result, turn_end, error, status). Malformed blocks are silently skipped instead of crashing | same |
| ✅ | `SessionManager` persists every event into `session_events`, bumps stats & status on `turn_end`, and broadcasts to WS subscribers | `server/src/sessions/manager.ts` |
| ✅ | Permission mode selectable per session: `default` (ask), `acceptEdits`, `plan`, `bypassPermissions`. `auto` is accepted but falls through to `default` for now | `server/src/sessions/agent-runner.ts` |
| ✅ | `interrupt()` supported at the Runner and manager layer | same |
| ✅ | `setPermissionMode` wired end-to-end: the session settings sheet PATCHes `/api/sessions/:id` with a new `mode`, the server updates the DB and calls `Query.setPermissionMode` on the live runner | same |
| ✅ | Session resume via `resumeSdkSessionId` — the SDK `session_id` from the first `system/init` is persisted to `sessions.sdk_session_id` (first-write-wins, SQLite migration id=2) and passed as `resume` on subsequent `getOrCreate`, so re-opening an old session after a server restart continues the same Agent SDK conversation | `server/src/sessions/manager.ts`, `server/src/sessions/store.ts`, `server/src/db/index.ts` |

## Permissions

| Status | Feature | Where |
|---|---|---|
| ✅ | SDK `canUseTool` callback is bridged to a Promise queue keyed by `toolUseID` — the request sits until the UI answers | `server/src/sessions/agent-runner.ts` |
| ✅ | Permission requests are enriched server-side with a human-friendly `summary` and a `blastRadius` hint per tool (Bash, Edit/Write/MultiEdit, Read, Glob/Grep, WebFetch, WebSearch) | `server/src/sessions/permission-summary.ts` |
| ✅ | Three-decision UX: **Allow once / Always / Deny** | `web/src/screens/Chat.tsx` |
| ✅ | "Always" records a `ToolGrant` scoped to the session; matching future requests auto-approve without prompting the user. Signature conventions: Bash→command, Edit-family→file_path, Glob/Grep→pattern | `server/src/sessions/grants.ts` |
| ✅ | Session status flips `awaiting` → `running` as permission requests come in and are resolved | `server/src/sessions/manager.ts` |
| ✅ | `GET /api/sessions/:id/grants` lists session + global grants (scope annotated); `DELETE /api/grants/:id` revokes one. The session settings sheet renders these under "Approved in this session" with a per-row Revoke button | same + `web/src/components/SessionSettingsSheet.tsx` |
| 🟡 | No "Always, globally" (cross-session) decision yet — `addGlobalGrant` exists but isn't wired to the UI | same |

## Diff rendering

| Status | Feature | Where |
|---|---|---|
| ✅ | Inline diff view for `Edit`, `Write`, and `MultiEdit` tool calls — the diff renders both inside the permission card (so you can decide on the spot) and inline in the transcript | `web/src/components/DiffView.tsx` |
| ✅ | Handles create (new file) / overwrite / edit hunks; contextless hunks for Edit since we don't have the full file | `web/src/lib/diff.ts` |
| ⬜ | Line-by-line commenting, "Review code" button, accept/reject per file — mockup'd but not implemented |  |

## WebSocket transport

| Status | Feature | Where |
|---|---|---|
| ✅ | `GET /ws` — one socket per browser tab, multiplexed across any number of sessions the client subscribes to | `server/src/transport/ws.ts` |
| ✅ | Cookie-authenticated handshake. Unauthenticated sockets get a single error frame and are closed | same |
| ✅ | `hello` / `subscribe` / `unsubscribe` / `user_message` / `interrupt` / `permission_decision` — all validated by zod discriminated unions from `@claudex/shared` | same + `shared/src/protocol.ts` |
| ✅ | Broadcasts: `hello_ack`, `session_update`, `assistant_text_delta`, `thinking`, `tool_use`, `tool_result`, `permission_request`, `turn_end`, `error` | same |
| ✅ | Malformed frames return a typed error frame; the socket stays open | same |
| ✅ | Auto-reconnecting WS client on the web side with exponential-ish backoff capped at 1s | `web/src/api/ws.ts` |
| 🟡 | `hello` carries a per-session `resume: {sessionId: lastSeq}` map so the server can replay missed events on reconnect — schema and storage are in place but the server-side replay is not wired yet (reconnect today relies on `/api/sessions/:id/events` as history backfill) | `server/src/transport/ws.ts` |

## Web UI

| Status | Feature | Where |
|---|---|---|
| ✅ | Login screen with 2-step flow (credentials → 6-digit TOTP). Auto-clears the TOTP input on wrong code so the next attempt doesn't concatenate | `web/src/screens/Login.tsx` |
| ✅ | Home: session list grouped by update time, status dot (idle/running/awaiting/archived/error), model + mode row, relative timestamp, live WS connection indicator | `web/src/screens/Home.tsx` |
| ✅ | New-session bottom sheet: existing-project picker **and** "+ add new project" row coexist (no more mutual-exclusion bug); title input, model pills (Opus 4.7 / Sonnet 4.6 / Haiku 4.5), 4-way permission mode selector. Name auto-defaults to the folder's last segment if left blank | same |
| ✅ | **Folder picker** (`FolderPicker.tsx`) behind the "Browse" button — full-screen on mobile, modal on desktop. Walks the host filesystem via `/api/browse`, with Home/Up buttons, dotfile toggle, dirs-first list, "Select this folder" confirms at the current path | `web/src/components/FolderPicker.tsx` |
| ✅ | **Project management sheet** (gear button in the Home header) — lists every project, inline rename, delete with friendly 409 `has_sessions` handling that tells the user to archive/delete sessions first | `web/src/screens/Home.tsx` |
| ✅ | Chat screen: user messages as ink bubbles, assistant as flowing prose, thinking in an italic left-rule block, tool_use chip with truncated input summary, tool_result in a mono block (error-tinted when `isError`) | `web/src/screens/Chat.tsx` |
| ✅ | Permission card in-thread with Allow-once / Always / Deny buttons, diff preview for Edit/Write/MultiEdit | same |
| ✅ | Optimistic echo of user messages (shown before the WS ack) | `web/src/state/sessions.ts` |
| ✅ | Transcript is reconstructed from both persisted events (initial load via `/api/sessions/:id/events`) and live WS frames, unified into a single UI piece list | same |
| ✅ | Sign out clears the session cookie and returns to the login screen | `web/src/screens/Home.tsx` |
| ✅ | **Composer pickers** — typing `@` after whitespace pops a file-mention sheet (reuses `/api/browse`, defaults to the session's project root, inserts `@<relative>` or `@<abs>` fallback outside the root); typing `/` at the start of a line pops a slash-command sheet populated at mount from `GET /api/slash-commands?projectId=<id>` — merges the CLI built-ins, the user's `~/.claude/commands/*.md`, and the active project's `.claude/commands/*.md`, each entry tagged with its `kind` shown as a badge. Network/auth failure falls back to a tiny built-in list (`help / clear / compact / review`) so the picker is never empty. Both sheets share the s-09 bottom-sheet language. Side-rail icons also open the pickers explicitly | `web/src/screens/Chat.tsx`, `web/src/components/SlashCommandSheet.tsx`, `web/src/components/FileMentionSheet.tsx`, `web/src/lib/slash-commands.ts`, `web/src/api/client.ts` |
| ✅ | Session settings side sheet (gear button in the Chat header) — edit title, swap model (Opus 4.7 / Sonnet 4.6 / Haiku 4.5), switch permission mode (Ask / Accept / Plan / Bypass), read-only workspace panel (branch + worktree path placeholder for P4), and "Approved in this session" list with per-grant Revoke. Model change mid-run shows a yellow "applies to next turn" notice | `web/src/components/SessionSettingsSheet.tsx` + `web/src/screens/Chat.tsx` |
| 🟡 | `/btw` side chat — not implemented |  |
| ✅ | **View modes (Normal / Verbose / Summary)** — dropdown picker in the Chat header (next to the gear). `normal` hides `thinking` blocks entirely (no inline expander yet — deferred); `verbose` shows every piece including thinking; `summary` keeps only user messages + the final `assistant_text` of each assistant turn and appends an **Outcome** card (driven by `session.status`) and a **Changes** card that aggregates `Edit`/`Write`/`MultiEdit` tool calls into per-file `+`/`−` line totals (PR card from mockup s-07 is still planned — no git integration yet). Session-scoped, no persistence across reloads | `web/src/screens/Chat.tsx`, `web/src/components/ViewModePicker.tsx`, `web/src/state/sessions.ts` |
| 🟡 | Usage panel (context ring, plan usage, per-model today) — no UI |  |
| 🟡 | Global settings page (2FA management, paired browsers, exposure audit log) — no UI |  |

## Tests

| Status | Feature | Where |
|---|---|---|
| ✅ | 169 backend tests, vitest, all green | `server/tests/` |
| ✅ | Bind-safety, DB migration + FK cascade | `tests/config.test.ts`, `tests/db.test.ts` |
| ✅ | Password/TOTP/JWT edge cases (tampering, cross-secret, wrong audience, expiry, file-mode 0600) | `tests/auth.test.ts` |
| ✅ | Auth HTTP routes including peek-retry TOTP, replay rejection, cookie attributes, user enumeration parity | `tests/auth-routes.test.ts` |
| ✅ | Session + project stores: stats, archive filtering, per-session event seq isolation, payload JSON roundtrip, FK cascade | `tests/sessions-store.test.ts` |
| ✅ | Deterministic Agent SDK → RunnerEvent translation (15 cases covering every block kind + malformed input) | `tests/agent-runner.test.ts` |
| ✅ | SessionManager lifecycle, status transitions, grant-based auto-approval | `tests/session-manager.test.ts` |
| ✅ | Session REST routes (path validation, duplicate path 409, archive, events, project rename + delete with sessions-FK guard, PATCH session title/model/mode with live-runner mode propagation, archived 409, empty-body 400, running-model warning, grants list + revoke with scope + 404) | `tests/session-routes.test.ts` |
| ✅ | Filesystem browse routes: auth gate, abs-path validation, 404 / 403 error paths, sort + flags, parent-null at root, symlinks are not followed | `tests/browse.test.ts` |
| ✅ | Slash-commands scanner + route: auth gate, built-ins-only when `~/.claude/commands` missing, user-command parsing (frontmatter / heading / plain line / null), project-command opt-in via `projectId`, unknown `projectId` soft-ignored. Uses an injected `userClaudeDir` tmp to avoid touching the host user's real `~/.claude/` | `tests/slash-commands.test.ts` |
| ✅ | WebSocket end-to-end over a real port (auth gate, hello_ack, broadcast isolation, permission decision round-trip, bad-frame recovery) | `tests/ws.test.ts` |
| ✅ | Tool grants: signature conventions, session-vs-global scope, idempotent insert, revoke, FK cascade | `tests/grants.test.ts` |
| ✅ | Permission summary content for every supported tool + missing-field edge cases | `tests/permission-summary.test.ts` |
| ✅ | Static web serving: index at /, immutable asset cache, SPA fallback for GET, /api 404s stay JSON, non-GET doesn't fall back, /api/health works alongside static | `tests/static.test.ts` |
| ⬜ | Frontend unit/component tests — none yet (mockup + visual review cover this for MVP) |  |

## Operational details

| Status | Feature | Where |
|---|---|---|
| ✅ | Typed shared contract in `@claudex/shared` — WS frames, HTTP DTOs, enums; both sides import from there | `shared/src/` |
| ✅ | Repo pushes to `https://github.com/ahaostudy/claudex.git` (main); commits co-sign Claude | git log |
| ⬜ | Dockerfile / one-liner install script | — |
| ⬜ | Telemetry / metrics endpoint | — (intentionally not doing this for MVP) |

---

## Not started (candidates for P4+)

- **P4** — git worktree creation on session start, parallel sessions per project, branch pickers, PR link-out
- **P5** — `/compact`, `/btw` side chat, usage/context panel, sticky virtual-keyboard row for the composer pickers
- **P6** — routines (scheduled tasks) with catch-up on wake
- **P7** — PR monitoring, auto-fix / auto-merge, preview (embedded browser), integrated terminal
- **P8** — Skills / Plugins / Connectors management UI, CLAUDE.md editor, env-var editor, global settings (2FA + paired browsers + audit log)
- **P9** — Docker image, signed release binaries, dashboards

---

## How to keep this file honest

- Every commit that adds a user-visible behavior, a new API surface, or moves
  an item between the three tiers **must** update the corresponding row in this
  file in the same commit.
- Every commit that deletes a feature must remove (or downgrade) its row.
- If you introduce a capability on the backend but intentionally don't expose
  it yet, add it as 🟡 with a one-line note on what's missing. That way nobody
  re-implements it or misses the last 10%.
- Don't reorganize the doc without a reason — stable anchors let humans and
  agents reference specific rows in review.
