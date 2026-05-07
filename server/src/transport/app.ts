import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type Database from "better-sqlite3";
import { ChallengeStore } from "../auth/index.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { ProjectStore } from "../sessions/projects.js";
import { SessionStore } from "../sessions/store.js";
import { SessionManager } from "../sessions/manager.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { registerWsRoute } from "./ws.js";
import { agentRunnerFactory } from "../sessions/agent-runner.js";
import type { RunnerFactory } from "../sessions/runner.js";

export interface AppDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
  // Any pino-compatible logger works; falsy disables Fastify logging (tests).
  logger: FastifyBaseLogger | false;
  isProduction: boolean;
  // Injectable for tests that want to replace the Agent SDK with a mock.
  runnerFactory?: RunnerFactory;
}

/**
 * Build a ready-to-listen Fastify app from typed dependencies.
 */
export async function buildApp(
  deps: AppDeps,
): Promise<{ app: FastifyInstance; manager: SessionManager }> {
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

  const manager = new SessionManager({
    sessions: new SessionStore(deps.db),
    projects: new ProjectStore(deps.db),
    runnerFactory: deps.runnerFactory ?? agentRunnerFactory,
    // Replaced by the WS layer once it's registered.
    broadcast: () => {
      /* noop until WS attaches */
    },
    logger: deps.logger === false ? undefined : deps.logger,
  });

  await registerSessionRoutes(app, { db: deps.db });
  await registerWsRoute(app, {
    manager,
    db: deps.db,
    jwtSecret: deps.jwtSecret,
  });

  return { app, manager };
}
