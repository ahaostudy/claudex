import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { CliSessionSummary } from "@claudex/shared";

/**
 * Discovery of `claude` CLI sessions persisted on disk so claudex can adopt
 * them. The CLI writes one JSONL file per session at:
 *
 *   ~/.claude/projects/<cwd-slug>/<sessionUuid>.jsonl
 *
 * The <cwd-slug> is the absolute cwd with every separator replaced by '-'.
 * POSIX `/Users/hao/Code/foo` → `-Users-hao-Code-foo`. Windows
 * `D:\Code\foo` → `D--Code-foo` (both `:` and `\` collapse to `-`, producing
 * the `X--` drive-letter prefix we key off).
 *
 * IMPORTANT — slug ambiguity: the CLI's encoding is lossy. A directory named
 * literally `my-dir` renders the same as `my/dir`. We cannot round-trip
 * perfectly; `decodeSlug` produces the CLI's own interpretation, which is
 * what the `claude` binary itself does at runtime. Users with real `-` in
 * their paths will see the same quirk claudex-less CLI users see.
 */

/** Default root: the real `~/.claude/projects` directory. */
export function defaultCliProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Reverse a CLI cwd slug back into an absolute path. POSIX slug convention:
 * `/` ↔ `-`, with a leading `-` indicating the root `/`. Windows slug
 * convention: `X:\` ↔ `X--`, with every `\` thereafter also collapsed to
 * `-` (indistinguishable from real dashes — we leave the body verbatim so
 * the user can read their own path, e.g. `D--Code-foo-bar` →
 * `D:\Code-foo-bar`).
 *
 * Known ambiguity: real dashes in directory names round-trip incorrectly.
 * Documented — same behavior as the CLI. See module docstring. A POSIX path
 * that literally starts with `/X--…` would also hit the Windows branch
 * here; that's rare enough to accept.
 */
export function decodeSlug(slug: string): string {
  // Windows drive-letter prefix: `D--…` or `-D--…` (the CLI may or may not
  // emit a leading `-` before the drive letter). Restore `X:\` and keep the
  // rest of the body verbatim.
  const winMatch = slug.match(/^-?([A-Za-z])--(.*)$/);
  if (winMatch) return `${winMatch[1]}:\\${winMatch[2]}`;
  // POSIX: strip the leading `-` (which represents the root `/`) and swap.
  const body = slug.startsWith("-") ? slug.slice(1) : slug;
  return "/" + body.split("-").join("/");
}

/**
 * Encode an absolute cwd into the CLI's slug convention: every `/` becomes
 * `-`, so `/Users/hao/Code/foo` becomes `-Users-hao-Code-foo`. Inverse of
 * `decodeSlug`. Lossy in the same way the CLI is: real `-` in directory
 * names will collide with the separator. Returns the input unchanged if it
 * isn't an absolute path (defensive — callers should pass cwds that came
 * from `lsof -p <pid> -d cwd` or similar).
 */
export function encodeCwdToSlug(cwd: string): string {
  if (!cwd.startsWith("/")) return cwd;
  return cwd.split("/").join("-");
}

/**
 * Enumerate every CLI session jsonl under `root` and return summaries. The
 * directory is usually small (dozens of cwds, tens of sessions each) so
 * doing this synchronously-ish is fine; we still stream-read each file to
 * extract only the head lines rather than slurping multi-MB transcripts.
 */
export async function listCliSessions(
  root: string = defaultCliProjectsRoot(),
): Promise<CliSessionSummary[]> {
  let slugs: string[];
  try {
    slugs = await fsp.readdir(root);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const out: CliSessionSummary[] = [];
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const cwd = decodeSlug(slug);
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const full = path.join(dir, name);
      const sessionId = name.slice(0, -".jsonl".length);
      let summary: CliSessionSummary | null = null;
      try {
        summary = await summarizeJsonl(full, sessionId, cwd);
      } catch {
        // Corrupt / unreadable file — skip, never blow up the whole list.
        continue;
      }
      if (summary) out.push(summary);
    }
  }

  // Newest first — matches how the rest of the app lists sessions.
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return out;
}

/**
 * Scan the first ~20 lines of a JSONL file to pull the first user message.
 * We stop as soon as we have a title to avoid walking multi-MB transcripts.
 */
async function summarizeJsonl(
  filePath: string,
  sessionId: string,
  cwd: string,
): Promise<CliSessionSummary | null> {
  const stat = await fsp.stat(filePath);
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let firstUserMessage: string | null = null;
  let lineCount = 0;
  const maxScan = 40; // head-only; we don't need the full line count for sort
  try {
    for await (const line of rl) {
      lineCount++;
      if (firstUserMessage === null && lineCount <= maxScan) {
        const text = extractUserText(line);
        if (text !== null && text.length > 0) {
          firstUserMessage = text;
        }
      }
      if (firstUserMessage !== null && lineCount >= maxScan) {
        break;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const title =
    firstUserMessage !== null && firstUserMessage.length > 0
      ? truncateTitle(firstUserMessage, 60)
      : "Untitled CLI session";

  return {
    sessionId,
    cwd,
    title,
    firstUserMessage,
    lineCount,
    fileSize: stat.size,
    lastModified: stat.mtime.toISOString(),
    filePath,
  };
}

/**
 * Pull the user-visible text out of one JSONL record, or return null if this
 * record isn't a user message we can render. Records look like:
 *   {"type":"user","message":{"role":"user","content":"hello"}, ...}
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
 * Non-user records ("assistant", "queue-operation", "attachment", ...) are
 * filtered out.
 */
function extractUserText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj.type !== "user") return null;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        return (block as Record<string, unknown>).text as string;
      }
    }
  }
  return null;
}

/**
 * Collapse whitespace and truncate on a word boundary under `max` chars,
 * appending an ellipsis when we drop anything. Titles in the UI are one
 * line; newlines look bad so we fold them too.
 */
export function truncateTitle(raw: string, max: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const slice = flat.slice(0, max);
  // Prefer a word boundary if one exists in the last ~20% of the slice.
  const lastSpace = slice.lastIndexOf(" ");
  const cutoff =
    lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cutoff.replace(/[\s.,;:!?-]+$/, "") + "…";
}
