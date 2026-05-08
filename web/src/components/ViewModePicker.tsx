import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ViewMode } from "@/state/sessions";

/**
 * Transcript view-mode picker. Rendered in the Chat header next to the gear.
 *
 * Mockup reference: screen 07 · Views. The desktop comparison shows three
 * columns labeled "Normal / Verbose / Summary"; on mobile the mockup pops a
 * single picker sheet with radio rows. We use a compact dropdown here so the
 * control stays inline with the header — closer to the desktop affordance
 * and friendlier than a cycling button (a blind tap doesn't reveal what the
 * next mode will be).
 *
 * Behavior:
 *   - Tap to open a small anchored menu below the button.
 *   - Tap a row to switch mode; the menu closes.
 *   - Outside-click or Escape closes the menu.
 */
export function ViewModePicker({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (ev: MouseEvent) => {
      if (!rootRef.current) return;
      if (ev.target instanceof Node && rootRef.current.contains(ev.target))
        return;
      setOpen(false);
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const label = MODE_LABEL[mode];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Transcript view mode"
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-8 px-2.5 rounded-[6px] border border-line bg-canvas text-[12px] text-ink-soft flex items-center gap-1.5 hover:bg-paper"
      >
        <span>{label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-20 w-[220px] rounded-[10px] border border-line bg-canvas shadow-lift p-1"
        >
          <div className="px-2 pt-1.5 pb-1 text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            Transcript view
          </div>
          {MODE_ORDER.map((value) => {
            const active = value === mode;
            return (
              <button
                key={value}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(value);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-start gap-2.5 px-2 py-2 rounded-[8px] text-left",
                  active
                    ? "bg-klein-wash/40 border border-klein/30"
                    : "hover:bg-paper/60 border border-transparent",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center",
                    active
                      ? "border-klein bg-klein text-canvas"
                      : "border-line-strong bg-canvas",
                  )}
                >
                  {active && <Check className="w-2.5 h-2.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium leading-tight">
                    {MODE_LABEL[value]}
                  </div>
                  <div className="text-[11px] text-ink-muted mt-0.5 leading-snug">
                    {MODE_DESCRIPTION[value]}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MODE_ORDER: ViewMode[] = ["normal", "verbose", "summary"];

const MODE_LABEL: Record<ViewMode, string> = {
  normal: "Normal",
  verbose: "Verbose",
  summary: "Summary",
};

const MODE_DESCRIPTION: Record<ViewMode, string> = {
  normal: "Tool calls + text. Thinking hidden.",
  verbose: "Every tool call, result, and thinking block.",
  summary: "Final replies + changes only.",
};
