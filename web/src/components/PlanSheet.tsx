import { useEffect } from "react";
import { ListChecks, X } from "lucide-react";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import type { PlanSnapshot } from "@/lib/todos";
import { PlanPanel } from "@/components/PlanPanel";

/**
 * Full "Plan" list as a modal surface. Mobile renders it as a
 * bottom sheet (the claudex canonical pattern — see TasksDrawer); desktop
 * renders the exact same DOM as a right-edge slide-over so a click on the
 * sticky Plan strip feels anchored to where the strip lives. Close on:
 *   - backdrop tap
 *   - Esc
 *   - header × button
 *   - clicking a row that calls `onReveal` (the sheet dismisses itself so
 *     the transcript scroll is actually visible behind the old overlay)
 *
 * The header carries a progress ring + "N of M done" + an archaic
 * TodoWrite seq link for power users. The body is `<PlanPanel />` so the
 * visual stays in one place; the footer is intentionally in PlanPanel,
 * not here, to keep this wrapper thin.
 */
export function PlanSheet({
  snapshot,
  onReveal,
  onClose,
}: {
  snapshot: PlanSnapshot;
  onReveal?: (seq: number) => void;
  onClose: () => void;
}) {
  useFocusReturn();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const { done, total } = snapshot;
  const pct = total > 0 ? done / total : 0;

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] flex items-end md:items-stretch md:justify-end"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Plan"
        className="w-full md:w-[400px] bg-canvas border-t md:border-t-0 md:border-l border-line rounded-t-[20px] md:rounded-none shadow-lift flex flex-col max-h-[85vh] md:max-h-screen md:h-full min-h-[55vh] md:min-h-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag-handle strip — mobile only; desktop slide-over doesn't
            need it. */}
        <div className="md:hidden flex justify-center pt-3 shrink-0">
          <span className="h-1 w-12 bg-line-strong rounded-full" aria-hidden />
        </div>
        <div className="px-4 md:px-5 pt-3 md:pt-4 pb-3 border-b border-line flex items-start gap-3 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-klein/30 bg-klein-wash text-klein-ink text-[10px] font-medium uppercase tracking-[0.1em]">
                <ListChecks className="w-2.5 h-2.5" aria-hidden />
                Plan
              </span>
              <span className="caps text-ink-muted">
                {total === 0 ? "empty" : `${done} of ${total} done`}
              </span>
            </div>
            <div className="display text-[18px] md:text-[20px] leading-tight mt-1">
              {total === 0
                ? "No plan yet"
                : snapshot.current?.activeForm ||
                  snapshot.current?.content ||
                  "Plan complete"}
            </div>
          </div>
          {total > 0 && (
            <ProgressRing pct={pct} />
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close plan"
            className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            <X className="w-3.5 h-3.5 text-ink-soft" aria-hidden />
          </button>
        </div>
        <PlanPanel
          snapshot={snapshot}
          onReveal={
            onReveal
              ? (seq) => {
                  onReveal(seq);
                  onClose();
                }
              : undefined
          }
          className="flex-1 min-h-0"
        />
      </div>
    </div>
  );
}

function ProgressRing({ pct }: { pct: number }) {
  // 36px ring, matches mockup s-16 sheet header.
  const size = 36;
  const r = 15;
  const cx = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct);
  return (
    <svg width={size} height={size} aria-hidden>
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke="#e8e4d8"
        strokeWidth={3}
      />
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke="#cc785c"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${cx} ${cx})`}
      />
    </svg>
  );
}
