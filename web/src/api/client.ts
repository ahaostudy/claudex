import type {
  BrowseResponse,
  ChangePasswordRequest,
  CliSessionSummary,
  CreateRoutineRequest,
  CreateSessionRequest,
  CreateSideSessionRequest,
  PendingDiffsResponse,
  Project,
  Routine,
  Session,
  SessionEvent,
  SlashCommand,
  ToolGrant,
  UpdateProjectRequest,
  UpdateRoutineRequest,
  UpdateSessionRequest,
  UsageRangeResponse,
  UsageTodayResponse,
  UserEnvResponse,
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
  listEvents(sessionId: string, sinceSeq = -1) {
    return request<{ events: SessionEvent[] }>(
      `/api/sessions/${sessionId}/events?sinceSeq=${sinceSeq}`,
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
};
