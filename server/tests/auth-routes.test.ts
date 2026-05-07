import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/transport/app.js";
import { openDb, type ClaudexDb } from "../src/db/index.js";
import {
  currentTotp,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  UserStore,
} from "../src/auth/index.js";
import { tempConfig } from "./helpers.js";

interface Ctx {
  app: FastifyInstance;
  dbh: ClaudexDb;
  username: string;
  password: string;
  totpSecret: string;
  cleanup: () => void;
}

async function bootstrap(): Promise<Ctx> {
  const { config, log, cleanup } = tempConfig();
  const dbh = openDb(config, log);
  const jwtSecret = loadOrCreateJwtSecret(config);
  const app = await buildApp({
    db: dbh.db,
    jwtSecret,
    logger: false,
    isProduction: false,
  });
  // Seed admin user
  const users = new UserStore(dbh.db);
  const totpSecret = generateTotpSecret();
  const passwordHash = await hashPassword("hunter22-please-work");
  users.create({
    username: "hao",
    passwordHash,
    totpSecret,
  });
  return {
    app,
    dbh,
    username: "hao",
    password: "hunter22-please-work",
    totpSecret,
    cleanup: () => {
      dbh.close();
      cleanup();
    },
  };
}

function cookieFor(res: { cookies: Array<{ name: string; value: string }> }) {
  const c = res.cookies.find((c) => c.name === "claudex_session");
  return c ? `claudex_session=${c.value}` : "";
}

describe("auth routes", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await bootstrap();
  });
  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  describe("POST /api/auth/login", () => {
    it("returns a challengeId for valid credentials", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: ctx.password },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.requireTotp).toBe(true);
      expect(typeof body.challengeId).toBe("string");
    });

    it("is case-insensitive on username", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "HAO", password: ctx.password },
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 401 for wrong password", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: "wrong-one" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for unknown user (no user enumeration)", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "nobody", password: "anything123" },
      });
      expect(res.statusCode).toBe(401);
      // Same error code whether password is wrong or user is gone
      expect(res.json().error).toBe("invalid_credentials");
    });

    it("rejects malformed bodies with 400", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao" }, // missing password
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/auth/verify-totp", () => {
    async function getChallenge() {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: ctx.password },
      });
      return login.json().challengeId as string;
    }

    it("sets an httpOnly session cookie for a valid TOTP", async () => {
      const challengeId = await getChallenge();
      const code = currentTotp(ctx.totpSecret);
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      const cookie = res.cookies.find((c) => c.name === "claudex_session");
      expect(cookie).toBeDefined();
      expect(cookie!.httpOnly).toBe(true);
      expect(cookie!.sameSite?.toLowerCase()).toBe("strict");
    });

    it("rejects a wrong TOTP code", async () => {
      const challengeId = await getChallenge();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: "000000" },
      });
      // Could be 401 invalid_totp. Also accept invalid_challenge if the wrong
      // code already consumed the challenge — but we consume only after code
      // check. Enforce strict behavior:
      expect(res.statusCode).toBe(401);
    });

    it("rejects replay of a challengeId", async () => {
      const challengeId = await getChallenge();
      const code = currentTotp(ctx.totpSecret);

      const ok = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code },
      });
      expect(ok.statusCode).toBe(200);

      // Even with a valid (next) TOTP, the challenge is already consumed.
      const replay = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: currentTotp(ctx.totpSecret) },
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error).toBe("invalid_challenge");
    });

    it("rejects malformed codes with 400", async () => {
      const challengeId = await getChallenge();
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code: "abc" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/auth/whoami", () => {
    async function fullLogin(): Promise<string> {
      const login = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "hao", password: ctx.password },
      });
      const challengeId = login.json().challengeId as string;
      const code = currentTotp(ctx.totpSecret);
      const verify = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/verify-totp",
        payload: { challengeId, code },
      });
      return cookieFor(verify as any);
    }

    it("returns user info with a valid session cookie", async () => {
      const cookie = await fullLogin();
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.username).toBe("hao");
      expect(body.user.twoFactorEnabled).toBe(true);
    });

    it("401 without a cookie", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
      });
      expect(res.statusCode).toBe(401);
    });

    it("401 with a garbage cookie", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/auth/whoami",
        headers: { cookie: "claudex_session=not-a-jwt" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears the session cookie", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/auth/logout",
      });
      expect(res.statusCode).toBe(200);
      const cleared = res.cookies.find((c) => c.name === "claudex_session");
      expect(cleared).toBeDefined();
      // clearCookie sets an empty value with a past expiry
      expect(cleared!.value).toBe("");
    });
  });
});
