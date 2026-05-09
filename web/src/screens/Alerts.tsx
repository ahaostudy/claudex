import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, Bell, CheckCircle2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type { Project, Session } from "@claudex/shared";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Alerts screen (mockup s-02 tab-bar badge, lines 434–435).
//
// Three buckets, per session, in this order:
//   1. `awaiting`  — claude is blocked on a user action (permission prompt).
//   2. `error`     — session hit a terminal failure.
//   3. completed   — turn finished while the user was elsewhere. Sourced
//      from the sessions-store `completions` map (per-session latest,
//      cleared when the user opens the session).
//
// Tap a row to jump into the chat. All state is client-derived from the
// live sessions store (WS-backed) so flips here reflect automatically.
// ---------------------------------------------------------------------------

type CompletionEntry = {
  session: Session;
  status: "idle" | "error";
  at: string;
  seen: boolean;
};

export function AlertsScreen() {
  const { sessions, completions } = useSessions();
  const [projects, setProjects] = useState<Project[]>([]);

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
  const sessionLookup = useMemo(
    () => new Map(sessions.map((s) => [s.id, s] as const)),
    [sessions],
  );

  // Bucket 1–2: awaiting + error, sorted awaiting-first then error, newest
  // within each. Side-chat children are excluded — their parent surfaces
  // the user's attention already.
  const attentionAlerts = useMemo(() => {
    const out = sessions.filter(
      (s) =>
        !s.parentSessionId && (s.status === "awaiting" || s.status === "error"),
    );
    const statusRank = (s: Session) =>
      s.status === "awaiting" ? 0 : s.status === "error" ? 1 : 2;
    const timeKey = (s: Session) =>
      Date.parse(s.lastMessageAt ?? s.updatedAt) || 0;
    out.sort((a, b) => {
      const r = statusRank(a) - statusRank(b);
      if (r !== 0) return r;
      return timeKey(b) - timeKey(a);
    });
    return out;
  }, [sessions]);

  // Bucket 3: recently-completed — sessions whose latest status transition
  // into idle/error fired a completion signal. Unseen entries are the
  // "fresh" signals; seen entries stick around as archival rows (demoted
  // styling) so the user can still click back into them. We de-dup
  // against the awaiting/error bucket so an errored session isn't listed
  // twice.
  const completionAlerts = useMemo<CompletionEntry[]>(() => {
    const attentionIds = new Set(attentionAlerts.map((s) => s.id));
    const out: CompletionEntry[] = [];
    for (const [sid, entry] of Object.entries(completions)) {
      if (attentionIds.has(sid)) continue;
      const session = sessionLookup.get(sid);
      if (!session) continue;
      if (session.parentSessionId) continue;
      out.push({
        session,
        status: entry.status,
        at: entry.at,
        seen: entry.seen,
      });
    }
    // Unseen first (by at desc), then seen (by at desc). A globally-newest
    // seen row should NOT leapfrog an older unseen row — the user's pending
    // signals always win the top slots.
    out.sort((a, b) => {
      if (a.seen !== b.seen) return a.seen ? 1 : -1;
      return Date.parse(b.at) - Date.parse(a.at);
    });
    return out;
  }, [completions, sessionLookup, attentionAlerts]);

  const unseenCompletions = completionAlerts.filter((e) => !e.seen);
  const seenCompletions = completionAlerts.filter((e) => e.seen);

  // Badge mirrors AppShell: only unseen entries count toward the open total.
  const totalCount = attentionAlerts.length + unseenCompletions.length;

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
          {totalCount === 0 ? "none" : `${totalCount} open`}
        </span>
      </header>

      {totalCount === 0 ? (
        <section className="flex-1 min-h-0 flex items-center justify-center px-6 py-10">
          <div className="max-w-[42ch] text-center">
            <div className="inline-flex h-10 w-10 rounded-full bg-paper border border-line items-center justify-center mb-3">
              <Bell className="w-4 h-4 text-ink-muted" />
            </div>
            <div className="display text-[1.25rem] mb-1">No alerts.</div>
            <p className="text-[13px] text-ink-muted leading-relaxed">
              You'll see sessions that need permission here, errors, and
              sessions that finish while you're on another screen.
            </p>
          </div>
        </section>
      ) : (
        <section className="flex-1 min-h-0 overflow-y-auto">
          {attentionAlerts.length > 0 && (
            <BucketHeader
              label="Needs attention"
              count={attentionAlerts.length}
            />
          )}
          <ul>
            {attentionAlerts.map((s) => (
              <li key={s.id}>
                <AlertRow
                  session={s}
                  project={projectLookup.get(s.projectId) ?? null}
                />
              </li>
            ))}
          </ul>
          {unseenCompletions.length > 0 && (
            <BucketHeader
              label="Recently completed"
              count={unseenCompletions.length}
            />
          )}
          <ul>
            {unseenCompletions.map((e) => (
              <li key={e.session.id}>
                <CompletionRow
                  entry={e}
                  project={projectLookup.get(e.session.projectId) ?? null}
                />
              </li>
            ))}
          </ul>
          {seenCompletions.length > 0 && (
            <BucketHeader
              label="Earlier (seen)"
              count={seenCompletions.length}
            />
          )}
          <ul>
            {seenCompletions.map((e) => (
              <li key={e.session.id}>
                <CompletionRow
                  entry={e}
                  project={projectLookup.get(e.session.projectId) ?? null}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}

function BucketHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="px-4 pt-3 pb-1.5 flex items-center gap-2 border-b border-line/60 bg-paper/30">
      <span className="caps text-ink-muted">{label}</span>
      <span className="mono text-[11px] text-ink-muted">{count}</span>
    </div>
  );
}

function AlertRow({
  session,
  project,
}: {
  session: Session;
  project: Project | null;
}) {
  const isAwaiting = session.status === "awaiting";
  const Icon = isAwaiting ? AlertTriangle : AlertCircle;
  const iconClass = isAwaiting ? "text-warn" : "text-danger";
  const dotClass = isAwaiting ? "bg-warn" : "bg-danger";
  const dotGlow = isAwaiting
    ? "0 0 0 4px rgba(217,119,6,0.18)"
    : "0 0 0 4px rgba(185,28,28,0.18)";
  const subtitle = isAwaiting
    ? "Needs your approval"
    : "Session errored — tap for details";
  const rel = formatRel(session.lastMessageAt ?? session.updatedAt);
  const projectName = project?.name ?? session.projectId.slice(0, 8);

  return (
    <Link
      to={`/session/${session.id}`}
      className="flex items-center gap-3 px-4 py-3 border-b border-line hover:bg-paper/40 cursor-pointer"
    >
      <span
        className={cn("h-2 w-2 rounded-full shrink-0", dotClass)}
        style={{ boxShadow: dotGlow }}
      />
      <Icon className={cn("w-4 h-4 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium truncate">
          {session.title || "Untitled"}
        </div>
        <div className="text-[12px] text-ink-muted truncate">{subtitle}</div>
      </div>
      <div className="text-right shrink-0 hidden sm:block">
        <div className="mono text-[12px] text-ink-soft truncate max-w-[160px]">
          {projectName}
        </div>
        <div className="text-[11px] text-ink-muted">{rel}</div>
      </div>
      <div className="text-right shrink-0 sm:hidden">
        <div className="text-[11px] text-ink-muted">{rel}</div>
      </div>
    </Link>
  );
}

function CompletionRow({
  entry,
  project,
}: {
  entry: CompletionEntry;
  project: Project | null;
}) {
  const isError = entry.status === "error";
  const Icon = isError ? AlertCircle : CheckCircle2;
  const iconClass = isError ? "text-danger" : "text-success";
  const dotClass = isError ? "bg-danger" : "bg-success";
  const dotGlow = isError
    ? "0 0 0 4px rgba(185,28,28,0.18)"
    : "0 0 0 4px rgba(21,128,61,0.18)";
  const subtitle = isError
    ? "Session ended with an error"
    : "Turn finished — tap to review";
  const rel = formatRel(entry.at);
  const projectName = project?.name ?? entry.session.projectId.slice(0, 8);
  // When seen, demote the whole row — fainter icon, muted title, smaller
  // "seen" chip — but keep the same structural shape so the row height
  // matches the unseen counterpart (layout doesn't jitter when an entry
  // flips from unseen to seen on tap-back).
  const seen = entry.seen;

  return (
    <Link
      to={`/session/${entry.session.id}`}
      className={cn(
        "flex items-center gap-3 px-4 py-3 border-b border-line hover:bg-paper/40 cursor-pointer",
        seen && "opacity-80",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full shrink-0",
          dotClass,
          seen && "opacity-50",
        )}
        style={seen ? undefined : { boxShadow: dotGlow }}
      />
      <Icon
        className={cn(
          "w-4 h-4 shrink-0",
          iconClass,
          seen && "opacity-60",
        )}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-[14px] truncate flex items-center gap-2",
            seen ? "font-normal text-ink-muted" : "font-medium",
          )}
        >
          <span className="truncate">{entry.session.title || "Untitled"}</span>
          {seen && (
            <span className="shrink-0 mono text-[10px] uppercase tracking-[0.08em] text-ink-faint border border-line rounded px-1 py-0.5">
              seen
            </span>
          )}
        </div>
        <div
          className={cn(
            "text-[12px] truncate",
            seen ? "text-ink-faint" : "text-ink-muted",
          )}
        >
          {subtitle}
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
  );
}

function formatRel(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((now - then) / 1000));
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}
