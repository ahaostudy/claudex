// ---------------------------------------------------------------------------
// Per-message action row.
//
// Rendered alongside user / assistant_text / tool_result bubbles in Chat.tsx.
// Wraps into an absolutely-positioned row that stays hidden until the bubble's
// `group` wrapper is hovered (desktop) or the `…` popover is opened (mobile).
//
// We intentionally don't ship this on tool_use / thinking / permission_request
// pieces — those aren't user-addressable content and the actions would be
// awkward (a tool_use chip is a summary, not a message; permission_request is
// interactive).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { Copy, FileCode, Link as LinkIcon, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

async function copy(text: string, successMsg = "Copied"): Promise<void> {
  // Clipboard API is async and only works on secure contexts / focused docs.
  // Fall through to a failure toast if either condition isn't met — we do NOT
  // try a document.execCommand('copy') fallback because it needs a live
  // selection of DOM text, which we don't have here (the source is a prop).
  try {
    if (!navigator?.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    toast(successMsg);
  } catch {
    toast("Copy failed — try manual select");
  }
}

export interface MessageActionsProps {
  /** Plain text to copy when the user clicks "Copy text". */
  text: string;
  /** Raw Markdown source. Only passed for assistant_text pieces — when present,
   * enables the "Copy as markdown" action. */
  markdown?: string;
  /** Permalink target — the session id + seq are used to build
   * `${origin}/session/${sessionId}#seq-${seq}`. When `seq` is undefined
   * (e.g. an optimistic echo not yet persisted) we still permalink to the
   * session, dropping the anchor. */
  sessionId: string;
  seq?: number;
}

function buildPermalink(sessionId: string, seq?: number): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  const base = `${origin}/session/${sessionId}`;
  return seq != null ? `${base}#seq-${seq}` : base;
}

/** The flat button used on desktop for a single action. */
function ActionButton({
  icon: Icon,
  label,
  onClick,
  title,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="h-6 px-1.5 rounded-[4px] border border-line bg-paper/80 hover:bg-paper text-[11px] text-ink-muted inline-flex items-center gap-1"
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

export function MessageActions({
  text,
  markdown,
  sessionId,
  seq,
}: MessageActionsProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (ev: MouseEvent | TouchEvent) => {
      if (!menuRef.current) return;
      if (menuRef.current.contains(ev.target as Node)) return;
      setMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const doCopyText = () => {
    void copy(text);
    setMenuOpen(false);
  };
  const doCopyMarkdown = () => {
    if (markdown == null) return;
    void copy(markdown);
    setMenuOpen(false);
  };
  const doCopyPermalink = () => {
    const url = buildPermalink(sessionId, seq);
    void copy(url, "Permalink copied");
    setMenuOpen(false);
  };

  return (
    <>
      {/* Desktop: inline row at top-right of the bubble, visible on hover. */}
      <div
        className={cn(
          "hidden md:flex absolute right-0 top-0 -translate-y-1/2 gap-1",
          "opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity",
          "pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto",
        )}
      >
        <ActionButton
          icon={Copy}
          label="Copy"
          title="Copy text"
          onClick={doCopyText}
        />
        {markdown != null && (
          <ActionButton
            icon={FileCode}
            label="Markdown"
            title="Copy as markdown"
            onClick={doCopyMarkdown}
          />
        )}
        <ActionButton
          icon={LinkIcon}
          label="Link"
          title="Copy permalink"
          onClick={doCopyPermalink}
        />
      </div>

      {/* Mobile: single … button at top-right that opens a popover. */}
      <div ref={menuRef} className="md:hidden absolute right-0 top-0 -translate-y-1/2">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title="Message actions"
          aria-label="Message actions"
          aria-expanded={menuOpen}
          className="h-6 w-6 rounded-[4px] border border-line bg-paper/80 text-ink-muted inline-flex items-center justify-center"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 z-[60] min-w-[150px] rounded-[8px] border border-line bg-paper shadow-lift py-1"
            role="menu"
          >
            <PopoverItem icon={Copy} label="Copy text" onClick={doCopyText} />
            {markdown != null && (
              <PopoverItem
                icon={FileCode}
                label="Copy as markdown"
                onClick={doCopyMarkdown}
              />
            )}
            <PopoverItem
              icon={LinkIcon}
              label="Copy permalink"
              onClick={doCopyPermalink}
            />
          </div>
        )}
      </div>
    </>
  );
}

function PopoverItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-ink hover:bg-canvas text-left"
    >
      <Icon className="h-3.5 w-3.5 text-ink-muted" />
      <span>{label}</span>
    </button>
  );
}
