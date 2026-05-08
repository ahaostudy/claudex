import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, GitBranch, Pencil, Trash2, FolderOpen, Settings2, X, Download } from "lucide-react";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { api, ApiError } from "@/api/client";
import type { Project, Session, ModelId, PermissionMode } from "@claudex/shared";
import { FolderPicker } from "@/components/FolderPicker";
import { AppShell } from "@/components/AppShell";
import { ImportSessionsSheet } from "@/components/ImportSessionsSheet";
import { cn } from "@/lib/cn";

const statusTone: Record<string, string> = {
  running: "bg-success",
  awaiting: "bg-warn",
  idle: "bg-ink-faint",
  archived: "bg-line-strong",
  error: "bg-danger",
};

export function HomeScreen() {
  const { user } = useAuth();
  const {
    init,
    sessions,
    refreshSessions,
    loadingSessions,
    connected,
    wsDiag,
  } = useSessions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeProjectId = searchParams.get("project");
  const [showNew, setShowNew] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showWsDiag, setShowWsDiag] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    init();
    refreshSessions();
  }, [init, refreshSessions]);

  // Projects list is its own fetch — sessions carry projectId but no name,
  // and we want the group header to show the project's display name even if
  // there are no sessions yet under it (though empty groups are hidden).
  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build ordered groups: bucket sessions by projectId, drop empty buckets,
  // sort sessions inside each bucket newest-first, sort groups by their
  // newest session's timestamp. Wrapped in useMemo so the layout is stable
  // across renders caused by WS status ticks.
  const groups = useMemo(() => {
    const byProject = new Map<string, Session[]>();
    for (const s of sessions) {
      const list = byProject.get(s.projectId);
      if (list) list.push(s);
      else byProject.set(s.projectId, [s]);
    }
    const sortKey = (s: Session) =>
      Date.parse(s.lastMessageAt ?? s.updatedAt) || 0;
    const projectLookup = new Map(projects.map((p) => [p.id, p] as const));
    const out: Array<{ project: Project | null; projectId: string; sessions: Session[] }> = [];
    for (const [projectId, list] of byProject) {
      list.sort((a, b) => sortKey(b) - sortKey(a));
      out.push({
        project: projectLookup.get(projectId) ?? null,
        projectId,
        sessions: list,
      });
    }
    out.sort(
      (a, b) => sortKey(b.sessions[0]) - sortKey(a.sessions[0]),
    );
    return out;
  }, [sessions, projects]);

  const filteredGroups = useMemo(() => {
    if (!activeProjectId) return groups;
    return groups.filter((g) => g.projectId === activeProjectId);
  }, [groups, activeProjectId]);

  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId) ?? null
    : null;

  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("project");
    setSearchParams(next, { replace: true });
  };

  const visibleSessionCount = filteredGroups.reduce(
    (n, g) => n + g.sessions.length,
    0,
  );

  return (
    <AppShell tab="sessions">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Sessions</div>
          <h1 className="display text-[1.25rem] leading-tight mt-0.5">
            {activeProject ? activeProject.name : "All projects"}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => setShowWsDiag((v) => !v)}
          title="WebSocket diagnostics"
          className={`inline-flex items-center gap-1.5 ml-1 px-1.5 py-0.5 rounded-[4px] border border-line bg-paper text-[10px] uppercase tracking-[0.1em] ${
            connected ? "text-success" : "text-ink-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected
                ? "bg-success animate-pulse"
                : wsDiag.phase === "connecting" || wsDiag.phase === "open"
                  ? "bg-warn"
                  : "bg-danger"
            }`}
          />
          {connected ? "live" : wsDiag.phase}
        </button>
        <span className="hidden md:inline text-[12px] text-ink-muted ml-2">
          signed in as <span className="mono">{user?.username}</span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            title="Import existing CLI sessions"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper"
          >
            <Download className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowProjects(true)}
            title="Manage projects"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper"
          >
            <Settings2 className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New session</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-6">
        <div className="px-5 pt-4 flex items-center gap-3 mb-4">
          <span className="mono text-[11px] text-ink-muted">
            {loadingSessions
              ? "loading…"
              : activeProjectId
                ? `${visibleSessionCount} in this project · ${sessions.length} total`
                : `${sessions.length} total`}
          </span>
          {activeProjectId && (
            <button
              type="button"
              onClick={clearFilter}
              className="inline-flex items-center gap-1 px-2 h-6 rounded-full border border-line bg-paper text-[11px] text-ink-soft hover:bg-canvas"
            >
              <X className="w-3 h-3" />
              clear filter
            </button>
          )}
        </div>

        {sessions.length === 0 && !loadingSessions ? (
          <div className="px-5">
            <EmptyState onNew={() => setShowNew(true)} />
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="px-5 text-[13px] text-ink-muted">
            No sessions in this project yet.
          </div>
        ) : (
          <div>
            {filteredGroups.map((g) => (
              <ProjectGroup
                key={g.projectId}
                project={g.project}
                projectId={g.projectId}
                sessions={g.sessions}
              />
            ))}
          </div>
        )}
      </section>

      {showNew && (
        <NewSessionSheet
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            navigate(`/session/${id}`);
          }}
        />
      )}
      {showProjects && (
        <ProjectsSheet onClose={() => setShowProjects(false)} />
      )}
      {showImport && (
        <ImportSessionsSheet
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            refreshSessions();
          }}
        />
      )}
      {showWsDiag && (
        <WsDiagPanel diag={wsDiag} onClose={() => setShowWsDiag(false)} />
      )}
    </AppShell>
  );
}

function ProjectGroup({
  project,
  projectId,
  sessions,
}: {
  project: Project | null;
  projectId: string;
  sessions: Session[];
}) {
  // Each group is its own block so its header `sticky top-0` is scoped to
  // the group's vertical run — when you scroll past, the next project's
  // header takes over. The parent `<section>` is the scroll container.
  return (
    <div>
      <div className="sticky top-0 z-[5] bg-paper/80 backdrop-blur border-b border-line px-5 py-2 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-klein" />
        <span className="mono text-[12px] font-medium">
          {project?.name ?? projectId.slice(0, 8)}
        </span>
        <span className="ml-auto text-[11px] text-ink-muted">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-2 px-5 pt-3 pb-1">
        {sessions.map((s) => (
          <li key={s.id}>
            <Link
              to={`/session/${s.id}`}
              className="block rounded-[10px] border border-line bg-canvas px-4 py-3 hover:bg-paper/60 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${statusTone[s.status]}`}
                />
                <span className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                  {s.status}
                </span>
                <span className="ml-auto text-[11px] text-ink-muted">
                  {formatRel(s.lastMessageAt ?? s.updatedAt)}
                </span>
              </div>
              <div className="text-[15px] font-medium leading-snug mt-1.5">
                {s.title}
              </div>
              <div className="flex items-center gap-3 text-[11px] text-ink-muted mt-1.5">
                <span className="mono flex items-center gap-1">
                  <GitBranch className="w-3 h-3" />
                  {s.branch ?? "main"}
                </span>
                <span className="mono">{s.model}</span>
                <span>· {s.mode}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-[12px] border border-dashed border-line-strong p-8 text-center">
      <div className="display text-[1.25rem] mb-2">No sessions yet.</div>
      <p className="text-[14px] text-ink-muted max-w-[42ch] mx-auto mb-5">
        Point claudex at a project folder on this host and start a session.
        The folder will be trusted — claudex asks claude to do things inside it.
      </p>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-1.5 h-10 px-4 rounded-[8px] bg-ink text-canvas text-[14px] font-medium"
      >
        Create your first session
      </button>
    </div>
  );
}

function NewSessionSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const NEW_PROJECT = "__new__";
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>(NEW_PROJECT);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelId>("claude-opus-4-7");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api.listProjects().then((r) => {
      setProjects(r.projects);
      if (r.projects.length > 0) setSelected(r.projects[0].id);
    });
  }, []);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      let projectId: string;
      if (selected === NEW_PROJECT) {
        const trimmedPath = projectPath.trim();
        if (!trimmedPath) {
          setErr("Pick an absolute path for the new project.");
          setBusy(false);
          return;
        }
        const trimmedName =
          projectName.trim() ||
          trimmedPath.split("/").filter(Boolean).pop() ||
          "project";
        const p = await api.createProject({
          name: trimmedName,
          path: trimmedPath,
        });
        projectId = p.project.id;
        setProjects((prev) => [p.project, ...prev]);
      } else {
        projectId = selected;
      }
      const res = await api.createSession({
        projectId,
        title: title || "Untitled",
        model,
        mode,
        worktree: false,
      });
      onCreated(res.session.id);
    } catch (e: any) {
      setErr(e?.code ?? e?.message ?? "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5">
        <div className="flex items-center mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              New session
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              Tell claude where to work.
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Project
            </div>
            <div className="space-y-1.5">
              {projects.map((p) => (
                <label
                  key={p.id}
                  className={`flex items-center gap-3 px-3 py-2.5 border rounded-[8px] cursor-pointer ${
                    selected === p.id
                      ? "border-klein bg-klein-wash/30"
                      : "border-line"
                  }`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    checked={selected === p.id}
                    onChange={() => setSelected(p.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{p.name}</div>
                    <div className="mono text-[11px] text-ink-muted truncate">
                      {p.path}
                    </div>
                  </div>
                </label>
              ))}
              <label
                className={`block border rounded-[8px] cursor-pointer ${
                  selected === NEW_PROJECT
                    ? "border-klein bg-klein-wash/30"
                    : "border-dashed border-line-strong"
                }`}
              >
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <input
                    type="radio"
                    className="sr-only"
                    checked={selected === NEW_PROJECT}
                    onChange={() => setSelected(NEW_PROJECT)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">
                      {projects.length > 0 ? "+ Add a new project" : "Add your first project"}
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      Any directory on this machine you want claude to work in.
                    </div>
                  </div>
                </div>
                {selected === NEW_PROJECT && (
                  <div className="px-3 pb-3 pt-1 space-y-2">
                    <input
                      className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
                      placeholder="Name (e.g. spindle)"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                    <div className="flex items-stretch gap-2">
                      <input
                        className="flex-1 min-w-0 h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px] mono"
                        placeholder="/Users/you/code/spindle"
                        value={projectPath}
                        onChange={(e) => setProjectPath(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        className="h-10 px-3 rounded-[8px] border border-line bg-paper text-[12px] text-ink-soft hover:bg-canvas inline-flex items-center gap-1"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Browse
                      </button>
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      Must be an absolute path that already exists on the host.
                      {projectName.trim().length === 0 && projectPath.trim().length > 0 &&
                        " (Name defaults to the folder name.)"}
                    </div>
                  </div>
                )}
              </label>
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Title (optional)
            </div>
            <input
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Fix hydration on /pricing"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: "claude-opus-4-7", label: "Opus 4.7" },
                { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
                { id: "claude-haiku-4-5", label: "Haiku 4.5" },
              ] as Array<{ id: ModelId; label: string }>
            ).map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={`h-10 rounded-[8px] text-[13px] font-medium border ${
                  model === m.id
                    ? "border-ink bg-canvas"
                    : "border-line bg-paper text-ink-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Permission mode
            </div>
            <div className="grid grid-cols-4 gap-1 p-1 bg-paper border border-line rounded-[8px]">
              {(
                [
                  ["default", "Ask"],
                  ["acceptEdits", "Accept"],
                  ["plan", "Plan"],
                  ["bypassPermissions", "Bypass"],
                ] as Array<[PermissionMode, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setMode(id)}
                  className={`h-9 rounded-[6px] text-[12px] font-medium ${
                    mode === id
                      ? "bg-canvas shadow-card border border-line text-ink"
                      : "text-ink-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {err && (
          <div className="mt-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}

        <button
          onClick={create}
          disabled={busy}
          className="mt-4 w-full h-12 rounded-[8px] bg-ink text-canvas font-medium disabled:opacity-50"
        >
          {busy ? "Creating…" : "Start session"}
        </button>
      </div>
      {pickerOpen && (
        <FolderPicker
          initialPath={projectPath.trim() || undefined}
          onPick={(abs) => {
            setProjectPath(abs);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function formatRel(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((now - then) / 1000));
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function WsDiagPanel({
  diag,
  onClose,
}: {
  diag: import("@/api/ws").WsDiagnostics;
  onClose: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["phase", diag.phase],
    ["attempts", String(diag.attempts)],
    ["reconnectIn", diag.reconnectIn ? `${diag.reconnectIn}ms` : "—"],
    [
      "lastFrameAt",
      diag.lastFrameAt
        ? `${Math.round((Date.now() - diag.lastFrameAt) / 1000)}s ago`
        : "—",
    ],
    ["lastCloseCode", diag.lastCloseCode ? String(diag.lastCloseCode) : "—"],
    ["lastCloseReason", diag.lastCloseReason || "—"],
    ["lastError", diag.lastError || "—"],
    [
      "url",
      typeof location !== "undefined"
        ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`
        : "?",
    ],
    [
      "userAgent",
      typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 90) : "?",
    ],
  ];
  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-4">
        <div className="flex items-center mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              WebSocket
            </div>
            <div className="display text-[1.1rem] leading-tight">
              Connection diagnostics
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        <dl className="mono text-[12px] divide-y divide-line">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 py-1.5">
              <dt className="text-ink-muted w-32 shrink-0">{k}</dt>
              <dd className="min-w-0 flex-1 break-all text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function ProjectsSheet({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(id: string) {
    setErr(null);
    const name = editingName.trim();
    if (!name) {
      setErr("Name can't be empty.");
      return;
    }
    try {
      await api.updateProject(id, { name });
      setEditingId(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "update failed");
    }
  }

  async function remove(p: Project) {
    setErr(null);
    if (
      !confirm(
        `Delete project "${p.name}"? Sessions under it are not deleted, only the project reference.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteProject(p.id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "has_sessions") {
        setErr(
          `Can't delete "${p.name}" — it still has sessions. Archive or delete them first.`,
        );
      } else {
        setErr(e instanceof ApiError ? e.code : "delete failed");
      }
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Projects
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              Manage where claude can work.
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-[13px] text-ink-muted text-center py-10 mono">
              loading…
            </div>
          ) : projects.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              No projects yet. Add one from the New Session sheet.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {projects.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  {editingId === p.id ? (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") save(p.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
                      />
                      <div className="mono text-[11px] text-ink-muted truncate">
                        {p.path}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => save(p.id)}
                          className="flex-1 h-9 rounded-[8px] bg-ink text-canvas text-[13px] font-medium"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="h-9 px-3 rounded-[8px] border border-line text-[13px]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium">{p.name}</div>
                        <div className="mono text-[11px] text-ink-muted truncate">
                          {p.path}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setEditingId(p.id);
                          setEditingName(p.name);
                          setErr(null);
                        }}
                        title="Rename"
                        className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center text-ink-soft hover:bg-paper"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => remove(p)}
                        title="Delete"
                        className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center text-danger hover:bg-danger-wash"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && (
          <div
            className={cn(
              "m-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30",
            )}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
