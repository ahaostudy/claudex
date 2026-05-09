#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Restart worker.
//
// Spawned detached by scripts/restart.mjs (or by the server's
// POST /api/admin/restart handler). Its job:
//
//   1. Wait until the old server has actually released the listen port.
//      We try to bind the port ourselves — EADDRINUSE means the old server
//      is still alive, retry. This avoids relying on lsof / netstat / ss,
//      none of which are consistent across macOS, Linux, and Windows.
//
//   2. Once the port is free, exec `pnpm exec tsx src/index.ts` in the
//      server directory to start the fresh process.
//
// Usage (internal; not meant to be called directly):
//   node scripts/restart-worker.mjs <port> <server-cwd>
//
// We deliberately don't forward stdio to any pipe the parent owns — the
// launcher opens a file fd for stdout/stderr and we inherit those, so logs
// land in ~/.claudex/server-stdout.log.
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.argv[2] ?? 5179);
const cwd = process.argv[3] ?? process.cwd();

/**
 * Returns true when the port is still held by some other listener on
 * 127.0.0.1. We try to bind it ourselves; an EADDRINUSE says the port's
 * still in use. "listening" means we momentarily claimed it — we release
 * immediately so the real server can take it a beat later.
 */
function portBusy(p) {
  return new Promise((res) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      res(v);
    };
    srv.once("error", () => done(true));
    srv.once("listening", () => srv.close(() => done(false)));
    try {
      srv.listen(p, "127.0.0.1");
    } catch {
      done(true);
    }
  });
}

const DEADLINE_MS = 30_000;
const deadline = Date.now() + DEADLINE_MS;
while (await portBusy(port)) {
  if (Date.now() > deadline) {
    // eslint-disable-next-line no-console
    console.error(
      `[claudex-restart] port ${port} still busy after ${DEADLINE_MS / 1000}s; giving up`,
    );
    process.exit(1);
  }
  await sleep(200);
}

// Start the new server. `pnpm exec tsx src/index.ts` matches the canonical
// dev entry documented in CLAUDE.md. On Windows, pnpm resolves to a .cmd
// shim which requires `shell: true` for spawn to find it.
const isWin = process.platform === "win32";
const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd,
  stdio: "inherit",
  env: process.env,
  shell: isWin,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[claudex-restart] failed to spawn server:", err);
  process.exit(1);
});
