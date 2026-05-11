import { useEffect } from "react";
import { ListChecks, X } from "lucide-react";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import type { PlanSnapshot } from "@/lib/todos";
import { PlanPanel } from "@/components/PlanPanel";

/**
 * Full "Plan" list surface. Two render modes driven by `variant`:
 *
 *   - `"overlay"` (default, mobile path): bottom sheet with backdrop +
 *     backdrop-click-to-close + Esc. Marked `md:hidden` so desktop never
 *     renders the overlay path even if both variants are mounted.
 *   - `"rail"` (desktop path): in-flow `<aside>` pushed alongside `<main>`,
 *     no backdrop, no blur, no modal semantics. Keeps the live transcript
 *     visible next to the plan so the user doesn't lose streaming output.
 *     Uses `hidden md:flex` so it never appears on mobile.
 *
 * Close on:
 *   - backdrop tap (overlay only)
 *   - Esc (overlay only)
 *   - header × button
 *   - clicking a row that calls `onReveal` (the surface dismisses itself so
 *     the transcript scroll is actually visible behind the old overlay)
 *
 * The header carries a progress ring + "N of M done". The body is
 * `<PlanPanel />` so the visual stays in one place; the footer is
 * intentionally in PlanPanel, not here, to keep this wrapper thin.
 */
export function PlanSheet({
  snapshot,
  onReveal,
  onClose,
  variant = "overlay",
}: {
  snapshot: PlanSnapshot;
  onReveal?: (seq: number) => void;
  onClose: () => void;
  /**
   * `"overlay"` renders a fixed, modal bottom-sheet/slide-over (mobile).
   * `"rail"` renders a flex-sibling `<aside>` that pushes the main chat
   *  column rather than covering it (desktop) — preferred when the user
   *  wants to keep watching live chat output while the plan is open.
   */
  variant?: "overlay" | "rail";
}) {
  const isRail = variant === "rail";

  // Focus return + Esc dismissal are only meaningful for the overlay —
  // the rail is not modal, so pressing Esc mid-typing should not close it,
  // and focus management stays with whatever the user is doing in the
  // transcript / composer.
  useFocusReturn(!isRail);

  useEffect(() => {
    if (isRail) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, isRail]);

  const { done, total } = snapshot;
  const pct = total > 0 ? done / total : 0;

  const header = (
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
      {total > 0 && <ProgressRing pct={pct} />}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close plan"
        className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
      >
        <X className="w-3.5 h-3.5 text-ink-soft" aria-hidden />
      </button>
    </div>
  );

  const body = (
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
  );

  if (isRail) {
    // Desktop push-mode sidebar. `hidden md:flex` keeps mobile on the
    // overlay path. Fixed 400px width matches the previous slide-over so
    // the panel body doesn't reflow when flipping between variants.
    return (
      <aside
        aria-label="Plan"
        className="hidden md:flex w-[400px] shrink-0 border-l border-line bg-canvas flex-col min-h-0 h-full"
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
        aria-label="Plan"
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
