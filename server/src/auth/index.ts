import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcrypt";
import { authenticator } from "otplib";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { Config } from "../lib/config.js";

// -----------------------------------------------------------------------------
// Password hashing
// -----------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

// -----------------------------------------------------------------------------
// TOTP — otplib wrapped to a tight interface
// -----------------------------------------------------------------------------

// Tolerate ±1 step (±30s) on verification — accounts for clock skew.
authenticator.options = { window: 1, step: 30, digits: 6 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpUri(
  secret: string,
  username: string,
  issuer = "claudex",
): string {
  return authenticator.keyuri(username, issuer, secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

// Expose the same generator for tests that need to produce a current code.
export function currentTotp(secret: string): string {
  return authenticator.generate(secret);
}

// -----------------------------------------------------------------------------
// JWT — HS256, secret stored on disk with 0600
// -----------------------------------------------------------------------------

export interface SessionToken {
  userId: string;
  // issued at / expires at in seconds since epoch
  iat: number;
  exp: number;
  jti: string;
}

const JWT_ISSUER = "claudex";
const JWT_AUDIENCE = "claudex-web";
const ACCESS_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export function loadOrCreateJwtSecret(config: Config): Uint8Array {
  const file = config.jwtSecretPath;
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    if (raw.length >= 32) return new Uint8Array(raw);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomBytes(48);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return new Uint8Array(secret);
}

export async function signAccessToken(
  secret: Uint8Array,
  userId: string,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setJti(nanoid(16))
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TTL_SEC)
    .sign(secret);
}

export async function verifyAccessToken(
  secret: Uint8Array,
  token: string,
): Promise<SessionToken> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return {
    userId: String(payload.sub),
    iat: (payload.iat as number) ?? 0,
    exp: (payload.exp as number) ?? 0,
    jti: String(payload.jti ?? ""),
  };
}

// -----------------------------------------------------------------------------
// User store — SQL operations kept tight and typed
// -----------------------------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  totp_secret: string;
  created_at: string;
}

export class UserStore {
  constructor(private readonly db: Database.Database) {}

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get() as {
      c: number;
    };
    return row.c;
  }

  findByUsername(username: string): UserRow | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username.toLowerCase()) as UserRow | undefined;
    return row ?? null;
  }

  findById(id: string): UserRow | null {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id) as UserRow | undefined;
    return row ?? null;
  }

  create(input: {
    username: string;
    passwordHash: string;
    totpSecret: string;
  }): UserRow {
    const row: UserRow = {
      id: nanoid(16),
      username: input.username.toLowerCase(),
      password_hash: input.passwordHash,
      totp_secret: input.totpSecret,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, totp_secret, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.username,
        row.password_hash,
        row.totp_secret,
        row.created_at,
      );
    return row;
  }
}

// -----------------------------------------------------------------------------
// Login challenge store — short-lived, in-memory, survives a TOTP round trip
// -----------------------------------------------------------------------------

interface Challenge {
  userId: string;
  expiresAt: number;
}

export class ChallengeStore {
  private map = new Map<string, Challenge>();
  private ttlMs = 5 * 60_000;

  create(userId: string): string {
    const id = nanoid(24);
    this.map.set(id, { userId, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  /** Inspect a challenge without consuming it. Returns null if missing/expired. */
  peek(id: string): string | null {
    const c = this.map.get(id);
    if (!c) return null;
    if (c.expiresAt < Date.now()) {
      this.map.delete(id);
      return null;
    }
    return c.userId;
  }

  /** Atomically validate + remove. Returns null if missing/expired. */
  consume(id: string): string | null {
    const c = this.map.get(id);
    if (!c) return null;
    this.map.delete(id);
    if (c.expiresAt < Date.now()) return null;
    return c.userId;
  }

  // Expose for tests.
  _size(): number {
    return this.map.size;
  }
}

export const ACCESS_COOKIE_NAME = "claudex_session";
