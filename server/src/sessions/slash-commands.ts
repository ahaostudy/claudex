import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SlashCommand } from "@claudex/shared";
import { ProjectStore } from "./projects.js";

/**
 * Slash-command listing API. Surfaces the real set of `/` commands the
 * `claude` CLI knows about so the web composer's `/` picker can show more
 * than the four hardcoded tokens we shipped in P2.
 *
 * Four sources, in priority order:
 *   1. Built-in CLI commands — hardcoded below. These ship with `claude`
 *      itself and have no on-disk manifest we can scan, so we keep a
 *      curated list of the common ones. Safer to under-report than to
 *      invent commands that don't exist in the CLI.
 *   2. User commands — `~/.claude/commands/*.md`. File basename (minus
 *      `.md`) is the command name; we parse out a description from
 *      frontmatter or a leading `# …` line.
 *   3. Project commands — `<project.path>/.claude/commands/*.md`, only
 *      when the caller passes a `projectId`.
 *   4. Plugin commands — driven by `~/.claude/plugins/installed_plugins.json`
 *      which lists every installed plugin with its `installPath`. For each
 *      plugin we scan `<installPath>/commands/*.md`. If the manifest is
 *      missing or unparseable, plugin scanning is skipped silently (we
 *      don't guess the versioned cache layout). Commands are de-duplicated
 *      across multiple installed versions of the same plugin — the most
 *      recently updated entry (by `lastUpdated`, else `installedAt`) wins.
 */

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------
//
// These are the user-facing slash commands shipped by the `claude` CLI.
// There is no machine-readable manifest for these — the CLI interprets them
// directly — so we maintain a curated list here. Err on the side of omitting
// rather than inventing: a missing entry is a nuisance; a phantom entry sends
// the CLI a command it doesn't understand.
//
// Sources: `claude --help`, `claude` interactive `/help`, and the public
// Claude Code docs as of May 2026. Review when upgrading the CLI version.

export const BUILT_IN_SLASH_COMMANDS: ReadonlyArray<{
  name: string;
  description: string;
}> = [
  { name: "add-dir", description: "Add a working directory to the session" },
  { name: "bug", description: "Report a bug with current context" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "compact", description: "Summarize and free context window" },
  { name: "config", description: "Open the CLI configuration" },
  { name: "continue", description: "Resume the most recent conversation" },
  { name: "cost", description: "Show token usage and cost for this session" },
  { name: "doctor", description: "Diagnose the local CLI installation" },
  { name: "help", description: "List available slash commands" },
  { name: "init", description: "Bootstrap a CLAUDE.md for this project" },
  { name: "login", description: "Authenticate with Anthropic" },
  { name: "logout", description: "Sign out of Anthropic" },
  { name: "mcp", description: "Manage MCP servers" },
  { name: "model", description: "Switch the active model" },
  { name: "plugin", description: "Manage installed plugins" },
  { name: "pr-comments", description: "Summarize comments on the current PR" },
  { name: "review", description: "Review the current diff" },
  { name: "resume", description: "Resume a previous session by id" },
  { name: "status", description: "Show session, model, and project status" },
];

// ---------------------------------------------------------------------------
// Markdown scanning
// ---------------------------------------------------------------------------

// Cap how much of each .md we read when extracting a description. The
// description is either in a YAML-ish frontmatter block (`description:`) or
// the first-heading/first-line. Either way it lives at the top — we don't
// need the body.
const DESCRIPTION_SCAN_BYTES = 1024;
const DESCRIPTION_SCAN_LINES = 10;

/**
 * Pull a one-line description out of a command markdown file.
 *
 * Tries, in order:
 *   1. YAML frontmatter `description:` key (first `---`-delimited block).
 *   2. First `# Heading` line — treated as description (minus the `#`s).
 *   3. First non-empty line.
 *
 * Reads at most the first `DESCRIPTION_SCAN_BYTES` bytes so a huge file
 * can't wedge the scan. Returns `null` when nothing usable is found.
 */
export function extractDescription(raw: string): string | null {
  const truncated = raw.slice(0, DESCRIPTION_SCAN_BYTES);
  const lines = truncated.split(/\r?\n/).slice(0, DESCRIPTION_SCAN_LINES);

  // Frontmatter: a `---` on the very first non-empty line opens a block; the
  // next `---` closes it. We only look inside that block for `description:`.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length && lines[i].trim() === "---") {
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "---") break;
      const m = line.match(/^\s*description\s*:\s*(.*)$/i);
      if (m) {
        const value = m[1].trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  }

  // First heading / non-empty line.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "---") continue;
    if (trimmed.startsWith("#")) {
      const cleaned = trimmed.replace(/^#+\s*/, "").trim();
      if (cleaned) return cleaned;
      continue;
    }
    return trimmed;
  }
  return null;
}

/**
 * Scan one `commands/` directory (top-level only) and return a SlashCommand
 * entry per `.md` file. Hidden files (dotfiles) are skipped. All filesystem
 * errors are swallowed — this is best-effort; a missing directory is normal
 * and an unreadable one shouldn't break the API.
 */
async function scanCommandsDir(
  dir: string,
  kind: SlashCommand["kind"],
): Promise<SlashCommand[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SlashCommand[] = [];
  for (const entry of entries) {
    // Only shallow `.md` files. Skip hidden, skip sub-dirs.
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.slice(0, -3); // strip ".md"
    if (!name) continue;
    const abs = path.join(dir, entry.name);
    let description: string | null = null;
    try {
      const handle = await fsp.open(abs, "r");
      try {
        const buf = Buffer.alloc(DESCRIPTION_SCAN_BYTES);
        const { bytesRead } = await handle.read(
          buf,
          0,
          DESCRIPTION_SCAN_BYTES,
          0,
        );
        description = extractDescription(buf.subarray(0, bytesRead).toString("utf8"));
      } finally {
        await handle.close();
      }
    } catch {
      // EACCES / ENOENT / weird binary file — leave description null.
    }
    out.push({ name, description, kind, source: abs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plugin scanning
// ---------------------------------------------------------------------------

// Shape of `~/.claude/plugins/installed_plugins.json` (v2). We're intentionally
// permissive: anything we don't recognize is skipped rather than failing hard.
interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}
interface InstalledPluginsFile {
  version?: number;
  plugins?: Record<string, InstalledPluginEntry[]>;
}

/**
 * Pick the "current" install for a plugin when multiple versions appear in
 * the manifest. Strategy: prefer the entry with the most recent
 * `lastUpdated`, falling back to `installedAt`, falling back to the first
 * entry as it appears. Deterministic enough for a stable listing.
 */
function pickCurrentInstall(
  installs: InstalledPluginEntry[],
): InstalledPluginEntry | null {
  if (installs.length === 0) return null;
  const withTime = installs.map((e) => ({
    entry: e,
    t: Date.parse(e.lastUpdated ?? e.installedAt ?? "") || 0,
  }));
  withTime.sort((a, b) => b.t - a.t);
  return withTime[0].entry;
}

/**
 * Scan plugin commands off `~/.claude/plugins/installed_plugins.json`.
 * Returns [] on any failure — missing file, bad JSON, unexpected shape, or a
 * plugin whose `installPath` has no `commands/` dir. This is best-effort;
 * the picker should never blow up because the plugin manifest changed
 * shape. De-duplicates across multiple installed versions of the same
 * plugin (keyed on the manifest key, e.g. `skill-creator@marketplace`).
 */
export async function scanPluginCommands(
  userClaudeDir: string,
): Promise<SlashCommand[]> {
  const manifestPath = path.join(
    userClaudeDir,
    "plugins",
    "installed_plugins.json",
  );
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch {
    return [];
  }
  let parsed: InstalledPluginsFile;
  try {
    parsed = JSON.parse(raw) as InstalledPluginsFile;
  } catch {
    return [];
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object") return [];

  const out: SlashCommand[] = [];
  // Iterate deterministically — sort by the manifest key so the output
  // order is stable across runs regardless of JSON iteration quirks.
  const keys = Object.keys(plugins).sort();
  for (const key of keys) {
    const installs = plugins[key];
    if (!Array.isArray(installs)) continue;
    const current = pickCurrentInstall(installs);
    if (!current?.installPath) continue;
    const cmdDir = path.join(current.installPath, "commands");
    const entries = await scanCommandsDir(cmdDir, "plugin");
    for (const e of entries) out.push(e);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ListSlashCommandsOpts {
  /** Absolute path to the user's Claude config dir. Defaults to `~/.claude`. */
  userClaudeDir?: string;
  /** Absolute path to a project root — enables project-scoped scan. */
  projectPath?: string;
}

/**
 * Build the full slash-command list. Pure of HTTP; production wires in
 * `~/.claude/commands/` as the user-commands root, tests pass in a tmp dir.
 *
 * Sort order: built-in first (CLI commands the user almost certainly
 * wants), then user, then project — each bucket alphabetized by `name`.
 * The built-ins list stays in its curated order (it's already alpha).
 */
export async function listSlashCommands(
  opts: ListSlashCommandsOpts = {},
): Promise<SlashCommand[]> {
  const userClaudeDir =
    opts.userClaudeDir ?? path.join(os.homedir(), ".claude");
  const builtIns: SlashCommand[] = BUILT_IN_SLASH_COMMANDS.map((c) => ({
    name: c.name,
    description: c.description,
    kind: "built-in",
  }));

  const userCmds = await scanCommandsDir(
    path.join(userClaudeDir, "commands"),
    "user",
  );
  userCmds.sort((a, b) => a.name.localeCompare(b.name));

  let projectCmds: SlashCommand[] = [];
  if (opts.projectPath) {
    projectCmds = await scanCommandsDir(
      path.join(opts.projectPath, ".claude", "commands"),
      "project",
    );
    projectCmds.sort((a, b) => a.name.localeCompare(b.name));
  }

  const pluginCmds = await scanPluginCommands(userClaudeDir);

  return [...builtIns, ...userCmds, ...projectCmds, ...pluginCmds];
}

// ---------------------------------------------------------------------------
// HTTP route
// ---------------------------------------------------------------------------

export interface SlashCommandsRoutesDeps {
  db: Database.Database;
  /**
   * Override the Claude config dir used for user-scoped scans. Defaults to
   * `~/.claude`. Tests pass a tmp dir so they don't read the host user's
   * real commands.
   */
  userClaudeDir?: string;
}

export async function registerSlashCommandRoutes(
  app: FastifyInstance,
  deps: SlashCommandsRoutesDeps,
): Promise<void> {
  const projects = new ProjectStore(deps.db);

  app.get(
    "/api/slash-commands",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as { projectId?: string };
      let projectPath: string | undefined;
      if (q?.projectId) {
        const project = projects.findById(q.projectId);
        // Unknown projectId is soft-ignored — the picker still works with
        // the built-in + user commands, which is better UX than a 404 when
        // the client races a project delete.
        if (project) projectPath = project.path;
      }
      const commands = await listSlashCommands({
        userClaudeDir: deps.userClaudeDir,
        projectPath,
      });
      return { commands };
    },
  );
}
