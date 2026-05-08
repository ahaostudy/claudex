import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Filesystem browse API. Powers the web FolderPicker.
 *
 * Deliberately minimal: list immediate children of a directory, classify
 * each as dir/file, flag hidden (leading-dot) entries. Never reads file
 * contents, never follows symlinks — this is a host-machine service and
 * the user knows their own paths.
 */
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
}
