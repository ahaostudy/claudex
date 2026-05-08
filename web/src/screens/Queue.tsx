import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  ListOrdered,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type {
  ModelId,
  PermissionMode,
  Project,
  QueuedPrompt,
  QueueStatus,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";

/**
 * Queue screen — the user composes several prompts and the server dispatches
 * them one at a time as fresh sessions. Independent of Routines because the
 * scheduling model is different ("run these now, in order" vs. "fire on a
 * cron").
 *
 * Live updates:
 *   - Sessions WS frames bubble up to AppShell via the Sessions store for
 *     badge counts; the queue itself gets refreshed on a plain 5-second poll
 *     because we didn't wire a per-queue WS channel (a batch flow is the
 *     opposite of latency-sensitive — "it'll get there" is fine).
 *   - On any edit (create / delete / reorder / patch) we refetch immediately
 *     so the UI reflects the mutation without waiting for the 5s tick.
 */
export function QueueScreen() {
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QueuedPrompt | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const [q, p] = await Promise.all([api.listQueue(), api.listProjects()]);
      setQueue(q.queue);
      setProjects(p.projects);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, []);

  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  async function cancel(row: QueuedPrompt) {
    if (
      !confirm(
        row.status === "running"
          ? "Cancel the running prompt? The session will be interrupted."
          : "Remove this queued prompt?",
      )
    )
      return;
    setErr(null);
    try {
      await api.deleteQueued(row.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "cancel failed");
    }
  }

  async function reorder(row: QueuedPrompt, direction: "up" | "down") {
    setErr(null);
    try {
      await api.reorderQueued(row.id, direction);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "reorder failed");
    }
  }

  return (
    <AppShell tab="queue">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Queue</div>
          <h1 className="display text-[1.25rem] leading-tight mt-0.5">Batch</h1>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card"
        >
          <Plus className="w-4 h-4" />
          New item
        </button>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        {loading ? (
          <div className="text-[13px] text-ink-muted text-center py-10 mono">
            loading…
          </div>
        ) : queue.length === 0 ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded-[12px] border border-dashed border-line-strong p-8 text-center">
              <ListOrdered className="w-6 h-6 mx-auto text-ink-muted mb-2" />
              <div className="display text-[1.1rem] mb-1">
                No prompts queued.
              </div>
              <div className="text-[13px] text-ink-muted max-w-[40ch] mx-auto">
                Line up several prompts and claudex will run them sequentially,
                each in its own fresh session. Useful for "go fix these four
                issues while I'm away".
              </div>
            </div>
          </div>
        ) : (
          <ul>
            {queue.map((row, idx) => {
              const project = projectsById.get(row.projectId);
              return (
                <QueueRow
                  key={row.id}
                  row={row}
                  project={project}
                  canMoveUp={
                    row.status === "queued" &&
                    queue
                      .slice(0, idx)
                      .some((r) => r.status === "queued")
                  }
                  canMoveDown={
                    row.status === "queued" &&
                    queue
                      .slice(idx + 1)
                      .some((r) => r.status === "queued")
                  }
                  onEdit={() => setEditing(row)}
                  onCancel={() => cancel(row)}
                  onReorder={(dir) => reorder(row, dir)}
                />
              );
            })}
          </ul>
        )}
        {err && (
          <div className="mx-4 md:mx-6 my-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
      </section>

      {(creating || editing) && (
        <QueueEditor
          initial={editing}
          projects={projects}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </AppShell>
  );
}

function QueueRow({
  row,
  project,
  canMoveUp,
  canMoveDown,
  onEdit,
  onCancel,
  onReorder,
}: {
  row: QueuedPrompt;
  project: Project | undefined;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onReorder: (direction: "up" | "down") => void;
}) {
  const navigate = useNavigate();
  const title =
    row.title && row.title.trim().length > 0
      ? row.title
      : row.prompt.split(/\r?\n/, 1)[0]?.slice(0, 60) ?? "(empty prompt)";

  return (
    <li className="px-4 md:px-6 py-3 border-b border-line hover:bg-paper/40">
      <div className="flex items-center gap-3">
        <StatusDot status={row.status} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium truncate">{title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-muted flex-wrap">
            {project ? (
              <span className="mono truncate">{project.name}</span>
            ) : (
              <span className="mono text-danger truncate">
                (project gone)
              </span>
            )}
            <span>·</span>
            <span className="mono">{row.model ?? "opus-4-7"}</span>
            <span>·</span>
            <span className="mono">{row.mode ?? "default"}</span>
            {row.worktree && (
              <>
                <span>·</span>
                <span className="mono">worktree</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {row.status === "queued" ? (
            <>
              <button
                onClick={() => onReorder("up")}
                disabled={!canMoveUp}
                className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas disabled:opacity-40"
                title="Move up"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onReorder("down")}
                disabled={!canMoveDown}
                className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas disabled:opacity-40"
                title="Move down"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onEdit}
                className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas"
                title="Edit"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onCancel}
                className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-danger hover:bg-danger-wash"
                title="Remove"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          ) : row.status === "running" ? (
            <>
              {row.sessionId && (
                <button
                  onClick={() => navigate(`/session/${row.sessionId}`)}
                  className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] hover:bg-canvas"
                >
                  Open session →
                </button>
              )}
              <button
                onClick={onCancel}
                className="h-8 px-2.5 rounded-[6px] border border-line text-danger text-[12px] hover:bg-danger-wash"
              >
                Stop
              </button>
            </>
          ) : (
            row.sessionId && (
              <button
                onClick={() => navigate(`/session/${row.sessionId}`)}
                className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] hover:bg-canvas"
              >
                Open session →
              </button>
            )
          )}
        </div>
      </div>
    </li>
  );
}

function StatusDot({ status }: { status: QueueStatus }) {
  const cls =
    status === "queued"
      ? "bg-ink-faint"
      : status === "running"
        ? "bg-success animate-pulse"
        : status === "done"
          ? "bg-ink-faint"
          : status === "cancelled"
            ? "bg-line-strong"
            : "bg-danger";
  return (
    <span
      className={`h-2 w-2 rounded-full shrink-0 ${cls}`}
      title={status}
      aria-label={status}
    />
  );
}

function QueueEditor({
  initial,
  projects,
  onCancel,
  onSaved,
}: {
  initial: QueuedPrompt | null;
  projects: Project[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(
    initial?.projectId ?? projects[0]?.id ?? "",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [model, setModel] = useState<ModelId>(
    initial?.model ?? "claude-opus-4-7",
  );
  const [mode, setMode] = useState<PermissionMode>(initial?.mode ?? "default");
  const [worktree, setWorktree] = useState<boolean>(initial?.worktree ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!initial && !projectId) return setErr("Pick a project first.");
    if (!prompt.trim()) return setErr("Prompt can't be empty.");
    setBusy(true);
    try {
      if (initial) {
        await api.updateQueued(initial.id, {
          prompt: prompt.trim(),
          title: title.trim() || undefined,
          model,
          mode,
          worktree,
        });
      } else {
        await api.createQueued({
          projectId,
          prompt: prompt.trim(),
          title: title.trim() || undefined,
          model,
          mode,
          worktree,
        });
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              {initial ? "Edit queued item" : "New queued item"}
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              {initial ? "Tweak before it runs." : "Compose a batch item."}
            </h2>
          </div>
          <button
            onClick={onCancel}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Project
            </div>
            {initial ? (
              <div className="px-3 py-2.5 border border-line rounded-[8px] text-[13px] text-ink-muted">
                {projects.find((p) => p.id === initial.projectId)?.name ??
                  initial.projectId}
                <span className="mono text-[11px] ml-2">
                  (can't change after queue)
                </span>
              </div>
            ) : projects.length === 0 ? (
              <div className="px-3 py-2.5 border border-dashed border-line-strong rounded-[8px] text-[13px] text-ink-muted">
                No projects yet. Add one from the New Session sheet first.
              </div>
            ) : (
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.path}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Title (optional)
            </div>
            <input
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Fix failing CI test"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Prompt
            </div>
            <textarea
              rows={5}
              className="w-full px-3 py-2 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Describe what claude should do…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Model
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
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            <span>Use git worktree (if the project is a repo)</span>
          </label>
        </div>
        {err && (
          <div className="mx-4 mb-2 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
        <div className="p-4 border-t border-line flex gap-2">
          <button
            onClick={onCancel}
            className="h-11 px-4 rounded-[8px] border border-line text-[13px]"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="flex-1 h-11 rounded-[8px] bg-ink text-canvas text-[13px] font-medium disabled:opacity-50"
          >
            {busy ? "Saving…" : initial ? "Save changes" : "Add to queue"}
          </button>
        </div>
      </div>
    </div>
  );
}
