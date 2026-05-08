import type {
  Attachment,
  AuditListResponse,
  BrowseResponse,
  ChangePasswordRequest,
  CliSessionSummary,
  CreateQueuedPromptRequest,
  CreateRoutineRequest,
  CreateSessionRequest,
  CreateSideSessionRequest,
  PendingDiffsResponse,
  Project,
  QueuedPrompt,
  Routine,
  Session,
  SessionEvent,
  SlashCommand,
  ToolGrant,
  UpdateProjectRequest,
  UpdateQueuedPromptRequest,
  UpdateRoutineRequest,
  UpdateSessionRequest,
  UsageRangeResponse,
  UsageSummaryResponse,
  UsageTodayResponse,
  UserEnvResponse,
  SearchResponse,
} from "@claudex/shared";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(`api ${status}: ${code}`);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, headers, ...rest } = init ?? {};
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    ...rest,
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) code = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  login(body: { username: string; password: string }) {
    return request<{ requireTotp: boolean; challengeId: string | null }>(
      "/api/auth/login",
      { method: "POST", json: body },
    );
  },
  verifyTotp(body: { challengeId: string; code: string }) {
    return request<{ ok: true }>("/api/auth/verify-totp", {
      method: "POST",
      json: body,
    });
  },
  logout() {
    return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
  },
  whoami() {
    return request<{ user: import("@claudex/shared").User }>("/api/auth/whoami");
  },
  listProjects() {
    return request<{ projects: Project[] }>("/api/projects");
  },
  createProject(body: { name: string; path: string }) {
    return request<{ project: Project }>("/api/projects", {
      method: "POST",
      json: body,
    });
  },
  updateProject(id: string, body: UpdateProjectRequest) {
    return request<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  deleteProject(id: string) {
    return request<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" });
  },
  browseHome() {
    return request<{ path: string }>("/api/browse/home");
  },
  browse(absPath: string) {
    return request<BrowseResponse>(
      `/api/browse?path=${encodeURIComponent(absPath)}`,
    );
  },
  listSessions(opts?: { project?: string; archived?: boolean }) {
    const qs = new URLSearchParams();
    if (opts?.project) qs.set("project", opts.project);
    if (opts?.archived) qs.set("archived", "1");
    const q = qs.toString();
    return request<{ sessions: Session[] }>(
      `/api/sessions${q ? `?${q}` : ""}`,
    );
  },
  getSession(id: string) {
    return request<{ session: Session }>(`/api/sessions/${id}`);
  },
  listEvents(
    sessionId: string,
    opts?: { sinceSeq?: number; beforeSeq?: number; limit?: number },
  ) {
    const qs = new URLSearchParams();
    if (opts?.sinceSeq !== undefined) qs.set("sinceSeq", String(opts.sinceSeq));
    if (opts?.beforeSeq !== undefined)
      qs.set("beforeSeq", String(opts.beforeSeq));
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    const q = qs.toString();
    return request<{
      events: SessionEvent[];
      hasMore: boolean;
      oldestSeq: number | null;
    }>(`/api/sessions/${sessionId}/events${q ? `?${q}` : ""}`);
  },
  getUsageSummary(sessionId: string) {
    return request<UsageSummaryResponse>(
      `/api/sessions/${sessionId}/usage-summary`,
    );
  },
  listPendingDiffs(sessionId: string) {
    return request<PendingDiffsResponse>(
      `/api/sessions/${sessionId}/pending-diffs`,
    );
  },
  createSession(body: CreateSessionRequest) {
    return request<{ session: Session }>("/api/sessions", {
      method: "POST",
      json: body,
    });
  },
  archiveSession(id: string) {
    return request<{ ok: true }>(`/api/sessions/${id}/archive`, {
      method: "POST",
    });
  },
  deleteSession(id: string) {
    // 204 No Content — `request` returns `undefined` for 204 by design.
    return request<void>(`/api/sessions/${id}`, { method: "DELETE" });
  },
  getSideSession(parentId: string) {
    return request<{ session: Session | null }>(
      `/api/sessions/${parentId}/side`,
    );
  },
  createSideSession(parentId: string, body?: CreateSideSessionRequest) {
    return request<{ session: Session }>(
      `/api/sessions/${parentId}/side`,
      { method: "POST", json: body ?? {} },
    );
  },
  updateSession(id: string, body: UpdateSessionRequest) {
    return request<{ session: Session; warnings?: string[] }>(
      `/api/sessions/${id}`,
      { method: "PATCH", json: body },
    );
  },
  listGrants(sessionId: string) {
    return request<{ grants: ToolGrant[] }>(
      `/api/sessions/${sessionId}/grants`,
    );
  },
  revokeGrant(grantId: string) {
    return request<{ ok: true }>(`/api/grants/${grantId}`, {
      method: "DELETE",
    });
  },
  listSlashCommands(projectId?: string) {
    const q = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : "";
    return request<{ commands: SlashCommand[] }>(
      `/api/slash-commands${q}`,
    );
  },
  listRoutines() {
    return request<{ routines: Routine[] }>("/api/routines");
  },
  getRoutine(id: string) {
    return request<{ routine: Routine }>(`/api/routines/${id}`);
  },
  createRoutine(body: CreateRoutineRequest) {
    return request<{ routine: Routine }>("/api/routines", {
      method: "POST",
      json: body,
    });
  },
  updateRoutine(id: string, body: UpdateRoutineRequest) {
    return request<{ routine: Routine }>(`/api/routines/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  deleteRoutine(id: string) {
    return request<{ ok: true }>(`/api/routines/${id}`, { method: "DELETE" });
  },
  runRoutine(id: string) {
    return request<{ sessionId: string }>(`/api/routines/${id}/run`, {
      method: "POST",
    });
  },
  listQueue() {
    return request<{ queue: QueuedPrompt[] }>("/api/queue");
  },
  createQueued(body: CreateQueuedPromptRequest) {
    return request<{ queued: QueuedPrompt }>("/api/queue", {
      method: "POST",
      json: body,
    });
  },
  updateQueued(id: string, body: UpdateQueuedPromptRequest) {
    return request<{ queued: QueuedPrompt }>(`/api/queue/${id}`, {
      method: "PATCH",
      json: body,
    });
  },
  deleteQueued(id: string) {
    return request<{ ok: true }>(`/api/queue/${id}`, { method: "DELETE" });
  },
  reorderQueued(id: string, direction: "up" | "down") {
    return request<{ ok: true; moved: boolean }>(
      `/api/queue/${id}/${direction}`,
      { method: "POST" },
    );
  },
  changePassword(body: ChangePasswordRequest) {
    return request<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      json: body,
    });
  },
  getUserEnv() {
    return request<UserEnvResponse>("/api/user/env");
  },
  listCliSessions() {
    return request<{ sessions: CliSessionSummary[] }>("/api/cli/sessions");
  },
  importCliSessions(sessionIds: string[]) {
    return request<{ imported: Session[] }>("/api/cli/sessions/import", {
      method: "POST",
      json: { sessionIds },
    });
  },
  getUsageToday() {
    return request<UsageTodayResponse>("/api/usage/today");
  },
  getUsageRange(days: number) {
    return request<UsageRangeResponse>(`/api/usage/range?days=${days}`);
  },
  /**
   * Full-text search across session titles + message bodies.
   *
   * The server 400s on empty / whitespace-only `q`; callers should
   * short-circuit and skip the request rather than relying on that. See
   * the web GlobalSearchSheet for the concrete debounced-typing flow.
   */
  search(q: string, limit?: number) {
    const qs = new URLSearchParams();
    qs.set("q", q);
    if (limit !== undefined) qs.set("limit", String(limit));
    return request<SearchResponse>(`/api/search?${qs.toString()}`);
  },
  /**
   * Build a `GET /api/sessions/:id/export` URL for a plain anchor download.
   * Returned as a URL rather than a fetch wrapper because the browser's
   * native download flow (anchor click) is what we actually want — wrapping
   * it in fetch would force us to build a Blob for a response we already
   * have on the server with the right Content-Disposition headers.
   */
  exportSessionUrl(id: string, format: "md" | "json") {
    return `/api/sessions/${encodeURIComponent(id)}/export?format=${format}`;
  },
  /**
   * Trigger a browser download for a session's transcript by synthesizing
   * an anchor click. No-ops in non-DOM environments.
   */
  exportSession(id: string, format: "md" | "json") {
    if (typeof document === "undefined") return;
    const a = document.createElement("a");
    a.href = this.exportSessionUrl(id, format);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  /**
   * Upload a single file to a session's attachment store. Returns the created
   * attachment metadata (id, filename, mime, size, previewUrl for images).
   * The raw bytes are served back via `previewUrl`, which for non-image mime
   * types is undefined (composer uses the filename chip instead of a thumb).
   *
   * Does NOT go through `request()` because we need to post a FormData body
   * without stringifying — `fetch` handles the multipart encoding natively
   * when you omit Content-Type.
   */
  async uploadAttachment(sessionId: string, file: File): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/attachments`,
      { method: "POST", credentials: "same-origin", body: form },
    );
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) code = body.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as Attachment;
  },
  /** Delete an as-yet-unlinked attachment. 404 after the attachment has been
   * sent with a message. */
  deleteAttachment(id: string) {
    return request<void>(`/api/attachments/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  listAudit(opts?: { limit?: number; since?: string; events?: string[] }) {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.since) qs.set("since", opts.since);
    if (opts?.events && opts.events.length > 0)
      qs.set("events", opts.events.join(","));
    const q = qs.toString();
    return request<AuditListResponse>(`/api/audit${q ? `?${q}` : ""}`);
  },
};
