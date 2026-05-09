import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, X } from "lucide-react";
import type { Session } from "@claudex/shared";
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

/**
 * Condensed per-session rail for the desktop Chat screen (mockup s-04,
 * lines 944–962). Lists sessions **scoped to the current project** — the
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

  // Project-scoped visible list. Memoized on [sessions, currentProjectId]
  // so clicking between sessions in the same project doesn't reshuffle.
  const visible = useMemo(() => {
    if (!current) return [] as Session[];
    return sessions.filter(
      (s) =>
        s.status !== "archived" &&
        s.projectId === current.projectId &&
        !s.parentSessionId,
    );
  }, [sessions, current]);

  // ---- Drag-to-resize ----------------------------------------------------
  const [width, setWidth] = useState<number>(() => readPersistedWidth());
  const asideRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
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
    };
    // width is read in onUp via closure; we want the CURRENT width at release.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, width]);

  // ---- Quick-create -------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <aside
      ref={asideRef}
      className={cn(
        "hidden md:flex relative border-r border-line bg-paper/40 flex-col shrink-0",
        dragging && "select-none",
      )}
      style={{ width }}
    >
      <div className="px-3 py-3 flex items-center gap-2">
        <Link
          to="/sessions"
          aria-label="Go to sessions"
          className="flex items-center gap-2 flex-1 min-w-0 -mx-1 px-1 py-0.5 rounded-[6px] hover:bg-canvas/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-klein/40"
        >
          <svg viewBox="0 0 32 32" className="w-5 h-5">
            <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
            <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
          </svg>
          <span className="mono text-[13px]">claudex</span>
        </Link>
        <span className="ml-auto mono text-[11px] text-ink-muted">
          {visible.length}
        </span>
      </div>

      <div className="px-3 pb-2 flex items-center gap-2">
        <span className="text-[12px] text-ink-soft uppercase tracking-[0.08em] font-medium">
          Sessions
        </span>
      </div>

      {/* Quick-create inline form. Stays in-rail — NOT a full sheet — so the
          user doesn't lose the transcript context. Only the first prompt is
          collected; model/mode/worktree are copied from the current session
          so the rail acts as a "same project, same setup" sibling spawner. */}
      <div className="px-3 pb-2">
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
              "w-full inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px]",
              "bg-klein text-canvas text-[12px] font-medium hover:opacity-90 disabled:opacity-50",
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
        ) : (
          <>
            {visible.map((s) => (
              <SessionRow key={s.id} session={s} active={s.id === currentId} />
            ))}
            {visible.length === 0 && (
              <div className="px-2.5 py-2 text-[12px] text-ink-muted">
                No other sessions in this project.
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-auto px-3 py-2 border-t border-line flex items-center gap-1.5 text-[11px] mono opacity-70">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            connected ? "bg-success" : "bg-ink-faint",
          )}
        />
        <span className="text-ink-soft">
          {connected ? "connected" : "offline"}
        </span>
      </div>

      {/* Resize strip — thin absolute column on the right edge. Grabbing it
          flips `dragging` true, at which point the document-level mousemove
          listener computes width from the cursor's clientX offset. The
          `select-none` class on the aside (applied while dragging) keeps
          the browser from highlighting transcript text while you drag. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sessions rail"
        onMouseDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        className={cn(
          "absolute top-0 right-0 h-full w-1 cursor-col-resize",
          "hover:bg-klein/30 transition-colors",
          dragging && "bg-klein/50",
        )}
      />
    </aside>
  );
}

function QuickCreateForm({
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

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function submit() {
    if (!current) return;
    const trimmed = prompt.trim();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.createSession({
        projectId: current.projectId,
        // Title is optional on the server; leaving it undefined lets the
        // CreateSession handler fall back to its own derivation (first-
        // prompt truncation) rather than us pre-coining a placeholder.
        title: trimmed ? trimmed.slice(0, 60) : "Untitled",
        model: current.model,
        mode: current.mode,
        // Match the Home NewSessionSheet default: no worktree unless the
        // user explicitly asks for one in the full sheet. Quick-create is
        // for "a quick peer session" — not for branching git state.
        worktree: false,
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
    <div className="rounded-[8px] border border-line bg-canvas p-2 space-y-2">
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
  // danger on error, ink-faint otherwise.
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

  // Active row: klein-wash fill + a 2px klein bar on the left. Inactive row:
  // canvas hover only. Dropping the outline+shadow "card" treatment makes the
  // list feel like one coherent rail rather than two competing surfaces.
  const baseRow =
    "block w-full text-left pl-[10px] pr-2.5 py-1.5 rounded-r-[6px] border-l-2";
  const activeCls = "bg-klein-wash/40 border-klein";
  const inactiveCls = "border-transparent hover:bg-canvas/60";

  const content = (
    <>
      <div className="flex items-center gap-1.5">
        <span className={dotTone} />
        <span
          className={cn(
            "text-[13px] font-medium truncate flex-1 min-w-0",
            !active && "text-ink-soft",
          )}
        >
          {title}
        </span>
      </div>
      <div
        className="mono text-[11px] text-ink-muted truncate mt-0.5"
        title={activityTitle}
      >
        {activityLabel}
      </div>
    </>
  );

  if (active) {
    return (
      <div className={cn(baseRow, activeCls)} aria-current="page">
        {content}
      </div>
    );
  }

  return (
    <Link to={`/session/${session.id}`} className={cn(baseRow, inactiveCls)}>
      {content}
    </Link>
  );
}
