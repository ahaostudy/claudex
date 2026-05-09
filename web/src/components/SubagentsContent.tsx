import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Copy, Loader2 } from "lucide-react";
import type {
  ListSubagentsResponse,
  SubagentSummary,
} from "@claudex/shared";
import { api } from "@/api/client";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

// ---------------------------------------------------------------------------
// SubagentsContent — the inner list shared by the desktop right rail
// (SessionSubagentsRail) and the mobile bottom-sheet (SubagentsDrawer).
// Scoped to one session via the `sessionId` prop; we pass it to
// `api.listAgents({ sessionId })` so the server does the filtering.
//
// Live-update strategy mirrors the old global /agents screen but scoped:
//   1. WS `claudex:refresh_transcript` with `detail.sessionId === sessionId`
//      triggers a 500ms debounced refetch.
//   2. While any row in the list has `status === "running"`, a single
//      panel-level 2s `setInterval` re-polls so a tool_result landing
//      surfaces promptly. Interval is cleared as soon as no row is running,
//      or when the component unmounts, or when the sessionId changes.
//
// Default expand rule: running rows expand by default; finished rows
// collapse by default. The user can still click any row to toggle.
// ---------------------------------------------------------------------------

/** Order we render tool groups in: Agent → Task → Explore → (alphabetical). */
const PRIMARY_GROUP_ORDER = ["Agent", "Task", "Explore"] as const;

export function SubagentsContent({ sessionId }: { sessionId: string }) {
  const [items, setItems] = useState<SubagentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Rows the user has explicitly toggled. We merge this with the default
  // "running rows are expanded" rule when rendering so status changes
  // don't clobber the user's choice on a row they opened/closed manually.
  const [manualExpanded, setManualExpanded] = useState<Record<string, boolean>>(
    {},
  );

  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useMemo(() => {
    // Capture sessionId in the closure so the WS listener below can call
    // the latest version without needing the listener itself to be
    // re-registered on every render.
    return async () => {
      try {
        const res: ListSubagentsResponse = await api.listAgents({
          sessionId,
        });
        setItems(res.items);
        setErr(null);
      } catch {
        setErr("load failed");
      } finally {
        setLoading(false);
      }
    };
  }, [sessionId]);

  // Initial load + sessionId change → reload + reset user toggles.
  useEffect(() => {
    setLoading(true);
    setManualExpanded({});
    void refresh();
  }, [refresh]);

  // Debounced refetch on WS-driven transcript refreshes. We only listen
  // for events that target THIS session — a refresh on some other session
  // won't touch our list.
  useEffect(() => {
    const onRefresh = (evt: Event) => {
      const ce = evt as CustomEvent<{ sessionId?: string }>;
      if (!ce.detail || ce.detail.sessionId !== sessionId) return;
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        void refresh();
      }, 500);
    };
    window.addEventListener("claudex:refresh_transcript", onRefresh);
    return () => {
      window.removeEventListener("claudex:refresh_transcript", onRefresh);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [refresh, sessionId]);

  // Panel-level fast-poll: one interval regardless of how many running
  // rows there are. Starts only while at least one row is running, stops
  // as soon as no row is running (or the panel unmounts).
  const hasRunningRow = items.some((i) => i.status === "running");
  useEffect(() => {
    if (!hasRunningRow) return;
    const handle = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(handle);
  }, [hasRunningRow, refresh]);

  const grouped = useMemo(() => groupByTool(items), [items]);
  const totalCount = items.length;

  const toggleRow = (id: string, defaultExpanded: boolean) => {
    setManualExpanded((prev) => {
      // If the user has explicitly toggled this row before, flip that bit.
      // Otherwise we're flipping away from the default (so on first click,
      // a running row collapses, a done row expands).
      const current = prev[id] ?? defaultExpanded;
      return { ...prev, [id]: !current };
    });
  };

  const isExpanded = (row: SubagentSummary): boolean => {
    if (row.id in manualExpanded) return manualExpanded[row.id];
    // Default: running rows expand, everything else collapses.
    return row.status === "running";
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-line flex items-center shrink-0">
        <span className="caps text-ink-muted">Subagents</span>
        <span className="mono text-[11px] text-ink-muted ml-auto">
          {totalCount} this session
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {loading ? (
          <div className="text-[12px] text-ink-muted text-center py-8 mono">
            loading…
          </div>
        ) : err ? (
          <div className="mx-3 my-3 text-[12px] text-danger bg-danger-wash rounded-[8px] px-2.5 py-2 border border-danger/30">
            {err}
          </div>
        ) : totalCount === 0 ? (
          <EmptyState />
        ) : (
          grouped.map((group) => (
            <SubagentGroup
              key={group.toolName}
              toolName={group.toolName}
              rows={group.rows}
              isExpanded={isExpanded}
              onToggle={(row) => toggleRow(row.id, row.status === "running")}
            />
          ))
        )}
      </div>

      <div className="mt-auto p-3 border-t border-line flex items-center gap-2 text-[11px] text-ink-muted shrink-0">
        <span>Newest first · grouped by tool</span>
        <span className="ml-auto mono">live</span>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="h-12 w-12 rounded-full bg-paper border border-line flex items-center justify-center mb-3">
        <Bot className="w-5 h-5 text-ink-muted" aria-hidden />
      </div>
      <div className="text-[13px] font-medium text-ink">No subagents yet.</div>
      <div className="text-[12px] text-ink-muted max-w-[30ch] mt-1">
        Any Task · Agent · Explore tool call shows up here.
      </div>
    </div>
  );
}

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
  const rest = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, rows] of rest) {
    if (rows.length > 0) out.push({ toolName: name, rows });
  }
  return out;
}

function SubagentGroup({
  toolName,
  rows,
  isExpanded,
  onToggle,
}: {
  toolName: string;
  rows: SubagentSummary[];
  isExpanded: (row: SubagentSummary) => boolean;
  onToggle: (row: SubagentSummary) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <div className="px-3 pt-3 pb-1.5 flex items-baseline gap-2">
        <span className="caps text-ink-soft">{toolName}</span>
        <span className="mono text-[11px] text-ink-muted">
          · {rows.length} {rows.length === 1 ? "run" : "runs"}
        </span>
      </div>
      {rows.map((row) => (
        <SubagentRow
          key={row.id}
          row={row}
          expanded={isExpanded(row)}
          onToggle={() => onToggle(row)}
        />
      ))}
    </section>
  );
}

function SubagentRow({
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
    <div
      className={cn(
        "mx-3 mb-1.5 rounded-[10px] border overflow-hidden relative",
        tint.border,
        tint.bg,
      )}
    >
      {/* 3px colored left-border strip (absolutely positioned). */}
      <div
        aria-hidden
        className={cn(
          "absolute left-0 top-0 bottom-0 w-[3px]",
          tint.strip,
        )}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "w-full pl-3 pr-2.5 py-2 flex items-center gap-2 text-left",
          expanded ? "border-b border-line" : "",
        )}
      >
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 h-5 rounded-[4px] border mono text-[10px] shrink-0",
            tint.chip,
          )}
        >
          {row.toolName}
        </span>
        {row.status === "running" ? (
          <Loader2 className="w-3 h-3 text-klein animate-spin shrink-0" aria-hidden />
        ) : row.status === "failed" || row.isError ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="w-3 h-3 text-danger shrink-0"
            aria-hidden
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            className="w-3 h-3 text-success shrink-0"
            aria-hidden
          >
            <path d="M5 12l5 5 9-10" />
          </svg>
        )}
        <span className="text-[12.5px] text-ink truncate flex-1">
          {row.description || (
            <span className="text-ink-muted italic">(no description)</span>
          )}
        </span>
        <span
          className={cn(
            "mono text-[10px] shrink-0 tabular-nums",
            row.status === "failed" || row.isError ? "text-danger" : "text-ink-muted",
          )}
          title={new Date(row.startedAt).toLocaleString()}
        >
          {row.status === "running"
            ? formatClockShort(row.startedAt, Date.now())
            : row.status === "failed" || row.isError
              ? "error"
              : row.durationMs !== null
                ? formatDurationShort(row.durationMs)
                : "—"}
        </span>
        {/* Chevron indicator — rotates when expanded. */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className={cn(
            "w-3 h-3 text-ink-muted shrink-0 transition-transform",
            expanded ? "rotate-90" : "",
          )}
          aria-hidden
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {expanded && <SubagentDetail row={row} />}
    </div>
  );
}

function SubagentDetail({ row }: { row: SubagentSummary }) {
  const inputJson = useMemo(() => safeStringify(row.input), [row.input]);
  const hasInput = Object.keys(row.input).length > 0;
  const isFailed = row.status === "failed" || row.isError;

  async function handleCopyInput() {
    const ok = await copyText(inputJson);
    toast(ok ? "Input copied" : "Copy failed");
  }

  return (
    <div className="px-3 py-3 space-y-3 bg-paper/30">
      {/* Input block */}
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="caps text-ink-muted">Input</span>
          {hasInput && (
            <button
              type="button"
              onClick={handleCopyInput}
              className="ml-auto inline-flex items-center gap-1 px-1.5 h-5 rounded-[4px] border border-line bg-canvas mono text-[10px] text-ink-soft hover:bg-paper/60"
              title="Copy input JSON"
            >
              <Copy className="w-2.5 h-2.5" aria-hidden />
              copy
            </button>
          )}
        </div>
        {hasInput ? (
          <pre className="mono text-[11px] leading-[1.5] text-canvas/90 bg-ink rounded-[8px] px-2.5 py-2 max-h-[160px] overflow-y-auto overflow-x-auto whitespace-pre-wrap break-words">
            {inputJson}
          </pre>
        ) : (
          <div className="text-[11px] text-ink-muted italic">(no input)</div>
        )}
      </div>

      {/* Result block — only when finished. Running case shows a brief
          "polling" hint so the user knows the 2s loop is on. */}
      <div>
        <div className="caps text-ink-muted mb-1">
          {row.status === "running"
            ? "Result"
            : isFailed
              ? "Error output"
              : "Result preview"}
        </div>
        {row.status === "running" ? (
          <div className="text-[11px] text-ink-muted italic inline-flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
            Still running — polling every 2s.
          </div>
        ) : row.resultPreview ? (
          <div
            className={cn(
              "rounded-[8px] border border-line bg-canvas px-2.5 py-2 text-[12px] leading-[1.55] max-h-[200px] overflow-y-auto whitespace-pre-wrap break-words",
              isFailed ? "text-danger" : "text-ink-soft",
            )}
          >
            {row.resultPreview}
          </div>
        ) : (
          <div className="text-[11px] text-ink-muted italic">(empty result)</div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-muted">
        <span className="mono">started {formatClock(row.startedAt)}</span>
        {row.finishedAt && (
          <>
            <span>·</span>
            <span className="mono">finished {formatClock(row.finishedAt)}</span>
          </>
        )}
        <span>·</span>
        <span className="mono" title={row.id}>
          id {truncateId(row.id)}
        </span>
        <Link
          to={`/session/${row.sessionId}#seq-${row.seq}`}
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] mono text-klein-ink hover:underline"
        >
          open turn · seq {row.seq} <span aria-hidden>→</span>
        </Link>
      </div>
    </div>
  );
}

function rowTint(row: SubagentSummary): {
  strip: string;
  bg: string;
  border: string;
  chip: string;
} {
  if (row.status === "failed" || row.isError) {
    return {
      strip: "bg-danger/70",
      bg: "bg-danger-wash/40",
      border: "border-danger/25",
      chip: "border-danger/30 text-danger bg-canvas/70",
    };
  }
  if (row.status === "running") {
    return {
      strip: "bg-klein",
      bg: "bg-klein-wash/35",
      border: "border-klein/25",
      chip: "border-klein/40 text-klein-ink bg-canvas/70",
    };
  }
  return {
    strip: "bg-success/50",
    bg: "bg-canvas",
    border: "border-line",
    chip: "border-line text-ink-soft",
  };
}

function safeStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

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

/** Compact MM:SS-style "elapsed" for a running row — the mockup shows e.g.
 * "0:14". We compute against `now` at render-time; the panel-level 2s
 * fast-poll causes the whole tree to re-render so this number keeps ticking.
 */
function formatClockShort(startedAtIso: string, now: number): string {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return "—";
  const elapsed = Math.max(0, Math.round((now - started) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function truncateId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 4)}…${id.slice(-2)}`;
}
