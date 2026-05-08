# claudex

Remote Control for Claude Code — a browser front-end for the `claude` CLI on your own machine.

**Status:** pre-alpha. MVP in progress.

## Quick start (developer)

Prereqs: Node 20+, pnpm 9+, the `claude` CLI installed and logged in.

```sh
pnpm install
pnpm init --username=hao --password='set-a-strong-one'  # first time only
```

### Dev mode (two ports)

```sh
pnpm dev
```

This runs Vite at `http://127.0.0.1:5173/` and the Fastify server at `http://127.0.0.1:5179/`. Vite proxies `/api` and `/ws` to the server so the browser still only hits 5173.

### Single-port mode (build + serve) — recommended for tunnels

When you want to expose claudex over Cloudflare Tunnel / Tailscale / Caddy, you want one port:

```sh
pnpm serve   # = `pnpm build` then `pnpm start`
```

The server mounts the built web bundle from `web/dist`, falls through to `index.html` for SPA routes, and keeps `/api/*` and `/ws` intact. Everything lives on `http://127.0.0.1:5179/`. Point your tunnel at that one address.

Advanced: override the bundle path with `CLAUDEX_WEB_DIST=/abs/path/to/dist`, or disable static serving explicitly with `CLAUDEX_WEB_DIST=none` (useful when Vite is running in parallel).

## What's inside

- `server/` — Fastify + WebSocket backend that spawns the local `claude` CLI via `@anthropic-ai/claude-agent-sdk`
- `web/` — React front-end, mobile-first, designed against `mockup/index.html`
- `shared/` — zod schemas and types shared across both
- `mockup/` — the high-fidelity static design spec
- `docs/FEATURES.md` — living ledger of **what's actually built today** (ready / partial / planned)

See [CLAUDE.md](./CLAUDE.md) for architecture and conventions.

## License

TBD (private project).
