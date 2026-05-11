import { useEffect, useState } from "react";
import { Users, X } from "lucide-react";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import { cn } from "@/lib/cn";
import { SubagentsPanel } from "@/components/SubagentsPanel";
import type { SubagentRun } from "@/state/sessions";

/**
 * Dedicated Subagents surface (mockup s-18). Twin of PlanSheet — same
 * two-mode rendering so the caller can pick the right presentation:
 *
 *   - `"overlay"` (default, mobile): modal bottom sheet with backdrop.
 *     `md:hidden` so desktop never renders this path.
 *   - `"rail"` (desktop): in-flow `<aside>` that pushes `<main>` aside
 *     instead of covering it — the live transcript keeps streaming next
 *     to the panel. `hidden md:flex` so mobile never renders this path.
 *
 * Opens from the SubagentsStrip, the in-thread indigo "Agent started →
 * view" pointer, and a `Users` icon in the session header. Tasks rail
 * stays tools-only; this is the only surface that renders subagent runs.
 *
 * Overlay closes on: backdrop tap, Esc, or the × button. Rail only
 * closes on the × button — it's not modal. Zero-runs case still mounts
 * (the strip hides itself at zero, but we keep the empty-state card for
 * when someone opens the surface via the header icon while no runs have
 * happened yet — reinforces "this is where agents would live").
 */
export function SubagentsSheet({
  runs,
  sessionId,
  onRevealToolUse,
  onClose,
  variant = "overlay",
}: {
  runs: SubagentRun[];
  /** Parent session id — threaded through to the panel so each run card
   *  can render a deep-link to the full-page `/session/:id/subagent/:taskId`
   *  standalone view. */
  sessionId: string;
  onRevealToolUse?: (toolUseId: string) => void;
  onClose: () => void;
  /**
   * `"overlay"` renders a fixed, modal sheet (mobile). `"rail"` renders
   * a flex-sibling `<aside>` that pushes the main chat column rather
   * than covering it (desktop).
   */
  variant?: "overlay" | "rail";
}) {
  const isRail = variant === "rail";

  useFocusReturn(!isRail);

  // `follow` is a UI-only stub for now — the mockup shows the toggle in
  // the header but auto-scroll-follow of the live stream is out of scope
  // for this change. Flip it visually; wire it to the timeline scroller
  // in a follow-up.
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (isRail) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, isRail]);

  const running = runs.filter((r) => r.status === "running");
  const liveCount = running.length;
  const totalCount = runs.length;
  const hasRunning = liveCount > 0;
  const runningDesc =
    running
      .map((r) => r.description?.trim() || "")
      .find((d) => d.length > 0) ?? "";
  const displayTitle =
    totalCount === 0
      ? "No delegated runs yet"
      : hasRunning
        ? runningDesc ||
          (liveCount === 1 ? "One sub-agent, live." : `${liveCount} sub-agents, live.`)
        : `${totalCount} ${totalCount === 1 ? "run" : "runs"} · all finished`;

  const header = (
    <div className="px-4 md:px-5 pt-3 md:pt-4 pb-3 border-b border-line flex items-start gap-3 shrink-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-indigo/30 bg-indigo-wash text-indigo text-[10px] font-medium uppercase tracking-[0.1em]">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                hasRunning ? "bg-indigo animate-pulse" : "bg-indigo/50",
              )}
              aria-hidden
            />
            Agents
          </span>
          <span className="caps text-ink-muted">
            {totalCount === 0
              ? "empty"
              : hasRunning
                ? `${liveCount} live · ${totalCount} total`
                : `${totalCount} total`}
          </span>
          <label
            className="ml-auto inline-flex items-center gap-1 mono text-[10px] text-ink-muted select-none cursor-pointer"
            title="Auto-scroll the live stream — stub for now."
          >
            <input
              type="checkbox"
              className="sr-only"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            <span
              className={cn(
                "h-3 w-6 rounded-full relative transition-colors",
                follow ? "bg-indigo" : "bg-line-strong",
              )}
              aria-hidden
            >
              <span
                className={cn(
                  "absolute top-[1px] h-2.5 w-2.5 rounded-full bg-canvas transition-all",
                  follow ? "right-[1px]" : "left-[1px]",
                )}
              />
            </span>
            follow
          </label>
        </div>
        <div className="display text-[18px] md:text-[22px] leading-tight mt-1">
          {displayTitle}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close subagents"
        className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
      >
        <X className="w-3.5 h-3.5 text-ink-soft" aria-hidden />
      </button>
    </div>
  );

  const body = (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {runs.length === 0 ? (
        <EmptyState />
      ) : (
        <SubagentsPanel
          runs={runs}
          sessionId={sessionId}
          variant="embedded"
          onRevealToolUse={
            onRevealToolUse
              ? (id) => {
                  onRevealToolUse(id);
                  onClose();
                }
              : undefined
          }
          onNavigate={onClose}
        />
      )}
    </div>
  );

  if (isRail) {
    return (
      <aside
        aria-label="Subagents"
        className="hidden md:flex w-[420px] shrink-0 border-l border-line bg-canvas flex-col min-h-0 h-full"
      >
        {header}
        {body}
      </aside>
    );
  }

  return (
    <div
      className="md:hidden fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] flex items-end"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Subagents"
        className="w-full bg-canvas border-t border-line rounded-t-[20px] shadow-lift flex flex-col max-h-[85vh] min-h-[55vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag-handle strip — mobile only. */}
        <div className="flex justify-center pt-3 shrink-0">
          <span className="h-1 w-12 bg-line-strong rounded-full" aria-hidden />
        </div>
        {header}
        {body}
      </div>
    </div>
  );
}

function EmptyState() {
  // Matches mockup s-18 "Empty state" card (lines ~4269–4275). Dashed
  // border so the user reads "not yet" rather than "empty error".
  return (
    <div className="p-4">
      <div className="rounded-[10px] border border-dashed border-line-strong bg-paper/40 px-3 py-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded-[4px] border border-line bg-canvas mono text-[10px] text-ink-muted uppercase tracking-[0.08em]">
          <Users className="w-2.5 h-2.5" aria-hidden />
          Agents
        </span>
        <span className="text-[12.5px] text-ink-muted">
          No delegated runs yet — the drawer fills the moment Claude calls{" "}
          <span className="mono text-[12px]">Agent</span> or{" "}
          <span className="mono text-[12px]">Task</span>.
        </span>
      </div>
    </div>
  );
}
