import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  EventKind,
  ModelId,
  PermissionMode,
  Session,
  SessionEvent,
  SessionStatus,
} from "@claudex/shared";

interface SessionRow {
  id: string;
  title: string;
  project_id: string;
  branch: string | null;
  worktree_path: string | null;
  status: string;
  model: string;
  mode: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  archived_at: string | null;
  sdk_session_id: string | null;
  parent_session_id: string | null;
  stats_messages: number;
  stats_files_changed: number;
  stats_lines_added: number;
  stats_lines_removed: number;
  stats_context_pct: number;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    branch: row.branch,
    worktreePath: row.worktree_path,
    status: row.status as SessionStatus,
    model: row.model as ModelId,
    mode: row.mode as PermissionMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    archivedAt: row.archived_at,
    sdkSessionId: row.sdk_session_id,
    parentSessionId: row.parent_session_id,
    stats: {
      messages: row.stats_messages,
      filesChanged: row.stats_files_changed,
      linesAdded: row.stats_lines_added,
      linesRemoved: row.stats_lines_removed,
      contextPct: row.stats_context_pct,
    },
  };
}

export interface SessionCreateInput {
  id?: string;
  title: string;
  projectId: string;
  model: ModelId;
  mode: PermissionMode;
  worktreePath?: string | null;
  branch?: string | null;
  parentSessionId?: string | null;
}

export class SessionStore {
  constructor(private readonly db: Database.Database) {}

  // ---- sessions ----------------------------------------------------------

  // By default hides `/btw` side chats (parent_session_id IS NOT NULL) —
  // they shouldn't clutter the home session list. Pass `includeSideChats`
  // when something (the settings sheet, a debug view) explicitly wants
  // them.
  list(opts?: { includeArchived?: boolean; includeSideChats?: boolean }): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE (? = 1 OR archived_at IS NULL)
           AND (? = 1 OR parent_session_id IS NULL)
         ORDER BY updated_at DESC`,
      )
      .all(
        opts?.includeArchived ? 1 : 0,
        opts?.includeSideChats ? 1 : 0,
      ) as SessionRow[];
    return rows.map(toSession);
  }

  listByProject(projectId: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE project_id = ? AND parent_session_id IS NULL
         ORDER BY updated_at DESC`,
      )
      .all(projectId) as SessionRow[];
    return rows.map(toSession);
  }

  /** List every side chat whose parent is `parentId`, newest first. */
  listChildren(parentId: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE parent_session_id = ?
         ORDER BY created_at DESC`,
      )
      .all(parentId) as SessionRow[];
    return rows.map(toSession);
  }

  findById(id: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  /**
   * Look up a session by its Agent SDK / CLI session_id. Used by the CLI
   * import path to keep adoption idempotent — re-importing a session that's
   * already adopted should return the existing row rather than duplicate it.
   */
  findBySdkSessionId(sdkSessionId: string): Session | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE sdk_session_id = ?")
      .get(sdkSessionId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  create(input: SessionCreateInput): Session {
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: input.id ?? nanoid(12),
      title: input.title,
      project_id: input.projectId,
      branch: input.branch ?? null,
      worktree_path: input.worktreePath ?? null,
      status: "idle",
      model: input.model,
      mode: input.mode,
      created_at: now,
      updated_at: now,
      last_message_at: null,
      archived_at: null,
      sdk_session_id: null,
      parent_session_id: input.parentSessionId ?? null,
      stats_messages: 0,
      stats_files_changed: 0,
      stats_lines_added: 0,
      stats_lines_removed: 0,
      stats_context_pct: 0,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (
           id, title, project_id, branch, worktree_path, status, model, mode,
           created_at, updated_at, last_message_at, archived_at, sdk_session_id,
           parent_session_id,
           stats_messages, stats_files_changed, stats_lines_added,
           stats_lines_removed, stats_context_pct
         ) VALUES (
           @id, @title, @project_id, @branch, @worktree_path, @status, @model, @mode,
           @created_at, @updated_at, @last_message_at, @archived_at, @sdk_session_id,
           @parent_session_id,
           @stats_messages, @stats_files_changed, @stats_lines_added,
           @stats_lines_removed, @stats_context_pct
         )`,
      )
      .run(row);
    return toSession(row);
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), id);
  }

  setModel(id: string, model: ModelId): void {
    this.db
      .prepare("UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?")
      .run(model, new Date().toISOString(), id);
  }

  setMode(id: string, mode: PermissionMode): void {
    this.db
      .prepare("UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, new Date().toISOString(), id);
  }

  /**
   * Persist the Agent SDK session_id for a claudex session. First-write-wins:
   * once set, subsequent calls are no-ops, because `resume` on a live SDK
   * conversation re-emits the same id and we don't want to thrash the row.
   * Returns true if the write happened, false if the row already had one.
   */
  setSdkSessionId(id: string, sdkSessionId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE sessions
         SET sdk_session_id = ?, updated_at = ?
         WHERE id = ? AND sdk_session_id IS NULL`,
      )
      .run(sdkSessionId, new Date().toISOString(), id);
    return res.changes > 0;
  }

  touchLastMessage(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
  }

  archive(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE sessions SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
  }

  bumpStats(
    id: string,
    delta: Partial<Session["stats"]>,
  ): void {
    this.db
      .prepare(
        `UPDATE sessions SET
           stats_messages = stats_messages + ?,
           stats_files_changed = stats_files_changed + ?,
           stats_lines_added = stats_lines_added + ?,
           stats_lines_removed = stats_lines_removed + ?,
           stats_context_pct = COALESCE(?, stats_context_pct),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        delta.messages ?? 0,
        delta.filesChanged ?? 0,
        delta.linesAdded ?? 0,
        delta.linesRemoved ?? 0,
        delta.contextPct ?? null,
        new Date().toISOString(),
        id,
      );
  }

  // ---- events ------------------------------------------------------------

  nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM session_events WHERE session_id = ?",
      )
      .get(sessionId) as { next: number };
    return row.next;
  }

  appendEvent(input: {
    sessionId: string;
    kind: EventKind;
    payload: Record<string, unknown>;
  }): SessionEvent {
    const seq = this.nextSeq(input.sessionId);
    const event: SessionEvent = {
      id: nanoid(16),
      sessionId: input.sessionId,
      kind: input.kind,
      seq,
      createdAt: new Date().toISOString(),
      payload: input.payload,
    };
    this.db
      .prepare(
        `INSERT INTO session_events (id, session_id, kind, seq, created_at, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.kind,
        event.seq,
        event.createdAt,
        JSON.stringify(event.payload),
      );
    return event;
  }

  listEvents(sessionId: string, sinceSeq = -1): SessionEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, kind, seq, created_at, payload
         FROM session_events WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC`,
      )
      .all(sessionId, sinceSeq) as Array<{
      id: string;
      session_id: string;
      kind: string;
      seq: number;
      created_at: string;
      payload: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      kind: r.kind as EventKind,
      seq: r.seq,
      createdAt: r.created_at,
      payload: JSON.parse(r.payload),
    }));
  }
}
