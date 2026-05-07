import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface Config {
  host: string;
  port: number;
  stateDir: string; // ~/.claudex
  dbPath: string; // ~/.claudex/claudex.db
  logDir: string; // ~/.claudex/logs
  jwtSecretPath: string; // ~/.claudex/jwt.secret
  nodeEnv: "development" | "production";
}

function resolveStateDir(): string {
  const override = process.env.CLAUDEX_STATE_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".claudex");
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
}

export function loadConfig(): Config {
  const stateDir = resolveStateDir();
  ensureDir(stateDir);
  const logDir = path.join(stateDir, "logs");
  ensureDir(logDir);

  const nodeEnv =
    process.env.NODE_ENV === "production" ? "production" : "development";

  return {
    host: process.env.CLAUDEX_HOST ?? "127.0.0.1",
    port: Number(process.env.CLAUDEX_PORT ?? 5179),
    stateDir,
    dbPath: path.join(stateDir, "claudex.db"),
    logDir,
    jwtSecretPath: path.join(stateDir, "jwt.secret"),
    nodeEnv,
  };
}

// Refuse to bind beyond loopback — this is a hard boundary. See CLAUDE.md.
export function assertSafeBind(host: string): void {
  const ok = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!ok) {
    throw new Error(
      `Refusing to bind to ${host}. claudex must bind to 127.0.0.1 only. ` +
        `Terminate TLS and expose via Cloudflare Tunnel / Tailscale / Caddy outside the process.`,
    );
  }
}
