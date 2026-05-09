import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditStore } from "../audit/store.js";
import { getRequestCtx } from "../lib/req.js";

// -----------------------------------------------------------------------------
// Admin routes — server lifecycle operations.
//
// POST /api/admin/restart
//
// Triggers an in-place server restart. Login-gated (same JWT cookie preHandler
// as every other surface; no separate role system yet — any authenticated
// user is the admin because claudex is single-user by design).
//
// The mechanism is the trick. We cannot restart by having a subprocess of the
// server kill the server and then spawn a new one — when the server dies, the
// whole process tree underneath it (Claude CLI, its bash, any `nohup &
// disown` the bash was about to run) dies too, and the new server never
// launches. The only way out is to hand the job to a process that is NOT
// parented to the server.
//
// So the flow is:
//
//   1. Fork `scripts/restart-worker.mjs` with `detached: true` + no inherited
//      stdio. Node's `child_process.spawn({ detached: true })` is the portable
//      primitive we need — it calls `setsid(2)` on Unix and `DETACHED_PROCESS
//      + CREATE_NEW_PROCESS_GROUP` on Windows, which puts the worker in a
//      fresh session/group that is NOT torn down when our process exits.
//      `unref()` tells libuv not to keep our event loop alive for it.
//   2. Flush a 200 JSON response with the worker pid + log path.
//   3. Send SIGTERM to ourselves so the existing shutdown handler in
//      `server/src/index.ts` runs cleanly (scheduler dispose → manager
//      dispose → app close → db close).
//   4. Worker waits for the listen port to drain, then execs
//      `pnpm exec tsx src/index.ts` in `server/`.
//
// Test mode (`NODE_ENV=test`) short-circuits after the audit write: we
// return 200 without spawning anything and without killing the process,
// because vitest runs the app in-process and we'd tear down the test
// runner. The spawn/kill path therefore isn't unit-tested — it's exercised
// by actually restarting the running server, which the user does
// manually.
// -----------------------------------------------------------------------------

export interface AdminRoutesDeps {
  audit: AuditStore;
  /** The port the old server is listening on. The worker uses this to
   *  decide when the old server has released its socket. */
  port: number;
  /** Absolute path to the claudex state directory (normally `~/.claudex`).
   *  We append the restart worker's stdout/stderr to
   *  `<stateDir>/server-stdout.log`, matching the log file the documented
   *  manual-restart recipe (CLAUDE.md) already writes to. */
  stateDir: string;
}

/** Resolve the repo root from this file's location. Works for both `tsx`
 *  (src/admin/routes.ts) and the built bundle (dist/admin/routes.js);
 *  `repoRoot/server/dist/...` still resolves back to `repoRoot` three
 *  `..`s up. */
function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/admin/routes.ts        → ../../../..   /server/src/admin
  // dist/admin/routes.js       → ../../../..   /server/dist/admin
  // Both land on the repo root. We verify by checking for pnpm-workspace.yaml.
  const candidates = [
    resolve(here, "..", "..", ".."),
    resolve(here, "..", "..", "..", ".."),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "pnpm-workspace.yaml"))) return c;
  }
  // Fallback: cwd is set to server/ when started per the docs.
  return resolve(process.cwd(), "..");
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRoutesDeps,
): Promise<void> {
  app.post(
    "/api/admin/restart",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const ctx = getRequestCtx(req);
      try {
        deps.audit.append({
          event: "server_restart",
          userId: ctx.userId,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      } catch {
        /* audit is fire-and-forget; never block the restart on it */
      }

      if (process.env.NODE_ENV === "test") {
        return reply.code(200).send({ ok: true, dryRun: true });
      }

      const repoRoot = resolveRepoRoot();
      const serverDir = join(repoRoot, "server");
      const workerPath = join(repoRoot, "scripts", "restart-worker.mjs");

      if (!existsSync(workerPath)) {
        return reply
          .code(500)
          .send({ error: "restart_worker_missing", path: workerPath });
      }

      // Append to the same log the documented manual-restart recipe writes
      // to, so operators have one place to look when "did it restart?"
      // becomes "why didn't it restart?".
      mkdirSync(deps.stateDir, { recursive: true });
      const logPath = join(deps.stateDir, "server-stdout.log");
      const logFd = openSync(logPath, "a");

      const child = spawn(
        process.execPath,
        [workerPath, String(deps.port), serverDir],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          cwd: serverDir,
          env: process.env,
          windowsHide: true,
        },
      );
      child.unref();

      // Reply before initiating shutdown. The small delay gives Fastify a
      // chance to flush the response to the socket before our SIGTERM
      // handler starts closing connections. 150ms is enough for localhost
      // round-trips and still below any reasonable client timeout.
      reply.code(200).send({
        ok: true,
        restarterPid: child.pid,
        port: deps.port,
        log: logPath,
      });

      setTimeout(() => {
        process.kill(process.pid, "SIGTERM");
      }, 150);
    },
  );
}
