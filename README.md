<div align="right"><sub><b>English</b> · <a href="./README_CN.md">中文</a></sub></div>

<p align="center">
  <img src="https://img.shields.io/badge/_-claudex-cc785c?style=for-the-badge&labelColor=faf9f5" alt="claudex" />
</p>

<h1 align="center">claudex</h1>

<p align="center"><em>Remote control for <a href="https://docs.anthropic.com/en/docs/claude-code/overview">Claude Code</a> — drive the <code>claude</code> CLI on your own machine from any browser. Mobile-first.</em></p>

<p align="center">
  <img alt="node" src="https://img.shields.io/badge/node-20%2B-3f9142?style=flat-square">
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-9%2B-cc785c?style=flat-square">
  <img alt="typescript" src="https://img.shields.io/badge/typescript-strict-1f1e1d?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-9a968e?style=flat-square">
  <img alt="platform" src="https://img.shields.io/badge/platform-mac%20%7C%20linux%20%7C%20windows-6b6862?style=flat-square">
</p>

---

## Why claudex

You already pay for Claude Code. You already trust its permission model, its memory files, its MCP servers, its plugins. The tool is excellent — except for the moment you step away from the keyboard.

**claudex doesn't replace Claude Code. It puts a cockpit around it.** A long-running coding task shouldn't tie you to your desk. Open your phone from anywhere and keep the session going: answer a permission prompt while waiting for coffee, queue the next three prompts from the train, watch the final build finish while the laptop is closed.

Everything still runs locally. Your API usage, your `~/.claude/` config, your `CLAUDE.md` files, your MCP servers — all inherited for free by spawning the real `claude` CLI as a subprocess. claudex is the *driver*, never the agent.

## What you actually get

<table>
<tr><td width="50%">
🧠 <b>One agent, many surfaces</b><br>
<sub>Chat transcript, subagent monitor, queue, routines, diff review — all live over one WebSocket.</sub>
</td><td width="50%">
📱 <b>Designed for a 390px phone first</b><br>
<sub>Desktop is an adaptive expansion, not the other way around. Bottom sheets, safe-area aware, iOS-keyboard-tuned.</sub>
</td></tr>
<tr><td>
🔐 <b>Auth that doesn't suck</b><br>
<sub>Username + password + TOTP on every fresh session. 10 single-use recovery codes printed once at init. httpOnly JWT, rate-limited.</sub>
</td><td>
🔍 <b>Full-text search across everything</b><br>
<sub>SQLite FTS5 over session titles and every message body. ⌘K from anywhere.</sub>
</td></tr>
<tr><td>
🌿 <b>Real git worktrees</b><br>
<sub>New sessions spawn on a branch inside an isolated worktree. Auto-rebase on create, auto-prune on archive.</sub>
</td><td>
🪞 <b>Permission prompts rendered right</b><br>
<sub>Not a modal dump — a dedicated card with blast-radius summary, inline diff preview, and a deep-link to the full Review screen.</sub>
</td></tr>
<tr><td>
🔁 <b>Fork any turn into a branch</b><br>
<sub>Click any event, fork from there. Explore an alternate path without polluting the original session's context.</sub>
</td><td>
📜 <b>Honest streaming</b><br>
<sub>The Agent SDK doesn't expose delta granularity, and we don't fake it. Three bouncing dots while claude is thinking, the reply lands as a whole message.</sub>
</td></tr>
<tr><td>
🎬 <b>Routines (scheduled prompts)</b><br>
<sub>Cron-backed automated turns with full permission + trust gating. Run the linter every morning, ship a nightly digest.</sub>
</td><td>
📚 <b>Queue mode</b><br>
<sub>Batch three, five, ten prompts and let claude chew through them sequentially. Edit order, pause, cancel.</sub>
</td></tr>
<tr><td>
🕳️ <b>/btw side chats</b><br>
<sub>Ask a quick question without disturbing the main context. Replies stream in a drawer; the main session never sees it.</sub>
</td><td>
🖥️ <b>Built-in terminal</b><br>
<sub>node-pty + xterm.js inside the same web UI. Real shell, real vim, real env. Mobile keybar for Esc / Ctrl / arrows.</sub>
</td></tr>
<tr><td>
🏷️ <b>Tags, pins, filters, view modes</b><br>
<sub>Organize sessions however you think. Three view modes: normal, verbose (full thinking blocks), summary (user turns + final replies + changes card).</sub>
</td><td>
📊 <b>Usage & alerts</b><br>
<sub>Per-session token ring, global usage panel with model breakdown, and a live Alerts tab for "needs your approval / errored / finished while you were elsewhere".</sub>
</td></tr>
</table>

## Install

### One-liner

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ahaostudy/claudex/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/ahaostudy/claudex/main/install.ps1 | iex
```

The installer checks for `git` / Node 20 / pnpm 9 / the `claude` CLI, offers to install the missing ones (never silently — every step is a prompt, no sudo unless you opt in), clones the repo to `~/claudex`, builds the web bundle, and walks you through the first-admin setup (username + hidden password prompt, then prints the TOTP QR and 10 recovery codes **shown once**). Flags: `--dir PATH` / `--branch NAME` / `--yes` / `--skip-init` / `--skip-build`. Env: `CLAUDEX_HOME`, `CLAUDEX_ASSUME_YES=1`.

### Manual

**Prereqs:** Node 20+, pnpm 9+, the `claude` CLI installed and logged in.

```sh
git clone https://github.com/ahaostudy/claudex.git
cd claudex
pnpm install
pnpm init --username=you --password='set-a-strong-one'
```

First-run init prints your TOTP secret (QR + manual string) and **10 recovery codes — shown once, never again**. Save them. Scan the QR into any TOTP app (1Password, Authy, Aegis, Google Authenticator).

## Run

```sh
pnpm serve        # build the web bundle + start the server on 127.0.0.1:5179
```

Then open `http://127.0.0.1:5179`. That's it locally.

**Remote access** — claudex binds to `127.0.0.1` only, by design. Put your tunnel of choice in front:

```sh
# Example: Cloudflare Tunnel
cloudflared tunnel --url http://127.0.0.1:5179
# Or frp, Tailscale Funnel, Caddy reverse-proxy, etc.
```

## Operator commands

```sh
pnpm claudex:status           # read-only diagnostic snapshot (sessions, queue, push devices, server state)
pnpm reset-credentials        # rotate username / password, keep TOTP
pnpm -r typecheck             # shared + server + web
pnpm --filter @claudex/server test
```

Runtime state lives in `~/.claudex/` (SQLite, logs, JWT secret). Nothing is written into `~/.claude/` — that belongs to the CLI.

## Design principles

- **Don't reimplement Claude.** Spawn the CLI, inherit everything for free.
- **Refuse to bind `0.0.0.0`.** Public exposure is the user's responsibility.
- **No dev-mode backdoor.** Auth is mandatory from first boot.
- **Mobile-first, not mobile-also.** Every screen is designed for a 390px viewport first.
- **Honest over clever.** No fake streaming, no fabricated progress bars, no telemetry, no analytics.

## Status

claudex is under active development and close to its personal-use MVP. The public feature ledger at [`docs/FEATURES.md`](docs/FEATURES.md) is the single source of truth — updated in the same commit as any behavior change. 500+ tests on the server, zero-warning typecheck across all three packages.

## License

MIT. Not affiliated with Anthropic.

---

<div align="center">
  <sub><b>English</b> · <a href="./README_CN.md">中文</a></sub>
  <br><br>
  <sub>Built because phones are faster than laptops at picking a diff to approve.</sub>
</div>
