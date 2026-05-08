import { useEffect, useRef, useState } from "react";
import { GitBranch, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "@/api/client";
import { Markdown } from "@/components/Markdown";
import { formatBytes } from "@/lib/format";
import { useSessions } from "@/state/sessions";
import type {
  MemoryResponse,
  ModelId,
  PermissionMode,
  Project,
  Session,
  ToolGrant,
} from "@claudex/shared";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * Session settings sheet. Rebuilt to match mockup s-10.
 *
 * Mobile (<md): full-height bottom-sheet-ish right slide-over with a small
 * left-aligned X header and caps+display title.
 * Desktop (≥md): 380px right rail with the mockup's right-rail header
 * (caps+display on the left, X button on the right).
 *
 * Only ships sections we can back with real data today. Notable omissions
 * vs. the mockup (documented in docs/FEATURES.md):
 *  - Effort slider (we don't expose thinking.budget_tokens today)
 *  - Worktree "Relocate…" (no backend)
 *  - Workspace "Status · clean / N staged" (no git-status reader)
 *  - "Change with ⌘⇧M" helper text (no shortcut bound)
 *  - "Duplicate session" (no clone endpoint)
 */
export function SessionSettingsSheet({
  session,
  project,
  onClose,
  onUpdated,
}: {
  session: Session;
  project?: Project | null;
  onClose: () => void;
  onUpdated: (next: Session) => void;
}) {
  useFocusReturn();
  const [model, setModel] = useState<ModelId>(session.model);
  const [mode, setMode] = useState<PermissionMode>(session.mode);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  // Two-step confirm for destructive delete. First click flips the button
  // to "Click again to confirm" and arms a 3s timeout that resets the
  // prompt. Second click actually calls DELETE. Ref-stored timer so the
  // timeout can be cleared on unmount or re-press.
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const forgetSession = useSessions((s) => s.forgetSession);

  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [grantsErr, setGrantsErr] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [memoryErr, setMemoryErr] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  // Re-hydrate editable state when the parent swaps a fresh session in.
  useEffect(() => {
    setModel(session.model);
    setMode(session.mode);
  }, [session.id, session.model, session.mode]);

  // Escape closes the sheet.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  // Lazy-load the CLAUDE.md preview. We fetch on sheet mount rather than on
  // Chat mount because it's only needed once the user opens settings — and
  // the sheet itself only mounts when it's opened.
  useEffect(() => {
    let cancelled = false;
    setMemoryErr(null);
    setMemory(null);
    api
      .getProjectMemory(session.projectId)
      .then((r) => {
        if (!cancelled) setMemory(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setMemoryErr(e instanceof ApiError ? e.code : "load_failed");
        setMemory({ files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [session.projectId]);

  async function patch(partial: { model?: ModelId; mode?: PermissionMode }) {
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

  async function revoke(id: string) {
    try {
      await api.revokeGrant(id);
      setGrants((prev) => (prev ?? []).filter((g) => g.id !== id));
    } catch (e) {
      setGrantsErr(e instanceof ApiError ? e.code : "revoke_failed");
    }
  }

  async function archive() {
    if (archived || archiving) return;
    setArchiving(true);
    setErr(null);
    try {
      await api.archiveSession(session.id);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "archive_failed");
      setArchiving(false);
    }
  }

  // Clean up any dangling confirm timer on unmount so it can't fire after
  // the sheet (or the whole session) is gone.
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) {
        clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
    };
  }, []);

  async function handleDelete() {
    if (deleting) return;
    if (!deleteConfirming) {
      setDeleteConfirming(true);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => {
        setDeleteConfirming(false);
        deleteTimerRef.current = null;
      }, 3000);
      return;
    }
    // Second click within 3s — do the thing.
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    setDeleting(true);
    setErr(null);
    try {
      await api.deleteSession(session.id);
      forgetSession(session.id);
      // Close the sheet first so the parent route doesn't try to re-render
      // a session that no longer exists before we navigate away.
      onClose();
      navigate("/sessions");
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "delete_failed");
      setDeleting(false);
      setDeleteConfirming(false);
    }
  }

  // Close the export menu on outside-click. Kept local to the sheet — a full
  // menu primitive is overkill for a 2-item popover.
  useEffect(() => {
    if (!exportOpen) return;
    function onDocClick(e: MouseEvent) {
      if (
        exportMenuRef.current &&
        !exportMenuRef.current.contains(e.target as Node)
      ) {
        setExportOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [exportOpen]);

  function runExport(format: "md" | "json") {
    setExportOpen(false);
    api.exportSession(session.id, format);
  }

  const archived = session.status === "archived";
  const hasWorktree = !!session.worktreePath;
  const archiveLabel = hasWorktree
    ? "Archive session & remove worktree"
    : "Archive";

  const MODELS: Array<{ id: ModelId; label: string; sub: string; subDesktop: string }> = [
    { id: "claude-opus-4-7", label: "Opus 4.7", sub: "latest", subDesktop: "latest · adaptive" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", sub: "balanced", subDesktop: "balanced" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", sub: "fast", subDesktop: "fast" },
  ];

  const MODES: Array<[PermissionMode, string]> = [
    ["default", "Ask"],
    ["acceptEdits", "Accept"],
    ["plan", "Plan"],
    ["auto", "Auto"],
    ["bypassPermissions", "Bypass"],
  ];

  const modeHint: Record<PermissionMode, string> = {
    default: "Claude will ask before every edit or command.",
    acceptEdits: "Auto-accept file edits and safe filesystem ops.",
    plan: "Read-only exploration. Claude won't edit files.",
    auto: "Autonomous mode — falls back to Ask until the server-side classifier ships.",
    bypassPermissions: "No prompts. Only use in sandboxed environments.",
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 flex justify-end"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Session settings" className="w-full md:w-[380px] bg-canvas md:border-l border-line shadow-lift flex flex-col max-h-screen h-full">
        {/* Mobile header: X on the left, caps+display stacked. */}
        <div className="md:hidden px-4 py-2.5 border-b border-line flex items-center gap-2">
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Session
            </div>
            <div className="display text-[17px] leading-tight">Settings</div>
          </div>
        </div>

        {/* Desktop header: caps+display on the left, X on the right. */}
        <div className="hidden md:flex px-5 py-3 border-b border-line items-center">
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

        <div className="flex-1 overflow-y-auto p-4 md:p-5 space-y-5 md:space-y-6">
          {archived && (
            <div className="text-[12px] text-ink-muted rounded-[8px] border border-dashed border-line-strong bg-paper/50 px-3 py-2">
              This session is archived — settings are read-only.
            </div>
          )}

          {/* Model */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Model
            </div>
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-paper border border-line rounded-[8px]">
              {MODELS.map((m) => {
                const active = model === m.id;
                return (
                  <button
                    key={m.id}
                    disabled={archived || saving}
                    onClick={() => {
                      setModel(m.id);
                      if (m.id !== session.model) patch({ model: m.id });
                    }}
                    className={`h-10 md:h-11 rounded-[6px] text-[12px] md:text-[13px] font-medium leading-tight transition-colors ${
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
                      <span className="md:hidden">{m.sub}</span>
                      <span className="hidden md:inline">{m.subDesktop}</span>
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

          {/* Permission mode — 5-segment on desktop. At 390px the five labels
              (Ask / Accept / Plan / Auto / Bypass) can't fit side-by-side, so
              mobile renders as a vertical stack of clickable rows with a short
              description to the right and a checkmark on the active row. */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Permission mode
            </div>
            {/* Mobile: stacked list of rows */}
            <div className="md:hidden rounded-[8px] border border-line bg-canvas overflow-hidden divide-y divide-line">
              {MODES.map(([id, label]) => {
                const active = mode === id;
                const dim = id === "bypassPermissions" && !active;
                return (
                  <button
                    key={id}
                    disabled={archived || saving}
                    onClick={() => {
                      setMode(id);
                      if (id !== session.mode) patch({ mode: id });
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left disabled:opacity-60 ${
                      active ? "bg-paper/60" : "hover:bg-paper/40"
                    } ${dim ? "opacity-60" : ""}`}
                  >
                    <span
                      className={`shrink-0 h-4 w-4 rounded-full border flex items-center justify-center ${
                        active
                          ? "bg-ink border-ink"
                          : "border-line bg-canvas"
                      }`}
                    >
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-canvas" />
                      )}
                    </span>
                    <span className="text-[13px] font-medium w-14 shrink-0">
                      {label}
                    </span>
                    <span className="text-[12px] text-ink-muted flex-1 min-w-0">
                      {modeHint[id]}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Desktop: 5-segment control */}
            <div className="hidden md:grid grid-cols-5 gap-1.5 p-1 bg-paper border border-line rounded-[8px]">
              {MODES.map(([id, label]) => {
                const active = mode === id;
                const dim = id === "bypassPermissions" && !active;
                return (
                  <button
                    key={id}
                    disabled={archived || saving}
                    onClick={() => {
                      setMode(id);
                      if (id !== session.mode) patch({ mode: id });
                    }}
                    className={`h-9 rounded-[6px] text-[12px] font-medium ${
                      active
                        ? "bg-canvas shadow-card border border-line text-ink"
                        : "text-ink-muted"
                    } ${dim ? "opacity-60" : ""}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="hidden md:block text-[12px] text-ink-muted mt-2">
              {modeHint[mode]}
            </div>
          </div>

          {/* Workspace — read-only. Branch + worktree (or project root). */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Workspace
            </div>
            <div className="rounded-[8px] border border-line bg-canvas p-4 space-y-2.5 text-[13px]">
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  Branch
                </span>
                <span className="mono text-[12px] truncate flex items-center gap-1.5 min-w-0">
                  <GitBranch className="w-3 h-3 text-ink-muted shrink-0" />
                  <span className="truncate">
                    {session.branch ?? (
                      <span className="text-ink-faint">— none —</span>
                    )}
                  </span>
                </span>
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted w-20 shrink-0">
                  Worktree
                </span>
                <span className="mono text-[12px] truncate min-w-0">
                  {session.worktreePath ?? (
                    project?.path ? (
                      <span className="text-ink-muted">{project.path}</span>
                    ) : (
                      <span className="text-ink-faint">project root</span>
                    )
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Memory — read-only CLAUDE.md preview. Shows up to two files:
              the project-scoped CLAUDE.md (first match of `<project>/CLAUDE.md`
              or `<project>/.claude/CLAUDE.md`) and the user-global
              `~/.claude/CLAUDE.md`. Content is capped at 64 KB server-side;
              larger files are truncated with a flag. Fetched on sheet mount
              — not at Chat mount — so we only pay for it when the user
              actually opens settings. */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Memory
            </div>
            <div className="rounded-[8px] border border-line bg-canvas overflow-hidden">
              {memory === null ? (
                <div className="px-4 py-3 text-[12px] text-ink-muted">
                  Reading memory…
                </div>
              ) : memory.files.length === 0 ? (
                <div className="px-4 py-3 text-[12px] text-ink-muted">
                  No CLAUDE.md found.
                  {project?.path ? (
                    <>
                      {" "}
                      Create one at{" "}
                      <span className="mono">{project.path}/CLAUDE.md</span>.
                    </>
                  ) : null}
                </div>
              ) : (
                memory.files.map((f) => {
                  const homeDir = deriveHomeDir(memory);
                  return (
                    <div
                      key={f.path}
                      className="border-b border-line last:border-b-0"
                    >
                      <div className="flex items-center gap-2 px-4 py-2 bg-paper/50">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-line bg-canvas text-[10px] font-medium uppercase tracking-[0.1em]">
                          {f.scope}
                        </span>
                        <span className="mono text-[11px] text-ink-muted truncate flex-1">
                          {shortenPath(f.path, homeDir)}
                        </span>
                        <span className="mono text-[11px] text-ink-faint">
                          {formatBytes(f.bytes)}
                          {f.truncated ? " · truncated" : ""}
                        </span>
                      </div>
                      <div className="max-h-[240px] overflow-y-auto px-4 py-3">
                        <Markdown source={f.content} />
                      </div>
                    </div>
                  );
                })
              )}
              {memoryErr && memory !== null && memory.files.length === 0 && (
                <div className="px-4 py-2 text-[12px] text-danger border-t border-line">
                  {memoryErr}
                </div>
              )}
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
                      title={
                        g.scope === "global"
                          ? "Applies to every session"
                          : "This session only"
                      }
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
                      disabled={archived}
                      className="h-6 px-2 text-[11px] rounded-[4px] border border-line hover:bg-paper text-ink-soft hover:text-danger disabled:opacity-60"
                    >
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

          {/* Export + Archive + Delete row.
              Export is always available (even on archived sessions — you'd
              still want the transcript). Archive is reversible (row flip +
              best-effort worktree cleanup). Delete is irreversible —
              hard-drops the session row, every session_event, and any /btw
              side-chat children via FK cascade. The Delete button uses a
              two-step confirm (click → "Click again to confirm" with a 3s
              timeout) to keep an accidental tap from wiping the transcript.
              Export sits to the left as the only non-destructive action. */}
          <div className="pt-4 border-t border-line flex flex-wrap gap-2">
            <div className="relative" ref={exportMenuRef}>
              <button
                onClick={() => setExportOpen((v) => !v)}
                disabled={archiving || deleting}
                className="h-9 px-3 rounded-[8px] border border-line text-[13px] text-ink-soft hover:bg-paper disabled:opacity-60"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
              >
                Export ⌄
              </button>
              {exportOpen && (
                <div
                  role="menu"
                  className="absolute left-0 bottom-full mb-1 min-w-[160px] rounded-[8px] border border-line bg-canvas shadow-lift py-1 z-10"
                >
                  <button
                    role="menuitem"
                    onClick={() => runExport("md")}
                    className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-paper"
                  >
                    As Markdown
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => runExport("json")}
                    className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-paper"
                  >
                    As JSON
                  </button>
                </div>
              )}
            </div>
            {!archived && (
              <>
                <button
                  onClick={archive}
                  disabled={archiving || deleting}
                  className="h-9 px-3 rounded-[8px] border border-line text-[13px] text-danger hover:bg-danger-wash disabled:opacity-60"
                >
                  {archiving ? "Archiving…" : archiveLabel}
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting || archiving}
                  title="Permanently delete this session. This cannot be undone."
                  className={`h-9 px-3 rounded-[8px] text-[13px] disabled:opacity-60 ${
                    deleteConfirming
                      ? "bg-danger text-canvas border border-danger"
                      : "border border-danger/50 text-danger hover:bg-danger-wash"
                  }`}
                >
                  {deleting
                    ? "Deleting…"
                    : deleteConfirming
                      ? "Click again to confirm"
                      : "Delete session"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shorten an absolute path for display. Replaces the host's home directory
// with `~` so the CLAUDE.md header row doesn't sprawl.
//
// The browser has no reliable handle on the host's $HOME, so we derive it
// from the user-scope CLAUDE.md path when the memory response includes one:
// the server always returns that as `<home>/.claude/CLAUDE.md`. When no
// user-scope file is visible we fall back to the raw absolute path — not
// as nice, but correct and never wrong.
function shortenPath(abs: string, homeDir: string | null): string {
  if (homeDir && abs === homeDir) return "~";
  if (homeDir && abs.startsWith(homeDir + "/")) {
    return "~" + abs.slice(homeDir.length);
  }
  return abs;
}

function deriveHomeDir(memory: MemoryResponse | null): string | null {
  if (!memory) return null;
  const user = memory.files.find((f) => f.scope === "user");
  if (!user) return null;
  // Strip the trailing `/.claude/CLAUDE.md` (14 chars including leading
  // slash). Guard against a server response that doesn't follow the shape.
  const suffix = "/.claude/CLAUDE.md";
  if (user.path.endsWith(suffix)) {
    return user.path.slice(0, -suffix.length);
  }
  return null;
}
