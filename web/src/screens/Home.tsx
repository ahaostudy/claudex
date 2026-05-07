import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, GitBranch } from "lucide-react";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type { Project, ModelId, PermissionMode } from "@claudex/shared";

const statusTone: Record<string, string> = {
  running: "bg-success",
  awaiting: "bg-warn",
  idle: "bg-ink-faint",
  archived: "bg-line-strong",
  error: "bg-danger",
};

export function HomeScreen() {
  const { user, logout } = useAuth();
  const {
    init,
    sessions,
    refreshSessions,
    loadingSessions,
    connected,
  } = useSessions();
  const navigate = useNavigate();
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    init();
    refreshSessions();
  }, [init, refreshSessions]);

  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <svg viewBox="0 0 32 32" className="w-5 h-5">
          <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
          <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
        </svg>
        <span className="mono text-[13px]">claudex</span>
        <span
          className={`inline-flex items-center gap-1.5 ml-1 px-1.5 py-0.5 rounded-[4px] border border-line bg-paper text-[10px] uppercase tracking-[0.1em] ${
            connected ? "text-success" : "text-ink-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "bg-success animate-pulse" : "bg-line-strong"
            }`}
          />
          {connected ? "live" : "offline"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-ink-muted hidden sm:inline">
            signed in as <span className="mono">{user?.username}</span>
          </span>
          <button
            onClick={() => logout()}
            className="text-[12px] text-ink-muted hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </header>

      <section className="px-5 pt-4 pb-24">
        <div className="flex items-baseline gap-3 mb-4">
          <h1 className="display text-[1.75rem] leading-tight">Sessions</h1>
          <span className="mono text-[11px] text-ink-muted">
            {loadingSessions ? "loading…" : `${sessions.length} total`}
          </span>
          <button
            onClick={() => setShowNew(true)}
            className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card"
          >
            <Plus className="w-4 h-4" />
            New
          </button>
        </div>

        {sessions.length === 0 && !loadingSessions ? (
          <EmptyState onNew={() => setShowNew(true)} />
        ) : (
          <ul className="space-y-2">
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
    </main>
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelId>("claude-opus-4-7");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      let projectId = selected;
      if (!projectId) {
        if (!projectName || !projectPath) {
          throw new Error("Add a project first");
        }
        const p = await api.createProject({
          name: projectName,
          path: projectPath,
        });
        projectId = p.project.id;
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
    <div className="fixed inset-0 z-20 bg-ink/30 flex items-end sm:items-center justify-center">
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
          {projects.length > 0 ? (
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
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted">
                Add a project
              </div>
              <input
                className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
                placeholder="Name (e.g. spindle)"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
              <input
                className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px] mono"
                placeholder="/Users/you/code/spindle"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
              />
            </div>
          )}

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
