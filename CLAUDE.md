# claudex

> Remote Control for Claude Code — a browser front-end for the `claude` CLI on your own machine, designed mobile-first.

## What this project is (and isn't)

- **Is**: a self-hosted web service that runs on the same machine as your `claude` CLI and exposes it over HTTP + WebSocket so you can drive it from a phone. Mirrors the Claude Desktop *Code* tab in spirit; the goal is P0 parity — sessions, diffs, permission prompts, view modes, basic usage panel.
- **Is not**: a reimplementation of the Claude agent runtime. We **do not** call the Anthropic API directly. We spawn the user's `claude` CLI as a subprocess via `@anthropic-ai/claude-agent-sdk`, which gives us all the user's existing config (`~/.claude/`, MCP servers, skills, plugins, CLAUDE.md, OAuth tokens) for free.

If you find yourself reaching for the `@anthropic-ai/sdk` (Anthropic API client), stop — that's the wrong surface for this project. The right surface is `@anthropic-ai/claude-agent-sdk`.

## Repo layout

```
claudex/
├── mockup/       # static HTML mockup — design reference, not shipped
├── server/       # Node + TS backend  (@claudex/server)
├── web/          # React + TS frontend (@claudex/web)
├── shared/       # zod schemas + types shared by both (@claudex/shared)
├── pnpm-workspace.yaml
└── CLAUDE.md
```

`shared/` is the contract. If you add a field to a WS message, a session object, or an API response, it goes in `shared/` first and is imported by both sides. Do not duplicate type definitions across `server/` and `web/`.

## Tech stack

- **Backend**: Node 20 + TypeScript, Fastify + @fastify/websocket, better-sqlite3, bcrypt + otplib (TOTP) + jose (JWT), `@anthropic-ai/claude-agent-sdk`, pino
- **Frontend**: React 18 + TypeScript + Vite + Tailwind + Zustand + React Router v6
- **Package manager**: pnpm workspaces (pnpm 9+)

## Boundaries & conventions

- **Server binds to `127.0.0.1` only.** Public exposure is the user's responsibility (Cloudflare Tunnel / Tailscale / Caddy). Never bind `0.0.0.0` or ship a one-click tunnel.
- **All state lives under `~/.claudex/`** — SQLite DB, logs, runtime config. Never pollute `~/.claude/`.
- **Auth is mandatory from day one** — no dev-mode backdoor. Username + password + TOTP; JWT in httpOnly cookie; WS handshake checks the cookie.
- **Mobile-first UI.** Every screen is designed for a 390px viewport first; desktop is an adaptive expansion.
- **Dark side of WS**: every message is a discriminated union with `type` as the tag, defined in `shared/src/protocol.ts` with zod. No ad-hoc JSON on the wire.

## Feature ledger — keep `docs/FEATURES.md` honest

`docs/FEATURES.md` is the source of truth for *what claudex actually does today*. Three tiers: ✅ ready, 🟡 partial (backend exists, UI missing or thin), ⬜ planned.

**Hard rule: every commit that changes user-visible behavior, adds an API surface, or promotes/demotes something between tiers must update `docs/FEATURES.md` in the same commit.** If you add a server capability but choose not to expose it in the UI yet, file it as 🟡 with a one-line note on what's missing — that's how we stop future agents from either re-implementing it or leaving the last 10% forever.

Before you start a task: read `docs/FEATURES.md` first. It'll tell you whether the thing you're about to build already exists as a backend-only 🟡 that just needs wiring, rather than a fresh build.

## Deployment reality (read this before editing anything)

The user runs claudex on their own Mac and accesses it from their phone over
**HTTP through an frpc tunnel**. Two facts flow from this:

1. **The site is NOT a secure context.** `crypto.randomUUID`,
   `navigator.clipboard.writeText`, `PushManager`, `Notification`,
   `crypto.subtle`, `ServiceWorker` — all are either unavailable or silently
   broken. Any code that touches them needs a runtime-detect fallback:
   ```ts
   const id =
     typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
       ? crypto.randomUUID()
       : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
   ```
   Same shape for clipboard (fall back to hidden `<textarea>` + `document.execCommand("copy")`).
2. **The server process is the live product.** `pnpm dev` is not running —
   the user connects to a built + restarted server. If you ship code and
   don't rebuild + restart, the user sees stale behavior (or worse, broken
   schema mismatches between old server and new client). See "Iteration loop"
   below.

There is always an `frpc` process running that tunnels port 5179 to the
public URL. **Never kill frpc.** Only kill the node server when restarting.

## Iteration loop — every batch, in order

This is how you close a batch of changes. **No shortcuts, no reordering.**
Even for a one-line fix, walk the whole list — the one time you skip step 3
is the time a Vite-side type elision breaks the server build.

**Steps 4, 5, 6 are not optional.** A "done" batch is one that is
typechecked, tested, built, documented in `docs/FEATURES.md`, committed,
and pushed. Anything short of that is "in progress" and **must not be left
that way** — see "Working with agents" below for why: the user runs
multiple agents in parallel, and an uncommitted working tree from one
session is what makes another session walk into a mess of unfamiliar
unstaged files, unmerged index entries, and no clue what's theirs vs. a
sibling's. If you think "I'll commit after the next round of feedback,"
you are creating that mess. Commit and push now; iterate on top.

1. **`pnpm -r typecheck`** — shared + server + web all green.
2. **`pnpm --filter @claudex/server test`** — all green. `.skip` is allowed
   but call it out in the commit message.
3. **`pnpm --filter @claudex/web build`** — Vite build must succeed. This
   catches things typecheck misses (CSS, imports, bundle-only errors).
4. **Update `docs/FEATURES.md` if behavior changed** (see "Feature ledger"
   above). This is part of the commit, not a follow-up.
5. **Commit.** Message describes what changed, not how many agents ran.
   You do this yourself — do not ask first.
6. **Push through the user's proxy:**
   ```sh
   https_proxy=http://localhost:7890 http_proxy=http://localhost:7890 \
     git push origin main
   ```
   Outbound git/npm/curl always need the proxy; localhost does not. You
   do this yourself right after the commit — do not ask first.
7. **Wait for the user's go-ahead, then restart the server.** Restart is
   gated: after pushing, report the batch is ready and stop. Only when
   the user explicitly says to restart (e.g. "restart", "重启", "go") do
   you run the restart sequence below. This is because the user is
   driving live on mobile and picks the moment — an unsolicited restart
   can cut them off mid-task.

   When the user gives the word: **kill only the node process — leave
   frpc alone.** Use the restart script. It spawns a fully detached
   worker (Node `spawn({ detached: true, stdio: 'ignore' })`,
   cross-platform — works on macOS/Linux/Windows without `setsid`/`nohup`
   tricks) that waits for port 5179 to free up, then starts the new
   server. The worker is NOT a child of your shell / Claude / the old
   server, so killing the old server cannot cascade-kill the restart.
   ```sh
   SRV=$(lsof -ti :5179 -sTCP:LISTEN | head -1)
   node scripts/restart.mjs 5179   # detaches the relaunch worker, then returns
   kill $SRV                        # worker sees the port free and starts new server
   ```
   If you're logged in and the server is already up, you can instead hit
   the HTTP endpoint — it runs the same launcher internally and returns
   before exiting: `curl -b cookies.txt -X POST http://127.0.0.1:5179/api/admin/restart`.
   This is what claudex itself uses when Claude needs to restart the
   server it's running under (the old `kill + nohup` shell sequence
   deadlocked because Claude is a child of the server — killing the
   server killed Claude mid-command before `nohup ... &` finished
   detaching).

   **When Claude is the one triggering the restart** (mid-tool-call, because
   code just changed and the session needs the new server), the plain
   endpoint above is fine but leaves the triggering tool call rendering as
   a dangling "failed" in the chat transcript — the server dies before it
   can emit the `tool_result`. To avoid that, pass the current session id
   and tool_use id in the request body:
   ```sh
   curl -b cookies.txt -X POST http://127.0.0.1:5179/api/admin/restart \
     -H 'Content-Type: application/json' \
     -d '{"sessionId":"<claudex-session-id>","toolUseId":"<this-tool-use-id>"}'
   ```
   The server persists a `pending_restart_results` row before SIGTERMing
   itself. On the next boot, a sweep turns that row into a synthetic
   success `tool_result` event for the same `toolUseId`, force-idles the
   session, and deletes the row — so the chat UI shows a green tool result
   instead of a dangling one.

   For the Bash-path equivalent (same pattern, no cookie plumbing — reads
   `~/.claudex/cookies.txt` internally, falls back to plain restart.mjs if
   the HTTP call fails):
   ```sh
   node scripts/restart-self.mjs 5179 \
     --session-id <claudex-session-id> \
     --tool-use-id <this-tool-use-id>
   ```

   Then verify three things:
   - new pid listening on 5179: `lsof -ti :5179 -sTCP:LISTEN`
   - frpc pid unchanged: `pgrep -f 'frpc -c'` (remember it from before)
   - health 200: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5179/api/health`

Do not do any of: skip typecheck because "the change was small", push
without commit, restart without build, restart without the user's
explicit say-so, or leave the web bundle stale ("it'll pick it up next
time"). The user is driving this live — stale dist/ on a live server →
prod mismatch the moment they restart.

## Working with agents

The user prefers delegating implementation to sub-agents (Agent tool)
rather than direct edits. Pattern:

- **Lanes.** Assign each agent a file/dir lane with an explicit "Don't
  touch" list so parallel agents don't overwrite each other.
- **Paste the mockup inline.** If a change references `mockup/<file>.html`,
  paste the HTML snippet verbatim into the prompt. Do not assume the
  agent will read it carefully.
- **Paste the migration id.** If it's a DB change, `grep "id:"
  server/src/db/index.ts` first and write the next id into the prompt.
- **Remind agents about secure context.** Any agent writing frontend code
  that touches nonces, clipboard, crypto, or notifications should get the
  "HTTP not HTTPS" warning in their prompt.
- **Close the prompt with:** "typecheck / test / build must pass. Do NOT
  commit, push, or restart the server — I'll handle commit + push after
  reviewing, and the user gates restart." Sub-agents never touch git or
  the running server, even though the main Claude session does.
- **Side-branch QA agents don't block.** Spawn them in parallel with
  dev agents; their feedback rolls into the next batch, not this one.

### Parallel Claude sessions — you are not alone on this repo

The user routinely runs **multiple top-level Claude sessions against this
same checkout in parallel** (different phone tabs, different terminals,
different agents delegated from each). That means when you `git status`
you may see unstaged changes, untracked files, or even unmerged index
entries in files that **you have not touched in this session**. This is
normal. It is almost always a sibling session mid-work, not corruption.

The rule: **stay in your lane.**

- If `git status` shows modifications to files outside your current task,
  do NOT `git add` them, do NOT stash them away, do NOT `git checkout --`
  to "clean up", do NOT resolve conflicts in them. They belong to another
  session and overwriting them is destroying that session's work.
- If `git commit` / `git push` is blocked by someone else's dirty state
  (unmerged index entries, unstaged changes colliding with the push),
  **stop immediately** and report to the user. Do not try to force the
  commit through by stashing / resetting / checking out other files.
  The user will tell you whether to wait, whether to save your diff as a
  patch, or whether the sibling session is done and you can proceed.
- If you see unmerged entries (`git ls-files -u` non-empty) with no
  `.git/MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REBASE_HEAD`, that's a
  sibling's half-finished merge that the user paused. Leave it alone.
- When you stage files for commit, **name them explicitly** — `git add
  path/to/file1 path/to/file2`. Never `git add -A` or `git add .`; that
  is what sweeps sibling sessions' work into your commit and causes the
  cross-contamination the user is trying to avoid.

This is also why step 5+6 of the iteration loop ("commit" and "push") are
non-negotiable: every session that leaves its work uncommitted is leaving
a landmine for the next session. Close your batches.

## MVP scope (done)

P0–P3 are shipped. claudex now has auth + sessions + streaming + permission
prompts + diff rendering + most of P4/P5 (routines, queue, tags, search,
export, forking, terminal, …). Track current scope in `docs/FEATURES.md`,
not here — this section will drift.

## Don'ts

- Don't introduce Prisma / Drizzle / a full ORM — hand-written SQL +
  better-sqlite3 is fine and faster to iterate.
- Don't add TLS in-process. The user terminates TLS outside.
- Don't add telemetry/analytics.
- Don't silently truncate messages, diffs, or file content.
- **Don't use secure-context-only Web APIs without a fallback** (see
  "Deployment reality" above). This is the single most common regression
  agents introduce.
- **Don't write to `~/.claude/`.** That belongs to the CLI. claudex state
  is `~/.claudex/`, period. Reading `~/.claude/projects/*.jsonl` or
  `~/.claude/CLAUDE.md` is fine; writing is not.
- **Don't bind `0.0.0.0`** or ship a one-click public-exposure helper.
  Public exposure is the user's responsibility (frpc, Cloudflare Tunnel,
  Tailscale, Caddy in front).
- **Don't persist state only in process memory** for anything that should
  survive a restart. Watchdog timers, queue state, session status — all
  of these need a SQLite row so the boot sweep can re-arm them.
- **Don't bypass `shared/`.** A new WS frame or API field goes in
  `shared/src/protocol.ts` first (with zod), then both sides import it.
