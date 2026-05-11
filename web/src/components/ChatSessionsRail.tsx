import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import type { PermissionMode, Session } from "@claudex/shared";
import { Logo } from "@/components/Logo";
import { useSessions } from "@/state/sessions";
import { api, ApiError } from "@/api/client";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import { toast } from "@/lib/toast";

// Persist the user's chosen rail width across reloads. Bounded to keep the
// Chat center column sane (below 180px the rail is unreadable; above 480px
// it steals too much room from the transcript).
const WIDTH_KEY = "claudex:chatRailWidth";
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 220;

function readPersistedWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

// Inline utility for the mockup's `.caps` class (uppercase, tight tracking,
// 11px). The webapp CSS doesn't ship `.caps` globally, so we reconstruct it
// here with Tailwind so the rail matches s-04 exactly without a global add.
const CAPS_CLS =
  "uppercase tracking-[0.14em] text-[11px] font-medium";

/**
 * Condensed per-session rail for the desktop Chat screen (mockup s-04,
 * lines 943–962). Lists sessions **scoped to the current project** — the
 * same-project rail is how we keep the sidebar focused on the conversation
 * the user is actually in, rather than replaying the full Home list.
 *
 * Also hosts an inline "+ New session" quick-create affordance and a
 * drag-to-resize strip on the right edge. Width is persisted to
 * localStorage (`claudex:chatRailWidth`) between 180px and 480px.
 *
 * Hidden below `md:` (mobile keeps the existing single-panel layout).
 */
export function ChatSessionsRail({ currentId }: { currentId: string }) {
  const sessions = useSessions((s) => s.sessions);
  const refreshSessions = useSessions((s) => s.refreshSessions);
  const connected = useSessions((s) => s.connected);
  const navigate = useNavigate();

  // Refresh the list once on mount so the rail is populated even if Home
  // was never visited this session. Subsequent live status updates arrive
  // via the global WS channel the sessions store already subscribes to.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Current session drives the project scope. When it hasn't loaded yet
  // (fresh navigation, no sessions in store) we render a Loading state
  // rather than showing the full cross-project list and then flickering.
  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );

  // Project-scoped visible list. Sorted pinned-first, then by the same
  // "last activity" key the row renders (`lastMessageAt ?? updatedAt`) so
  // the displayed timestamp and the row's position agree — sorting by
  // `updatedAt` alone while showing `lastMessageAt ?? updatedAt` made
  // the list look random whenever a non-message mutation (rename, mode
  // flip, pin toggle) had bumped `updatedAt` past a session's last
  // message. Memoized on [sessions, currentProjectId] so clicking between
  // sessions in the same project doesn't reshuffle for free but live
  // store updates do.
  const visible = useMemo(() => {
    if (!current) return [] as Session[];
    const filtered = sessions.filter(
      (s) =>
        s.status !== "archived" &&
        s.projectId === current.projectId &&
        !s.parentSessionId,
    );
    const sortKey = (s: Session) =>
      Date.parse(s.lastMessageAt ?? s.updatedAt) || 0;
    return filtered.sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return sortKey(b) - sortKey(a);
    });
  }, [sessions, current]);

  // Group the already-sorted list into time buckets so a long rail stays
  // scannable. Pinned rows always come first (under a "Pinned" header) so
  // they're visually distinct from "just updated"; everything else falls
  // into Last hour / Today / This week / This month / Older by how long
  // ago `updatedAt` was. Empty buckets are dropped entirely — we never
  // render an empty header.
  //
  // A small rolling-minute tick (`nowTick`) re-buckets rows whose
  // "Last hour" label just expired so the group headers stay correct
  // without waiting for the next server frame.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const groups = useMemo(() => {
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    const WEEK = 7 * DAY;
    const MONTH = 30 * DAY;
    const pinned: Session[] = [];
    const lastHour: Session[] = [];
    const today: Session[] = [];
    const thisWeek: Session[] = [];
    const thisMonth: Session[] = [];
    const older: Session[] = [];
    for (const s of visible) {
      if (s.pinned) {
        pinned.push(s);
        continue;
      }
      const activityIso = s.lastMessageAt ?? s.updatedAt;
      const delta = nowTick - (Date.parse(activityIso) || 0);
      if (delta < HOUR) lastHour.push(s);
      else if (delta < DAY) today.push(s);
      else if (delta < WEEK) thisWeek.push(s);
      else if (delta < MONTH) thisMonth.push(s);
      else older.push(s);
    }
    const out: Array<{ key: string; label: string; sessions: Session[] }> = [];
    if (pinned.length) out.push({ key: "pinned", label: "Pinned", sessions: pinned });
    if (lastHour.length) out.push({ key: "hour", label: "Last hour", sessions: lastHour });
    if (today.length) out.push({ key: "today", label: "Today", sessions: today });
    if (thisWeek.length) out.push({ key: "week", label: "This week", sessions: thisWeek });
    if (thisMonth.length) out.push({ key: "month", label: "This month", sessions: thisMonth });
    if (older.length) out.push({ key: "older", label: "Older", sessions: older });
    return out;
  }, [visible, nowTick]);

  // ---- Drag-to-resize ----------------------------------------------------
  const [width, setWidth] = useState<number>(() => readPersistedWidth());
  const asideRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // Freeze text selection on the whole document while dragging. Without
    // this the browser highlights transcript content as the cursor sweeps
    // across the center column. Restored in the cleanup below.
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const aside = asideRef.current;
      if (!aside) return;
      const left = aside.getBoundingClientRect().left;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, ev.clientX - left));
      setWidth(next);
    };
    const onUp = () => {
      setDragging(false);
      // Persist once on release — writing every mousemove would be churn.
      try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        /* quota / disabled storage — fall back to session-only width. */
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
    };
    // width is read in onUp via closure; we want the CURRENT width at release.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, width]);

  // ---- Quick-create -------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <aside
      ref={asideRef}
      className="hidden md:flex relative border-r border-line bg-paper/40 flex-col shrink-0"
      style={{ width }}
    >
      {/* Header block — mirrors mockup s-04 line 945: logo + mono wordmark +
          right-aligned count pill. Click goes to /sessions (global list). */}
      <div className="p-4 flex items-center gap-2">
        <Link
          to="/sessions"
          aria-label="Go to sessions"
          className="flex items-center gap-2 flex-1 min-w-0 -mx-1 px-1 py-0.5 rounded-[6px] hover:bg-canvas/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-klein/40"
        >
          <Logo className="w-5 h-5 shrink-0" />
          <span className="mono text-[13px] font-bold truncate">Claudex</span>
        </Link>
        <span className="ml-auto text-[11px] mono text-ink-muted">
          {visible.length}
        </span>
      </div>

      {/* Caps "Sessions" label — mockup uses px-3, we do too. Soft muted
          because the active session title below is the eye-anchor. */}
      <div className={cn("px-3", CAPS_CLS, "text-ink-muted mb-2")}>
        Sessions
      </div>

      {/* Quick-create affordance. Dashed-border trigger reads as "this will
          add a new thing" without the loud solid-fill of a primary CTA; the
          transcript is the primary surface and this rail is subordinate. */}
      <div className="px-2 pb-2">
        {createOpen ? (
          <QuickCreateForm
            current={current}
            onCancel={() => setCreateOpen(false)}
            onCreated={(id) => {
              setCreateOpen(false);
              navigate(`/session/${id}`);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            disabled={!current}
            className={cn(
              "w-full flex items-center justify-center gap-1.5 h-8 rounded-[6px]",
              "border border-dashed border-line-strong text-ink-muted",
              "hover:bg-canvas/60 hover:text-ink-soft hover:border-ink-faint",
              "text-[12px] disabled:opacity-50 transition-colors",
            )}
            title={
              current ? "New session in this project" : "Loading current session…"
            }
          >
            <Plus className="w-3.5 h-3.5" />
            New session
          </button>
        )}
      </div>

      <div className="px-2 space-y-1 overflow-y-auto flex-1 min-h-0">
        {!current ? (
          <div className="px-2.5 py-2 text-[12px] text-ink-muted mono">
            Loading…
          </div>
        ) : visible.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-ink-muted">
            No other sessions in this project.
          </div>
        ) : (
          groups.map((g, idx) => (
            <div key={g.key} className={cn("space-y-1", idx > 0 && "pt-2")}>
              {/* Bucket header — muted caps label that mirrors the
                  "Sessions" title styling so the rail feels like one
                  layered index instead of a flat list. First group's
                  header is flush against the "+ New session" button;
                  subsequent groups get a small gap via `pt-2` above. */}
              <div
                className={cn(
                  "px-2.5",
                  CAPS_CLS,
                  "text-ink-faint",
                )}
              >
                {g.label}
              </div>
              {g.sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === currentId}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* Footer — mockup uses `mt-auto p-4 border-t border-line text-[11px]
          text-ink-muted mono`. We add a tiny status dot in front to hint at
          the live WS connection state the user otherwise can't see. */}
      <div className="mt-auto p-4 border-t border-line text-[11px] text-ink-muted mono flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full shrink-0",
            connected ? "bg-success" : "bg-ink-faint",
          )}
        />
        <span>{connected ? "connected" : "offline"}</span>
      </div>

      {/* Resize strip — 1px invisible column; a subtle hover tint is the
          only affordance, which is enough once the cursor flips to
          col-resize. `active:bg-klein/40` brightens it while the drag is
          live so the user can tell the handle "grabbed". */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sessions rail"
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        className={cn(
          "absolute right-0 top-0 bottom-0 w-1 cursor-col-resize",
          "hover:bg-line/60 transition-colors",
          dragging && "bg-klein/40",
        )}
      />
    </aside>
  );
}

export function QuickCreateForm({
  current,
  onCancel,
  onCreated,
}: {
  current: Session | null;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Default the new session's permission mode to whatever the current session
  // is running under — matches the ergonomics of the old inherit-mode path
  // while letting the user override before spawning. Falls back to "default"
  // if `current` hasn't loaded yet (button is disabled in that case anyway).
  const [mode, setMode] = useState<PermissionMode>(
    current?.mode ?? "default",
  );
  // Worktree opt-in for the peer session. The user runs multiple agents in
  // parallel against this project, so defaulting to ON (when the project is
  // a git repo) gives each session its own checkout instead of racing on
  // the shared cwd. `projectIsGit` is looked up from /api/projects lazily
  // on mount; while it's null we optimistically assume git — if the server
  // rejects with `not_a_git_repo` the toast carries it up.
  const [projectIsGit, setProjectIsGit] = useState<boolean | null>(null);
  const [worktree, setWorktree] = useState<boolean>(true);
  const [userTouchedWorktree, setUserTouchedWorktree] = useState(false);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Resolve the project's git-ness from the list endpoint. If the current
  // session already has a worktreePath we know the project is a git repo
  // and can skip the network hop — worktrees are only created on git repos.
  useEffect(() => {
    if (!current) return;
    if (current.worktreePath) {
      setProjectIsGit(true);
      return;
    }
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (cancelled) return;
        const proj = r.projects.find((p) => p.id === current.projectId);
        setProjectIsGit(proj?.isGitRepo ?? false);
      })
      .catch(() => {
        if (!cancelled) setProjectIsGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

  // Apply the git-based default once resolved — but only if the user
  // hasn't flipped the checkbox themselves.
  useEffect(() => {
    if (userTouchedWorktree) return;
    if (projectIsGit === null) return;
    setWorktree(projectIsGit);
  }, [projectIsGit, userTouchedWorktree]);

  async function submit() {
    if (!current) return;
    const trimmed = prompt.trim();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createSession({
        projectId: current.projectId,
        // Title is secondary in the quick-create flow — users almost never
        // type one here. Derive from the first prompt when present, otherwise
        // "Untitled"; the server/UI will still show a friendly name based on
        // the first message anyway.
        title: trimmed ? trimmed.slice(0, 60) : "Untitled",
        model: current.model,
        mode,
        worktree: worktree && projectIsGit !== false,
        initialPrompt: trimmed || undefined,
      });
      onCreated(res.session.id);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "create_failed";
      setErr(code);
      toast(`Create failed: ${code}`);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[6px] border border-line bg-canvas p-2 space-y-2">
      <textarea
        ref={textareaRef}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="First prompt (optional)…"
        rows={2}
        className="w-full resize-none bg-paper border border-line rounded-[6px] p-2 text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-klein/60"
      />
      {/* Compact permission-mode segmented control. Mirrors the NewSessionSheet
          control from Home, shrunk to fit the rail (h-7, 11px labels). Title
          is intentionally omitted from this form — it's a low-value field at
          this entry point and pushed to the full sheet on Home instead. */}
      <div className="grid grid-cols-4 gap-0.5 p-0.5 bg-paper border border-line rounded-[6px]">
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
            type="button"
            onClick={() => setMode(id)}
            disabled={busy}
            className={cn(
              "h-7 rounded-[4px] text-[11px] font-medium transition-colors",
              mode === id
                ? "bg-canvas shadow-card border border-line text-ink"
                : "text-ink-muted hover:text-ink-soft",
            )}
            title={`Permission mode: ${label}`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* Worktree toggle — compact variant of the Home NewSessionSheet row.
          Disabled when we know the project isn't a git repo (projectIsGit
          resolved to false). While still resolving (null), kept enabled so
          an eager ⌘⏎ doesn't hit a spurious disabled state. */}
      <label
        className={cn(
          "flex items-center gap-2 px-1.5 py-1 rounded-[4px] text-[11px]",
          projectIsGit === false
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:bg-paper",
        )}
        title={
          projectIsGit === false
            ? "Project isn't a git repo — worktree unavailable."
            : "Spawn on a new claude/<slug> branch so this peer session stays off the main checkout."
        }
      >
        <input
          type="checkbox"
          checked={worktree && projectIsGit !== false}
          disabled={busy || projectIsGit === false}
          onChange={(e) => {
            setUserTouchedWorktree(true);
            setWorktree(e.target.checked);
          }}
          className="h-3 w-3"
        />
        <span className={projectIsGit === false ? "text-ink-faint" : "text-ink-soft"}>
          Use git worktree
        </span>
      </label>
      {err && (
        <div className="text-[11px] text-danger mono truncate">{err}</div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel"
          className="h-7 w-7 rounded-[6px] border border-line bg-paper text-ink-soft flex items-center justify-center hover:bg-canvas disabled:opacity-50"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !current}
          className="ml-auto h-7 px-3 rounded-[6px] bg-ink text-canvas text-[12px] font-medium disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
}: {
  session: Session;
  active: boolean;
}) {
  // Status dot mirrors Home: warn on awaiting, pulsing success on running,
  // danger on error, klein-pulse for detected external CLI, ink-faint for
  // idle, line-strong for archived (hidden in this rail but kept for parity).
  const dotTone = cn(
    "h-1.5 w-1.5 rounded-full shrink-0",
    session.status === "running" && "bg-success animate-pulse",
    session.status === "cli_running" && "bg-klein animate-pulse",
    session.status === "awaiting" && "bg-warn",
    session.status === "idle" && "bg-ink-faint",
    session.status === "error" && "bg-danger",
    session.status === "archived" && "bg-line-strong",
  );
  const title = session.title || "Untitled";
  const activityIso = session.lastMessageAt ?? session.updatedAt;
  const activityLabel = timeAgoShort(activityIso);
  const activityTitle = new Date(activityIso).toLocaleString();
  // Single-word status echo so the mono meta line doubles as a legend for
  // the dot: "running", "awaiting", "error". Skips idle/archived (the
  // neutral dot + timestamp is already self-evident there).
  const statusWord =
    session.status === "running" ||
    session.status === "cli_running" ||
    session.status === "awaiting" ||
    session.status === "error"
      ? session.status === "cli_running"
        ? "cli"
        : session.status
      : null;

  // Active row mirrors mockup s-04 line 948: a lifted card with canvas bg,
  // 1px line border, and shadow-card. No klein wash — the shadow + border
  // already separates it from the rail's paper/40 backdrop. Inactive rows
  // are truly flat (no border, transparent bg) with a canvas/60 hover.
  const rowBase = "block w-full text-left px-2.5 py-2 rounded-[6px]";
  const activeCls = "bg-canvas border border-line shadow-card";
  const inactiveCls = "hover:bg-canvas/60";

  const content = (
    <>
      <div className="flex items-center gap-1.5">
        <span className={dotTone} />
        <span
          className={cn(
            "text-[12px] truncate flex-1 min-w-0",
            active ? "font-medium text-ink" : "text-ink-soft",
          )}
        >
          {title}
        </span>
      </div>
      {/* Last sent user message preview — one line, ellipsis-truncated.
          Same data source as the Home row (server seeds via
          SESSION_SELECT_COLS; web store mirrors on `user_message` WS
          frames). Rail is narrow, so this sits at 11px to stay visually
          subordinate to the title. Rendered only when a prior user
          message exists. */}
      {session.lastUserMessage && (
        <div
          className={cn(
            "text-[11px] truncate mt-0.5",
            active ? "text-ink-soft" : "text-ink-muted",
          )}
        >
          {session.lastUserMessage}
        </div>
      )}
      <div
        className="mono text-[10px] text-ink-muted mt-0.5 truncate"
        title={activityTitle}
      >
        {statusWord ? `${activityLabel} · ${statusWord}` : activityLabel}
      </div>
    </>
  );

  if (active) {
    return (
      <div className={cn(rowBase, activeCls)} aria-current="page">
        {content}
      </div>
    );
  }

  return (
    <Link to={`/session/${session.id}`} className={cn(rowBase, inactiveCls)}>
      {content}
    </Link>
  );
}
