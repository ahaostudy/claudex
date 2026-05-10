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
import { useAlerts } from "@/state/alerts";
import { api } from "@/api/client";
import type { Alert as AlertRow, Project } from "@claudex/shared";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Alerts screen (persisted, state-transition design — see migration 20 and
// server/src/alerts/*).
//
// Three filter tabs:
//   • Unread — seenAt IS NULL (the badge count; what the user hasn't
//     looked at yet)
//   • Active — resolvedAt IS NULL (the underlying condition is still
//     happening — permission still pending, session still errored)
//   • All    — everything, seen or resolved or both. Archival view.
//
// The list is populated on mount via fetchAlerts; the useAlerts store is
// kept fresh by the `alerts_update` WS frame handler in state/sessions.
// We also auto-mark-all-seen on mount so the badge drops to zero the
// moment the user opens this screen — matches the user's mental model
// of "I looked at the inbox".
// ---------------------------------------------------------------------------

type FilterMode = "unread" | "active" | "all";

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
  const dismiss = useAlerts((s) => s.dismiss);

  const [projects, setProjects] = useState<Project[]>([]);
  const [mode, setMode] = useState<FilterMode>("unread");

  useEffect(() => {
    // First paint: make sure we have the latest list. The AppShell
    // already called fetchAlerts, but the Alerts screen is also
    // reachable via direct URL so belt-and-braces.
    void fetchAlerts();
  }, [fetchAlerts]);

  // On mount, clear the badge by marking all currently-unseen alerts as
  // seen. This runs once per Alerts-screen visit — new alerts that arrive
  // while the user is on the screen will flip the badge back up, which
  // is the right UX (user is still looking, but there's a fresh thing).
  useEffect(() => {
    const hasUnseen = alerts.some((a) => a.seenAt === null);
    if (hasUnseen) void markAllSeen();
    // intentionally one-shot per mount: no dep on `alerts`, otherwise we
    // re-fire on every list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const counts = useMemo(() => {
    let unread = 0;
    let active = 0;
    for (const a of alerts) {
      if (a.seenAt === null) unread++;
      if (a.resolvedAt === null) active++;
    }
    return { unread, active, all: alerts.length };
  }, [alerts]);

  const filtered = useMemo(() => {
    if (mode === "unread") return alerts.filter((a) => a.seenAt === null);
    if (mode === "active") return alerts.filter((a) => a.resolvedAt === null);
    return alerts;
  }, [alerts, mode]);

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
          {alerts.length === 0 ? "none" : `${alerts.length} total`}
        </span>
      </header>

      {/* Filter tabs — three buckets, counts shown inline */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-2 border-b border-line bg-paper/30 overflow-x-auto no-scrollbar">
        <FilterChip
          label="Unread"
          count={counts.unread}
          active={mode === "unread"}
          onClick={() => setMode("unread")}
        />
        <FilterChip
          label="Active"
          count={counts.active}
          active={mode === "active"}
          onClick={() => setMode("active")}
        />
        <FilterChip
          label="All"
          count={counts.all}
          active={mode === "all"}
          onClick={() => setMode("all")}
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
                : mode === "active"
                  ? "Nothing active."
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
  onDismiss,
}: {
  alert: AlertRow;
  project: Project | null;
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
      <Link to={href} className="flex items-center gap-3 min-w-0 flex-1">
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
