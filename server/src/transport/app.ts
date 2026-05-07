import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type Database from "better-sqlite3";
import { ChallengeStore } from "../auth/index.js";
import { registerAuthRoutes } from "../auth/routes.js";

export interface AppDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
  // Any pino-compatible logger works; falsy disables Fastify logging (tests).
  logger: FastifyBaseLogger | false;
  isProduction: boolean;
}

/**
 * Build a ready-to-listen Fastify app from typed dependencies.
 * Kept in its own module so tests can assemble the same app against a
 * tmp-dir DB and then call `.inject(...)` without opening a port.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app =
    deps.logger === false
      ? Fastify({ logger: false })
      : Fastify({ loggerInstance: deps.logger });

  await app.register(fastifyCookie);

  app.get("/api/health", async () => ({
    status: "ok",
    version: "0.0.1",
    time: new Date().toISOString(),
  }));

  const challenges = new ChallengeStore();
  await registerAuthRoutes(app, {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
    challenges,
    isProduction: deps.isProduction,
  });

  return app;
}
