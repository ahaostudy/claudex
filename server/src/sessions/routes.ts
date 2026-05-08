import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  CreateSessionRequest,
  CreateSideSessionRequest,
  UpdateProjectRequest,
  UpdateSessionRequest,
  type ToolGrant,
} from "@claudex/shared";
import { ProjectStore } from "./projects.js";
import { SessionStore } from "./store.js";
import { ToolGrantStore } from "./grants.js";
import { aggregatePendingDiffs } from "./diffs.js";
import type { SessionManager } from "./manager.js";
import { computeUsageSummary } from "./usage-summary.js";
import { triggerCliResync } from "./cli-resync.js";
import {
  createWorktree,
  isGitRepo,
  removeWorktree,
  WorktreeError,
} from "./worktree.js";

export interface SessionsRoutesDeps {
  db: Database.Database;
  manager: SessionManager;
  /**
   * Override the Claude CLI projects root for tests. Defaults to
   * `~/.claude/projects`. When a session has `sdkSessionId` set we look for
   * its JSONL under `<root>/<cwd-slug>/<uuid>.jsonl` for the resync-on-open
   * path.
   */
  cliProjectsRoot?: string;
}

const AddProject = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export async function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionsRoutesDeps,
): Promise<void> {
  const projects = new ProjectStore(deps.db);
  const sessions = new SessionStore(deps.db);
  const grants = new ToolGrantStore(deps.db);

  // -- projects -------------------------------------------------------------

  app.get(
    "/api/projects",
    { preHandler: app.requireAuth as any },
    async () => ({ projects: projects.list() }),
  );

  app.post(
    "/api/projects",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = AddProject.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const abs = path.resolve(parsed.data.path);
      // Reject paths that don't exist — we'd rather fail loudly than end up
      // with a phantom project in the UI.
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return reply.code(400).send({ error: "path_not_a_directory" });
      }
      if (projects.findByPath(abs)) {
        return reply.code(409).send({ error: "path_already_exists" });
      }
      const project = projects.create({
        name: parsed.data.name,
        path: abs,
        trusted: true,
      });
      return reply.send({ project });
    },
  );

  app.patch(
    "/api/projects/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateProjectRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const existing = projects.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      projects.setName(id, parsed.data.name);
      const updated = projects.findById(id);
      return reply.send({ project: updated });
    },
  );

  app.delete(
    "/api/projects/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = projects.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const sessionCount = projects.countSessions(id);
      if (sessionCount > 0) {
        // FK is ON DELETE RESTRICT — bail with a precise count so the UI
        // can phrase the error properly ("project has N sessions").
        return reply
          .code(409)
          .send({ error: "has_sessions", sessionCount });
      }
      projects.delete(id);
      return reply.send({ ok: true });
    },
  );

  // -- sessions -------------------------------------------------------------

  app.get(
    "/api/sessions",
    { preHandler: app.requireAuth as any },
    async (req) => {
      const q = req.query as { project?: string; archived?: string };
      if (q?.project) {
        return { sessions: sessions.listByProject(q.project) };
      }
      return {
        sessions: sessions.list({ includeArchived: q?.archived === "1" }),
      };
    },
  );

  app.get(
    "/api/sessions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = sessions.findById(id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      // Fire-and-forget CLI resync: if this session was adopted from the
      // `claude` CLI and its JSONL has grown since we last imported, pull the
      // new lines in the background. We never block the HTTP response on it;
      // the WS bridge will push the new events (or a `refresh_transcript`
      // signal) when they land.
      if (row.sdkSessionId) {
        triggerCliResync({
          sessions,
          sessionRow: row,
          manager: deps.manager,
          cliProjectsRoot: deps.cliProjectsRoot,
          logger:
            req.log && typeof req.log.warn === "function"
              ? {
                  warn: (o, m) => req.log.warn(o, m),
                  debug: (o, m) => req.log.debug?.(o, m),
                }
              : undefined,
        });
      }
      return { session: row };
    },
  );

  app.get(
    "/api/sessions/:id/events",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as {
        sinceSeq?: string;
        beforeSeq?: string;
        limit?: string;
      };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });

      const parseNum = (v: string | undefined): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const sinceSeq = parseNum(q?.sinceSeq);
      const beforeSeq = parseNum(q?.beforeSeq);
      const rawLimit = parseNum(q?.limit);

      // Back-compat: no pagination params at all → full history, matches
      // every existing caller.
      if (sinceSeq === undefined && beforeSeq === undefined && rawLimit === undefined) {
        return {
          events: sessions.listEvents(id),
          hasMore: false,
          oldestSeq: sessions.oldestEventSeq(id),
        };
      }

      // sinceSeq without any of the newer params keeps the tail-fetch shape.
      if (sinceSeq !== undefined && beforeSeq === undefined && rawLimit === undefined) {
        return {
          events: sessions.listEvents(id, sinceSeq),
          hasMore: false,
          oldestSeq: sessions.oldestEventSeq(id),
        };
      }

      // New pagination path — `limit` is mandatory on this branch; cap at 1000.
      const limit = Math.max(1, Math.min(rawLimit ?? 200, 1000));
      const events = sessions.listEvents(id, { beforeSeq, limit });
      const oldestSeqAll = sessions.oldestEventSeq(id);
      const batchOldest = events.length > 0 ? events[0].seq : null;
      // hasMore: there exists at least one event older than what we just
      // returned. If the oldest in the batch matches the absolute oldest in
      // the table, we've paged to the top.
      const hasMore =
        batchOldest !== null &&
        oldestSeqAll !== null &&
        batchOldest > oldestSeqAll;
      return { events, hasMore, oldestSeq: batchOldest };
    },
  );

  // GET /api/sessions/:id/usage-summary
  //
  // Small JSON payload (~1 KB) that lets the chat header ring, UsagePanel, and
  // ChatTasksRail show context / token info without re-downloading the full
  // event stream every time the transcript grows. Computed server-side via an
  // indexed scan over `session_events WHERE kind = 'turn_end'`.
  app.get(
    "/api/sessions/:id/usage-summary",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = sessions.findById(id);
      if (!row) return reply.code(404).send({ error: "not_found" });
      const events = sessions.listEvents(id);
      return reply.send(computeUsageSummary(events, row.model));
    },
  );

  // GET /api/sessions/:id/pending-diffs
  //
  // Aggregates every diff-producing (Edit / Write / MultiEdit) tool call in
  // the session that is *currently awaiting the user* — either because it
  // has a live `permission_request` with no matching `permission_decision`,
  // or because its `tool_use` event has no matching `tool_result` yet
  // (in-flight under acceptEdits / bypass modes where the SDK doesn't ask).
  //
  // The computed `hunks` ship with the response so the full-screen Diff
  // Review page (mockup s-06) can render without replaying the transcript
  // client-side. Empty array is a valid response — no pending edits = nothing
  // to review; the UI shows an empty state rather than a 404.
  app.get(
    "/api/sessions/:id/pending-diffs",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });
      const events = sessions.listEvents(id);
      const diffs = aggregatePendingDiffs(events);
      return reply.send({ diffs });
    },
  );

  app.post(
    "/api/sessions",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = CreateSessionRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const project = projects.findById(parsed.data.projectId);
      if (!project) return reply.code(400).send({ error: "project_not_found" });

      const title = parsed.data.title ?? "Untitled";
      let worktreePath: string | null = null;
      let branch: string | null = null;
      let sessionId: string | undefined;

      // If the caller asked for a worktree, verify the project is a git repo
      // up front, then create the worktree BEFORE inserting the session row
      // so a failure here leaves no dangling session in the DB. The session
      // id is pre-generated so the directory name matches the DB primary key.
      if (parsed.data.worktree) {
        if (!(await isGitRepo(project.path))) {
          return reply.code(400).send({ error: "not_a_git_repo" });
        }
        const { nanoid } = await import("nanoid");
        sessionId = nanoid(12);
        try {
          const wt = await createWorktree({
            projectPath: project.path,
            sessionId,
            title,
          });
          worktreePath = wt.path;
          branch = wt.branch;
        } catch (err) {
          if (err instanceof WorktreeError) {
            req.log.warn(
              { err, projectPath: project.path },
              "worktree creation failed",
            );
            return reply
              .code(400)
              .send({ error: "worktree_failed", detail: err.message });
          }
          throw err;
        }
      }

      const session = sessions.create({
        id: sessionId,
        title,
        projectId: parsed.data.projectId,
        model: parsed.data.model,
        mode: parsed.data.mode,
        worktreePath,
        branch,
      });
      return reply.send({ session });
    },
  );

  app.post(
    "/api/sessions/:id/archive",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      // Clean up the worktree if we made one. This is best-effort: a missing
      // directory (user rm'd it) or a git failure shouldn't block the user
      // from archiving — the session row flip is what matters.
      if (existing.worktreePath) {
        try {
          await removeWorktree(existing.worktreePath);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, worktreePath: existing.worktreePath },
            "worktree cleanup failed during archive",
          );
        }
      }
      sessions.archive(id);
      return reply.send({ ok: true });
    },
  );

  // DELETE /api/sessions/:id
  //
  // Hard-delete a session. Unlike archive, this is irreversible: the session
  // row + every `session_events` row (FK CASCADE) + any `/btw` side-chat
  // children (also CASCADE via `parent_session_id` FK) disappear. Tool grants
  // scoped to this session also cascade.
  //
  // Live runner is torn down first so the SDK subprocess doesn't keep writing
  // events against a row that's about to vanish. Worktree cleanup is
  // best-effort — archive logs & continues on failure, and delete must do the
  // same: the user expects the session to be gone regardless of whether git
  // cleaned up behind us.
  app.delete(
    "/api/sessions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });

      // Tear down the runner first so no more events get appended to a row
      // we're about to delete. Safe to call even when no runner is attached.
      try {
        await deps.manager.dispose(id);
      } catch (err) {
        req.log.warn(
          { err, sessionId: id },
          "runner dispose failed during session delete",
        );
      }

      if (existing.worktreePath) {
        try {
          await removeWorktree(existing.worktreePath);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, worktreePath: existing.worktreePath },
            "worktree cleanup failed during delete",
          );
        }
      }

      sessions.deleteById(id);
      return reply.code(204).send();
    },
  );

  // POST /api/sessions/:id/side
  //
  // Spawns a `/btw` side chat that branches off an existing session. Copies
  // project / model / mode from the parent; default mode is `plan` (read-only)
  // so the side chat can't accidentally mutate the main thread's working tree
  // while the user is just asking a quick lateral question. We explicitly do
  // NOT copy the worktree path — side chats run in the parent's cwd, and we
  // never create a new worktree for them.
  //
  // Archived parents can't spawn side chats (nothing to branch off of). If
  // an active side chat for this parent already exists, returns it instead
  // of creating a new one — matches the "one active side chat per main
  // thread" convention the UI enforces. To start fresh, archive the existing
  // side chat first.
  app.post(
    "/api/sessions/:id/side",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = CreateSideSessionRequest.safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: "bad_request" });
      const parent = sessions.findById(id);
      if (!parent) return reply.code(404).send({ error: "not_found" });
      if (parent.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }
      // Reuse an existing active side chat if the caller has one open.
      const children = sessions.listChildren(id);
      const active = children.find((c) => c.status !== "archived");
      if (active) {
        return reply.send({ session: active });
      }
      const session = sessions.create({
        title: parsed.data.title ?? "Side chat",
        projectId: parent.projectId,
        model: parent.model,
        // Read-only by default — /btw is for sanity checks, not actions.
        mode: "plan",
        parentSessionId: parent.id,
      });
      return reply.send({ session });
    },
  );

  // GET /api/sessions/:id/side
  //
  // Returns the currently-active side chat for `id`, if any. Used by the
  // web UI on mount to decide whether the /btw button should open an
  // existing drawer (preserving the conversation) or show an empty new
  // one. Deliberately ignores archived children so "Archive and start
  // new" feels like a clean slate.
  app.get(
    "/api/sessions/:id/side",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parent = sessions.findById(id);
      if (!parent) return reply.code(404).send({ error: "not_found" });
      const children = sessions.listChildren(id);
      const active = children.find((c) => c.status !== "archived") ?? null;
      return reply.send({ session: active });
    },
  );

  app.patch(
    "/api/sessions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = UpdateSessionRequest.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const existing = sessions.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      // Archived sessions are read-only. Unarchiving isn't wired yet; bail
      // loudly rather than silently updating a row the user can't use.
      if (existing.status === "archived") {
        return reply.code(409).send({ error: "archived" });
      }

      const warnings: string[] = [];
      const { title, model, mode } = parsed.data;

      if (title !== undefined) sessions.setTitle(id, title);
      if (model !== undefined && model !== existing.model) {
        sessions.setModel(id, model);
        // The Agent SDK doesn't expose a hot model swap — it picks up the
        // new model on the next user turn via a fresh SDK Query. Running
        // sessions therefore keep the old model for any in-flight turn.
        if (existing.status === "running" || deps.manager.hasRunner(id)) {
          warnings.push("model_change_applies_to_next_turn");
        }
      }
      if (mode !== undefined && mode !== existing.mode) {
        sessions.setMode(id, mode);
        // Propagate live if a runner is attached. Safe to call even when
        // the runner is idle; no-ops on sessions that never spawned one.
        try {
          await deps.manager.applyPermissionMode(id, mode);
        } catch (err) {
          req.log.warn(
            { err, sessionId: id, mode },
            "failed to propagate permission mode to runner",
          );
        }
      }

      const updated = sessions.findById(id)!;
      return reply.send({
        session: updated,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    },
  );

  // -- tool grants ---------------------------------------------------------

  app.get(
    "/api/sessions/:id/grants",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });
      const rows = grants.listForSession(id);
      const out: ToolGrant[] = rows.map((r) => ({
        id: r.id,
        toolName: r.tool_name,
        signature: r.input_signature,
        scope: r.session_id === null ? "global" : "session",
        createdAt: r.created_at,
      }));
      return reply.send({ grants: out });
    },
  );

  app.delete(
    "/api/grants/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = grants.findById(id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      grants.revoke(id);
      return reply.send({ ok: true });
    },
  );
}
