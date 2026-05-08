import path from "node:path";
import type { Session } from "@claudex/shared";
import type { ProjectStore } from "./projects.js";
import type { SessionStore } from "./store.js";

export interface CliImportDeps {
  sessions: SessionStore;
  projects: ProjectStore;
}

export interface CliImportInput {
  sessionId: string; // CLI/SDK session_id (uuid)
  cwd: string; // absolute path the CLI recorded the session under
  title: string;
}

export interface CliImportResult {
  session: Session;
  wasNew: boolean;
}

/**
 * Adopt a `claude` CLI session into claudex. Idempotent:
 *   - if a claudex session already has `sdk_session_id === input.sessionId`,
 *     we return that row with `wasNew: false` — never duplicate
 *   - otherwise we ensure a project row exists for `cwd` (creating one named
 *     after the cwd's basename if needed) and insert a fresh session row
 *     with `sdk_session_id` pre-populated so the next WS turn resumes the
 *     same SDK conversation via `resume: <uuid>`.
 *
 * The adopted session is never marked as a worktree — CLI sessions run in
 * the user's real cwd; claudex's worktree plumbing is for its own spawns.
 */
export function importCliSession(
  deps: CliImportDeps,
  input: CliImportInput,
): CliImportResult {
  const existing = deps.sessions.findBySdkSessionId(input.sessionId);
  if (existing) {
    return { session: existing, wasNew: false };
  }

  // Anchor the session against a project row for the cwd. If the user
  // already added this cwd manually we reuse it; otherwise we synthesize a
  // project named after the basename (e.g. "claudex" for /Users/h/Code/AI/claudex).
  const project = deps.projects.upsertByPath({
    name: path.basename(input.cwd) || input.cwd,
    path: input.cwd,
  });

  const session = deps.sessions.create({
    title: input.title,
    projectId: project.id,
    // Default to the project's home model. CLI sessions store their own
    // model in the transcript but we don't parse it here — the user can
    // flip it from the session settings sheet if they care.
    model: "claude-opus-4-7",
    mode: "default",
    worktreePath: null,
    branch: null,
  });

  // Stamp the SDK session id so the next WS turn passes it as `resume`. The
  // store's setSdkSessionId uses first-write-wins (`WHERE sdk_session_id IS
  // NULL`) which is exactly what we want here.
  deps.sessions.setSdkSessionId(session.id, input.sessionId);
  const withSdk = deps.sessions.findById(session.id);
  return { session: withSdk ?? session, wasNew: true };
}
