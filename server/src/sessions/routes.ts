import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CreateSessionRequest } from "@claudex/shared";
import { ProjectStore } from "./projects.js";
import { SessionStore } from "./store.js";

export interface SessionsRoutesDeps {
  db: Database.Database;
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
      const session = sessions.create({
        title: parsed.data.title ?? "Untitled",
        projectId: parsed.data.projectId,
        model: parsed.data.model,
        mode: parsed.data.mode,
      });
      return reply.send({ session });
    },
  );

  app.post(
    "/api/sessions/:id/archive",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!sessions.findById(id))
        return reply.code(404).send({ error: "not_found" });
      sessions.archive(id);
      return reply.send({ ok: true });
    },
  );
}
