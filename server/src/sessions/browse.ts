import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Filesystem browse API. Powers the web FolderPicker, the @-file mention
 * sheet, and the general-purpose Files browser.
 *
 * Three endpoints:
 *   GET /api/browse/home     — user home (the default landing path)
 *   GET /api/browse?path=    — list immediate children of an absolute path.
 *                              Classifies each as dir/file, flags hidden
 *                              (leading-dot) entries, never follows symlinks.
 *   GET /api/browse/read?path= — read text contents of an absolute-path file
 *                                with binary detection + 1 MB cap.
 *
 * This is a host-machine service and the user knows their own paths, so
 * we intentionally do not restrict which absolute paths can be listed.
 */

const BINARY_EXTENSIONS = new Set([
  // images
  "jpg", "jpeg", "png", "gif", "ico", "webp", "bmp", "tiff", "tif",
  // audio / video
  "mp3", "mp4", "wav", "ogg", "flac", "aac", "mkv", "avi", "mov", "wmv",
  // archives
  "zip", "tar", "gz", "bz2", "xz", "rar", "7z", "zst",
  // binaries
  "exe", "dll", "obj", "bin", "wasm", "so", "dylib", "a", "o",
  // docs
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // DBs
  "db", "sqlite", "sqlite3",
  // JVM
  "class", "jar",
  // compiled python
  "pyc",
]);

const MAX_READ_BYTES = 1 * 1024 * 1024; // 1 MB

function formatMode(mode: number): string {
  const chars = ["-", "-", "-", "-", "-", "-", "-", "-", "-", "-"];
  if ((mode & 0o400) !== 0) chars[1] = "r";
  if ((mode & 0o200) !== 0) chars[2] = "w";
  if ((mode & 0o100) !== 0) chars[3] = "x";
  if ((mode & 0o040) !== 0) chars[4] = "r";
  if ((mode & 0o020) !== 0) chars[5] = "w";
  if ((mode & 0o010) !== 0) chars[6] = "x";
  if ((mode & 0o004) !== 0) chars[7] = "r";
  if ((mode & 0o002) !== 0) chars[8] = "w";
  if ((mode & 0o001) !== 0) chars[9] = "x";
  return chars.join("");
}

export async function registerBrowseRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/browse/home",
    { preHandler: app.requireAuth as any },
    async () => ({ path: os.homedir() }),
  );

  app.get(
    "/api/browse",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { path?: string };
      const raw = q?.path;
      if (typeof raw !== "string" || raw.length === 0) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      if (!path.isAbsolute(raw)) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      const abs = path.resolve(raw);

      let stat: fs.Stats;
      try {
        // lstat on the target itself: if the path *is* a symlink to a dir
        // we still follow it for the listing (statSync would), but we do
        // not follow symlinks for children. Use stat here to accept a
        // symlinked-dir passed in as `path`.
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          return reply.code(404).send({ error: "not_found" });
        }
        if (code === "EACCES" || code === "EPERM") {
          return reply.code(403).send({ error: "permission_denied" });
        }
        throw err;
      }
      if (!stat.isDirectory()) {
        return reply.code(403).send({ error: "not_a_directory" });
      }

      let names: string[];
      try {
        names = await fsp.readdir(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EACCES" || code === "EPERM") {
          return reply.code(403).send({ error: "permission_denied" });
        }
        throw err;
      }

      const entries = [] as Array<{
        name: string;
        path: string;
        isDir: boolean;
        isHidden: boolean;
        size?: number;
        mtimeMs?: number;
      }>;
      for (const name of names) {
        const childPath = path.join(abs, name);
        let childStat: fs.Stats | null = null;
        try {
          // lstat — don't follow symlinks. A dangling symlink should show
          // up as a non-dir entry, not crash the listing.
          childStat = await fsp.lstat(childPath);
        } catch {
          // entry disappeared between readdir and lstat, or no permission.
          // Skip it — the listing is a snapshot, not a transaction.
          continue;
        }
        const isSymlink = childStat.isSymbolicLink();
        const isDir = !isSymlink && childStat.isDirectory();
        const isFile = isSymlink || childStat.isFile();
        if (!isDir && !isFile) {
          // sockets, block devices, fifos, etc. — skip.
          continue;
        }
        entries.push({
          name,
          path: childPath,
          isDir,
          isHidden: name.startsWith("."),
          size: isFile ? childStat.size : undefined,
          mtimeMs: childStat.mtimeMs,
        });
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const parent = path.dirname(abs);
      return {
        path: abs,
        parent: parent === abs ? null : parent,
        entries,
      };
    },
  );

  // GET /api/browse/read?path=<absPath>
  //
  // Reads a text file at any absolute host path. Used by the general-purpose
  // Files browser (which is not project-scoped). Mirrors the safety of the
  // project-scoped /api/files/read: extension blocklist, null-byte sniff, and
  // a hard 1 MB cap with a `truncated: true` flag. No git annotations — that
  // layer lives in the project-scoped API and isn't meaningful for arbitrary
  // host paths.
  app.get(
    "/api/browse/read",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const q = req.query as { path?: string };
      const raw = q?.path;
      if (typeof raw !== "string" || raw.length === 0) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      if (!path.isAbsolute(raw)) {
        return reply.code(400).send({ error: "not_absolute" });
      }
      const abs = path.resolve(raw);

      // Extension-based rejection first — fastest path, no I/O.
      const ext = path.extname(abs).toLowerCase().slice(1);
      if (BINARY_EXTENSIONS.has(ext)) {
        return reply.code(415).send({ error: "binary_file" });
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT")
          return reply.code(404).send({ error: "not_found" });
        if (code === "EACCES" || code === "EPERM")
          return reply.code(403).send({ error: "permission_denied" });
        throw err;
      }
      if (stat.isDirectory()) {
        return reply.code(400).send({ error: "is_a_directory" });
      }

      // Read up to MAX_READ_BYTES + 1 so we can detect "larger than cap" in
      // one read.
      const fd = await fsp.open(abs, "r");
      let content: string;
      let truncated = false;
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES + 1);
        const { bytesRead } = await fd.read(buf, 0, MAX_READ_BYTES + 1, 0);
        truncated = bytesRead > MAX_READ_BYTES;
        const slice = buf.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));

        // Null-byte sniff: catches binaries the extension check missed.
        const sniffLen = Math.min(512, slice.length);
        for (let i = 0; i < sniffLen; i++) {
          if (slice[i] === 0) {
            return reply.code(415).send({ error: "binary_file" });
          }
        }

        content = slice.toString("utf8");
      } finally {
        await fd.close();
      }

      const lines = content.length === 0 ? 0 : content.split("\n").length;
      const parent = path.dirname(abs);
      return {
        path: abs,
        parent: parent === abs ? null : parent,
        name: path.basename(abs),
        content,
        lines,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: formatMode(stat.mode),
        truncated,
      };
    },
  );
}
