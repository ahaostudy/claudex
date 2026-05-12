// pm2's entrypoint for the claudex server.
//
// pm2 on Windows can't `spawn('pnpm.cmd')` reliably (Node's spawn rejects .cmd
// scripts with EINVAL unless shell:true is threaded through every layer). So
// pm2 runs this plain Node script instead, and we spawn node+tsx ourselves
// from server/. Bonus: shorter process tree, cleaner restarts.

const { spawn } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const serverDir = path.join(repoRoot, "server");

let tsxCli;
try {
  // `tsx` restricts subpath imports via its package `exports` map, so we
  // resolve the package root via package.json and join bin manually.
  const pkgJson = require.resolve("tsx/package.json", { paths: [serverDir] });
  const pkgDir = path.dirname(pkgJson);
  const pkg = require(pkgJson);
  const binRel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin && Object.values(pkg.bin)[0];
  if (!binRel) throw new Error("tsx package.json has no bin entry");
  tsxCli = path.resolve(pkgDir, binRel);
} catch (err) {
  console.error(
    "[pm2-entry] could not locate tsx under server/node_modules. Run `pnpm install` first.",
  );
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}

process.env.NODE_ENV = process.env.NODE_ENV || "production";

const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
  cwd: serverDir,
  stdio: "inherit",
  env: process.env,
});

let exiting = false;
function forward(sig) {
  return () => {
    if (exiting) return;
    exiting = true;
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  };
}
process.on("SIGINT", forward("SIGINT"));
process.on("SIGTERM", forward("SIGTERM"));

child.on("exit", (code, signal) => {
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
child.on("error", (err) => {
  console.error("[pm2-entry] failed to spawn node:", err);
  process.exit(1);
});
