import { useEffect, useState } from "react";
import { GitBranch, Trash2, X } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type {
  ModelId,
  PermissionMode,
  Session,
  ToolGrant,
} from "@claudex/shared";

/**
 * Session settings side sheet. Mirrors mockup screen 10:
 * model 3-way, permission mode 4-way, editable title, read-only worktree
 * panel, and the "Approved in this session" list with per-row Revoke.
 *
 * On mobile: full-height right slide-over. On desktop ≥sm we still render as
 * a right rail rather than centering — matches the mockup's desktop layout.
 */
export function SessionSettingsSheet({
  session,
  onClose,
  onUpdated,
}: {
  session: Session;
  onClose: () => void;
  onUpdated: (next: Session) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [model, setModel] = useState<ModelId>(session.model);
  const [mode, setMode] = useState<PermissionMode>(session.mode);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [grantsErr, setGrantsErr] = useState<string | null>(null);

  // Re-hydrate editable state when the parent swaps a fresh session in.
  useEffect(() => {
    setTitle(session.title);
    setModel(session.model);
    setMode(session.mode);
  }, [session.id, session.title, session.model, session.mode]);

  async function loadGrants() {
    setGrantsErr(null);
    try {
      const r = await api.listGrants(session.id);
      setGrants(r.grants);
    } catch (e) {
      setGrantsErr(e instanceof ApiError ? e.code : "load_failed");
      setGrants([]);
    }
  }

  useEffect(() => {
    loadGrants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  async function patch(partial: {
    title?: string;
    model?: ModelId;
    mode?: PermissionMode;
  }) {
    setSaving(true);
    setErr(null);
    try {
      const r = await api.updateSession(session.id, partial);
      onUpdated(r.session);
      setWarnings(r.warnings ?? []);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "update_failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveTitle() {
    const next = title.trim();
    if (!next || next === session.title) return;
    await patch({ title: next });
  }

  async function revoke(id: string) {
    try {
      await api.revokeGrant(id);
      setGrants((prev) => (prev ?? []).filter((g) => g.id !== id));
    } catch (e) {
      setGrantsErr(e instanceof ApiError ? e.code : "revoke_failed");
    }
  }

  const archived = session.status === "archived";

  return (
    <div className="fixed inset-0 z-20 bg-ink/30 flex justify-end">
      <div className="w-full sm:w-[380px] bg-canvas border-l border-line shadow-lift flex flex-col max-h-screen">
        {/* Header — matches mockup desktop right-rail header */}
        <div className="px-5 py-3 border-b border-line flex items-center">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Settings
            </div>
            <div className="display text-[18px] leading-tight mt-0.5">
              This session
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line hover:bg-paper flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {archived && (
            <div className="text-[12px] text-ink-muted rounded-[8px] border border-dashed border-line-strong bg-paper/50 px-3 py-2">
              This session is archived — settings are read-only.
            </div>
          )}

          {/* Title */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Title
            </div>
            <input
              disabled={archived || saving}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px] disabled:opacity-60"
              placeholder="Untitled"
            />
          </div>

          {/* Model */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Model
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-paper border border-line rounded-[8px]">
              {(
                [
                  { id: "claude-opus-4-7", label: "Opus 4.7", sub: "latest" },
                  {
                    id: "claude-sonnet-4-6",
                    label: "Sonnet 4.6",
                    sub: "balanced",
                  },
                  { id: "claude-haiku-4-5", label: "Haiku 4.5", sub: "fast" },
                ] as Array<{ id: ModelId; label: string; sub: string }>
              ).map((m) => {
                const active = model === m.id;
                return (
                  <button
                    key={m.id}
                    disabled={archived || saving}
                    onClick={() => {
                      setModel(m.id);
                      if (m.id !== session.model) patch({ model: m.id });
                    }}
                    className={`h-11 rounded-[6px] text-[13px] font-medium leading-tight transition-colors ${
                      active
                        ? "bg-canvas shadow-card border border-line text-ink"
                        : "text-ink-muted"
                    }`}
                  >
                    <div>{m.label}</div>
                    <div
                      className={`text-[10px] ${
                        active ? "text-ink-muted" : "opacity-70"
                      }`}
                    >
                      {m.sub}
                    </div>
                  </button>
                );
              })}
            </div>
            {warnings.includes("model_change_applies_to_next_turn") && (
              <div className="mt-2 text-[12px] text-[#7a4700] bg-warn-wash/60 border border-warn/30 rounded-[6px] px-2.5 py-1.5">
                Model change applies to the next turn — the in-flight turn
                keeps using the previous model.
              </div>
            )}
          </div>

          {/* Permission mode — 4-way (the SDK "auto" is swallowed into default) */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
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
                  disabled={archived || saving}
                  onClick={() => {
                    setMode(id);
                    if (id !== session.mode) patch({ mode: id });
                  }}
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
            <div className="text-[12px] text-ink-muted mt-2">
              {mode === "default" && "Claude will ask before every edit or command."}
              {mode === "acceptEdits" && "Auto-accept file edits and safe filesystem ops."}
              {mode === "plan" && "Read-only exploration. Claude won't edit files."}
              {mode === "bypassPermissions" &&
                "No prompts. Only use in sandboxed environments."}
            </div>
          </div>

          {/* Workspace — Worktree info, read-only for now */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Workspace
            </div>
            <div className="rounded-[8px] border border-line bg-canvas p-4 space-y-2.5 text-[13px]">
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  Branch
                </span>
                <span className="mono text-[12px] truncate flex items-center gap-1.5">
                  <GitBranch className="w-3 h-3 text-ink-muted" />
                  {session.branch ?? (
                    <span className="text-ink-faint">— none —</span>
                  )}
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  Worktree
                </span>
                <span className="mono text-[12px] truncate">
                  {session.worktreePath ?? (
                    <span className="text-ink-faint">project root</span>
                  )}
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  Status
                </span>
                <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-line-strong" />
                  worktree creation arrives in P4
                </span>
              </div>
            </div>
          </div>

          {/* Approved in this session */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Approved in this session
            </div>
            <div className="rounded-[8px] border border-line bg-canvas p-3 space-y-2 text-[13px]">
              {grants === null ? (
                <div className="text-[12px] text-ink-muted mono">loading…</div>
              ) : grants.length === 0 ? (
                <div className="text-[12px] text-ink-muted">
                  No tools have been approved yet. "Always" on a permission
                  prompt saves one here.
                </div>
              ) : (
                grants.map((g) => (
                  <div key={g.id} className="flex items-center gap-2">
                    <span
                      className={`shrink-0 inline-flex items-center h-5 px-1.5 rounded-[4px] text-[10px] mono uppercase tracking-[0.1em] ${
                        g.scope === "global"
                          ? "bg-klein-wash text-klein-ink border border-klein/30"
                          : "bg-paper text-ink-muted border border-line"
                      }`}
                      title={g.scope === "global" ? "Applies to every session" : "This session only"}
                    >
                      {g.scope}
                    </span>
                    <span className="mono text-[12px] text-ink-soft shrink-0">
                      {g.toolName}
                    </span>
                    <span className="mono flex-1 truncate text-[12px] text-ink-muted">
                      {g.signature || "—"}
                    </span>
                    <button
                      onClick={() => revoke(g.id)}
                      className="h-6 px-2 text-[11px] rounded-[4px] border border-line hover:bg-paper inline-flex items-center gap-1 text-ink-soft hover:text-danger"
                    >
                      <Trash2 className="w-3 h-3" />
                      Revoke
                    </button>
                  </div>
                ))
              )}
              {grantsErr && (
                <div className="text-[12px] text-danger">{grantsErr}</div>
              )}
            </div>
          </div>

          {err && (
            <div className="text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
              {err}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
