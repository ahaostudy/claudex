import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCircle2,
  CheckCheck,
  X,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAlerts, dedupBySession } from "@/state/alerts";
import { api } from "@/api/client";
import type { Alert as AlertRow, Project } from "@claudex/shared";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Alerts screen (persisted, state-transition design — see migration 20 and
// server/src/alerts/*).
//
// Three filter tabs:
//   • All    — default landing tab; every deduped alert regardless of
//              seen/resolved state. Keeps the user from landing on a blank
//              screen when the badge says there's something to see.
//   • Unread — seenAt IS NULL (matches the badge count, but no longer
//              auto-clears on mount — the user has to either click a row
//              or hit "Mark all seen" to acknowledge).
//   • Read   — seenAt IS NOT NULL. Archival view of things the user has
//              already looked at.
//
// Per-session dedup: the list groups by sessionId and keeps only the
// latest alert per session (see dedupBySession in state/alerts). This
// avoids a chat that completes 10 turns spawning 10 separate "session
// completed" rows — the user sees one "latest" row per session, and the
// badge count tracks the same deduped view.
//
// The list is populated on mount via fetchAlerts; the useAlerts store is
// kept fresh by the `alerts_update` WS frame handler in state/sessions.
// ---------------------------------------------------------------------------

type FilterMode = "all" | "unread" | "read";

const KIND_ICON: Record<string, typeof AlertTriangle> = {
  permission_pending: AlertTriangle,
  session_error: AlertCircle,
  session_completed: CheckCircle2,
};
const KIND_TONE: Record<string, { icon: string; dot: string; dotGlow: string }> = {
  permission_pending: {
    icon: "text-warn",
    dot: "bg-warn",
    dotGlow: "0 0 0 4px rgba(217,119,6,0.18)",
  },
  session_error: {
    icon: "text-danger",
    dot: "bg-danger",
    dotGlow: "0 0 0 4px rgba(185,28,28,0.18)",
  },
  session_completed: {
    icon: "text-success",
    dot: "bg-success",
    dotGlow: "0 0 0 4px rgba(21,128,61,0.18)",
  },
};

export function AlertsScreen() {
  const alerts = useAlerts((s) => s.alerts);
  const fetchAlerts = useAlerts((s) => s.fetchAlerts);
  const markAllSeen = useAlerts((s) => s.markAllSeen);
  const markSeen = useAlerts((s) => s.markSeen);
  const dismiss = useAlerts((s) => s.dismiss);

  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<FilterMode>("all");

  useEffect(() => {
    // First paint: make sure we have the latest list. The AppShell
    // already called fetchAlerts, but the Alerts screen is also
    // reachable via direct URL so belt-and-braces.
    void fetchAlerts();
  }, [fetchAlerts]);

  // NOTE: we intentionally do NOT auto-mark-all-seen on mount anymore.
  // The old behavior cleared the badge the instant the user opened this
  // screen, which combined with a default-to-Unread filter meant the
  // user saw "red dot → open → empty list". The badge now persists until
  // the user either taps a row (markSeen on navigate) or hits the
  // explicit "Mark all seen" button.

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

  const projectLookup = useMemo(
    () => new Map(projects.map((p) => [p.id, p] as const)),
    [projects],
  );

  // Dedup once up front — the Alerts list, the tab counts, and the filter
  // slice all operate on the same deduped view so numbers match visually.
  const deduped = useMemo(() => dedupBySession(alerts), [alerts]);

  const counts = useMemo(() => {
    let unread = 0;
    let read = 0;
    for (const a of deduped) {
      if (a.seenAt === null) unread++;
      else read++;
    }
    return { all: deduped.length, unread, read };
  }, [deduped]);

  const filtered = useMemo(() => {
    if (mode === "unread") return deduped.filter((a) => a.seenAt === null);
    if (mode === "read") return deduped.filter((a) => a.seenAt !== null);
    return deduped;
  }, [deduped, mode]);

  return (
    <AppShell tab="alerts">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Alerts</div>
          <h1 className="display text-[1.25rem] leading-tight mt-0.5">
            Needs attention
          </h1>
        </div>
        <span className="ml-auto mono text-[11px] text-ink-muted">
          {deduped.length === 0 ? "none" : `${deduped.length} total`}
        </span>
      </header>

      {/* Filter tabs — All / Unread / Read */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-line bg-paper/30 overflow-x-auto no-scrollbar">
        <FilterChip
          label="All"
          count={counts.all}
          active={mode === "all"}
          onClick={() => setMode("all")}
        />
        <FilterChip
          label="Unread"
          count={counts.unread}
          active={mode === "unread"}
          onClick={() => setMode("unread")}
        />
        <FilterChip
          label="Read"
          count={counts.read}
          active={mode === "read"}
          onClick={() => setMode("read")}
        />
        {counts.unread > 0 && (
          <button
            type="button"
            onClick={() => void markAllSeen()}
            className="ml-auto shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] text-ink-soft hover:bg-paper"
            aria-label="Mark all alerts as seen"
          >
            <CheckCheck className="w-3 h-3" />
            Mark all seen
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <section className="flex-1 min-h-0 flex items-center justify-center px-6 py-10">
          <div className="max-w-[42ch] text-center">
            <div className="inline-flex h-10 w-10 rounded-full bg-paper border border-line items-center justify-center mb-3">
              <Bell className="w-4 h-4 text-ink-muted" />
            </div>
            <div className="display text-[1.25rem] mb-1">
              {mode === "unread"
                ? "No unread alerts."
                : mode === "read"
                  ? "Nothing read yet."
                  : "No alerts yet."}
            </div>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              Permission prompts, session errors, and turn-completions while
              you're elsewhere will land here.
            </p>
          </div>
        </section>
      ) : (
        <section className="flex-1 min-h-0 overflow-y-auto">
          <ul>
            {filtered.map((alert) => (
              <li key={alert.id}>
                <AlertRowView
                  alert={alert}
                  project={
                    alert.projectId
                      ? projectLookup.get(alert.projectId) ?? null
                      : null
                  }
                  onSeen={() => void markSeen(alert.id)}
                  onDismiss={() => void dismiss(alert.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] whitespace-nowrap",
        active
          ? "bg-ink text-canvas border-ink"
          : "bg-canvas text-ink-soft border-line",
      )}
    >
      {label}
      <span className={cn("mono text-[11px]", active ? "opacity-70" : "text-ink-muted")}>
        {count}
      </span>
    </button>
  );
}

function AlertRowView({
  alert,
  project,
  onSeen,
  onDismiss,
}: {
  alert: AlertRow;
  project: Project | null;
  onSeen: () => void;
  onDismiss: () => void;
}) {
  const Icon = KIND_ICON[alert.kind] ?? Bell;
  const tone = KIND_TONE[alert.kind] ?? KIND_TONE.session_completed;
  const rel = formatRel(alert.createdAt);
  const projectName =
    project?.name ?? (alert.projectId ? alert.projectId.slice(0, 8) : "—");

  const seen = alert.seenAt !== null;
  const resolved = alert.resolvedAt !== null;

  const href = alert.sessionId ? `/session/${alert.sessionId}` : "#";

  const body =
    alert.body ??
    (alert.kind === "permission_pending"
      ? "Needs your approval"
      : alert.kind === "session_error"
        ? "Session errored — tap for details"
        : "Turn finished — tap to review");

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 border-b border-line hover:bg-paper/40",
        resolved && "opacity-75",
      )}
    >
      <Link
        to={href}
        onClick={() => {
          // Tap-to-navigate also acknowledges the alert. This is how the
          // badge drains as the user works through the list — clicking a
          // row flips it to "seen" server-side and decrements the badge
          // by one. Much better than the old "auto mark all seen on
          // mount" which hid the content before the user could read it.
          if (!seen) onSeen();
        }}
        className="flex items-center gap-3 min-w-0 flex-1"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            tone.dot,
            resolved && "opacity-50",
          )}
          style={resolved ? undefined : { boxShadow: tone.dotGlow }}
        />
        <Icon
          className={cn(
            "w-4 h-4 shrink-0",
            tone.icon,
            resolved && "opacity-60",
          )}
        />
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-[14px] truncate flex items-center gap-2",
              seen ? "font-normal text-ink-muted" : "font-medium",
            )}
          >
            <span className="truncate">{alert.title || "Untitled"}</span>
            {seen && !resolved && (
              <span className="shrink-0 mono text-[10px] uppercase tracking-[0.08em] text-ink-faint border border-line rounded px-1 py-0.5">
                seen
              </span>
            )}
            {resolved && (
              <span className="shrink-0 mono text-[10px] uppercase tracking-[0.08em] text-ink-faint border border-line rounded px-1 py-0.5">
                resolved
              </span>
            )}
          </div>
          <div
            className={cn(
              "text-[12px] truncate",
              seen ? "text-ink-faint" : "text-ink-muted",
            )}
          >
            {body}
          </div>
        </div>
        <div className="text-right shrink-0 hidden sm:block">
          <div
            className={cn(
              "mono text-[12px] truncate max-w-[160px]",
              seen ? "text-ink-faint" : "text-ink-soft",
            )}
          >
            {projectName}
          </div>
          <div
            className={cn(
              "text-[11px]",
              seen ? "text-ink-faint" : "text-ink-muted",
            )}
          >
            {rel}
          </div>
        </div>
        <div className="text-right shrink-0 sm:hidden">
          <div
            className={cn(
              "text-[11px]",
              seen ? "text-ink-faint" : "text-ink-muted",
            )}
          >
            {rel}
          </div>
        </div>
      </Link>
      {!resolved && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
          className="shrink-0 h-7 w-7 rounded-full hover:bg-paper flex items-center justify-center text-ink-muted"
          aria-label="Dismiss alert"
          title="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

function formatRel(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((now - then) / 1000));
  if (diff < 3) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
