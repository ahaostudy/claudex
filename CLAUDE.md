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

## MVP scope (P0 → P3)

- **P0**: scaffolding, both packages run.
- **P1**: `claudex init` + login + TOTP + session cookie.
- **P2**: create session → spawn claude → stream text both ways.
- **P3**: permission prompts + diff rendering for Edit/Write tools.

After P3 we stop and wait for user validation before touching P4+.

## Don'ts

- Don't introduce Prisma / Drizzle / a full ORM — hand-written SQL + better-sqlite3 is fine and faster to iterate.
- Don't add TLS in-process. The user terminates TLS outside.
- Don't add telemetry/analytics.
- Don't silently truncate messages, diffs, or file content.
