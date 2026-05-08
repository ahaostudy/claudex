import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  Session,
  UsageRangeResponse,
  UsageTodayResponse,
} from "@claudex/shared";
import { AppShell } from "@/components/AppShell";
import { api } from "@/api/client";
import { useSessions } from "@/state/sessions";
import {
  computeSessionUsage,
  contextWindowTokens,
  formatTokens,
  type SessionUsage,
} from "@/lib/usage";
import { MODEL_LABEL } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Usage analytics — full-screen `/usage` page. Desktop-first layout adapted
// from mockup s-08 (lines referenced in the task spec). Mobile keeps the
// bottom-sheet `UsagePanel` and shows a "go to desktop" empty state here,
// because the mockup was designed for a 2-col + 3-col grid that can't
// collapse gracefully to a 390px viewport without sacrificing half the
// information.
//
// Tiles shipped (everything else is an honest empty state — we don't fake
// quota / plan data that claudex doesn't have):
//
//   1. Current session: when `?session=<id>` is set *or* there's a most-
//      recent non-archived top-level session. Replays that session's events
//      through `computeSessionUsage` and renders the same ring the inline
//      Chat context ring shows.
//   2. Plan period: OMITTED. Rendered as a card with "No plan data" copy.
//   3. Today · tokens: `/api/usage/today` totals + per-model mini rows.
//   4. 7-day bar chart: `/api/usage/range?days=7`, stacked by model.
//   5. Top sessions: from `/api/usage/today` — already sorted server-side.
//
// Time-range chips ("Today / 7 days / 30 days") — only "Today" is wired;
// the other two are visibly disabled so we don't lie about the data.
// ---------------------------------------------------------------------------

export function UsagePage() {
  const { sessions } = useSessions();
  const [params] = useSearchParams();
  const explicitSessionId = params.get("session");

  // Prefer the caller-provided session id, else the most-recent non-archived
  // top-level session in the local store. Either way, this is just for the
  // "current session" tile — the Today tile and the bar chart are independent.
  const activeSession: Session | null = useMemo(() => {
    if (explicitSessionId) {
      return sessions.find((s) => s.id === explicitSessionId) ?? null;
    }
    return (
      sessions
        .filter((s) => !s.parentSessionId && s.status !== "archived")
        .sort((a, b) =>
          (b.lastMessageAt ?? b.updatedAt).localeCompare(
            a.lastMessageAt ?? a.updatedAt,
          ),
        )[0] ?? null
    );
  }, [sessions, explicitSessionId]);

  // Per-session usage for the Current-session tile.
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  useEffect(() => {
    if (!activeSession) {
      setSessionUsage(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listEvents(activeSession.id);
        if (cancelled) return;
        setSessionUsage(computeSessionUsage(res.events, activeSession.model));
      } catch {
        if (!cancelled) setSessionUsage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession?.id, activeSession?.model]);

  // Cross-session aggregates.
  const [today, setToday] = useState<UsageTodayResponse | null>(null);
  const [range, setRange] = useState<UsageRangeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, r] = await Promise.all([
          api.getUsageToday(),
          api.getUsageRange(7),
        ]);
        if (cancelled) return;
        setToday(t);
        setRange(r);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "load_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppShell tab="usage">
      {/* Below md: UsagePage is desktop-focused. Mobile users keep the bottom-
          sheet UsagePanel on the Chat screen. We still render a tiny empty
          state here so deep-links don't 404 on a phone. */}
      <div className="md:hidden p-6 text-[13px] text-ink-muted">
        <div className="caps text-ink-muted">Usage</div>
        <div className="display text-[20px] text-ink mt-1">
          Open on a larger screen
        </div>
        <p className="mt-2 leading-relaxed">
          The Usage dashboard is designed for desktop. On mobile, tap the
          context ring in a session to see its usage.
        </p>
        <Link
          to="/sessions"
          className="mt-4 inline-block h-8 px-3 rounded-[6px] border border-line bg-paper text-[12px]"
        >
          Back to sessions
        </Link>
      </div>

      <div className="hidden md:block p-6 overflow-y-auto">
        <header className="flex items-baseline gap-4 mb-6">
          <div>
            <div className="caps text-ink-muted">Usage</div>
            <h1 className="display text-[24px] leading-tight mt-0.5">
              Today's consumption
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="h-8 px-3 rounded-[6px] border border-line bg-canvas text-[12px]"
              aria-pressed="true"
            >
              Today
            </button>
            <button
              type="button"
              disabled
              title="Coming soon"
              className="h-8 px-3 rounded-[6px] border border-line bg-paper text-[12px] opacity-60 cursor-not-allowed"
            >
              7 days
            </button>
            <button
              type="button"
              disabled
              title="Coming soon"
              className="h-8 px-3 rounded-[6px] border border-line bg-paper text-[12px] opacity-60 cursor-not-allowed"
            >
              30 days
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-[8px] border border-danger/30 bg-danger-wash text-[13px] text-[#7a1d21] px-3 py-2">
            Couldn't load usage: {error}
          </div>
        )}

        {/* Row 1: current session (2) + plan period (1) + today tokens (1) */}
        <section className="grid grid-cols-4 gap-4">
          <CurrentSessionTile session={activeSession} usage={sessionUsage} />
          <PlanPeriodTile />
          <TodayTokensTile today={today} />
        </section>

        {/* Row 2: 7-day chart (2) + top sessions (1) */}
        <section className="mt-5 grid grid-cols-3 gap-4">
          <SevenDayChartTile range={range} />
          <TopSessionsTile today={today} />
        </section>
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function CurrentSessionTile({
  session,
  usage,
}: {
  session: Session | null;
  usage: SessionUsage | null;
}) {
  // Hook order must be stable across renders — compute the cache-hit ratio
  // before any early return. The hook tolerates a null session.
  const cacheHitPct = useLastTurnCacheHit(session);

  if (!session) {
    return (
      <div className="col-span-2 rounded-[10px] border border-line bg-canvas p-5 flex items-center gap-5 min-h-[160px]">
        <div className="text-[13px] text-ink-muted">
          No active session. Open or start a session to see its context usage
          here.
        </div>
      </div>
    );
  }

  const window = contextWindowTokens(session.model);
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const known = usage?.lastTurnContextKnown ?? false;
  const pct = known ? Math.min(1, lastTurnInput / window) : 0;

  // Prompt / Output from aggregate counters. The caveat (per the spec) is
  // these are cumulative across the whole session — matches the existing
  // UsagePanel's math.
  const promptLabel = usage ? formatTokens(usage.totalInput) : "—";
  const outputLabel = usage ? formatTokens(usage.totalOutput) : "—";

  return (
    <div className="col-span-2 rounded-[10px] border border-line bg-canvas p-5 flex items-center gap-5">
      <div className="relative shrink-0">
        <svg width={120} height={120}>
          <circle
            cx={60}
            cy={60}
            r={52}
            fill="none"
            stroke="#e8e4d8"
            strokeWidth={10}
          />
          <circle
            cx={60}
            cy={60}
            r={52}
            fill="none"
            stroke={known ? "#cc785c" : "#cc785c66"}
            strokeWidth={10}
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 52}
            strokeDashoffset={2 * Math.PI * 52 * (1 - pct)}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="display text-[26px]">
            {known ? `${Math.round(pct * 100)}%` : "—"}
          </div>
          <div className="caps text-ink-muted">session</div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="caps text-ink-muted">Current session</div>
        <Link
          to={`/session/${session.id}`}
          className="display text-[22px] leading-tight mt-1 block truncate hover:underline"
        >
          {session.title}
        </Link>
        <div className="mono text-[12px] text-ink-muted mt-1 truncate">
          {known
            ? `${lastTurnInput.toLocaleString()} / ${window.toLocaleString()} tokens`
            : "— / " + window.toLocaleString() + " tokens"}{" "}
          · {MODEL_LABEL[session.model] ?? session.model}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <Stat label="Prompt" value={promptLabel} />
          <Stat label="Output" value={outputLabel} />
          <Stat
            label="Cache hits"
            value={cacheHitPct === null ? "—" : `${Math.round(cacheHitPct * 100)}%`}
          />
        </div>
      </div>
    </div>
  );
}

function PlanPeriodTile() {
  // Per the task spec: we don't have plan/quota info. Render an honest empty
  // state instead of a fake 58% bar.
  return (
    <div className="rounded-[10px] border border-line bg-canvas p-5 min-h-[160px] flex flex-col">
      <div className="caps text-ink-muted">Plan period</div>
      <div className="display text-[18px] mt-2 leading-tight">
        No plan data
      </div>
      <p className="text-[12px] text-ink-muted mt-2 leading-relaxed">
        Claude Code plan usage is reported by the CLI, not claudex. Run{" "}
        <span className="mono">/cost</span> inside a session to see your
        plan-period consumption.
      </p>
    </div>
  );
}

function TodayTokensTile({
  today,
}: {
  today: UsageTodayResponse | null;
}) {
  if (!today) {
    return (
      <div className="rounded-[10px] border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted">Today · tokens</div>
        <div className="text-[13px] text-ink-muted mt-2">Loading…</div>
      </div>
    );
  }
  if (today.totalTokens === 0) {
    return (
      <div className="rounded-[10px] border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted">Today · tokens</div>
        <div className="display text-[28px] leading-none mt-2 mono">0</div>
        <div className="text-[12px] text-ink-muted mt-1">
          No token activity recorded yet.
        </div>
      </div>
    );
  }
  const max = today.perModel[0]?.tokens ?? 1;
  return (
    <div className="rounded-[10px] border border-line bg-canvas p-5">
      <div className="caps text-ink-muted">Today · tokens</div>
      <div className="display text-[28px] leading-none mt-2 mono">
        {formatTokens(today.totalTokens)}
      </div>
      <div className="text-[12px] text-ink-muted">
        across {today.sessionCount}{" "}
        {today.sessionCount === 1 ? "session" : "sessions"}
      </div>
      <div className="mt-3 space-y-1.5 text-[12px]">
        {today.perModel.map((row, i) => {
          const opacity = modelDotOpacity(i);
          return (
            <div
              key={row.model}
              className="flex items-center gap-2"
              title={`${row.tokens.toLocaleString()} tokens`}
            >
              <span
                className="h-2 w-2 rounded-full bg-klein shrink-0"
                style={{ opacity }}
              />
              <span className="truncate">
                {MODEL_LABEL[row.model as keyof typeof MODEL_LABEL] ??
                  row.model}
              </span>
              <span className="ml-auto mono">{formatTokens(row.tokens)}</span>
              {/* non-semantic bar for visual comparison when there are >1 models */}
              {today.perModel.length > 1 && (
                <span
                  aria-hidden
                  className="hidden lg:inline-block h-1 rounded-full bg-line"
                  style={{ width: `${Math.max(8, (row.tokens / max) * 48)}px` }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SevenDayChartTile({ range }: { range: UsageRangeResponse | null }) {
  if (!range) {
    return (
      <div className="col-span-2 rounded-[10px] border border-line bg-canvas p-5 min-h-[200px]">
        <div className="flex items-center mb-3">
          <div className="caps text-ink-muted">Last 7 days · tokens / day</div>
        </div>
        <div className="text-[13px] text-ink-muted">Loading…</div>
      </div>
    );
  }
  const hasData = range.byDay.some((d) => d.totalTokens > 0);
  if (!hasData) {
    return (
      <div className="col-span-2 rounded-[10px] border border-line bg-canvas p-5 min-h-[200px]">
        <div className="flex items-center mb-3">
          <div className="caps text-ink-muted">Last 7 days · tokens / day</div>
        </div>
        <div className="text-[13px] text-ink-muted">
          No token activity recorded yet. Start a session and run a turn to
          see it appear here.
        </div>
      </div>
    );
  }
  return (
    <div className="col-span-2 rounded-[10px] border border-line bg-canvas p-5">
      <div className="flex items-center mb-3">
        <div className="caps text-ink-muted">Last 7 days · tokens / day</div>
        <div className="ml-auto text-[12px] text-ink-muted">
          stacked by model
        </div>
      </div>
      <StackedBarChart range={range} />
    </div>
  );
}

function TopSessionsTile({ today }: { today: UsageTodayResponse | null }) {
  if (!today) {
    return (
      <div className="rounded-[10px] border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted mb-2">Top sessions</div>
        <div className="text-[13px] text-ink-muted">Loading…</div>
      </div>
    );
  }
  if (today.topSessions.length === 0) {
    return (
      <div className="rounded-[10px] border border-line bg-canvas p-5 min-h-[160px]">
        <div className="caps text-ink-muted mb-2">Top sessions</div>
        <div className="text-[13px] text-ink-muted">
          Nothing ranked yet for today.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border border-line bg-canvas p-5">
      <div className="caps text-ink-muted mb-2">Top sessions</div>
      <div className="space-y-3 text-[13px]">
        {today.topSessions.map((s) => (
          <Link
            key={s.sessionId}
            to={`/session/${s.sessionId}`}
            className="block hover:bg-paper/60 rounded-[6px] -mx-1 px-1 py-0.5"
          >
            <div className="font-medium truncate">{s.title}</div>
            <div className="mono text-[11px] text-ink-muted truncate">
              {s.projectName ?? s.projectId} · {formatTokens(s.tokens)} tokens
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked bar chart. Not a full Recharts-style library — just enough SVG to
// render what mockup s-08 shows. We keep it self-contained so the Usage page
// doesn't drag a chart lib into the bundle.
// ---------------------------------------------------------------------------

function StackedBarChart({ range }: { range: UsageRangeResponse }) {
  const W = 700;
  const H = 160;
  const padTop = 10;
  const padBottom = 28;
  const padLeft = 40;
  const padRight = 10;
  const innerW = W - padLeft - padRight;
  const innerH = H - padTop - padBottom;

  const max = Math.max(1, ...range.byDay.map((d) => d.totalTokens));
  // Round to a nice axis value.
  const niceMax = niceCeiling(max);
  const bandW = innerW / range.byDay.length;
  const barW = Math.max(8, Math.min(60, bandW * 0.62));

  // Collect model ordering across days so stacking is consistent.
  const modelOrder: string[] = [];
  for (const day of range.byDay) {
    for (const m of day.perModel) {
      if (!modelOrder.includes(m.model)) modelOrder.push(m.model);
    }
  }

  // Gridlines — three intermediate ticks feels right for this size.
  const ticks = [0, niceMax / 3, (niceMax * 2) / 3, niceMax];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[160px]">
      {/* Gridlines + y labels */}
      {ticks.map((t) => {
        const y = padTop + innerH - (t / niceMax) * innerH;
        return (
          <g key={t}>
            <line
              x1={padLeft}
              x2={W - padRight}
              y1={y}
              y2={y}
              stroke="#e8e4d8"
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="#8a8577"
              className="mono"
            >
              {formatTokens(Math.round(t))}
            </text>
          </g>
        );
      })}

      {/* Stacked bars */}
      {range.byDay.map((day, i) => {
        const cx = padLeft + i * bandW + bandW / 2;
        const x = cx - barW / 2;
        // Stack from the bottom up, in modelOrder for stable colors.
        let runningY = padTop + innerH;
        const segments: Array<{
          model: string;
          tokens: number;
          y: number;
          h: number;
        }> = [];
        for (const model of modelOrder) {
          const row = day.perModel.find((r) => r.model === model);
          if (!row || row.tokens === 0) continue;
          const h = (row.tokens / niceMax) * innerH;
          runningY -= h;
          segments.push({ model, tokens: row.tokens, y: runningY, h });
        }
        return (
          <g key={day.date}>
            {segments.map((seg, idx) => (
              <rect
                key={seg.model}
                x={x}
                y={seg.y}
                width={barW}
                height={Math.max(1, seg.h)}
                fill="#cc785c"
                opacity={modelSegmentOpacity(
                  modelOrder.indexOf(seg.model),
                  idx === segments.length - 1,
                )}
                rx={2}
              >
                <title>
                  {day.date} · {MODEL_LABEL[seg.model as keyof typeof MODEL_LABEL] ?? seg.model}:{" "}
                  {seg.tokens.toLocaleString()} tokens
                </title>
              </rect>
            ))}
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill="#8a8577"
              className="mono"
            >
              {dayAxisLabel(day.date)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function dayAxisLabel(date: string): string {
  // date is `YYYY-MM-DD`. Parse as local midnight so the weekday label
  // matches the local interpretation the bucket used.
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(y, m - 1, d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
}

function modelSegmentOpacity(idx: number, _top: boolean): number {
  // Top-of-stack models get the most saturation; subsequent ones fade.
  // Matches the mockup's klein / klein/60 / klein/40 triple.
  return [1, 0.7, 0.45, 0.3, 0.2][idx] ?? 0.2;
}

function modelDotOpacity(idx: number): number {
  return [1, 0.7, 0.45, 0.3, 0.2][idx] ?? 0.2;
}

function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / pow;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * pow;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="caps text-ink-muted">{label}</div>
      <div className="mono text-[13px] mt-0.5">{value}</div>
    </div>
  );
}

/**
 * Pull the most recent turn_end's cache-hit ratio. We re-fetch events here
 * rather than plumbing it through computeSessionUsage because this stat is
 * specific to the Usage page tile and doesn't warrant a new field in
 * SessionUsage.
 */
function useLastTurnCacheHit(session: Session | null): number | null {
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    if (!session) {
      setRatio(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listEvents(session.id);
        if (cancelled) return;
        let cacheRead = 0;
        let newInput = 0;
        // Walk events bottom-up so the first turn_end we hit is the newest.
        for (let i = res.events.length - 1; i >= 0; i--) {
          const ev = res.events[i];
          if (ev.kind !== "turn_end") continue;
          const usage = (ev.payload as Record<string, unknown>).usage as
            | {
                inputTokens?: number;
                cacheReadInputTokens?: number;
              }
            | undefined;
          if (!usage) continue;
          cacheRead = Number(usage.cacheReadInputTokens ?? 0) | 0;
          newInput = Number(usage.inputTokens ?? 0) | 0;
          break;
        }
        const denom = cacheRead + newInput;
        setRatio(denom > 0 ? cacheRead / denom : null);
      } catch {
        if (!cancelled) setRatio(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.id]);
  return ratio;
}
