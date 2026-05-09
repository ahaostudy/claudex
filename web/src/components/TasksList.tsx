import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import type { UIPiece } from "@/state/sessions";

/**
 * TasksList — shared grouped-by-tool list of every tool call in the current
 * session. Rendered inside both the desktop right rail (ChatTasksRail) and
 * the mobile bottom-sheet (TasksDrawer) so behavior is identical on both.
 *
 * Grouping:
 *   - "Subagents" is pinned to the top and contains every row whose tool
 *     name is one of {Task, Agent, Explore}. The user wants these up top
 *     because they're the most salient activity for a running turn.
 *   - Every other tool name gets its own group; the groups are rendered in
 *     alphabetical order (Bash, Edit, Glob, Grep, Read, Write, …).
 *
 * Each row re-implements the mockup s-13 sub-row tile:
 *   - 3px colored left strip (klein running, success done, danger failed)
 *   - small tool chip (mono, bordered, colored per status)
 *   - truncated description derived from the tool input
 *   - right-side duration: mm:ss live timer while running, timeAgoShort for
 *     completed rows, "error" for failed.
 *
 * We do NOT own an approval queue here — the approval UI is already in the
 * main transcript as its own piece, and Chat.tsx's `pendingApprovalCount`
 * is consumed by the header strip above us, not this list. Keeping the rail
 * purely reactive to `pieces` means it survives transcript refetches for
 * free.
 */

// Tool names the SDK uses for agent-spawning / explore calls — pinned to
// the top of the rail under a single "Subagents" group. Case-sensitive.
const SUBAGENT_TOOLS = new Set(["Task", "Agent", "Explore"]);

export type TaskState = "running" | "done" | "failed";

export interface TaskRow {
  /** Stable id — the tool_use id; used as the react key and passed through
   * to onReveal so Chat can scroll to the source piece in the transcript. */
  id: string;
  /** Raw SDK tool name (e.g. "Bash", "Task"). Used for grouping + the chip. */
  name: string;
  /** One-line summary of the input — truncated. */
  summary: string;
  /** Paired tool_result-derived status. */
  state: TaskState;
  /** ISO timestamp of the tool_use piece. Used for the live timer and the
   * timeAgoShort label on finished rows. */
  startedAt?: string;
  /** Paired tool_result duration in ms, if the underlying result tracks it.
   * We don't currently — rows fall back to startedAt→finishedAt math. */
  durationMs?: number | null;
  /** ISO finishedAt for completed rows; used to render "Xs ago" via
   * timeAgoShort on done rows. Running rows use startedAt for mm:ss. */
  finishedAt?: string;
}

/**
 * Walk `pieces` once and pair every tool_use with its matching tool_result
 * (if any) by toolUseId. Orphan tool_results (no preceding tool_use) are
 * ignored — they'd have no row to attach to anyway.
 *
 * Rows are returned in no particular order; the group renderer sorts them
 * (newest first within a group) so callers can trust display order.
 */
export function buildTaskRows(pieces: UIPiece[]): TaskRow[] {
  const resultsById = new Map<string, UIPiece & { kind: "tool_result" }>();
  for (const p of pieces) {
    if (p.kind === "tool_result") resultsById.set(p.toolUseId, p);
  }
  const rows: TaskRow[] = [];
  for (const p of pieces) {
    if (p.kind !== "tool_use") continue;
    const matched = resultsById.get(p.id);
    let state: TaskState = "running";
    if (matched) state = matched.isError ? "failed" : "done";
    rows.push({
      id: p.id,
      name: p.name,
      summary: summarizeToolInput(p.name, p.input),
      state,
      startedAt: p.createdAt,
      finishedAt: matched?.createdAt,
      durationMs: null,
    });
  }
  return rows;
}

/** Tool-specific best guess at the most user-facing input field, falling
 * back to a truncated JSON blob so we never produce an empty row. */
function summarizeToolInput(
  _name: string,
  input: Record<string, unknown>,
): string {
  const candidates = [
    "description",
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "prompt",
  ];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.length > 120 ? v.slice(0, 118) + "…" : v;
    }
  }
  const s = JSON.stringify(input);
  if (!s || s === "{}") return "";
  return s.length > 120 ? s.slice(0, 118) + "…" : s;
}

interface TaskGroup {
  /** Display label — "Subagents" for the pinned bucket, raw tool name
   * otherwise. */
  label: string;
  rows: TaskRow[];
}

function groupRows(rows: TaskRow[]): TaskGroup[] {
  const subagents: TaskRow[] = [];
  const byTool = new Map<string, TaskRow[]>();
  for (const r of rows) {
    if (SUBAGENT_TOOLS.has(r.name)) {
      subagents.push(r);
      continue;
    }
    const list = byTool.get(r.name);
    if (list) list.push(r);
    else byTool.set(r.name, [r]);
  }
  // Newest-first within a group. We don't have a reliable seq on every
  // UIPiece (pending / optimistic pieces can lack it) so we use the
  // position in the pieces array by proxy — rows were pushed in piece
  // order, so reverse gets us newest-first.
  const sortNewestFirst = (arr: TaskRow[]) => arr.slice().reverse();
  const out: TaskGroup[] = [];
  if (subagents.length > 0) {
    out.push({ label: "Subagents", rows: sortNewestFirst(subagents) });
  }
  const alpha = [...byTool.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, rs] of alpha) {
    if (rs.length > 0) out.push({ label: name, rows: sortNewestFirst(rs) });
  }
  return out;
}

export function TasksList({
  pieces,
  onReveal,
}: {
  pieces: UIPiece[];
  /** Scroll the main transcript to the source event when a row is clicked.
   * We only ever emit "tool-use-id"; approvals have their own card inline
   * and aren't listed here. */
  onReveal?: (attr: "tool-use-id", id: string) => void;
}) {
  const rows = useMemo(() => buildTaskRows(pieces), [pieces]);
  const groups = useMemo(() => groupRows(rows), [rows]);
  const hasRunning = rows.some((r) => r.state === "running");

  // Tick once a second while anything is running so mm:ss timers stay
  // fresh. We do a single panel-level interval instead of one per row —
  // cheap, and it stops as soon as nothing is running.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasRunning) return;
    const handle = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [hasRunning]);

  if (groups.length === 0) return <EmptyState />;

  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <TaskGroupView key={g.label} group={g} onReveal={onReveal} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div
        className="h-12 w-12 rounded-full bg-paper border border-line flex items-center justify-center mb-3"
        aria-hidden
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="w-5 h-5 text-ink-muted"
        >
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      </div>
      <div className="text-[13px] font-medium text-ink">No tool calls yet.</div>
      <div className="text-[12px] text-ink-muted max-w-[30ch] mt-1">
        As claude reaches for bash, edits, or search they'll show up here.
      </div>
    </div>
  );
}

function TaskGroupView({
  group,
  onReveal,
}: {
  group: TaskGroup;
  onReveal?: (attr: "tool-use-id", id: string) => void;
}) {
  return (
    <section>
      <div className="px-3 pt-3 pb-1.5 flex items-baseline gap-2">
        <span className="caps text-ink-soft">{group.label}</span>
        <span className="mono text-[11px] text-ink-muted">
          · {group.rows.length} {group.rows.length === 1 ? "run" : "runs"}
        </span>
      </div>
      {group.rows.map((row) => (
        <TaskRowView key={row.id} row={row} onReveal={onReveal} />
      ))}
    </section>
  );
}

function TaskRowView({
  row,
  onReveal,
}: {
  row: TaskRow;
  onReveal?: (attr: "tool-use-id", id: string) => void;
}) {
  const tint = rowTint(row.state);
  const right = renderRightLabel(row);
  return (
    <div
      className={cn(
        "mx-3 mb-1.5 rounded-[10px] border overflow-hidden relative",
        tint.border,
        tint.bg,
      )}
    >
      {/* 3px colored left strip — status indicator. */}
      <div
        aria-hidden
        className={cn("absolute left-0 top-0 bottom-0 w-[3px]", tint.strip)}
      />
      <button
        type="button"
        onClick={() => onReveal?.("tool-use-id", row.id)}
        className="w-full pl-3 pr-2.5 py-2 flex items-center gap-2 text-left hover:bg-paper/40"
        title={row.summary || row.name}
      >
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 h-5 rounded-[4px] border mono text-[10px] shrink-0",
            tint.chip,
          )}
        >
          {row.name}
        </span>
        <StatusIcon state={row.state} />
        <span className="text-[12.5px] text-ink truncate flex-1">
          {row.summary || (
            <span className="text-ink-muted italic">(no description)</span>
          )}
        </span>
        <span
          className={cn(
            "mono text-[10px] shrink-0 tabular-nums",
            row.state === "failed" ? "text-danger" : "text-ink-muted",
          )}
          title={row.startedAt ? new Date(row.startedAt).toLocaleString() : undefined}
        >
          {right}
        </span>
      </button>
    </div>
  );
}

function StatusIcon({ state }: { state: TaskState }) {
  if (state === "running") {
    return (
      <Loader2
        className="w-3 h-3 text-klein animate-spin shrink-0"
        aria-hidden
      />
    );
  }
  if (state === "failed") {
    return (
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
    );
  }
  return (
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
  );
}

function rowTint(state: TaskState): {
  strip: string;
  bg: string;
  border: string;
  chip: string;
} {
  if (state === "failed") {
    return {
      strip: "bg-danger/70",
      bg: "bg-danger-wash/40",
      border: "border-danger/25",
      chip: "border-danger/30 text-danger bg-canvas/70",
    };
  }
  if (state === "running") {
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

/**
 * Right-side label: mm:ss live timer while running, timeAgoShort on done,
 * "error" on failed. We prefer the started-at ISO for the running timer
 * because the underlying UIPiece doesn't surface a monotonic start — we
 * wall-clock against Date.now() and let the parent's 1s interval tick us.
 */
function renderRightLabel(row: TaskRow): string {
  if (row.state === "failed") return "error";
  if (row.state === "running") {
    if (!row.startedAt) return "running";
    return formatElapsedClock(row.startedAt);
  }
  // done — prefer the tool_result createdAt so the label reads like a
  // "finished N ago", not "started N ago". Falls back to startedAt if the
  // paired result's createdAt is missing (older events).
  return timeAgoShort(row.finishedAt ?? row.startedAt ?? null);
}

/** mm:ss elapsed from an ISO start — compact, tabular-nums caller. */
function formatElapsedClock(startedAtIso: string): string {
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started)) return "—";
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
