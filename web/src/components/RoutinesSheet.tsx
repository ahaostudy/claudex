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

// Common cron presets so the user doesn't have to write cron for the 80%
// case. `custom` drops into a free-text input. The labels are phrased in
// the user's timezone — the server schedules in the host's local TZ too.
const PRESETS: Array<{ id: string; label: string; expr: string }> = [
  { id: "hourly", label: "Every hour", expr: "0 * * * *" },
  { id: "daily-9", label: "Every day at 9:00", expr: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays at 9:00", expr: "0 9 * * 1-5" },
  { id: "weekly-mon-9", label: "Mondays at 9:00", expr: "0 9 * * 1" },
  { id: "every-30m", label: "Every 30 minutes", expr: "*/30 * * * *" },
];

// Narrow, on-purpose humanizer for the presets we offer. Falls through to
// the raw cron string for anything we don't recognise — good enough until we
// want the weight of `cronstrue`.
function humanCron(expr: string): string {
  const trimmed = expr.trim();
  const hit = PRESETS.find((p) => p.expr === trimmed);
  if (hit) return hit.label;
  // Handle "0 H * * *" as "Every day at H:00"
  const m = trimmed.match(/^0 (\d{1,2}) \* \* \*$/);
  if (m) return `Every day at ${m[1]}:00`;
  return trimmed;
}

function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = then - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return diff >= 0 ? "soon" : "just now";
  if (mins < 60)
    return diff >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return diff >= 0 ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return diff >= 0 ? `in ${days}d` : `${days}d ago`;
}

export function RoutinesSheet({ onClose }: { onClose: () => void }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    setLoading(true);
    try {
      const [r, p] = await Promise.all([
        api.listRoutines(),
        api.listProjects(),
      ]);
      setRoutines(r.routines);
      setProjects(p.projects);
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
      onClose();
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

  if (editing || creating) {
    return (
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
    );
  }

  return (
    <div className="fixed inset-0 z-20 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Routines
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              Scheduled sessions.
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-3 border-b border-line">
          <button
            onClick={() => setCreating(true)}
            className="w-full inline-flex items-center justify-center gap-1.5 h-10 rounded-[8px] bg-ink text-canvas text-[13px] font-medium"
          >
            <Plus className="w-4 h-4" />
            New routine
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-[13px] text-ink-muted text-center py-10 mono">
              loading…
            </div>
          ) : routines.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <Calendar className="w-6 h-6 mx-auto text-ink-muted mb-2" />
              <div className="text-[14px] font-medium mb-1">No routines yet.</div>
              <div className="text-[12px] text-ink-muted max-w-[36ch] mx-auto">
                Routines start a fresh session on a cron schedule. Useful for
                nightly audits, morning summaries, or periodic health checks.
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {routines.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        r.status === "active"
                          ? "bg-success"
                          : "bg-line-strong"
                      }`}
                    />
                    <span className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                      {r.status}
                    </span>
                    <span className="ml-auto text-[11px] text-ink-muted">
                      next {formatRel(r.nextRunAt)}
                    </span>
                  </div>
                  <div className="text-[15px] font-medium leading-snug mt-1">
                    {r.name}
                  </div>
                  <div className="text-[12px] text-ink-muted mt-0.5">
                    {humanCron(r.cronExpr)}
                  </div>
                  <div className="text-[11px] text-ink-muted mt-0.5 mono truncate">
                    {r.cronExpr}
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    <button
                      onClick={() => runNow(r)}
                      title="Run now"
                      className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] inline-flex items-center gap-1 hover:bg-paper"
                    >
                      <Play className="w-3 h-3" />
                      Run now
                    </button>
                    <button
                      onClick={() => togglePause(r)}
                      title={r.status === "active" ? "Pause" : "Resume"}
                      className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] inline-flex items-center gap-1 hover:bg-paper"
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
                      title="Edit"
                      className="ml-auto h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-paper"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(r)}
                      title="Delete"
                      className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-danger hover:bg-danger-wash"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && (
          <div className="m-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
      </div>
    </div>
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

  // Keep cronExpr in sync with preset selection.
  useEffect(() => {
    if (cronPreset === "custom") return;
    const hit = PRESETS.find((p) => p.id === cronPreset);
    if (hit) setCronExpr(hit.expr);
  }, [cronPreset]);

  async function save() {
    setErr(null);
    if (!name.trim()) {
      setErr("Name can't be empty.");
      return;
    }
    if (!projectId) {
      setErr("Pick a project first.");
      return;
    }
    if (!prompt.trim()) {
      setErr("Prompt can't be empty.");
      return;
    }
    if (!cronExpr.trim()) {
      setErr("Cron expression can't be empty.");
      return;
    }
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
    <div className="fixed inset-0 z-20 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              {initial ? "Edit routine" : "New routine"}
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
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
            <div className="text-[11px] text-ink-muted mt-1">
              Five fields: minute hour day-of-month month day-of-week. Evaluated
              in the host's local timezone.
            </div>
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
