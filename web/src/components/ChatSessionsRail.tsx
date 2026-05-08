import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { Session } from "@claudex/shared";
import { useSessions } from "@/state/sessions";
import { cn } from "@/lib/cn";

/**
 * Condensed per-session rail for the desktop Chat screen (mockup s-04,
 * lines 944–962). Lists the user's non-archived sessions with the active
 * one highlighted as a "card", others as hover-only rows. Intentionally
 * narrow (220px) — this is NOT the AppShell global sidebar.
 *
 * Hidden below `md:` (mobile keeps the existing single-panel layout).
 */
export function ChatSessionsRail({ currentId }: { currentId: string }) {
  const { sessions, refreshSessions, connected } = useSessions();

  // Refresh the list once on mount so the rail is populated even if Home
  // was never visited this session. Subsequent live status updates arrive
  // via the global WS channel the sessions store already subscribes to.
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  const visible = sessions.filter((s) => s.status !== "archived");

  return (
    <aside className="hidden md:flex border-r border-line bg-paper/40 flex-col w-[220px] shrink-0">
      <div className="p-4 flex items-center gap-2">
        <svg viewBox="0 0 32 32" className="w-5 h-5">
          <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
          <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
        </svg>
        <span className="mono text-[13px]">claudex</span>
        <span className="ml-auto mono text-[11px] text-ink-muted">
          {visible.length}
        </span>
      </div>
      <div className="px-3 caps text-ink-muted mb-2">Sessions</div>
      <div className="px-2 space-y-1 overflow-y-auto flex-1 min-h-0">
        {visible.map((s) => (
          <SessionRow key={s.id} session={s} active={s.id === currentId} />
        ))}
        {visible.length === 0 && (
          <div className="px-2.5 py-2 text-[12px] text-ink-muted">
            No sessions yet.
          </div>
        )}
      </div>
      <div className="mt-auto p-4 border-t border-line text-[11px] text-ink-muted mono">
        {connected ? "connected" : "offline · retrying"}
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  active,
}: {
  session: Session;
  active: boolean;
}) {
  const statusDot = cn(
    "h-1.5 w-1.5 rounded-full shrink-0",
    session.status === "running" && "bg-success",
    session.status === "awaiting" && "bg-warn",
    session.status === "idle" && "bg-ink-faint",
    session.status === "error" && "bg-danger",
    session.status === "archived" && "bg-line-strong",
  );
  const rawBranch = session.branch?.trim();
  const branch = rawBranch && rawBranch !== "-" ? rawBranch : null;
  const title = session.title || "Untitled";

  if (active) {
    return (
      <div className="px-2.5 py-2 rounded-[6px] bg-canvas border border-line shadow-card">
        <div className="flex items-center gap-1.5">
          <span className={statusDot} />
          <span className="text-[12px] font-medium truncate">{title}</span>
        </div>
        {branch && (
          <div className="mono text-[10px] text-ink-muted mt-0.5 truncate">
            claude/{branch}
          </div>
        )}
      </div>
    );
  }

  return (
    <Link
      to={`/session/${session.id}`}
      className="block w-full text-left px-2.5 py-2 rounded-[6px] hover:bg-canvas/60"
    >
      <div className="flex items-center gap-1.5">
        <span className={statusDot} />
        <span className="text-[12px] truncate">{title}</span>
      </div>
      {branch && (
        <div className="mono text-[10px] text-ink-muted mt-0.5 truncate">
          claude/{branch}
        </div>
      )}
    </Link>
  );
}
