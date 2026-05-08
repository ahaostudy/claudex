import { loadConfig, assertSafeBind } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { openDb } from "./db/index.js";
import { loadOrCreateJwtSecret } from "./auth/index.js";
import { buildApp, defaultWebDist } from "./transport/app.js";
import { SessionStore } from "./sessions/store.js";
import { backfillSessionTitles } from "./sessions/backfill-titles.js";
import { loadOrCreateVapidKeys } from "./push/vapid.js";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const config = loadConfig();
  assertSafeBind(config.host);
  const log = createLogger(config);
  const { db, close: closeDb } = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const vapid = loadOrCreateVapidKeys(config, log);

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
    vapid,
    stateDir: config.stateDir,
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

  // One-shot title backfill. See server/src/sessions/backfill-titles.ts —
  // retitles historical sessions whose current title is still a placeholder
  // using their first persisted user_message. Synchronous; fast because it
  // only reads text.
  try {
    const backfillResult = backfillSessionTitles({
      sessions: new SessionStore(db),
    });
    log.info(
      `backfilled titles: ${backfillResult.retitled}/${backfillResult.scanned} sessions retitled`,
    );
  } catch (err) {
    log.error({ err }, "session title backfill failed");
  }

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
