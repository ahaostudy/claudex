import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Bot, Copy, Loader2 } from "lucide-react";
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
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

// ---------------------------------------------------------------------------
// /agents — Subagent monitor.
//
// Read-only observability over the SDK's `Task` / `Agent` / `Explore` tool
// invocations across every session. The whole surface is aggregation + a
// grouped list; we never let the user kick off or cancel a subagent from here
// (the parent session drives that).
//
// Live update strategy mirrors the Queue screen: every session's
// `refresh_transcript` WS frame is fanned out to a custom window event the
// store emits, and we subscribe + debounce-refetch. Any event kind that the
// transport broadcasts goes through that bus, so we hear about new
// tool_use / tool_result rows without polling.
//
// While a user has an expanded row whose run is still `running`, we *also*
// tick an additional 2s refetch on top of the WS-driven debounce — the SDK's
// Task tool doesn't emit intermediate events on the parent session's wire,
// so the bus fires only at dispatch + finalize. The fast tick gives the
// expanded view a chance to surface the `resultPreview` the moment the
// tool_result lands, without the user having to close + reopen.
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

/** Order we render tool groups in: the "Agents" category the user singled out
 * goes first, then Task, then Explore, then everything else alphabetical.
 * Everything after this list renders in lexicographic order. */
const PRIMARY_GROUP_ORDER = ["Agent", "Task", "Explore"] as const;

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

  // Aggressive refetch while the expanded row is still running. The SDK's
  // Task tool runs its child turn entirely inside the parent session's stream
  // — there is no separate claudex session we could subscribe to for the
  // sub-turn's assistant_text. So the best we can do is keep polling /api/agents
  // at a tighter cadence than the WS bus guarantees, so the `resultPreview`
  // surfaces promptly once the tool_result lands.
  const expandedRow = items.find((i) => i.id === expandedId) ?? null;
  const shouldFastPoll = expandedRow !== null && expandedRow.status === "running";
  useEffect(() => {
    if (!shouldFastPoll) return;
    const handle = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldFastPoll, chip]);

  const setChip = (next: ChipFilter) => {
    const sp = new URLSearchParams(searchParams);
    if (next === "all") sp.delete("status");
    else sp.set("status", next);
    setSearchParams(sp, { replace: true });
  };

  // Bucket by toolName. Order: Agent → Task → Explore → (alphabetical rest).
  // Within each bucket items already arrive in startedAt-desc order from the
  // server, so we preserve insertion order.
  const grouped = useMemo(() => groupByTool(items), [items]);

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
          <div>
            {grouped.map((group) => (
              <SubagentGroup
                key={group.toolName}
                toolName={group.toolName}
                rows={group.rows}
                expandedId={expandedId}
                onToggle={(id) =>
                  setExpandedId((curr) => (curr === id ? null : id))
                }
              />
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}

function normalizeChip(raw: string | null): ChipFilter {
  if (raw === "active" || raw === "done" || raw === "failed") return raw;
  return "all";
}

/** Bucket + sort helper. Items already arrive sorted by startedAt desc from
 * the server, so inside a bucket we only need to preserve insertion order. */
function groupByTool(
  items: SubagentSummary[],
): Array<{ toolName: string; rows: SubagentSummary[] }> {
  const buckets = new Map<string, SubagentSummary[]>();
  for (const item of items) {
    const key = item.toolName || "Other";
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }
  const out: Array<{ toolName: string; rows: SubagentSummary[] }> = [];
  for (const name of PRIMARY_GROUP_ORDER) {
    const rows = buckets.get(name);
    if (rows && rows.length > 0) out.push({ toolName: name, rows });
    buckets.delete(name);
  }
  const rest = [...buckets.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [name, rows] of rest) {
    if (rows.length > 0) out.push({ toolName: name, rows });
  }
  return out;
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

/** One tool bucket: a section header + its rows. Rendered as a <section>
 * rather than a <ul> so the header sits at the top-level of the group and
 * rows can own their own expand panel flow. */
function SubagentGroup({
  toolName,
  rows,
  expandedId,
  onToggle,
}: {
  toolName: string;
  rows: SubagentSummary[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  const runCount = rows.length;
  return (
    <section>
      <div className="sticky top-0 z-[1] bg-canvas/95 backdrop-blur px-4 md:px-6 py-1.5 border-b border-line flex items-center gap-2">
        <span className="caps text-ink-soft">{toolName}</span>
        <span className="text-[11px] text-ink-muted mono">
          · {runCount} {runCount === 1 ? "run" : "runs"}
        </span>
      </div>
      <ul>
        {rows.map((row) => (
          <AgentRow
            key={row.id}
            row={row}
            expanded={expandedId === row.id}
            onToggle={() => onToggle(row.id)}
          />
        ))}
      </ul>
    </section>
  );
}

/** A single row in a tool group. Collapsed state: one tight line with a
 * colored left-border that encodes status + a very subtle background tint.
 * Expanded state: a child panel (AgentDetail) with input + output + meta. */
function AgentRow({
  row,
  expanded,
  onToggle,
}: {
  row: SubagentSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tint = rowTint(row);
  return (
    <li
      className={cn(
        "border-b border-line",
        tint.bg,
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 md:px-6 py-2 flex items-center gap-3 hover:bg-paper/60"
        aria-expanded={expanded}
      >
        {/* 3px colored left-border strip encodes status. Pulses softly while
            the run is still in flight so it draws the eye. */}
        <span
          aria-hidden
          className={cn(
            "self-stretch w-[3px] rounded-sm shrink-0",
            tint.strip,
            row.status === "running" ? "animate-pulse" : undefined,
          )}
        />
        <span
          className={cn(
            "mono text-[11px] px-1.5 py-0.5 rounded shrink-0 border",
            tint.chip,
          )}
        >
          {row.toolName}
        </span>
        {row.status === "running" && (
          <Loader2
            className="w-3 h-3 text-klein shrink-0 animate-spin"
            aria-hidden
          />
        )}
        <span className="text-[13px] font-medium truncate min-w-0 flex-1">
          {row.description || <span className="text-ink-muted italic">(no description)</span>}
        </span>
        <Link
          to={`/session/${row.sessionId}#seq-${row.seq}`}
          onClick={(e) => e.stopPropagation()}
          className="mono text-[11px] text-ink-muted hover:underline truncate shrink min-w-0 max-w-[28%] hidden sm:inline"
          title={`${row.sessionTitle}${row.projectName ? ` · ${row.projectName}` : ""}`}
        >
          {row.sessionTitle}
        </Link>
        <span
          className="mono text-[11px] text-ink-muted tabular-nums shrink-0"
          title={new Date(row.startedAt).toLocaleString()}
        >
          {row.status === "running"
            ? "running"
            : row.durationMs !== null
              ? formatDurationShort(row.durationMs)
              : "—"}
        </span>
        <span
          className="mono text-[11px] text-ink-faint tabular-nums shrink-0"
          title={new Date(row.startedAt).toLocaleString()}
        >
          {timeAgoShort(row.startedAt)}
        </span>
      </button>
      {expanded && <AgentDetail row={row} />}
    </li>
  );
}

/** Per-status tint classes. Running: klein stripe + klein-wash tint. Done
 * (no error): success stripe + paper tint. Failed / isError: danger stripe
 * + danger-wash tint. The `chip` classes style the small tool-name pill. */
function rowTint(row: SubagentSummary): {
  strip: string;
  bg: string;
  chip: string;
} {
  if (row.status === "failed" || row.isError) {
    return {
      strip: "bg-danger/70",
      bg: "bg-danger-wash/40",
      chip: "border-danger/30 text-danger bg-canvas/70",
    };
  }
  if (row.status === "running") {
    return {
      strip: "bg-klein",
      bg: "bg-klein-wash/30",
      chip: "border-klein/40 text-klein-ink bg-canvas/70",
    };
  }
  return {
    strip: "bg-success/50",
    bg: "bg-paper/30",
    chip: "border-line text-ink-soft bg-canvas/70",
  };
}

/** The expand panel below a row — input (pretty JSON) + result preview + meta.
 * Kept as its own component so the row stays tight. */
function AgentDetail({ row }: { row: SubagentSummary }) {
  const inputJson = useMemo(() => safeStringify(row.input), [row.input]);
  const hasInput = Object.keys(row.input).length > 0;

  async function handleCopyInput() {
    const ok = await copyText(inputJson);
    toast(ok ? "Input copied" : "Copy failed");
  }

  return (
    <div className="px-4 md:px-6 pb-3 pt-1 space-y-3">
      {/* Input / parameters */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="caps text-ink-muted">Input</div>
          {hasInput && (
            <button
              type="button"
              onClick={handleCopyInput}
              className="mono text-[11px] text-ink-muted hover:text-ink inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-line bg-canvas hover:bg-paper/60"
              title="Copy input JSON"
            >
              <Copy className="w-3 h-3" aria-hidden />
              Copy
            </button>
          )}
        </div>
        {hasInput ? (
          <pre className="mono text-[12px] text-ink-soft bg-paper/60 rounded-[8px] p-2 border border-line max-h-40 overflow-auto whitespace-pre-wrap break-words">
            {inputJson}
          </pre>
        ) : (
          <div className="text-[12px] text-ink-muted italic">(no input)</div>
        )}
      </div>

      {/* Result preview. For the running case we explain why there's no
          preview yet + note that we're polling. For done/failed we show the
          200-char truncated preview with a link to the full transcript. */}
      <div>
        <div className="caps text-ink-muted mb-1">
          {row.status === "failed" ? "Error output" : "Result"}
        </div>
        {row.status === "running" ? (
          <div className="text-[12px] text-ink-muted italic inline-flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
            Still running — polling every 2 s for the result.
          </div>
        ) : row.resultPreview ? (
          <>
            <pre
              className={cn(
                "mono text-[12px] bg-paper/60 rounded-[8px] p-2 border border-line max-h-48 overflow-auto whitespace-pre-wrap break-words",
                row.status === "failed" ? "text-danger" : "text-ink-soft",
              )}
            >
              {row.resultPreview}
            </pre>
            <div className="mt-1 text-[11px] text-ink-faint">
              showing first 200 chars —{" "}
              <Link
                to={`/session/${row.sessionId}#seq-${row.seq}`}
                className="text-klein hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                open session for full tool_result
              </Link>
            </div>
          </>
        ) : (
          <div className="text-[12px] text-ink-muted italic">(empty result)</div>
        )}
      </div>

      {/* Meta — session / project / timestamps. The collapsed row no longer
          shows project or full timestamps, so they all land here. */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] mono text-ink-muted">
        <Link
          to={`/session/${row.sessionId}#seq-${row.seq}`}
          className="text-klein hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Open session →
        </Link>
        <span className="truncate max-w-[40ch]">
          session: {row.sessionTitle}
        </span>
        {row.projectName && (
          <span className="truncate max-w-[30ch]">
            project: {row.projectName}
          </span>
        )}
        <span>started {formatClock(row.startedAt)}</span>
        {row.finishedAt && <span>finished {formatClock(row.finishedAt)}</span>}
      </div>
    </div>
  );
}

/** JSON.stringify with a catch-all in case of circular refs or getters that
 * throw. Mirrors the helper in Chat.tsx but inline here to keep /agents
 * decoupled from the chat surface. */
function safeStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
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

// `StatusDot` is retained only in the revision history — rows now encode
// status via a colored left-border strip + background tint (see rowTint).
