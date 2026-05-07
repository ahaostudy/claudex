import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../src/lib/config.js";
import type { Logger } from "../src/lib/logger.js";
import pino from "pino";

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
