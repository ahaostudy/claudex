import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ViewMode } from "@/state/sessions";

/**
 * Transcript view-mode picker. Rendered in the Chat header next to the
 * model + mode pills.
 *
 * Mockup reference: screen 07 · View modes (lines 1390–1431). Both
 * breakpoints use the same stacked radio-card layout:
 *   - Mobile (< md): opens as a bottom sheet with backdrop (fixed inset-0).
 *   - Desktop (≥ md): opens as a popover anchored below the `Normal ⌄`
 *     header pill.
 *
 * Selected row: `border-klein bg-klein-wash/40` + filled klein radio.
 * Unselected: `border-line` + empty circle. Dismiss on backdrop click, Esc,
 * outside click (desktop), or by picking a row.
 */
const MODE_ORDER: ViewMode[] = ["normal", "verbose", "summary"];

const MODE_LABEL: Record<ViewMode, string> = {
  normal: "Normal",
  verbose: "Verbose",
  summary: "Summary",
};

const MODE_DESCRIPTION: Record<ViewMode, string> = {
  normal: "Tool calls collapsed into summaries, with full text responses.",
  verbose: "Every tool call, file read, and intermediate step Claude takes.",
  summary: "Only Claude's final responses and the changes it made.",
};

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Transcript view mode"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="h-8 px-2.5 rounded-[6px] border border-line bg-canvas text-[12px] text-ink-soft flex items-center gap-1.5 hover:bg-paper"
      >
        <span>{MODE_LABEL[mode]}</span>
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
      </button>

      {/* Desktop popover — anchored below the pill, constrained to the
          viewport via `max-w-[calc(100vw-1rem)]`. Hidden on < md because
          the mobile path is a full-width bottom sheet. */}
      {open && (
        <div className="hidden md:block absolute right-0 mt-1.5 z-30 w-[320px] max-w-[calc(100vw-1rem)] rounded-[10px] border border-line bg-canvas shadow-lift p-3">
          <ViewModePanel
            mode={mode}
            onChange={(m) => {
              onChange(m);
              setOpen(false);
            }}
          />
        </div>
      )}

      {/* Mobile bottom sheet — full-width, backdrop blurs the thread behind. */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 flex items-end justify-center"
          onClick={() => setOpen(false)}
        >
          <div className="absolute inset-0 bg-canvas/60 backdrop-blur-[2px]" />
          <div
            className="relative w-full bg-canvas border-t border-line rounded-t-[20px] shadow-lift"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex justify-center pt-3">
              <span className="h-1 w-12 bg-line-strong rounded-full" />
            </div>
            <div className="px-4 pt-3 pb-5">
              <ViewModePanel
                mode={mode}
                onChange={(m) => {
                  onChange(m);
                  setOpen(false);
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Inner panel shared by the desktop popover and mobile bottom sheet.
 * Stacked radio cards per mockup s-07, lines 1409–1425.
 */
function ViewModePanel({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (next: ViewMode) => void;
}) {
  return (
    <div>
      <div className="caps text-ink-muted">Transcript view</div>
      <h3 className="display text-[20px] leading-tight mt-1">
        How much detail?
      </h3>
      <div className="mt-3 space-y-2">
        {MODE_ORDER.map((value) => {
          const active = value === mode;
          return (
            <label
              key={value}
              className={cn(
                "flex items-start gap-3 p-3 rounded-[8px] border cursor-pointer",
                active
                  ? "border-klein bg-klein-wash/40"
                  : "border-line hover:bg-paper/40",
              )}
            >
              <input
                type="radio"
                name="view-mode"
                value={value}
                checked={active}
                onChange={() => onChange(value)}
                className="sr-only"
              />
              {active ? (
                <span className="h-4 w-4 mt-1 rounded-full border-2 border-klein bg-klein shrink-0">
                  <span className="block h-full w-full rounded-full border-2 border-canvas" />
                </span>
              ) : (
                <span className="h-4 w-4 mt-1 rounded-full border-2 border-line-strong bg-canvas shrink-0" />
              )}
              <div>
                <div className="text-[14px] font-medium">
                  {MODE_LABEL[value]}
                </div>
                <div className="text-[12px] text-ink-muted mt-0.5">
                  {MODE_DESCRIPTION[value]}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-3 text-[11px] text-ink-muted">
        <span>
          Cycle with{" "}
          <kbd className="inline-flex items-center justify-center h-4 px-1 rounded-[4px] border border-line-strong bg-paper text-[10px] mono">
            ⌃O
          </kbd>
        </span>
        <span className="ml-auto">Applies only to this session</span>
      </div>
    </div>
  );
}
