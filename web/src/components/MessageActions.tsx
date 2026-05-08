// ---------------------------------------------------------------------------
// Per-message action row.
//
// Rendered as a sibling BELOW user / assistant_text / tool_result bubbles in
// Chat.tsx. Hidden by default — appears on hover (desktop) or when the parent
// bubble has been tapped (mobile). The component is stateless about reveal:
// the parent owns a single `revealedSeq` and passes `revealed` down so only
// one bubble ever shows its row at a time.
//
// We intentionally don't ship this on tool_use / thinking / permission_request
// pieces — those aren't user-addressable content and the actions would be
// awkward (a tool_use chip is a summary, not a message; permission_request is
// interactive).
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, FileCode, GitFork, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { api, ApiError } from "@/api/client";

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
  /** Align the chip row with the bubble. User bubbles are right-aligned,
   * assistant / tool_result bubbles are left-aligned. */
  align?: "start" | "end";
  /** Mobile reveal override. When true, the row is forced visible regardless
   * of hover state; this is how the Chat-level `revealedSeq` pokes through
   * the default `opacity-0` on touch devices. Desktop still uses hover — the
   * `md:` hover classes override this (see the class list below). */
  revealed?: boolean;
  /** Called after any action runs. Chat uses it to clear `revealedSeq` so
   * the chips auto-dismiss once the user picked something. */
  onActionComplete?: () => void;
}

function buildPermalink(sessionId: string, seq?: number): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  const base = `${origin}/session/${sessionId}`;
  return seq != null ? `${base}#seq-${seq}` : base;
}

/** Rounded-full pill chip matching the composer chip rail. */
function ActionChip({
  icon: Icon,
  label,
  onClick,
  title,
  disabled,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the click from bubbling up to the bubble wrapper's tap
        // handler — otherwise tapping a chip would immediately toggle
        // `revealedSeq` back on, racing the `onActionComplete` clear.
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="h-8 min-w-[36px] px-3 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft hover:bg-paper disabled:opacity-50"
    >
      <Icon className="w-3.5 h-3.5" />
      <span>{label}</span>
    </button>
  );
}

export function MessageActions({
  text,
  markdown,
  sessionId,
  seq,
  align = "start",
  revealed = false,
  onActionComplete,
}: MessageActionsProps): JSX.Element {
  const [forking, setForking] = useState(false);
  const navigate = useNavigate();
  // Track mount so an in-flight fork request can't setState after unmount
  // (e.g. user navigates away mid-request). React will warn, and more
  // importantly, a stale `forking=true` could leak into the next instance
  // if this component were ever kept alive across session switches.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const done = () => {
    onActionComplete?.();
  };

  const doCopyText = () => {
    void copy(text);
    done();
  };
  const doCopyMarkdown = () => {
    if (markdown == null) return;
    void copy(markdown);
    done();
  };
  const doCopyPermalink = () => {
    const url = buildPermalink(sessionId, seq);
    void copy(url, "Permalink copied");
    done();
  };
  // Branch this session at `seq` into a new top-level session. The fork
  // copies every event with `seq <= this event.seq`, inherits project /
  // model / mode, and lands with a fresh SDK conversation — the assistant
  // has no memory of being forked. On success we navigate straight into
  // the new session so the user can keep going from the branch point.
  const doFork = async () => {
    if (forking || seq == null) return;
    setForking(true);
    try {
      const { session } = await api.forkSession(sessionId, { upToSeq: seq });
      toast("Branched into new session");
      done();
      navigate(`/session/${session.id}`);
    } catch (err) {
      const code =
        err instanceof ApiError ? err.code : "fork_failed";
      toast(
        code === "archived"
          ? "Can't branch from an archived session"
          : "Branch failed",
      );
      done();
    } finally {
      if (mounted.current) setForking(false);
    }
  };

  return (
    <div
      className={cn(
        // Rendered in normal flow as a sibling below the bubble. Tight top
        // margin so the chips hug the bubble without touching it.
        "flex gap-1 mt-1",
        align === "end" ? "justify-end" : "justify-start",
        // Default hidden. Mobile: parent flips `revealed` to force-show.
        // Desktop (md+): hover on the `group` wrapper wins unconditionally,
        // so the tap state is ignored — exactly what we want for pointer
        // devices where the bubble isn't tappable.
        "transition-opacity duration-150",
        revealed ? "opacity-100" : "opacity-0",
        "md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100",
        // Don't let the hidden row swallow clicks aimed at pieces behind it.
        revealed
          ? "pointer-events-auto"
          : "pointer-events-none md:group-hover:pointer-events-auto md:focus-within:pointer-events-auto",
      )}
    >
      <ActionChip
        icon={Copy}
        label="Copy"
        title="Copy text"
        onClick={doCopyText}
      />
      {markdown != null && (
        <ActionChip
          icon={FileCode}
          label="Markdown"
          title="Copy as markdown"
          onClick={doCopyMarkdown}
        />
      )}
      <ActionChip
        icon={LinkIcon}
        label="Link"
        title="Copy permalink"
        onClick={doCopyPermalink}
      />
      {seq != null && (
        <ActionChip
          icon={GitFork}
          label="Branch"
          title="Branch from here into a new session"
          onClick={() => void doFork()}
          disabled={forking}
        />
      )}
    </div>
  );
}
