import { loadConfig, assertSafeBind } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { openDb } from "./db/index.js";
import { loadOrCreateJwtSecret } from "./auth/index.js";
import { buildApp, defaultWebDist } from "./transport/app.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const config = loadConfig();
  assertSafeBind(config.host);
  const log = createLogger(config);
  const { db, close: closeDb } = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);

  // Resolve the web bundle location. Override with CLAUDEX_WEB_DIST; set
  // CLAUDEX_WEB_DIST=none to explicitly disable (i.e. you're running Vite
  // on a separate port in dev).
  const webEnv = process.env.CLAUDEX_WEB_DIST;
  let webDist: string | undefined;
  if (webEnv === "none") {
    webDist = undefined;
  } else if (webEnv) {
    webDist = path.resolve(webEnv);
  } else {
    const candidate = defaultWebDist();
    webDist = fs.existsSync(candidate) ? candidate : undefined;
  }

  const { app, manager, scheduler } = await buildApp({
    db,
    jwtSecret,
    logger: log as any,
    isProduction: config.nodeEnv === "production",
    webDist,
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      scheduler.dispose();
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
      {
        host: config.host,
        port: config.port,
        stateDir: config.stateDir,
        webDist: webDist ?? "(disabled — use Vite dev at 5173)",
      },
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
