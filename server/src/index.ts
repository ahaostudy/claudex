import Fastify from "fastify";
import { loadConfig, assertSafeBind } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { openDb } from "./db/index.js";

async function main() {
  const config = loadConfig();
  assertSafeBind(config.host);
  const log = createLogger(config);
  const { db, close: closeDb } = openDb(config, log);

  const app = Fastify({ loggerInstance: log });

  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.1",
    time: new Date().toISOString(),
  }));

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
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
