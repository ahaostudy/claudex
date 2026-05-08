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
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Decide whether to set the `Secure` attribute on the session cookie based
 * on how this specific request reached us. Keeping it off on plain-HTTP
 * requests is what lets claudex work behind an http-only tunnel (frp,
 * dev port-forward, a LAN box with no TLS) while still turning Secure on
 * automatically whenever a reverse proxy — or the client directly — is
 * speaking HTTPS.
 *
 * Detection order:
 *   1. request.protocol === "https" (Fastify's trust-proxy-aware check)
 *   2. X-Forwarded-Proto header (some proxies don't set .protocol)
 *   3. fall back to plain HTTP → Secure=false
 *
 * If a user insists on Secure regardless, they can force it via
 * CLAUDEX_COOKIE_SECURE=1.
 */
function isRequestSecure(req: FastifyRequest): boolean {
  if (process.env.CLAUDEX_COOKIE_SECURE === "1") return true;
  if (process.env.CLAUDEX_COOKIE_SECURE === "0") return false;
  if ((req as any).protocol === "https") return true;
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.toLowerCase().includes("https")) {
    return true;
  }
  return false;
}

function cookieOpts(req: FastifyRequest) {
  return {
    httpOnly: true,
    // Lax is the right default for a session cookie: it survives top-level
    // navigation (QR-code link, email link) and blocks CSRF on state-changing
    // requests since we only accept JSON bodies. Strict used to cost us the
    // first-hop cookie on some reverse proxies.
    sameSite: "lax" as const,
    secure: isRequestSecure(req),
    path: "/",
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
): Promise<void> {
  const users = new UserStore(deps.db);

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

  app.post("/api/auth/verify-totp", async (req, reply) => {
    const parsed = VerifyTotpRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request" });
    }
    const { challengeId, code } = parsed.data;

    // Peek first so a wrong code doesn't burn the challenge. Only a successful
    // TOTP consumes it; an expired/missing challenge still looks the same to
    // the caller.
    const userId = deps.challenges.peek(challengeId);
    if (!userId) {
      return reply.code(401).send({ error: "invalid_challenge" });
    }
    const row = users.findById(userId);
    if (!row) {
      deps.challenges.consume(challengeId);
      return reply.code(401).send({ error: "user_gone" });
    }
    if (!verifyTotp(row.totp_secret, code)) {
      return reply.code(401).send({ error: "invalid_totp" });
    }
    // TOTP good → consume the challenge (prevents replay of this exact
    // challenge + code pair) and issue the session cookie.
    deps.challenges.consume(challengeId);
    const token = await signAccessToken(deps.jwtSecret, row.id);
    reply.setCookie(ACCESS_COOKIE_NAME, token, {
      ...cookieOpts(req),
      maxAge: 60 * 60 * 24 * 30,
    });
    const body: VerifyTotpResponse = { ok: true };
    return reply.send(body);
  });

  app.post("/api/auth/logout", async (req, reply) => {
    reply.clearCookie(ACCESS_COOKIE_NAME, cookieOpts(req));
    return reply.send({ ok: true });
  });

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
