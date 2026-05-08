import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/lib/config.js";
import type { Logger } from "../src/lib/logger.js";
import pino from "pino";
import { buildApp } from "../src/transport/app.js";
import { openDb, type ClaudexDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import type { RunnerFactory } from "../src/sessions/runner.js";
import type { SessionManager } from "../src/sessions/manager.js";

/**
 * Create a fully isolated Config pointing at a fresh tmp dir and a silent logger.
 * Use `cleanup()` in `afterEach` to remove the tmp dir.
 */
export function tempConfig(overrides?: Partial<Config>): {
  config: Config;
  log: Logger;
  cleanup: () => void;
} {
  const stateDir = mkdtempSync(path.join(tmpdir(), "claudex-test-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    stateDir,
    dbPath: path.join(stateDir, "claudex.db"),
    logDir: path.join(stateDir, "logs"),
    jwtSecretPath: path.join(stateDir, "jwt.secret"),
    nodeEnv: "development",
    ...overrides,
  };
  const log = pino({ level: "silent" }) as Logger;
  return {
    config,
    log,
    cleanup: () => {
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * Stands up an isolated app with a freshly-created user, logs them in, and
 * hands back the session cookie + a scratch tmp dir. The returned
 * `cleanup()` tears all of that down.
 *
 * Prefer this to hand-rolling the login dance in each suite.
 */
export async function bootstrapAuthedApp(
  runnerFactory?: RunnerFactory,
  opts?: { userClaudeDir?: string },
): Promise<{
  app: FastifyInstance;
  dbh: ClaudexDb;
  cookie: string;
  tmpDir: string;
  manager: SessionManager;
  cleanup: () => Promise<void>;
}> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const { app, manager } = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
    runnerFactory,
    userClaudeDir: opts?.userClaudeDir,
  });
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  const passwordHash = await hashPassword("hunter22-please-work");
  users.create({ username: "hao", passwordHash, totpSecret });

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "hao", password: "hunter22-please-work" },
  });
  const challengeId = login.json().challengeId as string;
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify-totp",
    payload: { challengeId, code: currentTotp(totpSecret) },
  });
  const sessionCookie = verify.cookies.find(
    (c) => c.name === "claudex_session",
  )!;
  const cookie = `claudex_session=${sessionCookie.value}`;

  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), "claudex-proj-"));

  return {
    app,
    dbh,
    cookie,
    tmpDir,
    manager,
    cleanup: async () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await manager.disposeAll();
      await app.close();
      dbh.close();
      cleanup();
    },
  };
}
