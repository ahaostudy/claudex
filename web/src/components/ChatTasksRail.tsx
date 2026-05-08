import { useEffect, useMemo, useState } from "react";
import type { Session, UsageSummaryResponse } from "@claudex/shared";
import { api } from "@/api/client";
import { contextWindowTokens } from "@/lib/usage";
import { cn } from "@/lib/cn";
import type { UIPiece } from "@/state/sessions";

/**
 * Right-rail "Tasks" panel for the desktop Chat screen (mockup s-04,
 * lines 1072–1098). Two sections:
 *   1. Live view of in-flight and recently-completed tool_use events for
 *      the current session, each as a small card.
 *   2. A Context window footer with the same math as the Usage panel
 *      (`lastTurnInput / contextWindow(model)`).
 *
 * claudex doesn't model "tasks" as a first-class concept; we derive cards
 * directly from the existing transcript piece list. This keeps the feature
 * honest — no fake progress bars, no fabricated statuses.
 */
export function ChatTasksRail({
  session,
  pieces,
  pendingApprovalCount,
  onReveal,
  onClose,
}: {
  session: Session | null;
  pieces: UIPiece[];
  pendingApprovalCount: number;
  /**
   * Called when a task card is clicked. `attr` names the data-attribute to
   * query (e.g. `tool-use-id`, `approval-id`) so Chat can scroll to the
   * right DOM element. We don't pass refs down because the card list is
   * derived — the stable hook is the attribute selector.
   */
  onReveal?: (attr: "tool-use-id" | "approval-id", id: string) => void;
  onClose: () => void;
}) {
  // ----- Tasks list from tool_use / tool_result pairs -----
  const tasks = useMemo(() => buildTasks(pieces), [pieces]);
  const activeCount =
    tasks.filter((t) => t.state !== "done").length + pendingApprovalCount;

  // ----- Context window footer -----
  // Mirrors the Usage panel: ask the server for a pre-aggregated summary so
  // a 10k-event session doesn't cost us the full /events payload every time
  // a piece lands.
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getUsageSummary(session.id);
        if (cancelled) return;
        setUsage(res);
      } catch {
        // Fall back to zeros — the ring will render as unknown.
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch each time the transcript length changes meaningfully so the
    // ring updates after a turn_end lands. Cheap — the summary payload is
    // O(1) KB regardless of transcript size.
  }, [session?.id, session?.model, pieces.length]);

  const contextWindow = session ? contextWindowTokens(session.model) : 200_000;
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const pctKnown = usage?.lastTurnContextKnown ?? false;
  const pct = pctKnown
    ? Math.max(0, Math.min(1, lastTurnInput / contextWindow))
    : 0;
  const unknownReason =
    usage && usage.turnCount === 0
      ? "no turns yet"
      : "historical turn — cache fields not persisted; next turn will reflect real context";

  return (
    <aside className="hidden md:flex border-l border-line bg-paper/40 flex-col w-[300px] shrink-0 min-h-0">
      <div className="px-4 py-3 border-b border-line flex items-center">
        <span className="caps text-ink-muted">Tasks</span>
        <span className="ml-auto mono text-[11px] text-ink-muted">
          {activeCount > 0 ? `${activeCount} active` : "idle"}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Hide tasks rail"
          aria-label="Hide tasks rail"
          className="ml-2 h-6 w-6 rounded-[6px] hover:bg-canvas/60 flex items-center justify-center text-ink-muted"
        >
          ×
        </button>
      </div>
      <div className="p-3 space-y-2 overflow-y-auto flex-1 min-h-0">
        {tasks.length === 0 ? (
          <div className="text-[12px] text-ink-muted px-1">
            No tool calls yet. As claude reaches for bash, edits, or search
            they'll show up here.
          </div>
        ) : (
          tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              onReveal={onReveal}
            />
          ))
        )}
      </div>
      <div className="mt-auto p-3 border-t border-line">
        <div className="caps text-ink-muted mb-2">Context window</div>
        <div className="flex items-center gap-3" title={pctKnown ? undefined : unknownReason}>
          <ContextDonut pct={pct} known={pctKnown} />
          <div>
            <div className="text-[14px] font-medium">
              {pctKnown ? `${Math.round(pct * 100)}%` : "—"}
            </div>
            <div className="text-[11px] text-ink-muted">
              {pctKnown
                ? `${lastTurnInput.toLocaleString()} / ${contextWindow.toLocaleString()} tokens`
                : `— / ${contextWindow.toLocaleString()} tokens`}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Task derivation — walk the piece list once, pair tool_use with tool_result
// by toolUseId, and also surface permission_requests as "awaiting" cards.
// ---------------------------------------------------------------------------

type TaskState = "running" | "done" | "awaiting";
interface Task {
  id: string;
  name: string;
  summary: string;
  state: TaskState;
  // What to pass to onReveal when the card is clicked. We keep these
  // separate from `id` because the rail card id can be prefixed (e.g.
  // `perm-<approvalId>`) to avoid collisions across kinds.
  revealAttr: "tool-use-id" | "approval-id";
  revealId: string;
}

function buildTasks(pieces: UIPiece[]): Task[] {
  const resultsById = new Map<string, UIPiece & { kind: "tool_result" }>();
  for (const p of pieces) {
    if (p.kind === "tool_result") {
      resultsById.set(p.toolUseId, p);
    }
  }

  const tasks: Task[] = [];
  for (const p of pieces) {
    if (p.kind === "tool_use") {
      const matched = resultsById.get(p.id);
      tasks.push({
        id: p.id,
        name: p.name,
        summary: summarizeToolInput(p.name, p.input),
        state: matched ? "done" : "running",
        revealAttr: "tool-use-id",
        revealId: p.id,
      });
    } else if (p.kind === "permission_request") {
      tasks.push({
        id: `perm-${p.approvalId}`,
        name: `${p.toolName} · awaiting you`,
        summary: p.summary,
        state: "awaiting",
        revealAttr: "approval-id",
        revealId: p.approvalId,
      });
    }
  }

  // Newest first — the mockup shows active tasks on top, done below.
  return tasks.reverse();
}

function summarizeToolInput(
  name: string,
  input: Record<string, unknown>,
): string {
  // Tool-specific best guess at the most relevant field; fall back to a
  // truncated JSON blob so we never produce an empty card.
  const candidates = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
  ];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.length > 80 ? v.slice(0, 78) + "…" : v;
    }
  }
  const s = JSON.stringify(input);
  if (!s || s === "{}") return name;
  return s.length > 80 ? s.slice(0, 78) + "…" : s;
}

function TaskCard({
  task,
  onReveal,
}: {
  task: Task;
  onReveal?: (attr: "tool-use-id" | "approval-id", id: string) => void;
}) {
  const dot = cn(
    "h-1.5 w-1.5 rounded-full shrink-0",
    task.state === "running" && "bg-success animate-pulse",
    task.state === "awaiting" && "bg-warn",
    task.state === "done" && "bg-ink-faint",
  );
  const right =
    task.state === "running"
      ? "running"
      : task.state === "awaiting"
        ? "—"
        : "done";
  return (
    <button
      type="button"
      onClick={() => onReveal?.(task.revealAttr, task.revealId)}
      className={cn(
        "w-full text-left rounded-[8px] border border-line bg-canvas p-3 hover:bg-paper cursor-pointer",
        task.state === "done" && "opacity-80",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={dot} />
        <span className="mono text-[12px] text-ink-soft truncate">
          {task.name}
        </span>
        <span className="mono text-[11px] text-ink-muted ml-auto shrink-0">
          {right}
        </span>
      </div>
      <div className="text-[12px] mono text-ink-muted mt-1.5 line-clamp-2 break-all">
        {task.summary}
      </div>
    </button>
  );
}

function ContextDonut({ pct, known }: { pct: number; known: boolean }) {
  const r = 15.5;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);
  return (
    <svg width={38} height={38}>
      <circle cx={19} cy={19} r={r} fill="none" stroke="#e8e4d8" strokeWidth={3} />
      <circle
        cx={19}
        cy={19}
        r={r}
        fill="none"
        stroke={known ? "#cc785c" : "#cc785c55"}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 19 19)"
      />
    </svg>
  );
}
