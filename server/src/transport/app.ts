import Fastify, { type FastifyInstance, type FastifyBaseLogger } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChallengeStore } from "../auth/index.js";
import { registerAuthRoutes } from "../auth/routes.js";
import { ProjectStore } from "../sessions/projects.js";
import { SessionStore } from "../sessions/store.js";
import { SessionManager } from "../sessions/manager.js";
import { ToolGrantStore } from "../sessions/grants.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { registerWsRoute } from "./ws.js";
import { agentRunnerFactory } from "../sessions/agent-runner.js";
import type { RunnerFactory } from "../sessions/runner.js";

export interface AppDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
  logger: FastifyBaseLogger | false;
  isProduction: boolean;
  runnerFactory?: RunnerFactory;
  /**
   * Absolute path to the built web/dist directory. If set, the server
   * mounts those files at `/` and falls through to index.html for SPA
   * routes — so browsers can hit the server on a single port, which is
   * what you want behind a Cloudflare Tunnel / Tailscale / Caddy
   * exposing ONE hostname.
   *
   * In dev you typically leave this unset and rely on Vite at 5173 with
   * its /api + /ws proxy pointing here.
   */
  webDist?: string;
}

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
    grants: new ToolGrantStore(deps.db),
    runnerFactory: deps.runnerFactory ?? agentRunnerFactory,
    broadcast: () => {
      /* replaced by WS layer */
    },
    logger: deps.logger === false ? undefined : deps.logger,
  });

  await registerSessionRoutes(app, { db: deps.db });
  await registerWsRoute(app, {
    manager,
    db: deps.db,
    jwtSecret: deps.jwtSecret,
  });

  if (deps.webDist) {
    await registerWebStatic(app, deps.webDist);
  }

  return { app, manager };
}

async function registerWebStatic(
  app: FastifyInstance,
  webDist: string,
): Promise<void> {
  if (!fs.existsSync(webDist)) {
    app.log.warn(
      { webDist },
      "webDist path does not exist; skipping static mount. Run `pnpm --filter @claudex/web build` first.",
    );
    return;
  }

  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    // We set our own Cache-Control per request (see setHeaders below), so
    // turn off fastify-static's default max-age=0 cache header.
    cacheControl: false,
    // Everything under /assets (Vite hash-named bundles) can be cached hard.
    // index.html we always revalidate so users pick up new bundles on refresh.
    setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  });

  // SPA fallback: any GET that's not /api/*, /ws, or an existing file goes
  // to index.html so React Router can handle /session/:id etc. on refresh.
  const indexPath = path.join(webDist, "index.html");
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0] ?? "/";
    if (req.method !== "GET") {
      return reply.code(404).send({ error: "not_found" });
    }
    if (
      url.startsWith("/api/") ||
      url === "/api" ||
      url === "/ws" ||
      url.startsWith("/ws/")
    ) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (!fs.existsSync(indexPath)) {
      return reply.code(500).send({ error: "index_html_missing" });
    }
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(fs.readFileSync(indexPath));
  });
}

// Default location of the built web bundle when the repo layout is intact.
export function defaultWebDist(): string {
  // src/transport/app.ts  →  repo: ../../..
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "web", "dist");
}
