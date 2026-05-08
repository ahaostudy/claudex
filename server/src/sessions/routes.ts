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
import type { SessionManager } from "./manager.js";
import {
  createWorktree,
  isGitRepo,
  removeWorktree,
  WorktreeError,
} from "./worktree.js";

export interface SessionsRoutesDeps {
  db: Database.Database;
  manager: SessionManager;
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
      return { session: row };
    },
  );

  app.get(
    "/api/sessions/:id/events",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const q = req.query as { sinceSeq?: string };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });
      const sinceSeq = q?.sinceSeq ? Number(q.sinceSeq) : -1;
      return { events: sessions.listEvents(id, sinceSeq) };
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
