#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import QRCode from "qrcode";
import pino from "pino";
import { loadConfig } from "../lib/config.js";
import { openDb } from "../db/index.js";
import {
  UserStore,
  generateTotpSecret,
  hashPassword,
  loadOrCreateJwtSecret,
  totpUri,
} from "../auth/index.js";
import {
  generateRecoveryCodes,
  hashRecoveryCodes,
  RECOVERY_CODE_BATCH_SIZE,
} from "../auth/recovery-codes.js";

interface InitInputs {
  username: string;
  password: string;
}

/**
 * Collect credentials. Precedence:
 *   1. CLI flags: --username=... --password=...
 *   2. Env vars: CLAUDEX_INIT_USERNAME / CLAUDEX_INIT_PASSWORD
 *   3. Interactive prompts on stdin.
 *
 * Non-interactive paths exist so tests and automation don't have to juggle
 * pipes and pseudo-ttys.
 */
async function collectInputs(): Promise<InitInputs> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
  };
  const username = flag("username") ?? process.env.CLAUDEX_INIT_USERNAME;
  const password = flag("password") ?? process.env.CLAUDEX_INIT_PASSWORD;
  if (username && password) {
    return { username, password };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      "non-interactive stdin: provide --username=... --password=... or " +
        "CLAUDEX_INIT_USERNAME / CLAUDEX_INIT_PASSWORD env vars.",
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    let u = username;
    while (!u) {
      const v = (await rl.question("Username: ")).trim();
      if (v) u = v;
    }
    let p = password ?? "";
    while (p.length < 8) {
      p = await rl.question(
        "Password (>= 8 chars, will be visible while typing): ",
      );
      if (p.length < 8) output.write("Too short.\n");
    }
    const confirm = await rl.question("Confirm password: ");
    if (p !== confirm) {
      throw new Error("passwords did not match");
    }
    return { username: u, password: p };
  } finally {
    rl.close();
  }
}

async function main() {
  const config = loadConfig();
  // Silent logger — the init flow prints its own human-friendly output and
  // we don't want pino frames mixed with readline prompts on stdout.
  const log = pino({ level: "silent" }) as any;
  const { db, close } = openDb(config, log);
  loadOrCreateJwtSecret(config);

  const users = new UserStore(db);
  if (users.count() > 0) {
    process.stderr.write(
      `claudex: an admin already exists in ${config.dbPath}.\n` +
        `To start over, delete the database file manually and run \`claudex init\` again.\n`,
    );
    close();
    process.exit(1);
  }

  let inputs: InitInputs;
  try {
    inputs = await collectInputs();
  } catch (err) {
    process.stderr.write(
      `claudex init: ${err instanceof Error ? err.message : err}\n`,
    );
    close();
    process.exit(1);
  }

  if (inputs.password.length < 8) {
    process.stderr.write("password must be at least 8 characters\n");
    close();
    process.exit(1);
  }

  const totpSecret = generateTotpSecret();
  const uri = totpUri(totpSecret, inputs.username.toLowerCase());
  const qr = await QRCode.toString(uri, { type: "terminal", small: true });

  const passwordHash = await hashPassword(inputs.password);
  const user = users.create({
    username: inputs.username,
    passwordHash,
    totpSecret,
  });

  // Seed the 10 one-time recovery codes at setup so a user who loses their
  // authenticator on day one isn't locked out. The server only stores
  // hashes — what we print below is the ONLY chance to capture them.
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_BATCH_SIZE);
  const recoveryHashes = await hashRecoveryCodes(recoveryCodes);
  users.setRecoveryCodeHashes(user.id, recoveryHashes);

  output.write(`\nScan this QR code with your authenticator app:\n\n`);
  output.write(qr);
  output.write(`\nOr enter this secret manually: ${totpSecret}\n`);
  output.write(`Issuer / account: claudex / ${inputs.username.toLowerCase()}\n`);
  output.write(`\n✓ Admin user "${inputs.username}" created.\n`);
  output.write(`  State directory: ${config.stateDir}\n`);
  output.write(`  DB: ${config.dbPath}\n`);
  output.write(
    `\nRecovery codes — save these somewhere safe. Each one works ONCE if you\n` +
      `lose your authenticator app. They are NOT shown again.\n\n`,
  );
  for (const code of recoveryCodes) {
    output.write(`  ${code}\n`);
  }
  output.write(
    `\nYou can regenerate these later from Settings → Security (this invalidates\n` +
      `the current batch).\n`,
  );
  output.write(`\nNext: run \`pnpm dev\` and visit http://127.0.0.1:5173/.\n`);
  close();
}

main().catch((err) => {
  process.stderr.write(
    `claudex init failed: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(2);
});
