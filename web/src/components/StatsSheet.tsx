import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { StatsResponse } from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { cn } from "@/lib/cn";

/**
 * Statistics dashboard — single honest snapshot of what claudex has done on
 * this machine so far. Reached from the Home header's chart icon; bottom
 * sheet on mobile, centered modal on desktop. One fetch of `/api/stats` on
 * open; no polling, no WS subscription — the numbers change slowly and a
 * fresh mount is the cheapest way to re-read.
 *
 * Every card is backed by a literal query. The "Top tools" chart is a pure
 * CSS bar rail (each bar `uses / topUses * 100%` wide) — no library, no
 * axis labels, because the raw uses count carries all the signal.
 *
 * What we deliberately don't show (kept explicit so future reviewers don't
 * mistake omissions for bugs):
 *   - No "days streak" / "sessions this week" — claudex is a local tool,
 *     not a habit tracker; streaks would manufacture drama out of gaps.
 *   - No social / leaderboard metrics. This is a single-user install.
 */
export function StatsSheet({ onClose }: { onClose: () => void }) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getStats();
        if (cancelled) return;
        setStats(res);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof ApiError ? e.code : "load_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc-to-close. Matches the affordance on UsagePanel / GlobalSearchSheet.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-2xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="caps text-ink-muted">Statistics</div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              How claudex is doing.
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {err ? (
            <div className="text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
              Couldn't load stats: {err}
            </div>
          ) : !stats ? (
            <div className="text-[13px] text-ink-muted mono py-10 text-center">
              loading…
            </div>
          ) : (
            <StatsGrid stats={stats} />
          )}
        </div>
      </div>
    </div>
  );
}

function StatsGrid({ stats }: { stats: StatsResponse }) {
  const topUses = stats.topTools.reduce(
    (m, t) => (t.uses > m ? t.uses : m),
    0,
  );
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <Card label="Sessions">
        <div className="flex items-baseline gap-3">
          <span className="display text-[1.6rem] leading-tight">
            {stats.totalSessions}
          </span>
          <span className="text-[11px] text-ink-muted mono">total</span>
        </div>
        <div className="mt-2 text-[12px] text-ink-soft mono">
          <span className="text-success">{stats.activeSessions}</span>{" "}
          <span className="text-ink-muted">active</span>
          <span className="text-ink-faint"> · </span>
          <span>{stats.archivedSessions}</span>{" "}
          <span className="text-ink-muted">archived</span>
        </div>
      </Card>

      <Card label="Turns">
        <div className="flex items-baseline gap-3">
          <span className="display text-[1.6rem] leading-tight">
            {stats.totalTurns}
          </span>
          <span className="text-[11px] text-ink-muted mono">total</span>
        </div>
        <div className="mt-2 text-[12px] text-ink-soft mono">
          <span>{stats.avgTurnsPerSession.toFixed(1)}</span>{" "}
          <span className="text-ink-muted">avg per session</span>
        </div>
      </Card>

      <Card label="Tokens">
        <div className="flex items-baseline gap-3">
          <span className="display text-[1.6rem] leading-tight">
            {formatCount(stats.totalTokens)}
          </span>
          <span className="text-[11px] text-ink-muted mono">total</span>
        </div>
        <div className="mt-2 text-[12px] text-ink-soft mono">
          <span>{formatCount(stats.avgTokensPerTurn)}</span>{" "}
          <span className="text-ink-muted">avg per turn</span>
        </div>
      </Card>

      <Card label="Busiest project">
        {stats.busiestProject ? (
          <>
            <div className="text-[15px] font-medium truncate">
              {stats.busiestProject.name}
            </div>
            <div className="mt-1 text-[12px] text-ink-soft mono">
              <span>{stats.busiestProject.sessionCount}</span>{" "}
              <span className="text-ink-muted">
                session
                {stats.busiestProject.sessionCount === 1 ? "" : "s"}
              </span>
            </div>
          </>
        ) : (
          <div className="text-[13px] text-ink-muted">No projects yet.</div>
        )}
      </Card>

      <Card label="Top tools" span2>
        {stats.topTools.length === 0 ? (
          <div className="text-[13px] text-ink-muted">
            No tool_use events recorded yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {stats.topTools.map((t) => {
              const pct = topUses > 0 ? (t.uses / topUses) * 100 : 0;
              return (
                <li key={t.name} className="flex items-center gap-3">
                  <span className="mono text-[12px] text-ink min-w-[6rem] truncate">
                    {t.name}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-paper border border-line overflow-hidden">
                    <div
                      className="h-full bg-klein"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="mono text-[12px] text-ink-soft tabular-nums min-w-[2.5rem] text-right">
                    {t.uses}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card label="Range" span2>
        {stats.oldestSession && stats.newestSession ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <RangeRow
              heading="Oldest"
              title={stats.oldestSession.title}
              iso={stats.oldestSession.createdAt}
            />
            <RangeRow
              heading="Newest"
              title={stats.newestSession.title}
              iso={stats.newestSession.createdAt}
            />
          </div>
        ) : (
          <div className="text-[13px] text-ink-muted">
            No sessions on record.
          </div>
        )}
      </Card>
    </div>
  );
}

function Card({
  label,
  span2,
  children,
}: {
  label: string;
  span2?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-[12px] border border-line bg-paper/60 p-4",
        span2 && "sm:col-span-2",
      )}
    >
      <div className="caps text-ink-muted mb-2">{label}</div>
      {children}
    </div>
  );
}

function RangeRow({
  heading,
  title,
  iso,
}: {
  heading: string;
  title: string;
  iso: string;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        {heading}
      </div>
      <div className="text-[14px] font-medium truncate mt-0.5">
        {title || "Untitled"}
      </div>
      <div className="mono text-[11px] text-ink-muted mt-0.5">
        {formatDate(iso)}
      </div>
    </div>
  );
}

// Friendlyish token counts — exact below 1k, 12.3k above, 1.2M above a million.
// Kept local to this sheet so we don't drag formatTokens() from lib/usage (which
// targets a different audience).
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// `YYYY-MM-DD` in the viewer's local timezone. The server sends UTC ISO
// strings; converting here keeps the display consistent with how the user
// thinks about "when was this session created."
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
