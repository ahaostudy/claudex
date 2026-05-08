# claudex · Features

> Living ledger of what actually ships. Updated in the **same commit** as the
> feature that changes it. If a behavior exists in code but isn't reflected
> here, that's a bug — either the doc or the code is wrong.

Three status tiers:

- ✅ **Ready** — end-to-end working, accessible from the UI a user sees.
- 🟡 **Partial** — backend or scaffold exists, UI is missing or thin. Safe to
  use from the API; users won't see it yet.
- ⬜ **Planned** — listed so nobody re-plans it from scratch, but not started.

Last updated: see the git log of this file. Current revision lists **85 shipped
behaviors** and **237 backend tests**.

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
| ✅ | `POST /api/auth/change-password` — logged-in only. Requires the caller's current password (401 `invalid_credentials` on mismatch), min-8 on new password (400 `bad_request`), rejects identical-to-current (400 `same_password`). On success rotates the bcrypt hash and issues a fresh session cookie so the caller's tab keeps working. The JWT secret is not rotated, so other tabs' old cookies remain valid until their own `exp` — we don't maintain a revocation list yet | `server/src/auth/routes.ts`, `server/src/auth/index.ts` (`UserStore.setPasswordHash`) |
| ✅ | `GET /api/user/env` — logged-in only. Read-only reflection of the user's Claude CLI environment: the session user, `claudeDir` (absolute `~/.claude`), `settingsReadable`, and a merged plugin list keyed by `<plugin>@<marketplace>` — union of `~/.claude/settings.json` `enabledPlugins` and `~/.claude/plugins/installed_plugins.json`. Each entry carries `name`, `marketplace`, `version`, `installPath`, `enabled`. Missing or malformed files degrade gracefully rather than erroring | `server/src/sessions/user-env.ts` |
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
| ✅ | Plugin commands — driven by `~/.claude/plugins/installed_plugins.json`. For each installed plugin we scan `<installPath>/commands/*.md`; multiple installed versions of the same plugin de-duplicate to the most recently updated install (by `lastUpdated`, else `installedAt`). Missing or malformed manifest is swallowed silently rather than 500-ing. Tagged `kind: "plugin"`; `source` points at the absolute `.md` path | `server/src/sessions/slash-commands.ts` (`scanPluginCommands`) |

## Sessions

| Status | Feature | Where |
|---|---|---|
| ✅ | `POST /api/sessions` — create. Body: `projectId`, `model`, `mode`, `title?`, `worktree` (currently a flag only; worktree wiring is planned) | `server/src/sessions/routes.ts` |
| ✅ | `GET /api/sessions` — list. `?project=<id>` scopes to one project; `?archived=1` includes archived | same |
| ✅ | `GET /api/sessions/:id` — fetch one | same |
| ✅ | `GET /api/sessions/:id/events?sinceSeq=N` — replay persisted events | same |
| ✅ | `POST /api/sessions/:id/archive` — mark read-only | same |
| ✅ | `POST /api/sessions/:id/side` — spawn a `/btw` child session that branches off an existing session. Copies the parent's `projectId` + `model`, defaults `mode` to `plan` (so side chats can't mutate the working tree unless the user explicitly flips it), and sets `parent_session_id` on the new row. Idempotent: if the parent already has an active (non-archived) side chat the existing child is returned instead of creating a duplicate. `409 archived` if the parent is archived, `404` if it doesn't exist. Paired `GET /api/sessions/:id/side` returns the active child or `null`. Side chats are hidden from the default session list (`parent_session_id IS NOT NULL`) so they don't clutter Home | `server/src/sessions/routes.ts`, `server/src/sessions/store.ts` |
| ✅ | `sessions.parent_session_id` — SQLite migration id=3, `TEXT REFERENCES sessions(id) ON DELETE CASCADE`. Deleting the parent cascades through every `/btw` child. Non-null rows are excluded from `list()` / `listByProject()` by default; `listChildren(parentId)` fetches a single parent's side chats | `server/src/db/index.ts`, `server/src/sessions/store.ts` |
| ✅ | `PATCH /api/sessions/:id` — partial update (`title`, `model`, `mode`). `mode` changes are pushed into the live runner via `setPermissionMode`; `model` changes are DB-only and the response carries `warnings: ["model_change_applies_to_next_turn"]` when a runner is already attached. Refuses `409 archived` on archived sessions and `400 bad_request` on empty bodies (at least one field required) | same |
| ✅ | Every event gets a monotonic per-session `seq` and is written to `session_events` (payload as JSON) | `server/src/sessions/store.ts` |
| ✅ | Aggregate stats on the session row (messages, files changed, +/− lines, contextPct) bumpable via `bumpStats` | same |
| ✅ | `worktree: true` creates a `<project>/.claude/worktrees/<session>` worktree on a new `claude/<slug>-<suffix>` branch; `false` keeps cwd at project root. Non-git project rejects with 400 `not_a_git_repo`. Archive cleans up the worktree but leaves the branch for manual disposition | `server/src/sessions/worktree.ts`, `server/src/sessions/routes.ts` |
| 🟡 | `filesChanged` / `linesAdded` / `linesRemoved` plumbing exists but isn't populated — counters will always read 0 until wired into tool_result parsing | same |
| 🟡 | Auto-title from the first user message: if the session has no prior `user_message` events, is not a side chat, and its current title is empty / `"Untitled"` / ≤3 words (placeholder-ish), `SessionManager.sendUserMessage` persists a new title derived from the first line of the message (trim, take first line, cap at 60 chars, snap to last word boundary if feasible, single-char ellipsis `…`). Live broadcast is TBD — updated title only surfaces on the next Home refresh until the WS shell refactor / global sessions channel lands | `server/src/sessions/manager.ts` |

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
| ✅ | Agent SDK spawned with `thinking: { type: "adaptive", display: "summarized" }` so Opus 4.7 forwards summarized thinking text to the runner (default display is `"omitted"`, which keeps the model thinking silently). This is what makes Verbose view-mode show anything beyond Normal — without it both modes render identically for the vast majority of turns | `server/src/sessions/agent-runner.ts` |
| ✅ | **Side-chat context injection** — when a session has `parent_session_id` set (a `/btw` child) and has never spawned an SDK conversation before, the manager synthesizes a context seed from the parent's `user_message` + `assistant_text` events (tool calls / thinking stripped so the child isn't drowned in noise) and pushes it to the SDK as a synthetic first user message. Seed never hits the child's `session_events` log — the transcript only shows what the user actually typed. Resumes skip the seed because the SDK already has the full history | `server/src/sessions/manager.ts` |
| ✅ | **User-message broadcast** — `SessionManager.sendUserMessage` broadcasts a manager-synthesized `user_message` RunnerEvent (translated to a `ServerUserMessage` WS frame as `{type, sessionId, content, createdAt}`) so every tab subscribed to the session sees the user's turn the moment it lands, not after `turn_end`. The originating tab receives its own broadcast and reconciles it against its local optimistic echo (match on content + `createdAt` within 3s → flip `serverAcked`) rather than rendering a duplicate. Other tabs insert a fresh piece above any trailing `pending` placeholder | `server/src/sessions/manager.ts`, `server/src/transport/ws.ts`, `web/src/state/sessions.ts` |

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
| ✅ | **Global sessions channel**: every authenticated socket automatically joins a global broadcast set on `hello_ack`. Cross-session frames (`session_update`, `user_message`) are delivered to both per-session subscribers *and* the global set, so Home/list screens get live status dots without per-session `subscribe` frames. Turn-scoped frames (`assistant_text_delta`, `thinking`, `tool_use`, `tool_result`, `permission_request`, `turn_end`) still go only to explicit subscribers — idle list tabs don't get firehosed with transcript content | `server/src/transport/ws.ts` |
| ✅ | Malformed frames return a typed error frame; the socket stays open | same |
| ✅ | Auto-reconnecting WS client on the web side with exponential-ish backoff capped at 1s | `web/src/api/ws.ts` |
| 🟡 | `hello` carries a per-session `resume: {sessionId: lastSeq}` map so the server can replay missed events on reconnect — schema and storage are in place but the server-side replay is not wired yet (reconnect today relies on `/api/sessions/:id/events` as history backfill) | `server/src/transport/ws.ts` |

## Terminal

| Status | Feature | Where |
|---|---|---|
| ✅ | `GET /pty` WebSocket endpoint — authenticated via the session cookie, attaches a `node-pty` subprocess rooted in the session's cwd (worktree path if present, else project root). Shell is `$SHELL` with a `/bin/zsh` / `/bin/bash` fallback; the client cannot pick the shell or inject env (server-side only, plus `TERM=xterm-256color`). JSON frames: server → `{data}` / `{exit, exitCode, signal}` / `{error, code, message}`; client → `{data}` / `{resize, cols, rows}`. One PTY per session — a second concurrent attach for the same `sessionId` is refused with `{error: "busy"}`. Archived sessions refuse with `archived`, unknown sessions with `not_found`. PTY is killed on socket close / error; socket is closed on PTY exit | `server/src/transport/pty.ts` |
| ✅ | TerminalDrawer in the Chat header — button next to Settings. Mounts an `@xterm/xterm` terminal with fit-addon, JetBrains Mono 13px, light palette matching the app canvas. Opens as a full-screen bottom sheet on mobile and a lower-right panel on desktop. Header shows the cwd and a live/connecting/closed/error indicator. ResizeObserver drives `fit + resize` frames so the PTY honors the actual viewport size. No auto-reconnect — a PTY session is stateful and silent reconnects would be worse than visible breakage | `web/src/components/TerminalDrawer.tsx`, `web/src/screens/Chat.tsx` |

## Web UI

| Status | Feature | Where |
|---|---|---|
| ✅ | Login screen with 2-step flow (credentials → 6-digit TOTP). Auto-clears the TOTP input on wrong code so the next attempt doesn't concatenate | `web/src/screens/Login.tsx` |
| ✅ | **AppShell** (`components/AppShell.tsx`) — global navigation frame used by every non-chat, non-login screen. Mobile: fixed bottom tab bar (h-58px, `bg-canvas/95 backdrop-blur`, active = 3px klein underline pill) with four tabs **Sessions · Routines · Alerts · Settings**. Desktop (≥md): 260px left sidebar with logo, same four nav items (active = `bg-canvas shadow-card border border-line`), a Projects list sourced from `/api/projects` with per-project session counts, and a pinned user profile card at the bottom. Chat and Login intentionally bypass AppShell — they need full viewport for the composer and pairing screen respectively | `web/src/components/AppShell.tsx`, `web/src/App.tsx` |
| ✅ | Routing: `/` redirects to `/sessions`; `/sessions`, `/routines`, `/alerts`, `/settings` each wrap their screen in AppShell with the matching tab highlighted; `/session/:id` is the chat; `/login` is standalone. Unknown paths redirect to `/sessions` | `web/src/App.tsx` |
| ✅ | Home (`/sessions`): session list **grouped by project** with sticky group headers (klein dot + mono project name + session count), matching mockup s-02. Inside each group, session cards show status dot (idle/running/awaiting/archived/error), title, branch/model/mode. Groups with zero sessions are hidden. Group ordering is newest-session-first; within a group, sessions are newest-first by `lastMessageAt ?? updatedAt`. Header buttons: live WS connection indicator, projects-management gear, New session | `web/src/screens/Home.tsx` |
| ✅ | **Project filter from the sidebar**: clicking a project row in the desktop sidebar navigates to `/sessions?project=<id>`, which filters the Home list down to that project's group and shows a "× clear filter" pill under the header. An "All projects" row at the top of the Projects list clears the filter (`/sessions` with no query string). The mobile tab-bar Sessions button also clears the filter because it navigates to `/sessions`. The sidebar project row for the currently filtered project renders in the active pill style | `web/src/screens/Home.tsx`, `web/src/components/AppShell.tsx` |
| ✅ | Routines (`/routines`): full-page version of the old RoutinesSheet, reachable from the tab bar. Same list + editor dialog for cron preset picking, model/mode selection, run now, pause/resume, delete | `web/src/screens/Routines.tsx` |
| ✅ | Alerts (`/alerts`): placeholder screen under AppShell. No backend alerts surface yet, so the page renders an honest empty state explaining that permission prompts currently live inline in each chat | `web/src/screens/Alerts.tsx` |
| ✅ | New-session bottom sheet: existing-project picker **and** "+ add new project" row coexist (no more mutual-exclusion bug); title input, model pills (Opus 4.7 / Sonnet 4.6 / Haiku 4.5), 4-way permission mode selector. Name auto-defaults to the folder's last segment if left blank | `web/src/screens/Home.tsx` |
| ✅ | **Folder picker** (`FolderPicker.tsx`) behind the "Browse" button — full-screen on mobile, modal on desktop. Walks the host filesystem via `/api/browse`, with Home/Up buttons, dotfile toggle, dirs-first list, "Select this folder" confirms at the current path | `web/src/components/FolderPicker.tsx` |
| ✅ | **Project management sheet** (gear button in the Home header) — lists every project, inline rename, delete with friendly 409 `has_sessions` handling that tells the user to archive/delete sessions first | `web/src/screens/Home.tsx` |
| ✅ | Chat screen: user messages as ink bubbles, assistant as flowing prose, thinking in an italic left-rule block, tool_use chip with truncated input summary, tool_result in a mono block (error-tinted when `isError`). **Shell layout**: flex-column with `h-[100dvh]`, so messages scroll inside their own pane and the composer stays pinned to the bottom of the viewport (fixes the old bug where the composer scrolled off with the transcript). Chat intentionally does **not** render AppShell — every vertical pixel goes to the transcript + composer | `web/src/screens/Chat.tsx` |
| ✅ | **Desktop three-column Chat layout (≥ md)** — the Chat screen spreads across a 220px sessions rail · fluid center · 300px tasks rail (mockup s-04 lines 942–1100). Left rail shows every non-archived session with status dot + title + branch/worktree subline; the active one gets the card treatment, the others are clickable hover rows that navigate via `<Link>`. Rail footer reports live WS connection (`connected` / `offline · retrying`). Hidden below md, so the mobile Chat layout is unchanged | `web/src/components/ChatSessionsRail.tsx`, `web/src/screens/Chat.tsx` |
| ✅ | **Desktop tasks rail** — right-hand 300px panel listing in-flight and recently-completed tool calls as cards (status dot: running = green/pulse, awaiting = warn, done = ink-faint; body shows the tool's most relevant input field — command / file_path / pattern / url / query — or a truncated JSON fallback). Pending `permission_request` pieces surface as "awaiting you" cards. Footer renders a Context-window donut + `lastTurnInput / contextWindow(model)` using the same math as the Usage panel. Collapsible via a `PanelRight` toggle in the desktop chat header; state persists in `localStorage` under `claudex.chat.tasksRail`. No dedicated "task" abstraction server-side — purely a live view derived from existing `tool_use` / `tool_result` / `permission_request` pieces | `web/src/components/ChatTasksRail.tsx`, `web/src/screens/Chat.tsx`, `web/src/lib/usage.ts` |
| ✅ | **Chat header (mobile)**: back chevron → `/sessions`, title + meta line (status dot · project · model · mode), context ring → Usage panel, three-dot `MoreVertical` → bottom sheet with view-mode picker, session settings, terminal, and /btw. Replaces the old stacked row of ViewMode / ContextRing / Stop / /btw / Settings2 / Terminal buttons | same |
| ✅ | **Chat header (desktop ≥md)**: status dot + title/meta on the left; right rail is ViewMode dropdown, Model pill, Permission-mode pill, context ring, /btw, session settings, terminal, and a `PanelRight` toggle that opens / closes the tasks rail. Model and permission-mode pills are real dropdowns bound to `PATCH /api/sessions/:id` — no round-trip through the session settings sheet for the common case | same |
| ✅ | **Composer chip rail** above the composer (mockup 918-924): horizontally scrolling row of five chips — `/Slash`, `@File`, `Attach` (disabled, not wired), `/btw`, `/compact`. Slash/File open the same pickers as typing the sigils; /btw opens the side-chat drawer; /compact injects the literal token into the textarea | same |
| ✅ | **Send ↔ Stop button swap**: the single circular action button in the composer swaps between an arrow Send (idle) and a red `StopCircle` (when `session.status` is `running` or `awaiting`). Interrupt flows through the same `ClientInterrupt` WS frame as before. Evicts the previous red Stop square from the chat header | same |
| ✅ | Permission card in-thread with Allow-once / Always / Deny buttons, diff preview for Edit/Write/MultiEdit | same |
| ✅ | Optimistic echo of user messages (shown before the WS ack) | `web/src/state/sessions.ts` |
| ✅ | **Inline "claude is thinking" placeholder** — after each user send the transcript gets a `pending` UI piece with three bouncing dots so the user can tell the request is alive. Cleared by the first substantive WS frame (`assistant_text_delta` / `thinking` / `tool_use` / `tool_result` / `permission_request` / `turn_end` / `error`) or a `session_update` back to `idle` / `error` / `archived`. Flips to a red "no response in 30s" notice if nothing arrives in 30s — but doesn't block the user from typing or hitting Stop. Refresh-resilient: entering a Chat page whose `session.status` is `running` or `awaiting` seeds the same placeholder without waiting for a user send. Paired with a second-line note that the reply won't stream word-by-word (SDK limitation, see `memory/project_streaming_deferred.md`) | `web/src/screens/Chat.tsx` (`PendingBlock`), `web/src/state/sessions.ts` |
| ✅ | **Stop button in the composer** — when `session.status` is `running` or `awaiting` the round Send arrow in the composer flips to a red `StopCircle` icon. Sends a `ClientInterrupt` WS frame which the server routes to `SessionManager.interrupt` → `AgentRunner.interrupt` → `Query.interrupt` on the SDK. Single state-swapped button — no twin buttons side-by-side | `web/src/screens/Chat.tsx`, `server/src/transport/ws.ts`, `server/src/sessions/agent-runner.ts` |
| ✅ | **Queue-while-busy composer** — the send button only requires non-empty text (never gated on session state). Messages typed while claude is still processing are handed to the SDK's async-iterable input queue and processed after the current turn; the placeholder in the textarea reads "Type while claude thinks — will queue…" to set expectations | `web/src/screens/Chat.tsx`, `server/src/sessions/agent-runner.ts` |
| ✅ | Transcript is reconstructed from both persisted events (initial load via `/api/sessions/:id/events`) and live WS frames, unified into a single UI piece list | same |
| ✅ | Sign out clears the session cookie and returns to the login screen | `web/src/screens/Home.tsx` |
| ✅ | **Composer pickers** — typing `@` after whitespace pops a file-mention sheet (reuses `/api/browse`, defaults to the session's project root, inserts `@<relative>` or `@<abs>` fallback outside the root); typing `/` at the start of a line pops a slash-command sheet populated at mount from `GET /api/slash-commands?projectId=<id>` — merges the CLI built-ins, the user's `~/.claude/commands/*.md`, and the active project's `.claude/commands/*.md`, each entry tagged with its `kind` shown as a badge. Network/auth failure falls back to a tiny built-in list (`help / clear / compact / review`) so the picker is never empty. Both sheets share the s-09 bottom-sheet language. Side-rail icons also open the pickers explicitly | `web/src/screens/Chat.tsx`, `web/src/components/SlashCommandSheet.tsx`, `web/src/components/FileMentionSheet.tsx`, `web/src/lib/slash-commands.ts`, `web/src/api/client.ts` |
| ✅ | Session settings side sheet (gear button in the desktop Chat header, or under the mobile three-dot menu) — edit title, swap model (Opus 4.7 / Sonnet 4.6 / Haiku 4.5), switch permission mode (Ask / Accept / Plan / Bypass), read-only workspace panel (branch + worktree path placeholder for P4), and "Approved in this session" list with per-grant Revoke. Model change mid-run shows a yellow "applies to next turn" notice. The desktop header now also surfaces model + mode as inline pill dropdowns for quick changes, wired to the same `PATCH /api/sessions/:id` endpoint | `web/src/components/SessionSettingsSheet.tsx` + `web/src/screens/Chat.tsx` |
| ✅ | **`/btw` side chat** — reachable from the composer chip rail and the desktop Chat header (and the mobile three-dot menu). Opens a lateral conversation that reads the parent thread but never writes back. Mobile: bottom sheet covering ~65% of the viewport so the main thread stays peekable above; desktop: right-rail panel with an orange left border and "side chat · /btw" badge per mockup s-11. One drawer per main session; re-opening `/btw` reuses the existing child session (conversation is preserved). "Archive & start new" button wipes the current child and creates a fresh one. Composer is deliberately lean — no `/` or `@` triggers, because /btw is for quick questions, not actions. Defaults to `plan` mode so the model can't accidentally edit files from the side lane | `web/src/components/SideChatDrawer.tsx`, `web/src/screens/Chat.tsx` |
| ✅ | **View modes (Normal / Verbose / Summary)** — stacked radio-card picker matching mockup s-07 (lines 1390–1431): caps label + display heading + three rows each with a filled-klein/empty-line radio, title, and one-line description, plus a footer hint (`⌃O` to cycle · "Applies only to this session"). Rendered as a bottom sheet on mobile (with backdrop blur over the thread) and an anchored popover on desktop; same inner panel in both. Opened from the `Normal ⌄` header pill on desktop and the three-dot menu on mobile. **Normal** collapses non-diff tool_use calls to single-line chips (click to expand to full pretty-printed input), truncates tool_result to 1200 chars with a "show N more chars" toggle, hides thinking blocks entirely. **Verbose** expands every piece, never truncates tool_result, and surfaces thinking blocks (requires the Agent SDK to be started with `thinking.display: "summarized"` — see the Chat-loop row). **Summary** keeps only user messages + the final `assistant_text` of each assistant turn and appends an **Outcome** card (driven by `session.status`) and a **Changes** card that aggregates `Edit`/`Write`/`MultiEdit` tool calls into per-file `+`/`−` line totals (PR card from mockup s-07 is still planned — no git integration yet). Session-scoped, no persistence across reloads | `web/src/screens/Chat.tsx`, `web/src/components/ViewModePicker.tsx`, `web/src/state/sessions.ts` |
| ✅ | Markdown rendering for assistant text via `react-markdown` + `remark-gfm` — headings, bold/italic, strikethrough, inline & fenced code (Tailwind-styled, language tag, no syntax highlighter), lists, task lists (GFM `- [ ]` / `- [x]` → disabled checkboxes), blockquotes, tables, links (external `href` opens in a new tab with `rel="noopener noreferrer"`). User messages are kept verbatim — no markdown processing — so literal `**` or backticks the user typed render as entered. `tool_result` blocks are also verbatim (mono/pre-wrap), because tool output is usually command stdout, not prose | `web/src/components/Markdown.tsx`, `web/src/screens/Chat.tsx` |
| ✅ | Context ring in the chat header opens a Usage panel with current-session token counts (input/output/total) and a cost estimate using a front-end pricing table. Aggregated by model when a session spanned multiple models. The big ring shows a client-side context % estimate computed as `lastTurnInput / contextWindowTokens(model)` — the most recent `turn_end`'s `inputTokens` over the known per-model window (every 4.x model is 200k today). The chat-header mini-ring shares the same computation and refetches `/events` on piece-length changes. Plan-period usage and cross-session charts are not yet shown (single-session data only) | `web/src/components/UsagePanel.tsx`, `web/src/lib/usage.ts`, `web/src/lib/pricing.ts`, `web/src/screens/Chat.tsx` |
| ✅ | **Import existing CLI sessions** — Home header "download" button opens a sheet that lists sessions under `~/.claude/projects/<cwd-slug>/*.jsonl` (already-adopted sessions are hidden). `GET /api/cli/sessions` streams each file's first few lines to extract the first user message as a title; `POST /api/cli/sessions/import` idempotently creates `sessions` rows with `sdk_session_id` set so the existing resume path picks up from where CLI left off. The slug↔cwd decoding is the CLI's own `/` ↔ `-` scheme | `server/src/sessions/cli-discovery.ts`, `server/src/sessions/cli-import.ts`, `server/src/sessions/cli-routes.ts`, `web/src/components/ImportSessionsSheet.tsx`, `web/src/screens/Home.tsx` |
| ✅ | **Terminal drawer** — reachable from the desktop Chat header and the mobile three-dot menu. Not in the mockup, kept as an extra affordance for power users; PTY attached to the session cwd | `web/src/components/TerminalDrawer.tsx`, `web/src/screens/Chat.tsx` |
| 🟡 | Global settings page partially shipped — Account (change password), Security (2FA status only — recovery-code rotation and paired-browser list still planned), Appearance (light theme only — dark + text-size toggles rendered as disabled placeholders), Plugins (read-only view of `~/.claude/settings.json` `enabledPlugins` merged with `~/.claude/plugins/installed_plugins.json`). No audit log, no exposure panel | `web/src/screens/Settings.tsx`, `server/src/auth/routes.ts`, `server/src/sessions/user-env.ts` |

## Tests

| Status | Feature | Where |
|---|---|---|
| ✅ | 237 backend tests, vitest, all green | `server/tests/` |
| ✅ | Bind-safety, DB migration + FK cascade | `tests/config.test.ts`, `tests/db.test.ts` |
| ✅ | Password/TOTP/JWT edge cases (tampering, cross-secret, wrong audience, expiry, file-mode 0600) | `tests/auth.test.ts` |
| ✅ | Auth HTTP routes including peek-retry TOTP, replay rejection, cookie attributes, user enumeration parity | `tests/auth-routes.test.ts` |
| ✅ | Session + project stores: stats, archive filtering, per-session event seq isolation, payload JSON roundtrip, FK cascade | `tests/sessions-store.test.ts` |
| ✅ | Deterministic Agent SDK → RunnerEvent translation (15 cases covering every block kind + malformed input) | `tests/agent-runner.test.ts` |
| ✅ | SessionManager lifecycle, status transitions, grant-based auto-approval | `tests/session-manager.test.ts` |
| ✅ | Session REST routes (path validation, duplicate path 409, archive, events, project rename + delete with sessions-FK guard, PATCH session title/model/mode with live-runner mode propagation, archived 409, empty-body 400, running-model warning, grants list + revoke with scope + 404) | `tests/session-routes.test.ts` |
| ✅ | Filesystem browse routes: auth gate, abs-path validation, 404 / 403 error paths, sort + flags, parent-null at root, symlinks are not followed | `tests/browse.test.ts` |
| ✅ | Slash-commands scanner + route: auth gate, built-ins-only when `~/.claude/commands` missing, user-command parsing (frontmatter / heading / plain line / null), project-command opt-in via `projectId`, unknown `projectId` soft-ignored. Uses an injected `userClaudeDir` tmp to avoid touching the host user's real `~/.claude/` | `tests/slash-commands.test.ts` |
| ✅ | WebSocket end-to-end over a real port (auth gate, hello_ack, broadcast isolation, permission decision round-trip, interrupt round-trip, bad-frame recovery, global sessions channel delivers cross-session frames to unsubscribed tabs while turn frames stay gated) | `tests/ws.test.ts` |
| ✅ | Tool grants: signature conventions, session-vs-global scope, idempotent insert, revoke, FK cascade | `tests/grants.test.ts` |
| ✅ | Permission summary content for every supported tool + missing-field edge cases | `tests/permission-summary.test.ts` |
| ✅ | Static web serving: index at /, immutable asset cache, SPA fallback for GET, /api 404s stay JSON, non-GET doesn't fall back, /api/health works alongside static | `tests/static.test.ts` |
| ✅ | Worktree lifecycle: `isGitRepo` classification (dir / file / missing), `createWorktree` branch collision fallback, `removeWorktree` cleanup, POST /api/sessions `worktree: true` round-trip on a tmp git repo, 400 `not_a_git_repo` on non-git project, archive path removes the worktree dir, archive tolerates a pre-deleted worktree dir | `tests/worktree.test.ts` |
| ✅ | `/btw` side chat: POST + GET routes (create copies parent project/model and defaults to `plan`, persists `parent_session_id`, cascades on parent delete, 404 on unknown parent, idempotent re-POST reuses the active child), default session list hides children, SessionManager context seed injection (strips tool/thinking noise, seeds only once on first spawn, top-level sessions unaffected, seed never written to the child's event log) | `tests/side-sessions.test.ts` |
| ✅ | Routines CRUD + scheduler: REST round-trip (POST / GET / PATCH / DELETE), `invalid_cron` on bad expression, `project_not_found` on unknown project, `POST /:id/run` spawns a session and delivers the prompt. Scheduler fires on elapsed `next_run_at` (capturing fake timer — no `vitest.useFakeTimers()` needed), paused routines skip, deleted routines stop firing, `reload()` rearms after cron edits, missed fires are logged and skipped (no catch-up), `fire()` direct-call advances `last_run_at` + `next_run_at`. `cron-parser` wrapper helpers (`isValidCron` / `computeNextRun`) | `tests/routines.test.ts` |
| ⬜ | Frontend unit/component tests — none yet (mockup + visual review cover this for MVP) |  |

## Routines

| Status | Feature | Where |
|---|---|---|
| ✅ | `routines` table (SQLite migration id=4) keyed on `id` with FK to `projects` (`ON DELETE RESTRICT`). Columns: `name`, `prompt`, `cron_expr`, `model`, `mode`, `status` (`active` / `paused`), `last_run_at`, `next_run_at`, `created_at`, `updated_at`. Two indexes: `status`, `project_id` | `server/src/db/index.ts` |
| ✅ | `RoutineStore` — same-shape API as `ProjectStore` / `SessionStore`: `create` / `list` / `listActive` / `findById` / `update` / `setStatus` / `setSchedule` / `setLastRun` / `delete` | `server/src/routines/store.ts` |
| ✅ | `RoutineScheduler` — single chained `setTimeout` anchored to the next-due active routine. On fire: creates a fresh session titled `"<name> · <timestamp>"` with the routine's project/model/mode, delivers `prompt` via `SessionManager.sendUserMessage`, rolls `last_run_at` + `next_run_at` forward, and rearms. `reload()` on any CRUD change. No catch-up: missed fires (server was down) are logged and the schedule is rolled forward to the next future slot. Uses `cron-parser@5` (`CronExpressionParser.parse`) to evaluate 5-field expressions in the host's local timezone. Injectable `now` / `setTimeout` / `clearTimeout` for deterministic tests | `server/src/routines/scheduler.ts` |
| ✅ | REST (login-gated): `GET /api/routines`, `GET /api/routines/:id`, `POST /api/routines` (400 `invalid_cron` on parse failure, 400 `project_not_found` on unknown project), `PATCH /api/routines/:id` (partial — same invalid-cron check), `DELETE /api/routines/:id`, `POST /api/routines/:id/run` ("Run now" — invokes `scheduler.fire()` and returns `sessionId`). Every mutating route calls `scheduler.reload()` | `server/src/routines/routes.ts` |
| ✅ | Routines reached from the bottom tab bar on mobile / sidebar nav on desktop (`/routines`). List with status dot, human-readable cron ("Every day at 9:00"), next-fire relative time; per-row Run now / Pause-Resume / Edit / Delete. Editor dialog has name, project picker (locked after create), prompt textarea, five cron presets (hourly / daily 9 / weekdays 9 / Mondays 9 / every 30m) + Custom cron field, model pills, 4-way permission mode selector. Invalid cron surfaces the server's `invalid_cron` as a friendly message. The old `RoutinesSheet` component is retired in favor of this full-page screen | `web/src/screens/Routines.tsx`, `web/src/App.tsx` |

## Settings

| Status | Feature | Where |
|---|---|---|
| ✅ | `/settings` route, reached from the tab bar on mobile / sidebar on desktop (AppShell wraps every non-chat, non-login screen). Four-tab layout — left rail on desktop, horizontal scroll strip on mobile. Tabs: Account / Security / Appearance / Plugins | `web/src/screens/Settings.tsx`, `web/src/App.tsx`, `web/src/components/AppShell.tsx` |
| ✅ | **Account** tab — username, createdAt, 2FA-enabled badge, and a "Change password" button that opens a modal. Modal enforces current password, new-password ≥ 8, and non-identity; surfaces server error codes (`invalid_credentials`, `same_password`, `bad_request`) in human words. On success the modal shows a "password updated — other tabs keep working until cookie exp" note | `web/src/screens/Settings.tsx` (`AccountPanel`, `ChangePasswordModal`) |
| ✅ | **Security** tab — honest about current scope: shows 2FA issuer + enabled state; "Regenerate recovery codes" rendered as a disabled placeholder with a hint to use `pnpm reset-credentials` for now. Paired-browsers list is called out as planned (we don't track individual JWT jtis yet) | same (`SecurityPanel`) |
| ✅ | **Appearance** tab — light theme marker with a disabled "Dark (soon)" pill and a disabled text-size slider, matching the mockup's affordance without lying about availability | same (`AppearancePanel`) |
| ✅ | **Plugins** tab — read-only reflection of `~/.claude/settings.json` `enabledPlugins` merged with `~/.claude/plugins/installed_plugins.json`. Shows `claudeDir`, settings-readable state, and each plugin with name / marketplace / version / enabled badge. Empty state explicitly says claudex does not install plugins itself. Zero mutation — fetched via `GET /api/user/env` | same (`PluginsPanel`) |

## Operational details

| Status | Feature | Where |
|---|---|---|
| ✅ | Typed shared contract in `@claudex/shared` — WS frames, HTTP DTOs, enums; both sides import from there | `shared/src/` |
| ✅ | Repo pushes to `https://github.com/ahaostudy/claudex.git` (main); commits co-sign Claude | git log |
| ⬜ | Dockerfile / one-liner install script | — |
| ⬜ | Telemetry / metrics endpoint | — (intentionally not doing this for MVP) |

---

## Not started (candidates for P4+)

- **P4** — parallel sessions per project surfaced in the UI, branch pickers, PR link-out
- **P5** — `/compact`, usage/context panel, sticky virtual-keyboard row for the composer pickers
- **P7** — PR monitoring, auto-fix / auto-merge, preview (embedded browser)
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
