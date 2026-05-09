import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot } from "lucide-react";
import type {
  ListSubagentsResponse,
  SubagentRunStatus,
  SubagentStats,
  SubagentSummary,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";

// ---------------------------------------------------------------------------
// /agents — Subagent monitor.
//
// Read-only observability over the SDK's `Task` / `Agent` / `Explore` tool
// invocations across every session. The whole surface is aggregation + a
// flat list; we never let the user kick off or cancel a subagent from here
// (the parent session drives that).
//
// Live update strategy mirrors the Queue screen: every session's
// `refresh_transcript` WS frame is fanned out to a custom window event the
// store emits, and we subscribe + debounce-refetch. Any event kind that the
// transport broadcasts goes through that bus, so we hear about new
// tool_use / tool_result rows without polling.
//
// Filter chips (All / Running / Done / Failed) are URL-backed via
// `?status=active|done|all` + an explicit `failed` client-side filter. The
// server's `status` param lumps done + failed under `done` (the wire is
// three-valued: active / done / all), so we still filter "failed" in JS —
// fine because the server's list is already capped.
// ---------------------------------------------------------------------------

type ChipFilter = "all" | "active" | "done" | "failed";

const CHIPS: Array<{ id: ChipFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Running" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

export function AgentsScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const chip = normalizeChip(searchParams.get("status"));

  const [items, setItems] = useState<SubagentSummary[]>([]);
  const [stats, setStats] = useState<SubagentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Debounce WS-driven refetches. A burst of events (stream of tool_use /
  // tool_result / assistant_text in one turn) otherwise slams /api/agents.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh() {
    try {
      // Server filter maps All / Running → `all` / `active`; Done and Failed
      // both collapse into the server's `done` bucket and we narrow to
      // failed-only client-side. Keeps the server filter a three-value
      // enum (active / done / all) which is exactly the wire shape.
      const serverStatus: "active" | "done" | "all" =
        chip === "active" ? "active" : chip === "all" ? "all" : "done";
      const res: ListSubagentsResponse = await api.listAgents({
        status: serverStatus,
      });
      const narrowed =
        chip === "failed"
          ? res.items.filter((i) => i.status === "failed")
          : chip === "done"
            ? res.items.filter((i) => i.status === "done")
            : res.items;
      setItems(narrowed);
      setStats(res.stats);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chip]);

  useEffect(() => {
    // Every session's refresh_transcript frame triggers a window event in the
    // sessions store. We debounce so a stream of events per turn produces at
    // most one /api/agents fetch per 500 ms.
    const scheduleRefetch = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        void refresh();
      }, 500);
    };
    window.addEventListener("claudex:refresh_transcript", scheduleRefetch);
    return () => {
      window.removeEventListener("claudex:refresh_transcript", scheduleRefetch);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chip]);

  const setChip = (next: ChipFilter) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "all") sp.delete("status");
    else sp.set("status", next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <AppShell tab="agents">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3">
        <div className="caps text-ink-muted">Subagents</div>
        <h1 className="display text-[1.25rem] leading-tight mt-0.5">
          What claude is delegating.
        </h1>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        <StatsCards stats={stats} />

        <div className="px-4 md:px-6 py-3 flex items-center gap-2 flex-wrap">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setChip(c.id)}
              className={cn(
                "h-8 px-3 rounded-full text-[12px] font-medium border",
                chip === c.id
                  ? "bg-ink text-canvas border-ink"
                  : "bg-canvas text-ink-soft border-line hover:bg-paper/60",
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-[13px] text-ink-muted text-center py-10 mono">
            loading…
          </div>
        ) : err ? (
          <div className="mx-4 md:mx-6 my-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        ) : items.length === 0 ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded-[12px] border border-dashed border-line-strong p-8 text-center">
              <Bot className="w-6 h-6 mx-auto text-ink-muted mb-2" />
              <div className="display text-[1.1rem] mb-1">
                No subagent runs yet.
              </div>
              <div className="text-[13px] text-ink-muted max-w-[44ch] mx-auto">
                When claude delegates to a subagent — via the SDK's Task,
                Agent, or Explore tools — the run shows up here with its
                status, duration, and a preview of the result.
              </div>
            </div>
          </div>
        ) : (
          <ul>
            {items.map((row) => (
              <AgentRow
                key={row.id}
                row={row}
                expanded={expandedId === row.id}
                onToggle={() =>
                  setExpandedId((id) => (id === row.id ? null : row.id))
                }
              />
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

function normalizeChip(raw: string | null): ChipFilter {
  if (raw === "active" || raw === "done" || raw === "failed") return raw;
  return "all";
}

function StatsCards({ stats }: { stats: SubagentStats | null }) {
  // Same four-card visual shape as StatsSheet: caps label + big number, zero
  // ornament. Skeletal rows while the stats are loading so layout doesn't
  // jump on first paint.
  const s = stats ?? {
    activeCount: 0,
    completedToday: 0,
    avgDurationMs: null,
    failureRate: null,
  };
  return (
    <div className="px-4 md:px-6 pt-4 grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard label="Active" value={String(s.activeCount)} />
      <StatCard label="Done today" value={String(s.completedToday)} />
      <StatCard
        label="Avg duration"
        value={s.avgDurationMs === null ? "—" : formatDurationShort(s.avgDurationMs)}
      />
      <StatCard
        label="Failure rate"
        value={
          s.failureRate === null
            ? "—"
            : `${Math.round(s.failureRate * 100)}%`
        }
        tone={s.failureRate !== null && s.failureRate >= 0.5 ? "danger" : undefined}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger";
}) {
  return (
    <div className="rounded-[12px] border border-line bg-paper/40 px-4 py-3">
      <div className="caps text-ink-muted">{label}</div>
      <div
        className={cn(
          "display text-[1.4rem] leading-tight mt-1",
          tone === "danger" ? "text-danger" : undefined,
        )}
      >
        {value}
      </div>
    </div>
  );
}

function AgentRow({
  row,
  expanded,
  onToggle,
}: {
  row: SubagentSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="px-4 md:px-6 py-3 border-b border-line hover:bg-paper/40">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 text-left"
        aria-expanded={expanded}
      >
        <StatusDot status={row.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="mono text-[12px] text-ink-muted shrink-0">
              {row.toolName}
            </span>
            <span className="text-[14px] font-medium truncate">
              {row.description || "(no description)"}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-muted flex-wrap">
            {/* Desktop: deep-link into the parent session at the exact event.
                Mobile: still shown, just stacks below the description. The
                `#seq-<n>` anchor is best-effort — Chat.tsx already honors
                scroll-to-event hashes where supported. */}
            <Link
              to={`/session/${row.sessionId}#seq-${row.seq}`}
              onClick={(e) => e.stopPropagation()}
              className="mono hover:underline truncate"
            >
              {row.sessionTitle}
            </Link>
            {row.projectName && (
              <>
                <span>·</span>
                <span className="mono truncate">{row.projectName}</span>
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 mono text-[12px] text-ink-muted tabular-nums text-right">
          <div>
            {row.status === "running"
              ? "running"
              : row.durationMs !== null
                ? formatDurationShort(row.durationMs)
                : "—"}
          </div>
          <div
            className="mono text-[10px] text-ink-faint mt-0.5"
            title={new Date(row.startedAt).toLocaleString()}
          >
            started {timeAgoShort(row.startedAt)}
          </div>
        </div>
      </button>
      {expanded && (
        <div className="mt-3 ml-5 pl-3 border-l border-line space-y-2">
          {row.resultPreview ? (
            <pre className="whitespace-pre-wrap break-words text-[12px] mono text-ink-soft bg-paper/60 rounded-[8px] p-2 border border-line">
              {row.resultPreview}
            </pre>
          ) : (
            <div className="text-[12px] text-ink-muted">
              {row.status === "running"
                ? "Still running — no result yet."
                : "(empty result)"}
            </div>
          )}
          <div className="flex items-center gap-3 text-[12px]">
            <Link
              to={`/session/${row.sessionId}#seq-${row.seq}`}
              className="text-klein hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              Open session →
            </Link>
            <span className="text-ink-muted mono">
              started {formatClock(row.startedAt)}
            </span>
            {row.finishedAt && (
              <span className="text-ink-muted mono">
                finished {formatClock(row.finishedAt)}
              </span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function StatusDot({ status }: { status: SubagentRunStatus }) {
  const cls =
    status === "running"
      ? "bg-success animate-pulse"
      : status === "failed"
        ? "bg-danger"
        : "bg-ink-faint";
  return (
    <span
      className={`h-2 w-2 rounded-full shrink-0 ${cls}`}
      title={status}
      aria-label={status}
    />
  );
}

/** Short, readable duration formatting: "340ms" / "12s" / "2m 10s" / "1h 5m". */
function formatDurationShort(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) {
    return remSec === 0 ? `${minutes}m` : `${minutes}m ${remSec}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}

/** HH:MM:SS local time — just enough detail to correlate with server logs. */
function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
