import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Calendar,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type {
  ModelId,
  PermissionMode,
  Project,
  Routine,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";
import { timeAgoOrInShort } from "@/lib/format";

// Inlined version of RoutinesSheet contents as a full-page screen. The old
// sheet is kept around for the "Run now → navigate into session" flow but
// the tab bar is now the primary entry point, not the Home header button.

const PRESETS: Array<{ id: string; label: string; expr: string }> = [
  { id: "hourly", label: "Every hour", expr: "0 * * * *" },
  { id: "daily-9", label: "Every day at 9:00", expr: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays at 9:00", expr: "0 9 * * 1-5" },
  { id: "weekly-mon-9", label: "Mondays at 9:00", expr: "0 9 * * 1" },
  { id: "every-30m", label: "Every 30 minutes", expr: "*/30 * * * *" },
];

function humanCron(expr: string): string {
  const trimmed = expr.trim();
  const hit = PRESETS.find((p) => p.expr === trimmed);
  if (hit) return hit.label;
  const m = trimmed.match(/^0 (\d{1,2}) \* \* \*$/);
  if (m) return `Every day at ${m[1]}:00`;
  return trimmed;
}

function formatRel(iso: string | null): string {
  return timeAgoOrInShort(iso);
}

export function RoutinesScreen() {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [creating, setCreating] = useState(false);
  // `loadErr` is the refresh() failure (blocks the list); `err` is a mutation
  // failure (run/pause/delete) rendered alongside the list. Priority in the
  // render: loadErr > loading > empty > data; the mutation banner lives below
  // the list so the list itself stays visible when a delete fails.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    setLoading(true);
    setLoadErr(null);
    try {
      const [r, p] = await Promise.all([
        api.listRoutines(),
        api.listProjects(),
      ]);
      setRoutines(r.routines);
      setProjects(p.projects);
    } catch (e) {
      // Don't silently fall through to an empty-state card — that would look
      // identical to a genuine "no routines" account and hide a transient
      // network/API break from the user. Surface the failure as a banner with
      // a retry button so the list reflects what we know: we don't know yet.
      setLoadErr(e instanceof ApiError ? e.code : "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function runNow(r: Routine) {
    setErr(null);
    try {
      const res = await api.runRoutine(r.id);
      navigate(`/session/${res.sessionId}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "run failed");
    }
  }

  async function togglePause(r: Routine) {
    setErr(null);
    try {
      await api.updateRoutine(r.id, {
        status: r.status === "active" ? "paused" : "active",
      });
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "update failed");
    }
  }

  async function remove(r: Routine) {
    if (!confirm(`Delete routine "${r.name}"?`)) return;
    setErr(null);
    try {
      await api.deleteRoutine(r.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "delete failed");
    }
  }

  return (
    <AppShell tab="routines">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Routines</div>
          <h1 className="display text-[20px] md:text-[26px] leading-tight mt-0.5">
            Scheduled sessions
          </h1>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card"
        >
          <Plus className="w-4 h-4" />
          New routine
        </button>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        {loadErr ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded-[8px] border border-danger/30 bg-danger-wash px-4 py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1 text-[13px] text-danger">
                Couldn't load routines: <span className="mono">{loadErr}</span>
              </div>
              <button
                type="button"
                onClick={refresh}
                disabled={loading}
                className="shrink-0 h-8 px-3 rounded-[6px] border border-danger/40 bg-canvas text-[12px] text-danger font-medium disabled:opacity-50"
              >
                {loading ? "Retrying…" : "Retry"}
              </button>
            </div>
          </div>
        ) : loading ? (
          <div className="text-[13px] text-ink-muted text-center py-10 mono">
            loading…
          </div>
        ) : routines.length === 0 ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded-[12px] border border-dashed border-line-strong p-8 text-center">
              <Calendar className="w-6 h-6 mx-auto text-ink-muted mb-2" />
              <div className="display text-[1.1rem] mb-1">No routines yet.</div>
              <div className="text-[13px] text-ink-muted max-w-[40ch] mx-auto">
                Routines start a fresh session on a cron schedule. Useful for
                nightly audits, morning summaries, or periodic health checks.
              </div>
            </div>
          </div>
        ) : (
          <ul>
            {routines.map((r) => (
              <li
                key={r.id}
                className="px-4 md:px-6 py-3 border-b border-line hover:bg-paper/40"
              >
                {/* Mobile stacked */}
                <div className="md:hidden">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        r.status === "active"
                          ? "bg-success"
                          : "bg-line-strong"
                      }`}
                    />
                    <div className="text-[14px] font-medium truncate flex-1">
                      {r.name}
                    </div>
                    <span className="text-[11px] text-ink-muted shrink-0">
                      next {formatRel(r.nextRunAt)}
                    </span>
                  </div>
                  <div className="text-[12px] text-ink-muted truncate mt-0.5">
                    {humanCron(r.cronExpr)}
                  </div>
                  <div className="mono text-[11px] text-ink-muted truncate mt-0.5">
                    {r.cronExpr}
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    <button
                      onClick={() => runNow(r)}
                      className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] inline-flex items-center gap-1 hover:bg-canvas"
                    >
                      <Play className="w-3 h-3" />
                      Run now
                    </button>
                    <button
                      onClick={() => togglePause(r)}
                      className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] inline-flex items-center gap-1 hover:bg-canvas"
                    >
                      {r.status === "active" ? (
                        <>
                          <Pause className="w-3 h-3" />
                          Pause
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3" />
                          Resume
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="ml-auto h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas"
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(r)}
                      className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-danger hover:bg-danger-wash"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Desktop grid row: dot · name/cron · next · actions */}
                <div className="hidden md:grid grid-cols-[22px_minmax(0,1fr)_180px_auto] gap-4 items-center">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      r.status === "active"
                        ? "bg-success"
                        : "bg-line-strong"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium truncate">
                      {r.name}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-muted">
                      <span className="mono truncate">{r.cronExpr}</span>
                      <span>·</span>
                      <span className="truncate">{humanCron(r.cronExpr)}</span>
                    </div>
                  </div>
                  <div className="text-[12px] text-ink-muted truncate">
                    next {formatRel(r.nextRunAt)}
                  </div>
                  <div className="flex items-center gap-1.5 justify-end">
                    <button
                      onClick={() => runNow(r)}
                      className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] inline-flex items-center gap-1 hover:bg-canvas"
                    >
                      <Play className="w-3 h-3" />
                      Run now
                    </button>
                    <button
                      onClick={() => togglePause(r)}
                      className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] inline-flex items-center gap-1 hover:bg-canvas"
                    >
                      {r.status === "active" ? (
                        <>
                          <Pause className="w-3 h-3" />
                          Pause
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3" />
                          Resume
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => setEditing(r)}
                      className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas"
                      title="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(r)}
                      className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-danger hover:bg-danger-wash"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {err && (
          <div className="mx-4 md:mx-6 my-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
      </section>

      {(editing || creating) && (
        <RoutineEditor
          initial={editing}
          projects={projects}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={async () => {
            setEditing(null);
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </AppShell>
  );
}

function RoutineEditor({
  initial,
  projects,
  onCancel,
  onSaved,
}: {
  initial: Routine | null;
  projects: Project[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [projectId, setProjectId] = useState(
    initial?.projectId ?? projects[0]?.id ?? "",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [cronPreset, setCronPreset] = useState<string>(() => {
    if (!initial) return "daily-9";
    const found = PRESETS.find((p) => p.expr === initial.cronExpr);
    return found ? found.id : "custom";
  });
  const [cronExpr, setCronExpr] = useState(
    initial?.cronExpr ?? PRESETS[1].expr,
  );
  const [model, setModel] = useState<ModelId>(initial?.model ?? "claude-opus-4-7");
  const [mode, setMode] = useState<PermissionMode>(initial?.mode ?? "default");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (cronPreset === "custom") return;
    const hit = PRESETS.find((p) => p.id === cronPreset);
    if (hit) setCronExpr(hit.expr);
  }, [cronPreset]);

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr("Name can't be empty.");
    if (!projectId) return setErr("Pick a project first.");
    if (!prompt.trim()) return setErr("Prompt can't be empty.");
    if (!cronExpr.trim()) return setErr("Cron expression can't be empty.");
    setBusy(true);
    try {
      if (initial) {
        await api.updateRoutine(initial.id, {
          name: name.trim(),
          prompt: prompt.trim(),
          cronExpr: cronExpr.trim(),
          model,
          mode,
        });
      } else {
        await api.createRoutine({
          name: name.trim(),
          projectId,
          prompt: prompt.trim(),
          cronExpr: cronExpr.trim(),
          model,
          mode,
        });
      }
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_cron") {
        setErr("That cron expression isn't valid. Use a 5-field form like `0 9 * * *`.");
      } else {
        setErr(e instanceof ApiError ? e.code : "save failed");
      }
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
              {initial ? "Edit routine" : "New routine"}
            </div>
            <h2 className="display text-[20px] md:text-[22px] leading-tight mt-0.5">
              {initial ? "Tweak the schedule." : "Schedule a repeating session."}
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
              Name
            </div>
            <input
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Daily dep audit"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Project
            </div>
            {initial ? (
              <div className="px-3 py-2.5 border border-line rounded-[8px] text-[13px] text-ink-muted">
                {projects.find((p) => p.id === initial.projectId)?.name ??
                  initial.projectId}
                <span className="mono text-[11px] ml-2">
                  (can't change after create)
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
              Prompt
            </div>
            <textarea
              rows={4}
              className="w-full px-3 py-2 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Run `pnpm audit` and summarize the output."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Schedule
            </div>
            <div className="grid grid-cols-2 gap-1.5 mb-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setCronPreset(p.id)}
                  className={`h-9 rounded-[6px] text-[12px] font-medium border text-left px-2 ${
                    cronPreset === p.id
                      ? "border-klein bg-klein-wash/30"
                      : "border-line bg-paper text-ink-muted"
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => setCronPreset("custom")}
                className={`h-9 rounded-[6px] text-[12px] font-medium border text-left px-2 ${
                  cronPreset === "custom"
                    ? "border-klein bg-klein-wash/30"
                    : "border-line bg-paper text-ink-muted"
                }`}
              >
                Custom cron
              </button>
            </div>
            <input
              disabled={cronPreset !== "custom"}
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[13px] mono disabled:opacity-60"
              placeholder="0 9 * * *"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
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
            {busy ? "Saving…" : initial ? "Save changes" : "Create routine"}
          </button>
        </div>
      </div>
    </div>
  );
}
