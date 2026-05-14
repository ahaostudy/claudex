#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Update + restart worker.
//
// Spawned detached by the server's POST /api/admin/update-and-restart handler.
// Its job:
//
//   1. git fetch origin — pull the latest tags from the remote.
//   2. git checkout <tag> — switch to the target release tag.
//   3. pnpm install — install any changed dependencies.
//   4. Wait until the old server has released the listen port (same portBusy
//      loop as restart-worker.mjs).
//   5. exec `pnpm exec tsx src/index.ts` in server/ to start the new process.
//
// Usage (internal):
//   node scripts/update-restart-worker.mjs <port> <repoRoot> <tag>
//
// Logs land in ~/.claudex/server-stdout.log via inherited fds from the parent
// (the admin route opens the log file and passes it as stdio).
// -----------------------------------------------------------------------------

import { execSync, spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.argv[2] ?? 5179);
const repoRoot = process.argv[3] ?? process.cwd();
const tag = process.argv[4];
if (!tag) {
  console.error("[claudex-update] missing <tag> argument");
  process.exit(1);
}

const serverDir = `${repoRoot}/server`;

function run(cmd: string, args: string[], opts?: { cwd?: string }) {
  const cwd = opts?.cwd ?? repoRoot;
  console.error(`[claudex-update] running: ${cmd} ${args.join(" ")} (cwd=${cwd})`);
  execSync(cmd, args, { cwd, stdio: "inherit" });
}

// ---- step 1: git fetch ---------------------------------------------------
try {
  run("git", ["fetch", "origin"], { cwd: repoRoot });
} catch (err) {
  console.error("[claudex-update] git fetch failed:", err);
  process.exit(1);
}

// ---- step 2: git checkout <tag> -------------------------------------------
try {
  run("git", ["checkout", tag], { cwd: repoRoot });
} catch (err) {
  console.error("[claudex-update] git checkout failed:", err);
  process.exit(1);
}

// ---- step 3: pnpm install -------------------------------------------------
try {
  run("pnpm", ["install"], { cwd: repoRoot });
} catch (err) {
  console.error("[claudex-update] pnpm install failed:", err);
  process.exit(1);
}

// ---- step 4: wait for port ------------------------------------------------
function portBusy(p: number) {
  return new Promise<boolean>((res) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v: boolean) => {
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
    console.error(
      `[claudex-update] port ${port} still busy after ${DEADLINE_MS / 1000}s; giving up`,
    );
    process.exit(1);
  }
  await sleep(200);
}

// ---- step 5: start new server ---------------------------------------------
const isWin = process.platform === "win32";
const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: serverDir,
  stdio: "inherit",
  env: process.env,
  shell: isWin,
});

child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  console.error("[claudex-update] failed to spawn server:", err);
  process.exit(1);
});
