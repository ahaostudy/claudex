# claudex

Remote Control for Claude Code — a browser front-end for the `claude` CLI on your own machine.

**Status:** pre-alpha. MVP in progress.

## Quick start (developer)

Prereqs: Node 20+, pnpm 9+, the `claude` CLI installed and logged in.

```sh
pnpm install
pnpm dev              # runs server (5179) and web (5173) in parallel
# first run only:
pnpm init             # interactive: set admin user, password, TOTP seed
```

Open `http://127.0.0.1:5173` on the same machine, or tunnel `127.0.0.1:5179` via Cloudflare Tunnel / Tailscale to reach it from your phone.

## What's inside

- `server/` — Fastify + WebSocket backend that spawns the local `claude` CLI via `@anthropic-ai/claude-agent-sdk`
- `web/` — React front-end, mobile-first, designed against `mockup/index.html`
- `shared/` — zod schemas and types shared across both
- `mockup/` — the high-fidelity static design spec

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## License

TBD (private project).
