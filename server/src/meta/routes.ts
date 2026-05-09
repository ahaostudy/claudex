import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MetaResponse } from "@claudex/shared";

// ---------------------------------------------------------------------------
// GET /api/meta
//
// Backs the `/about` screen. Everything except `uptimeSec` is sampled once at
// boot — cheap, and nothing on this list changes between server restarts:
//
//   - `version`      — server `package.json#version`
//   - `commit`       — `git rev-parse HEAD` at the repo root; null when not a
//                      git checkout (Docker, archive extract) or git isn't on
//                      PATH
//   - `buildTime`    — `__BUILD_TIME__` (define-substituted at build time) if
//                      present, else the moment this module was imported
//                      (i.e. "server boot time")
//   - `nodeVersion`  — `process.versions.node`
//   - `sqliteVersion`— `SELECT sqlite_version()` (better-sqlite3 has no
//                      exported constant; the SQL is the only stable API)
//   - `platform`     — `${os.platform()} ${os.arch()}` (e.g. "darwin arm64")
//
// `uptimeSec` is `process.uptime()` at request time so the About screen
// can render "running for 23m".
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

// The build-time define is declared via `declare const __BUILD_TIME__: string`
// in build setups that want to bake a real timestamp in. When unset we fall
// back to boot time — see `bootTimeIso` below.
declare const __BUILD_TIME__: string | undefined;

const bootTimeIso = new Date().toISOString();

/**
 * Locate the server package.json. We don't bake in a relative path because the
 * file can be imported from `src/` via tsx (dev/tests) or `dist/` (built
 * bundle). `fileURLToPath(import.meta.url)` gives us whichever the runtime
 * chose, and we walk up until we find a `package.json` with the
 * `@claudex/server` name stamped on it.
 */
function resolveServerPackageJson(): {
  version: string;
  rootDir: string;
} {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  // Safety cap on the walk so a misconfigured module path can't loop forever.
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cur, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (raw?.name === "@claudex/server" && typeof raw.version === "string") {
          return { version: raw.version, rootDir: cur };
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Last resort: an honest "unknown". Better than crashing the route for a
  // misplaced install layout.
  return { version: "0.0.0", rootDir: here };
}

const { version: serverVersion, rootDir: serverRootDir } =
  resolveServerPackageJson();

// Git commit — resolved once at boot, cached forever. Using `execFile`
// (no shell) with the repo root as cwd, and swallowing any error (non-repo,
// no git on PATH, detached filesystem) as `null`.
let cachedCommit: string | null = null;
let cachedCommitShort: string | null = null;
let commitResolved = false;
const commitPromise: Promise<void> = (async () => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: serverRootDir, timeout: 1500 },
    );
    const sha = stdout.trim();
    if (/^[0-9a-f]{40}$/.test(sha)) {
      cachedCommit = sha;
      cachedCommitShort = sha.slice(0, 7);
    }
  } catch {
    /* not a git checkout — leave null */
  } finally {
    commitResolved = true;
  }
})();

function resolveBuildTime(): string {
  try {
    // Guard the `typeof` check so bundlers that don't define the symbol still
    // work — a bare reference to `__BUILD_TIME__` would ReferenceError.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maybe = (globalThis as any).__BUILD_TIME__ as string | undefined;
    if (typeof maybe === "string" && maybe.length > 0) return maybe;
    if (typeof __BUILD_TIME__ === "string" && __BUILD_TIME__.length > 0) {
      return __BUILD_TIME__;
    }
  } catch {
    /* reference error on __BUILD_TIME__ when not defined — fall through */
  }
  return bootTimeIso;
}

const cachedBuildTime = resolveBuildTime();
const cachedPlatform = `${os.platform()} ${os.arch()}`;
const cachedNodeVersion = process.versions.node;

export interface MetaRoutesDeps {
  db: Database.Database;
}

export async function registerMetaRoutes(
  app: FastifyInstance,
  deps: MetaRoutesDeps,
): Promise<void> {
  // Sample SQLite once — better-sqlite3 compiles a fixed sqlite amalgamation
  // into the native binding, so the version can't change at runtime. We still
  // prepare it lazily (not at module import) so tests that mock the db in
  // exotic ways don't trip on a top-level query.
  let cachedSqliteVersion: string | null = null;
  const getSqliteVersion = (): string => {
    if (cachedSqliteVersion !== null) return cachedSqliteVersion;
    try {
      const row = deps.db
        .prepare("SELECT sqlite_version() AS v")
        .get() as { v?: unknown } | undefined;
      const v = row?.v;
      cachedSqliteVersion = typeof v === "string" ? v : "unknown";
    } catch {
      cachedSqliteVersion = "unknown";
    }
    return cachedSqliteVersion;
  };

  app.get(
    "/api/meta",
    { preHandler: app.requireAuth as any },
    async (): Promise<MetaResponse> => {
      // Ensure the git lookup finished — the async probe takes <100ms in the
      // common case. If someone hits `/api/meta` within the first few ms of
      // boot we want the real value, not a transient null.
      if (!commitResolved) {
        try {
          await commitPromise;
        } catch {
          /* already swallowed above */
        }
      }
      return {
        version: serverVersion,
        commit: cachedCommit,
        commitShort: cachedCommitShort,
        buildTime: cachedBuildTime,
        nodeVersion: cachedNodeVersion,
        sqliteVersion: getSqliteVersion(),
        platform: cachedPlatform,
        uptimeSec: Math.max(0, Math.floor(process.uptime())),
      };
    },
  );
}
