import { loadConfig, assertSafeBind } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { openDb } from "./db/index.js";
import { loadOrCreateJwtSecret } from "./auth/index.js";
import { buildApp } from "./transport/app.js";

async function main() {
  const config = loadConfig();
  assertSafeBind(config.host);
  const log = createLogger(config);
  const { db, close: closeDb } = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);

  const { app, manager } = await buildApp({
    db,
    jwtSecret,
    logger: log as any,
    isProduction: config.nodeEnv === "production",
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      await manager.disposeAll();
      await app.close();
    } finally {
      closeDb();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info(
      { host: config.host, port: config.port, stateDir: config.stateDir },
      "claudex server ready",
    );
  } catch (err) {
    log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
