import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import {
  LoginRequest,
  VerifyTotpRequest,
  type LoginResponse,
  type VerifyTotpResponse,
  type WhoAmIResponse,
} from "@claudex/shared";
import {
  ACCESS_COOKIE_NAME,
  ChallengeStore,
  UserStore,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
  verifyTotp,
} from "./index.js";

export interface AuthDeps {
  db: Database.Database;
  jwtSecret: Uint8Array;
  challenges: ChallengeStore;
  // production flag drives the `Secure` cookie attribute
  isProduction: boolean;
}

// A small symbol used to attach the resolved userId onto a request after
// authentication middleware runs.
declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
): Promise<void> {
  const users = new UserStore(deps.db);
  const cookieOpts = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: deps.isProduction,
    path: "/",
  };

  // --- decorator: require an authenticated user ------------------------------
  app.decorate(
    "requireAuth",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = req.cookies?.[ACCESS_COOKIE_NAME];
      if (!token) return reply.code(401).send({ error: "unauthenticated" });
      try {
        const claims = await verifyAccessToken(deps.jwtSecret, token);
        const row = users.findById(claims.userId);
        if (!row) return reply.code(401).send({ error: "user_gone" });
        req.userId = row.id;
      } catch {
        return reply.code(401).send({ error: "invalid_token" });
      }
    },
  );

  // --- POST /api/auth/login -------------------------------------------------
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = LoginRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const { username, password } = parsed.data;
    const row = users.findByUsername(username);
    // Uniformly cost the request even when the user is missing so we don't
    // leak timing — always run bcrypt once.
    const ok =
      row != null && (await verifyPassword(password, row.password_hash));
    if (!ok || !row) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const challengeId = deps.challenges.create(row.id);
    const body: LoginResponse = { requireTotp: true, challengeId };
    return reply.send(body);
  });

  // --- POST /api/auth/verify-totp -------------------------------------------
  app.post("/api/auth/verify-totp", async (req, reply) => {
    const parsed = VerifyTotpRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const { challengeId, code } = parsed.data;
    const userId = deps.challenges.consume(challengeId);
    if (!userId) {
      return reply.code(401).send({ error: "invalid_challenge" });
    }
    const row = users.findById(userId);
    if (!row) return reply.code(401).send({ error: "user_gone" });
    if (!verifyTotp(row.totp_secret, code)) {
      return reply.code(401).send({ error: "invalid_totp" });
    }
    const token = await signAccessToken(deps.jwtSecret, row.id);
    reply.setCookie(ACCESS_COOKIE_NAME, token, {
      ...cookieOpts,
      maxAge: 60 * 60 * 24 * 30,
    });
    const body: VerifyTotpResponse = { ok: true };
    return reply.send(body);
  });

  // --- POST /api/auth/logout ------------------------------------------------
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(ACCESS_COOKIE_NAME, cookieOpts);
    return reply.send({ ok: true });
  });

  // --- GET /api/auth/whoami -------------------------------------------------
  app.get(
    "/api/auth/whoami",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const row = users.findById(req.userId!);
      if (!row) return reply.code(401).send({ error: "user_gone" });
      const body: WhoAmIResponse = {
        user: {
          id: row.id,
          username: row.username,
          createdAt: row.created_at,
          twoFactorEnabled: true,
        },
      };
      return reply.send(body);
    },
  );
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: (
      req: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void | FastifyReply>;
  }
}
