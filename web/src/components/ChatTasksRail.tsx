import { useEffect, useMemo, useState } from "react";
import type { Session, UsageSummaryResponse } from "@claudex/shared";
import { api } from "@/api/client";
import { contextWindowTokens } from "@/lib/usage";
import type { UIPiece } from "@/state/sessions";
import { TasksList, buildTaskRows } from "@/components/TasksList";

/**
 * Right-rail "Tasks" panel for the desktop Chat screen (mockup s-04 and
 * s-13). Three stacked sections:
 *
 *   1. Header — "Tasks" label + an "N active / idle" counter that sums
 *      in-flight tool calls and pending permission prompts. A × button
 *      collapses the rail.
 *   2. Body — <TasksList /> grouped by tool type, with "Subagents"
 *      pinned to the top (Task / Agent / Explore) and every other tool
 *      rendered in its own alphabetical group (Bash / Edit / …). Shared
 *      with the mobile TasksDrawer so the two surfaces stay identical.
 *   3. Context window footer — same math as the Usage panel
 *      (`lastTurnInput / contextWindow(model)`), rendered as a small
 *      donut + "32% / 64,128 / 200,000 tokens". Load failures get a
 *      red dot instead of swallowing the error.
 *
 * claudex doesn't model "tasks" as a first-class concept — cards are
 * derived from the transcript piece list. This keeps the rail honest:
 * no fake progress bars, no fabricated statuses. `pendingApprovalCount`
 * is passed down so the header counter is truthful even when the only
 * in-flight work is awaiting the user.
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
   * Scroll the main transcript to the event that spawned a row when the
   * user clicks it. Only `tool-use-id` is emitted today; the approval
   * card lives in the transcript directly so it's not listed here.
   * `approval-id` remains in the signature for wire-compat with earlier
   * callers.
   */
  onReveal?: (attr: "tool-use-id" | "approval-id", id: string) => void;
  onClose: () => void;
}) {
  // ----- Header counter: running tool calls + pending approvals -----
  const activeCount = useMemo(() => {
    const rows = buildTaskRows(pieces);
    return rows.filter((r) => r.state === "running").length + pendingApprovalCount;
  }, [pieces, pendingApprovalCount]);

  // ----- Context window footer -----
  // Pre-aggregated summary: a 10k-event session shouldn't pay for the full
  // /events payload every time a piece lands.
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  // We distinguish "endpoint failed" from "we don't know the last turn's
  // context yet" so the donut can flag a real fetch failure separately
  // from an un-persisted historical turn.
  const [usageErr, setUsageErr] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getUsageSummary(session.id);
        if (cancelled) return;
        setUsage(res);
        setUsageErr(null);
      } catch (e) {
        if (cancelled) return;
        setUsageErr(e instanceof Error ? e.message : "load_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch when the transcript length changes so the ring refreshes
    // after a turn_end lands. Summary payload is O(1) KB regardless of
    // transcript size.
  }, [session?.id, session?.model, pieces.length]);

  const contextWindow = session ? contextWindowTokens(session.model) : 200_000;
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const pctKnown = usageErr ? false : (usage?.lastTurnContextKnown ?? false);
  const pct = pctKnown
    ? Math.max(0, Math.min(1, lastTurnInput / contextWindow))
    : 0;
  const unknownReason = usageErr
    ? `Failed to load usage: ${usageErr}`
    : usage && usage.turnCount === 0
      ? "no turns yet"
      : "historical turn — cache fields not persisted; next turn will reflect real context";

  // `onReveal` from TasksList is narrower than our prop; thread it through.
  const revealToolUse = onReveal
    ? (attr: "tool-use-id", id: string) => onReveal(attr, id)
    : undefined;

  return (
    <aside className="hidden md:flex border-l border-line bg-paper/40 flex-col w-[320px] shrink-0 min-h-0">
      <div className="px-4 py-3 border-b border-line flex items-center shrink-0">
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
      <div className="flex-1 overflow-y-auto min-h-0">
        <TasksList
          pieces={pieces}
          sessionId={session?.id}
          onReveal={revealToolUse}
        />
      </div>
      <div className="mt-auto p-3 border-t border-line shrink-0">
        <div className="caps text-ink-muted mb-2 flex items-center gap-1.5">
          <span>Context window</span>
          {usageErr && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-danger"
              title="Failed to load usage"
              aria-label="Failed to load usage"
            />
          )}
        </div>
        <div
          className="flex items-center gap-3"
          title={pctKnown ? undefined : unknownReason}
        >
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

function ContextDonut({ pct, known }: { pct: number; known: boolean }) {
  // 24px total; r=9.5 leaves 2.5px of padding for the stroke. The previous
  // 38px ring felt oversized next to the thin rail typography.
  const size = 24;
  const r = 9.5;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);
  return (
    <svg width={size} height={size}>
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke="#e8e4d8"
        strokeWidth={2.5}
      />
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke={known ? "#cc785c" : "#cc785c55"}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cx})`}
      />
    </svg>
  );
}
