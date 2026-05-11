// ---------------------------------------------------------------------------
// Per-message action row.
//
// Rendered as an absolutely-positioned overlay at the tail end of user /
// assistant_text / tool_result bubbles in Chat.tsx. Hidden by default —
// appears on hover (desktop) or when the parent bubble has been tapped
// (mobile). Because the row is absolute, it never reserves vertical flow
// space, so consecutive messages keep a uniform gap regardless of whether
// the row is present.
//
// Parent owns a single `revealedSeq` and passes `revealed` down so only one
// bubble ever shows its row at a time.
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
import { copyText } from "@/lib/clipboard";
import { api, ApiError } from "@/api/client";

async function copy(text: string, successMsg = "Copied"): Promise<void> {
  // copyText handles the async Clipboard API with a hidden-textarea
  // execCommand fallback — claudex runs over HTTP (frpc tunnel) where the
  // async API is unavailable.
  const ok = await copyText(text);
  toast(ok ? successMsg : "Copy failed");
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

/** Icon-only square button. Flat (no border), sits on the metadata line —
 * we want these to read as a row of subtle affordances, not a button bank. */
function ActionIcon({
  icon: Icon,
  onClick,
  title,
  disabled,
}: {
  icon: typeof Copy;
  onClick: () => void;
  title: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stop the click from bubbling up to the bubble wrapper's tap
        // handler — otherwise tapping would immediately toggle
        // `revealedSeq` back on, racing the `onActionComplete` clear.
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="h-6 w-6 rounded-[6px] flex items-center justify-center text-ink-faint hover:text-ink-soft hover:bg-paper disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
    >
      <Icon className="w-3.5 h-3.5" />
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
        // Don't reserve vertical space when idle — collapse to zero height
        // so consecutive pieces keep a uniform gap whether or not the row
        // is rendered. The row expands when `revealed` (click/tap on the
        // bubble, mobile and desktop both), or on sustained desktop hover
        // (see the delay-500 note below).
        //
        // A tiny top margin is applied only when expanded so the row hugs
        // the bubble without touching it.
        "overflow-hidden transition-[height,opacity] duration-100",
        // `revealed` drives the visible state on both mobile and desktop —
        // a click on the bubble toggles it at the Chat level. Previously
        // desktop had a hard `md:opacity-0` override and relied exclusively
        // on `:hover`, which flickered the row as the mouse tracked across
        // messages during scroll.
        revealed
          ? "h-6 opacity-100 mt-1 pointer-events-auto"
          : "h-0 opacity-0 mt-0 pointer-events-none",
        // Desktop also reveals on hover, but with a 500ms delay so
        // scroll-past mouse moves don't trigger it. When hover leaves, the
        // `group-hover:*` classes stop applying, delay drops back to 0, and
        // the row collapses immediately — so a brief hover during scroll
        // never starts the enter transition in the first place.
        "md:group-hover:h-6 md:group-hover:opacity-100 md:group-hover:mt-1 md:group-hover:pointer-events-auto md:group-hover:delay-500",
        // Keyboard focus (tabbing into an action) should be immediate — no
        // delay — so the user can actually see what they're focusing.
        "md:focus-within:h-6 md:focus-within:opacity-100 md:focus-within:mt-1 md:focus-within:pointer-events-auto md:focus-within:delay-0",
        "flex items-center gap-0.5",
        align === "end" ? "justify-end" : "justify-start",
      )}
    >
      <ActionIcon
        icon={Copy}
        title="Copy text"
        onClick={doCopyText}
      />
      {markdown != null && (
        <ActionIcon
          icon={FileCode}
          title="Copy as markdown"
          onClick={doCopyMarkdown}
        />
      )}
      <ActionIcon
        icon={LinkIcon}
        title="Copy permalink"
        onClick={doCopyPermalink}
      />
      {seq != null && (
        <ActionIcon
          icon={GitFork}
          title="Branch from here into a new session"
          onClick={() => void doFork()}
          disabled={forking}
        />
      )}
    </div>
  );
}
