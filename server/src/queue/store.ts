import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  ModelId,
  PermissionMode,
  QueueStatus,
  QueuedPrompt,
} from "@claudex/shared";

interface QueueRow {
  id: string;
  project_id: string;
  prompt: string;
  title: string | null;
  model: string | null;
  mode: string | null;
  worktree: number; // 0/1
  status: string;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  seq: number;
}

function toQueuedPrompt(row: QueueRow): QueuedPrompt {
  return {
    id: row.id,
    projectId: row.project_id,
    prompt: row.prompt,
    title: row.title,
    model: (row.model ?? null) as ModelId | null,
    mode: (row.mode ?? null) as PermissionMode | null,
    worktree: row.worktree !== 0,
    status: row.status as QueueStatus,
    sessionId: row.session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    seq: row.seq,
  };
}

export interface QueueCreateInput {
  projectId: string;
  prompt: string;
  title?: string | null;
  model?: ModelId | null;
  mode?: PermissionMode | null;
  worktree?: boolean;
}

export interface QueueUpdateInput {
  prompt?: string;
  title?: string | null;
  model?: ModelId | null;
  mode?: PermissionMode | null;
  worktree?: boolean;
}

/**
 * CRUD for the `queued_prompts` table. SQL lives here; the HTTP routes and
 * the runner share the same API — mirroring how `RoutineStore` / `SessionStore`
 * are organized. Intentionally simple — the runner is where the coordination
 * lives; this class just moves rows around.
 */
export class QueueStore {
  constructor(private readonly db: Database.Database) {}

  /** Every row, lowest seq first. The UI renders this list verbatim. */
  list(): QueuedPrompt[] {
    const rows = this.db
      .prepare(`SELECT * FROM queued_prompts ORDER BY seq ASC, created_at ASC`)
      .all() as QueueRow[];
    return rows.map(toQueuedPrompt);
  }

  findById(id: string): QueuedPrompt | null {
    const row = this.db
      .prepare("SELECT * FROM queued_prompts WHERE id = ?")
      .get(id) as QueueRow | undefined;
    return row ? toQueuedPrompt(row) : null;
  }

  /**
   * Rows currently flagged `running`. The runner uses this to enforce
   * one-at-a-time dispatch even across restarts — if there's already a
   * running row the runner picks nothing new.
   */
  findRunning(): QueuedPrompt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM queued_prompts WHERE status = 'running' ORDER BY seq ASC`,
      )
      .all() as QueueRow[];
    return rows.map(toQueuedPrompt);
  }

  /** Lowest-seq row with status='queued', or null. */
  pickNextQueued(): QueuedPrompt | null {
    const row = this.db
      .prepare(
        `SELECT * FROM queued_prompts
         WHERE status = 'queued'
         ORDER BY seq ASC, created_at ASC
         LIMIT 1`,
      )
      .get() as QueueRow | undefined;
    return row ? toQueuedPrompt(row) : null;
  }

  /** Highest seq currently present (across all statuses), or 0 when empty. */
  maxSeq(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM queued_prompts`)
      .get() as { m: number };
    return row.m;
  }

  create(input: QueueCreateInput): QueuedPrompt {
    const now = new Date().toISOString();
    const seq = this.maxSeq() + 1;
    const row: QueueRow = {
      id: nanoid(12),
      project_id: input.projectId,
      prompt: input.prompt,
      title: input.title ?? null,
      model: input.model ?? null,
      mode: input.mode ?? null,
      worktree: input.worktree ? 1 : 0,
      status: "queued",
      session_id: null,
      created_at: now,
      started_at: null,
      finished_at: null,
      seq,
    };
    this.db
      .prepare(
        `INSERT INTO queued_prompts (
           id, project_id, prompt, title, model, mode, worktree, status,
           session_id, created_at, started_at, finished_at, seq
         ) VALUES (
           @id, @project_id, @prompt, @title, @model, @mode, @worktree, @status,
           @session_id, @created_at, @started_at, @finished_at, @seq
         )`,
      )
      .run(row);
    return toQueuedPrompt(row);
  }

  /**
   * Update mutable fields. Only valid when the row is still `queued` —
   * callers must enforce that; the store itself doesn't gatekeep because a
   * few edge paths (runner recovery) set fields on non-queued rows too.
   */
  update(id: string, patch: QueueUpdateInput): QueuedPrompt | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const merged = {
      id,
      prompt: patch.prompt ?? existing.prompt,
      title: patch.title === undefined ? existing.title : patch.title,
      model: patch.model === undefined ? existing.model : patch.model,
      mode: patch.mode === undefined ? existing.mode : patch.mode,
      worktree:
        patch.worktree === undefined
          ? existing.worktree
            ? 1
            : 0
          : patch.worktree
            ? 1
            : 0,
    };
    this.db
      .prepare(
        `UPDATE queued_prompts SET
           prompt = @prompt,
           title = @title,
           model = @model,
           mode = @mode,
           worktree = @worktree
         WHERE id = @id`,
      )
      .run(merged);
    return this.findById(id);
  }

  setStatus(
    id: string,
    status: QueueStatus,
    stamps?: {
      sessionId?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): void {
    const existing = this.findById(id);
    if (!existing) return;
    const next = {
      id,
      status,
      session_id:
        stamps?.sessionId !== undefined ? stamps.sessionId : existing.sessionId,
      started_at:
        stamps?.startedAt !== undefined ? stamps.startedAt : existing.startedAt,
      finished_at:
        stamps?.finishedAt !== undefined
          ? stamps.finishedAt
          : existing.finishedAt,
    };
    this.db
      .prepare(
        `UPDATE queued_prompts
         SET status = @status,
             session_id = @session_id,
             started_at = @started_at,
             finished_at = @finished_at
         WHERE id = @id`,
      )
      .run(next);
  }

  /**
   * Swap seq with the nearest queued-status neighbour in the given direction.
   * Returns true if a swap happened, false when the row is already at the
   * top/bottom of the queued set (or wasn't itself queued). Direction is
   * resolved against ascending seq: "up" picks the neighbour with the next
   * smaller seq (which sorts earlier in the UI list).
   */
  swapNeighbor(id: string, direction: "up" | "down"): boolean {
    const row = this.findById(id);
    if (!row || row.status !== "queued") return false;
    const neighbour =
      direction === "up"
        ? (this.db
            .prepare(
              `SELECT * FROM queued_prompts
               WHERE status = 'queued' AND seq < ?
               ORDER BY seq DESC
               LIMIT 1`,
            )
            .get(row.seq) as QueueRow | undefined)
        : (this.db
            .prepare(
              `SELECT * FROM queued_prompts
               WHERE status = 'queued' AND seq > ?
               ORDER BY seq ASC
               LIMIT 1`,
            )
            .get(row.seq) as QueueRow | undefined);
    if (!neighbour) return false;
    // SQLite has no PK on seq, so we can swap directly in a transaction.
    const update = this.db.prepare(
      `UPDATE queued_prompts SET seq = ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      update.run(neighbour.seq, row.id);
      update.run(row.seq, neighbour.id);
    })();
    return true;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM queued_prompts WHERE id = ?").run(id);
  }
}
