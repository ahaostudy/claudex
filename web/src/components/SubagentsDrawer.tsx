import { useEffect } from "react";
import { X } from "lucide-react";
import { SubagentsContent } from "@/components/SubagentsContent";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * Mobile bottom-sheet Subagents drawer for the Chat screen.
 *
 * Matches the overlay pattern from mockup s-05 (dim backdrop + drawer pinned
 * to the bottom, pushed up to cover most of the viewport) and the visual
 * frame from s-13 (rounded-t, drag handle strip, caps "Subagents" header
 * with a count + close button).
 *
 * Closes on:
 *   - backdrop tap
 *   - Esc key
 *   - the × button in the header
 * Focus is restored to whatever opened the drawer via `useFocusReturn`.
 *
 * The inner list is SubagentsContent (shared with the desktop rail) — this
 * wrapper is purely chrome.
 */
export function SubagentsDrawer({
  sessionId,
  onClose,
}: {
  sessionId: string;
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

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] flex items-end justify-center"
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
        {/* Drag handle strip — matches s-13 iPhone frame. Purely decorative. */}
        <div className="flex justify-center pt-3 shrink-0">
          <span className="h-1 w-12 bg-line-strong rounded-full" aria-hidden />
        </div>
        {/* Header row with a close button. The inner content's own header is
            not used on mobile because the close affordance needs to live at
            the drawer-frame level for thumb reach. Instead, SubagentsContent
            renders its caps "Subagents" strip as part of the list header;
            we rely on that. We skip a duplicate title here to keep it clean
            — the close button sits flush with the top-right corner. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close subagents"
          className="absolute top-3 right-3 h-8 w-8 rounded-[6px] border border-line bg-canvas flex items-center justify-center"
        >
          <X className="w-4 h-4 text-ink-soft" aria-hidden />
        </button>
        <div className="flex-1 min-h-0 flex flex-col">
          <SubagentsContent sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}
