import chokidar, { type FSWatcher } from "chokidar";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Session, SessionStatus } from "@claudex/shared";
import type { SessionStore } from "../sessions/store.js";
import type { ProjectStore } from "../sessions/projects.js";
import type { SessionManager } from "../sessions/manager.js";
import {
  defaultCliProjectsRoot,
  decodeSlug,
} from "../sessions/cli-discovery.js";
import { importCliSession } from "../sessions/cli-import.js";
import { resyncCliSession } from "../sessions/cli-resync.js";

/**
 * CLI live sync — watches `~/.claude/projects/<slug>/<uuid>.jsonl` for changes
 * from the user's `claude` CLI and keeps claudex's DB state in sync in near
 * real time. Complements the on-demand Import sheet + the GET /api/sessions
 * resync-on-open path: this fires as soon as the CLI writes, whether or not
 * the user has claudex open on that session.
 *
 * Design notes:
 *   - We only react to `add` / `change`. `unlink` is deliberately ignored —
 *     a user deleting a CLI JSONL should not silently wipe claudex state.
 *   - Status is a heuristic from the file's mtime + last line (see
 *     `deriveCliStatus`). File-watch can't observe "is the CLI actually
 *     running right now", only "has the file grown recently". Paused-but-
 *     background sessions may briefly flip to idle then back.
 *   - Resync is deduped per sessionId so a flurry of writes triggers at most
 *     one in-flight import. The next change event after completion will
 *     pick up anything missed.
 *   - Creating a chokidar watcher is behind a factory so tests can point it
 *     at a tmp `cliProjectsRoot` without touching the real `~/.claude`.
 */

const SDK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNNING_MTIME_WINDOW_MS = 60_000;
const TAIL_BYTES = 8 * 1024;

export interface CliSyncWatcherDeps {
  sessions: SessionStore;
  projects: ProjectStore;
  manager: SessionManager;
  /** Override `~/.claude/projects` — tests always pass a tmp root. */
  cliProjectsRoot?: string;
  logger?: {
    debug?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export interface CliSyncWatcher {
  /** Await the initial directory scan + initial status backfill. */
  ready(): Promise<void>;
  /** Stop watching and release FS handles. Safe to call multiple times. */
  close(): Promise<void>;
  /**
   * Test hook — process a single `change` event synchronously against the
   * current state. Production callers should let chokidar drive it.
   */
  __handleForTest(
    kind: "add" | "change",
    absPath: string,
  ): Promise<void>;
}

export function startCliSyncWatcher(
  deps: CliSyncWatcherDeps,
): CliSyncWatcher {
  const root = deps.cliProjectsRoot ?? defaultCliProjectsRoot();
  const log = deps.logger;

  // Dedup guard — one in-flight operation per sessionId.
  const inflight = new Set<string>();

  // Initial status backfill: runs once after boot against every CLI-imported
  // session already in the DB. Cheap: stat + tail-read per row.
  const backfillPromise = backfillStatuses(deps, root).catch((err) => {
    log?.warn?.({ err }, "cli-sync: initial status backfill failed");
  });

  // Make the directory exist so chokidar doesn't swallow a fresh install
  // where the user hasn't ever run `claude` yet. No-op if it already exists.
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (err) {
    log?.warn?.({ err, root }, "cli-sync: could not ensure projects root");
  }

  const watcher: FSWatcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  const handle = async (
    kind: "add" | "change",
    absPath: string,
  ): Promise<void> => {
    if (!absPath.endsWith(".jsonl")) return;
    const base = path.basename(absPath, ".jsonl");
    if (!SDK_ID_RE.test(base)) return;
    const sdkSessionId = base;

    // We might get `add` events during the initial scan even with
    // ignoreInitial — chokidar treats newly-discovered files after ready as
    // add regardless. Either way, adopt-if-new is the same path.
    if (inflight.has(sdkSessionId)) return;
    inflight.add(sdkSessionId);
    try {
      const existing = deps.sessions.findBySdkSessionId(sdkSessionId);
      if (existing) {
        await onExistingChange(deps, existing, absPath);
      } else {
        await onNewJsonl(deps, absPath, sdkSessionId, root);
      }
    } catch (err) {
      log?.warn?.(
        { err, sdkSessionId, kind, absPath },
        "cli-sync: handler failed",
      );
    } finally {
      inflight.delete(sdkSessionId);
    }
  };

  watcher.on("add", (p: string) => {
    void handle("add", p);
  });
  watcher.on("change", (p: string) => {
    void handle("change", p);
  });
  watcher.on("error", (err: unknown) => {
    log?.warn?.({ err }, "cli-sync: watcher error");
  });

  const readyPromise = new Promise<void>((resolve) => {
    watcher.once("ready", () => resolve());
  });

  return {
    ready: async () => {
      await readyPromise;
      await backfillPromise;
    },
    close: async () => {
      await watcher.close();
    },
    __handleForTest: handle,
  };
}

/**
 * A JSONL appeared for a session we haven't adopted yet. Import it through
 * the normal `importCliSession` path so the row is stamped with the same
 * cli_jsonl_seq + events the Import sheet would produce. The project's cwd
 * comes from the slug directory the file lives in.
 */
async function onNewJsonl(
  deps: CliSyncWatcherDeps,
  absPath: string,
  sdkSessionId: string,
  root: string,
): Promise<void> {
  const slug = path.basename(path.dirname(absPath));
  const parent = path.dirname(path.dirname(absPath));
  // Guard against files at unexpected depths — a JSONL dropped directly into
  // the root, or buried deeper than `<root>/<slug>/<file>`, isn't something
  // we can safely adopt.
  if (parent !== root) {
    deps.logger?.debug?.(
      { absPath, root },
      "cli-sync: ignoring JSONL outside <root>/<slug>/ layout",
    );
    return;
  }
  const cwd = decodeSlug(slug);
  const title = await firstUserMessageTitle(absPath);

  const result = await importCliSession(
    {
      sessions: deps.sessions,
      projects: deps.projects,
      logger: deps.logger,
    },
    {
      sessionId: sdkSessionId,
      cwd,
      title,
      filePath: absPath,
    },
  );
  if (result.wasNew) {
    deps.logger?.info?.(
      {
        sessionId: result.session.id,
        sdkSessionId,
        cwd,
        eventsImported: result.eventsImported,
      },
      "cli-sync: adopted new CLI session",
    );
    // Broadcast a status so Home's list wakes up. New imports default to
    // idle; the status heuristic below will upgrade if the file is fresh.
    const derived = await deriveCliStatus(result.session, absPath);
    if (derived !== result.session.status) {
      deps.sessions.setStatus(result.session.id, derived);
    }
    // Tell subscribed tabs to refetch the transcript (initial events have
    // been seeded) and Home to refresh status.
    deps.manager.notifyTranscriptRefresh(result.session.id);
    notifyStatus(deps, result.session.id, derived);
  } else {
    // Race: someone else adopted this session between our lookup and the
    // import call. Treat as a change event and resync.
    await onExistingChange(deps, result.session, absPath);
  }
}

/**
 * An existing adopted session's JSONL changed. Resync from the last
 * cli_jsonl_seq and refresh status.
 */
async function onExistingChange(
  deps: CliSyncWatcherDeps,
  session: Session,
  absPath: string,
): Promise<void> {
  // Resync — appends any new events and broadcasts refresh_transcript on
  // success via its manager hook.
  try {
    await resyncCliSession(
      {
        sessions: deps.sessions,
        manager: deps.manager,
        cliProjectsRoot: deps.cliProjectsRoot,
        logger: deps.logger,
      },
      session,
    );
  } catch (err) {
    deps.logger?.warn?.(
      { err, sessionId: session.id },
      "cli-sync: resync failed",
    );
  }

  // Always refresh derived status — the JSONL grew, which is new signal
  // regardless of whether any mapped events got appended.
  const fresh = deps.sessions.findById(session.id) ?? session;
  const next = await deriveCliStatus(fresh, absPath);
  if (next !== fresh.status) {
    deps.sessions.setStatus(session.id, next);
    notifyStatus(deps, session.id, next);
  }
}

/**
 * Run the initial status-derivation pass over every CLI-imported session.
 * Cheap — one stat + short tail read per row. Doesn't touch events.
 */
async function backfillStatuses(
  deps: CliSyncWatcherDeps,
  root: string,
): Promise<void> {
  const all = deps.sessions.list({ includeArchived: false, includeSideChats: true });
  for (const s of all) {
    if (!s.sdkSessionId) continue;
    const absPath = await locateJsonl(root, s.sdkSessionId);
    if (!absPath) continue;
    try {
      const next = await deriveCliStatus(s, absPath);
      if (next !== s.status) {
        deps.sessions.setStatus(s.id, next);
        notifyStatus(deps, s.id, next);
      }
    } catch (err) {
      deps.logger?.debug?.(
        { err, sessionId: s.id },
        "cli-sync: status backfill skipped row",
      );
    }
  }
}

/**
 * mtime + last-line heuristic. See module-header notes for limitations.
 * Returns the new status to stamp (which may equal the existing one).
 */
export async function deriveCliStatus(
  session: Session,
  absPath: string,
  now: number = Date.now(),
): Promise<SessionStatus> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return session.status;
  }
  const mtimeAge = now - stat.mtimeMs;
  const lastLine = await tailLastJsonlLine(absPath).catch(() => null);
  const looksDone = lastLineLooksTerminal(lastLine);
  const recentlyWritten = mtimeAge < RUNNING_MTIME_WINDOW_MS;
  if (recentlyWritten && !looksDone) return "running";
  if (looksDone && session.status === "running") return "idle";
  return session.status;
}

/**
 * True when the JSONL's last record looks like the CLI finished a turn.
 * The CLI records final assistant messages with `stop_reason` set; we also
 * accept top-level `result` records, which some SDK versions emit.
 */
function lastLineLooksTerminal(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "result") return true;
  if (obj.type !== "assistant") return false;
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message) return false;
  return message.stop_reason !== undefined && message.stop_reason !== null;
}

/**
 * Read the last ~8 KB of a file, split on `\n`, parse the last non-empty
 * line as JSON. Returns null on malformed / missing / empty input.
 */
async function tailLastJsonlLine(
  absPath: string,
): Promise<Record<string, unknown> | null> {
  let fd: fsp.FileHandle | null = null;
  try {
    fd = await fsp.open(absPath, "r");
    const stat = await fd.stat();
    const size = stat.size;
    if (size === 0) return null;
    const len = Math.min(TAIL_BYTES, size);
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, size - len);
    const text = buf.toString("utf-8");
    const lines = text.split("\n");
    // Walk back from the end looking for the first non-empty line.
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // If the tail window started mid-line we may have truncated JSON;
        // keep walking backwards — an earlier complete line is fine.
        continue;
      }
    }
    return null;
  } finally {
    if (fd) await fd.close();
  }
}

async function firstUserMessageTitle(absPath: string): Promise<string> {
  const readline = await import("node:readline");
  const stream = fs.createReadStream(absPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      n++;
      if (n > 40) break;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type !== "user") continue;
        const msg = obj.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "user") continue;
        const c = msg.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? (c.find(
                  (b) =>
                    b &&
                    typeof b === "object" &&
                    (b as Record<string, unknown>).type === "text",
                ) as Record<string, unknown> | undefined)?.text
              : undefined;
        if (typeof text === "string" && text.trim().length > 0) {
          return truncate(text.replace(/\s+/g, " ").trim(), 60);
        }
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return "Untitled CLI session";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, "") + "…";
}

async function locateJsonl(
  root: string,
  sdkSessionId: string,
): Promise<string | null> {
  try {
    const slugs = await fsp.readdir(root);
    for (const slug of slugs) {
      const candidate = path.join(root, slug, `${sdkSessionId}.jsonl`);
      try {
        const stat = await fsp.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // not this dir, keep looking
      }
    }
  } catch {
    return null;
  }
  return null;
}

function notifyStatus(
  deps: CliSyncWatcherDeps,
  sessionId: string,
  status: SessionStatus,
): void {
  // Map the DB status back onto the "status" RunnerEvent vocabulary. The
  // WS bridge translates this into a `session_update` frame on the wire.
  let rtStatus: "running" | "idle" | "terminated" | "starting";
  if (status === "running") rtStatus = "running";
  else if (status === "idle") rtStatus = "idle";
  else rtStatus = "idle"; // awaiting/error/archived ride the row itself; we don't synthesize those here
  deps.manager.broadcastStatus(sessionId, rtStatus);
}
