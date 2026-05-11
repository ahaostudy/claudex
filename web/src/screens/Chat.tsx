import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GitCompareArrows,
  GitFork,
  ListChecks,
  Loader2,
  MessageCircle,
  MoreVertical,
  PanelRight,
  Paperclip,
  Pencil,
  Send,
  Settings2,
  StopCircle,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { ChatSessionsRail } from "@/components/ChatSessionsRail";
import { Logo } from "@/components/Logo";
import { ChatTasksRail } from "@/components/ChatTasksRail";
import { TasksDrawer } from "@/components/TasksDrawer";
import { PlanStrip } from "@/components/PlanStrip";
import { SubagentsStrip } from "@/components/SubagentsStrip";
import { PlanSheet } from "@/components/PlanSheet";
import { SubagentsSheet } from "@/components/SubagentsSheet";
import { selectLatestTodos } from "@/lib/todos";
import { useSessions } from "@/state/sessions";
import { useSubagentRuns } from "@/state/sessions";
import { api } from "@/api/client";
import type {
  AskUserQuestionAnnotation,
  Attachment,
  ModelId,
  PermissionMode,
  Project,
  Session,
  SlashClaudexAction,
} from "@claudex/shared";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import { DiffView, toolCallToDiff } from "@/components/DiffView";
import { diffForToolCall } from "@/lib/diff";
import { SessionSettingsSheet } from "@/components/SessionSettingsSheet";
import { AskUserQuestionCard } from "@/components/AskUserQuestionCard";
import { PlanAcceptCard } from "@/components/PlanAcceptCard";
import { SideChatDrawer } from "@/components/SideChatDrawer";
import { SlashCommandSheet, type PickerHandle } from "@/components/SlashCommandSheet";
import { FileMentionSheet } from "@/components/FileMentionSheet";
import { TerminalDrawer } from "@/components/TerminalDrawer";
import { ViewModePicker } from "@/components/ViewModePicker";
import { ContextRingButton, UsagePanel } from "@/components/UsagePanel";
import { Markdown } from "@/components/Markdown";
import { LinkPreview, firstHttpUrl } from "@/components/LinkPreview";
import { ImageLightbox } from "@/components/ImageLightbox";
import { MessageActions } from "@/components/MessageActions";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ToastHost, toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { summarizeToolCall, toolIcon } from "@/lib/tool-summary";
import type { SlashCommand } from "@/lib/slash-commands";
import { BUILTIN_FALLBACK_SLASH_COMMANDS } from "@/lib/slash-commands";
import type { UIPiece, ViewMode } from "@/state/sessions";
import { contextWindowTokens } from "@/lib/usage";
import { MODEL_LABEL } from "@/lib/pricing";
import { extractImagesFromText, type ImageRef } from "@/lib/images";
import { useVisualViewport } from "@/hooks/useVisualViewport";

// ---------------------------------------------------------------------------
// Model / mode label tables shared by the desktop header pills and the chat
// overflow sheet. Keep these in sync with NewSessionSheet in Home.
// ---------------------------------------------------------------------------
const MODEL_IDS: ModelId[] = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];
const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Ask",
  acceptEdits: "Accept",
  plan: "Plan",
  bypassPermissions: "Bypass",
  auto: "Auto",
};
const MODE_IDS: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

const VIEW_LABEL: Record<ViewMode, string> = {
  normal: "Normal",
  verbose: "Verbose",
  summary: "Summary",
};

// One-line description per mode, kept in sync with the desktop popover in
// ViewModePicker.tsx (mockup s-07 lines 1414–1422). Used by the mobile
// MoreSheet's "Transcript view" group so the picker feels the same shape
// on both breakpoints.
const VIEW_DESCRIPTION: Record<ViewMode, string> = {
  normal: "Tool calls collapsed into summaries, with full text responses.",
  verbose: "Every tool call, file read, and intermediate step Claude takes.",
  summary: "Only Claude's final responses and the changes it made.",
};

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // `sessionBase` holds the full session DTO we fetched via REST (title,
  // model, mode, tags, worktree path, etc). It's write-authoritative for
  // those fields and gets updated on explicit user edits (PATCH, settings
  // sheet). But `status` is driven entirely by the server via WS
  // `session_update` frames, which update the sessions store — the local
  // copy would otherwise go stale the moment claude starts running. See
  // `session` below: we merge the live status from the store over the
  // local base so every status-dependent render reacts to the wire.
  const [sessionBase, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showSideChat, setShowSideChat] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  // Mobile-only bottom-sheet for the per-session Tasks list. Desktop uses
  // the right-rail <ChatTasksRail /> instead (gated by `showTasks`).
  const [showTasksDrawer, setShowTasksDrawer] = useState(false);
  // Plan (TodoWrite) sheet — opened from the sticky PlanStrip, from the
  // inline chat pointer, and from the mobile header. One surface works
  // for both mobile (bottom sheet) and desktop (right slide-over); see
  // PlanSheet for the responsive DOM.
  const [showPlanSheet, setShowPlanSheet] = useState(false);
  // Subagents drawer (mockup s-18) — twin of PlanSheet. Opens from the
  // SubagentsStrip, the indigo "Agent started" pointer inside the
  // thread, and the Bot icon in the chat header.
  const [showSubagentsSheet, setShowSubagentsSheet] = useState(false);
  // Click-to-expand image overlay. Populated by the thumbnail click handlers
  // in Piece below — we hold the state here so the lightbox renders at the
  // Chat root, above every other drawer / sheet.
  const [lightbox, setLightbox] = useState<{
    images: ImageRef[];
    index: number;
  } | null>(null);
  // Mobile tap-to-reveal state for the per-message action row. Only one
  // bubble's chips can be shown at a time — tapping a different bubble flips
  // `revealedSeq` to that bubble's seq, and tapping the revealed bubble again
  // (or running an action) clears it. Desktop uses `group-hover` instead and
  // ignores this entirely (see MessageActions classes). Optimistic echoes
  // without a persisted seq can't be revealed via tap — acceptable tradeoff,
  // their chips only surface on desktop hover.
  const [revealedSeq, setRevealedSeq] = useState<number | null>(null);
  // iOS Safari collapses its layout viewport when the software keyboard
  // opens, which used to park the composer *under* the keyboard. We read
  // the visual viewport's bottom offset and lift the composer wrapper by
  // that many pixels on mobile (the `md:hidden` media check below no-ops
  // this on desktop where `offsetBottom` is always 0). A zero-offset path
  // leaves the desktop transform undefined so layout stays pristine.
  const { offsetBottom: kbOffset } = useVisualViewport();
  // Mobile three-dot menu — opens the full ChatMoreSheet bottom sheet.
  // Desktop has its own compact dropdown (DesktopMoreMenu) inside the
  // header that folds secondary actions (session diff / /btw / settings
  // / terminal) behind a single "⋯" so the header stays breathable on
  // tablet widths where the sessions + tasks rails are both open.
  const [showMore, setShowMore] = useState(false);
  // Desktop tasks rail visibility. Persisted across navigations so users
  // who prefer the condensed layout stay condensed. Mobile ignores this —
  // the rail itself is `hidden md:flex`. Default `false` since the Settings
  // rail (below) is the desktop default now — Tasks is on-demand.
  const [showTasks, setShowTasks] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("claudex.chat.tasksRail");
    if (stored === "0") return false;
    if (stored === "1") return true;
    return false;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "claudex.chat.tasksRail",
        showTasks ? "1" : "0",
      );
    } catch {
      /* private browsing etc. — ignore */
    }
  }, [showTasks]);
  // Desktop settings rail visibility — the new default persistent right
  // rail (mockup s-10). Mirrors the `showTasks` persistence so either rail
  // remembers the user's preference independently.
  const [showSettingsRail, setShowSettingsRail] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("claudex.chat.settingsRail");
    if (stored === "0") return false;
    if (stored === "1") return true;
    // Default: open at md+ (desktop), closed at narrower viewports. We
    // sample `matchMedia` once at mount; the rail component itself is
    // still hidden under md via Tailwind so this is just for desktop.
    return window.matchMedia("(min-width: 768px)").matches;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "claudex.chat.settingsRail",
        showSettingsRail ? "1" : "0",
      );
    } catch {
      /* private browsing etc. — ignore */
    }
  }, [showSettingsRail]);
  const {
    transcripts,
    transcriptMeta,
    init,
    ensureTranscript,
    loadOlderTranscript,
    subscribeSession,
    sendUserMessage,
    interruptSession,
    ensurePendingFor,
    resolvePermission,
    resolveAskUserQuestion,
    resolvePlanAccept,
    viewMode,
    setViewMode,
  } = useSessions();

  // Live status subscription from the global sessions store. Populated by
  // `session_update` WS frames (see state/sessions.ts). When present, it
  // overrides the stale `sessionBase.status` so the composer lock, status
  // dot, and status-gated UI all react to server-side transitions
  // (running / awaiting / idle / error) without waiting for a page reload.
  // Falls back to undefined when the store hasn't seen this session yet
  // (direct-nav / no Home visit); in that case we use the base status.
  const liveStatus = useSessions((s) =>
    id ? s.sessions.find((x) => x.id === id)?.status : undefined,
  );
  // Ensure the global sessions store knows about this session so live
  // `session_update` frames have a row to update. Fires once per id change.
  // Cheap — `/api/sessions` returns the full list and is an indexed query.
  const refreshSessions = useSessions((s) => s.refreshSessions);
  useEffect(() => {
    if (!id) return;
    // Skip if the store already has it (came from Home or a prior load).
    const present = useSessions.getState().sessions.some((x) => x.id === id);
    if (!present) void refreshSessions();
  }, [id, refreshSessions]);
  const session = useMemo<Session | null>(() => {
    if (!sessionBase) return null;
    return liveStatus !== undefined
      ? { ...sessionBase, status: liveStatus }
      : sessionBase;
  }, [sessionBase, liveStatus]);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!id) return;
    api.getSession(id).then((r) => {
      setSession(r.session);
      if (r.session.status === "running" || r.session.status === "awaiting") {
        ensurePendingFor(id);
      }
    });
    ensureTranscript(id);
    subscribeSession(id);
  }, [id, ensureTranscript, subscribeSession, ensurePendingFor]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (cancelled) return;
        const hit = r.projects.find((p) => p.id === session.projectId) ?? null;
        setProject(hit);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session?.projectId]);

  const pieces = id ? transcripts[id] ?? [] : [];
  const meta = id ? transcriptMeta[id] : undefined;

  const { visiblePieces, changes } = useMemo(
    () => applyViewMode(pieces, viewMode),
    [pieces, viewMode],
  );

  // Latest TodoWrite snapshot — drives the sticky PlanStrip, the PlanSheet,
  // and the inline lightweight pointer. Empty snapshot (total === 0)
  // hides every plan surface so we don't eat space on sessions that
  // never call TodoWrite. Recomputed O(n) walk when pieces change, but
  // the walk is a tight loop and pieces.length is bounded by the
  // transcript size the user is already paying for to render.
  const planSnapshot = useMemo(() => selectLatestTodos(pieces), [pieces]);
  // Subagent lifecycle rollup used by the SubagentsStrip (always mounted)
  // + the SubagentsPanel inside the rail/drawer. Memoized internally by
  // the store against the transcript array reference so re-renders on
  // every WS frame are cheap.
  const subagentRuns = useSubagentRuns(id ?? "");

  // Index of the newest user-message piece in the current visible list.
  // Drives the "Edit" affordance on that bubble only — older user turns
  // aren't editable because the truncation semantics only make sense for
  // the tail. Falls back to -1 when the visible list has no user piece
  // (pre-first-turn or Verbose-only reply).
  const lastUserVisibleIndex = useMemo(() => {
    for (let i = visiblePieces.length - 1; i >= 0; i--) {
      if (visiblePieces[i].kind === "user") return i;
    }
    return -1;
  }, [visiblePieces]);

  // Map a tool_use piece's id to its matching tool_result (if present in the
  // current visible list). Used to merge the two into a single collapsible
  // block: the `tool_use` branch reads the matched result from here; the
  // `tool_result` branch checks the matchedIds set and skips rendering to
  // avoid a duplicate bubble. Orphan tool_results (no preceding tool_use)
  // continue to render on their own.
  const { matchedResultByToolUseId, matchedToolUseIds } = useMemo(() => {
    const byId = new Map<string, { content: string; isError: boolean }>();
    const absorbed = new Set<string>();
    const seenToolUse = new Set<string>();
    for (const p of visiblePieces) {
      if (p.kind === "tool_use") {
        seenToolUse.add(p.id);
      } else if (p.kind === "tool_result" && p.toolUseId) {
        if (seenToolUse.has(p.toolUseId) && !byId.has(p.toolUseId)) {
          byId.set(p.toolUseId, { content: p.content, isError: p.isError });
          absorbed.add(p.toolUseId);
        }
      }
    }
    return { matchedResultByToolUseId: byId, matchedToolUseIds: absorbed };
  }, [visiblePieces]);

  // Any still-pending permission request for a diff-producing tool
  // (Edit / Write / MultiEdit) surfaces a "Review diff" klein chip in the
  // desktop header so the full-screen review page is one click away.
  // We derive this from the live transcript instead of calling
  // /pending-diffs — the permission pieces are already in memory.
  const pendingDiffApprovalId = useMemo(() => {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p.kind !== "permission_request") continue;
      const d = diffForToolCall(p.toolName, p.input);
      if (d) return p.approvalId;
    }
    return null;
  }, [pieces]);

  const scroller = useRef<HTMLDivElement>(null);
  // When a permalink hash is being resolved, we suppress tail-autoscroll so
  // it doesn't yank the viewport away from the target event while the
  // polling scroll-to-seq is still in flight. The hash-nav effect below
  // flips this on mount (and on hashchange) and releases it after the
  // target is scrolled or the 10-page lazy-load budget runs out.
  const hashScrollActiveRef = useRef(false);
  // Autoscroll-to-bottom only when pieces are appended at the tail, not when
  // older pages are prepended (lazy-load). We track the previous pieces
  // length; a decrease in tail-delta means older pieces landed, so we
  // explicitly skip the smooth-scroll. The loadOlder path anchors scroll
  // position itself (see onScroll).
  const prevTailLenRef = useRef(0);
  useEffect(() => {
    const list = id ? transcripts[id] ?? [] : [];
    const tail = list.length;
    const grew = tail > prevTailLenRef.current;
    prevTailLenRef.current = tail;
    // Also skip autoscroll on the very first render after an initial load —
    // we want to land at the bottom without a visible smooth animation.
    if (grew && !hashScrollActiveRef.current) {
      scroller.current?.scrollTo({
        top: scroller.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [visiblePieces.length, id, transcripts]);

  // One-shot: after the initial transcript load finishes, jump to the
  // bottom instantly so big imported sessions land at the tail. Skipped
  // when the URL carries a `#seq-N` anchor — the hash-nav effect below
  // handles that case and we don't want to race it to the bottom.
  const didInitialJumpRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !meta || meta.initialLoading) return;
    if (didInitialJumpRef.current === id) return;
    if (pieces.length === 0) return;
    didInitialJumpRef.current = id;
    if (/^#seq-\d+$/.test(location.hash)) return;
    // rAF so the browser has painted the rows once; otherwise
    // scrollHeight can be stale right after the state write.
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [id, meta?.initialLoading, pieces.length, location.hash]);

  // Keyboard-open autoscroll. When `kbOffset` jumps from 0 to a positive
  // value the iOS software keyboard has just appeared and the composer has
  // been lifted above it — scroll the transcript tail into view so the user
  // sees the latest message while they type. Desktop never sets kbOffset so
  // this is a mobile-only effect in practice.
  useEffect(() => {
    if (kbOffset <= 0) return;
    const el = scroller.current;
    if (!el) return;
    // rAF so the transform on the composer wrapper has actually landed
    // before we measure scrollHeight — avoids a one-frame mis-scroll.
    requestAnimationFrame(() => {
      if (!scroller.current) return;
      scroller.current.scrollTop = scroller.current.scrollHeight;
    });
  }, [kbOffset]);

  // Hash-anchored scroll-to-event. Permalinks from MessageActions / global
  // search look like `/session/<id>#seq-42`. We want that anchor to land
  // the transcript centered on the matching event, even if the event lives
  // on an older page that hasn't been lazy-loaded yet.
  //
  // Strategy:
  //   1. Poll the DOM for `[data-event-seq="N"]` every 120ms up to 2s —
  //      transcripts stream in asynchronously, so we can't just scroll
  //      once on mount. If found, scrollIntoView + flash ring for 1.2s.
  //   2. If not found and there's older history, call `loadOlderTranscript`
  //      up to 10 times until the element appears (or no more pages).
  //   3. Re-run on `hashchange` so in-session nav from GlobalSearchSheet
  //      works without a page reload.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function scrollToSeq(seq: number) {
      const container = scroller.current;
      if (!container) return;
      hashScrollActiveRef.current = true;
      const deadline = Date.now() + 2000;
      let olderLoads = 0;

      const find = () =>
        container.querySelector(`[data-event-seq="${seq}"]`) as
          | HTMLElement
          | null;

      try {
        while (!cancelled) {
          const el = find();
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            // Flash a klein ring for 1.2s so the user can spot the target
            // after the scroll settles. Added as literal classes so they
            // survive the removal step without other transitions kicking in.
            const flashClasses = [
              "ring-2",
              "ring-klein/60",
              "rounded-[10px]",
            ];
            el.classList.add(...flashClasses);
            window.setTimeout(() => {
              if (!cancelled) el.classList.remove(...flashClasses);
            }, 1200);
            return;
          }
          // Not yet in the DOM. If we still have budget, wait 120ms and retry.
          // If the poll window is up, try loading an older page (up to 10x)
          // before giving up — the target may live above the initial tail.
          if (Date.now() < deadline) {
            await new Promise((r) => window.setTimeout(r, 120));
            continue;
          }
          if (olderLoads >= 10) return;
          const m = id ? transcriptMeta[id] : undefined;
          if (!m || !m.hasMore || m.loadingOlder) return;
          olderLoads += 1;
          try {
            await loadOlderTranscript(id!);
          } catch {
            return;
          }
          // After loading, give the freshly prepended rows a tick to mount
          // before the next poll.
          await new Promise((r) => window.setTimeout(r, 60));
        }
      } finally {
        hashScrollActiveRef.current = false;
      }
    }

    function tryHash() {
      const m = /^#seq-(\d+)$/.exec(window.location.hash);
      if (!m) return;
      const seq = Number(m[1]);
      if (!Number.isFinite(seq)) return;
      void scrollToSeq(seq);
    }

    tryHash();
    window.addEventListener("hashchange", tryHash);
    return () => {
      cancelled = true;
      hashScrollActiveRef.current = false;
      window.removeEventListener("hashchange", tryHash);
    };
    // Re-run on session change AND on hash change via the listener. pieces
    // length is intentionally omitted — the internal poll covers that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, location.hash]);

  /**
   * Scroll-to-top trigger for lazy-loading older messages. We:
   *   1. record scrollHeight BEFORE the fetch,
   *   2. await the store action (which prepends pieces),
   *   3. measure scrollHeight AFTER the new pieces paint, and
   *   4. bump scrollTop by the delta so the user's visible window stays put.
   * This keeps the reading position stable while more history drops in.
   */
  const onScrollerScroll = () => {
    const el = scroller.current;
    if (!el || !id) return;
    if (!meta || !meta.hasMore || meta.loadingOlder) return;
    if (el.scrollTop >= 80) return;
    const beforeHeight = el.scrollHeight;
    loadOlderTranscript(id).finally(() => {
      // rAF so we measure after React commits the prepended pieces.
      requestAnimationFrame(() => {
        const cur = scroller.current;
        if (!cur) return;
        const delta = cur.scrollHeight - beforeHeight;
        if (delta > 0) cur.scrollTop = el.scrollTop + delta;
      });
    });
  };

  const [headerContext, setHeaderContext] = useState<{ pct: number; known: boolean }>({
    pct: 0,
    known: false,
  });
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const u = await api.getUsageSummary(session.id);
        if (cancelled) return;
        const w = contextWindowTokens(session.model);
        const pct = w > 0 && u.lastTurnContextKnown
          ? Math.min(1, u.lastTurnInput / w)
          : 0;
        setHeaderContext({ pct, known: u.lastTurnContextKnown });
      } catch {
        /* leave at last value */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.model, pieces.length]);

  // Helper: update a field on the session via the REST patch endpoint and
  // reflect the result in local state. Used by both the desktop header
  // pills and the mobile overflow sheet so they share one code path.
  async function patchSession(partial: {
    model?: ModelId;
    mode?: PermissionMode;
  }) {
    if (!id || !session) return;
    try {
      const r = await api.updateSession(id, partial);
      setSession(r.session);
    } catch {
      // Silent: the session settings sheet has a more explicit error UI.
      // Quick header changes degrade gracefully.
    }
  }

  if (!id) return null;

  const busy = session?.status === "running" || session?.status === "awaiting";
  const statusDot = cn(
    "h-2 w-2 rounded-full shrink-0",
    session?.status === "running" && "bg-success animate-pulse",
    session?.status === "cli_running" && "bg-klein animate-pulse",
    session?.status === "awaiting" && "bg-warn",
    session?.status === "idle" && "bg-ink-faint",
    session?.status === "archived" && "bg-line-strong",
    session?.status === "error" && "bg-danger",
    !session && "bg-line-strong",
  );
  const metaLine = (
    <>
      {project && (
        <>
          <span className="mono">{project.name}</span>
          <span>·</span>
        </>
      )}
      <span className="mono">
        {session ? MODEL_LABEL[session.model] ?? session.model : "—"}
      </span>
      <span>·</span>
      <span>{session ? MODE_LABEL[session.mode] ?? session.mode : "—"}</span>
    </>
  );

  return (
    // Full-viewport layout. On mobile it's a single flex column (the
    // existing behavior). On desktop (md+) the three-column grid from
    // mockup s-04 kicks in: 220px sessions rail · fluid center · 300px
    // tasks rail. The center column keeps its own flex-col so messages
    // scroll internally and the composer stays pinned.
    <div className="flex h-[100dvh] bg-canvas overflow-hidden">
      <ChatSessionsRail currentId={id} />
      <main className="flex flex-col flex-1 min-w-0 min-h-0">
      {/* Mobile header — shown below md breakpoint (mockup 860-868). */}
      <header className="md:hidden shrink-0 px-4 py-2.5 border-b border-line flex items-center gap-2 bg-canvas">
        <button
          type="button"
          onClick={() => navigate("/sessions")}
          className="h-9 w-9 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0"
          aria-label="Back to sessions"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={statusDot} />
            <div className="text-[14px] font-medium truncate">
              {session?.title ?? "Session"}
            </div>
            {session?.forkedFromSessionId ? (
              <span
                className="shrink-0 inline-flex items-center gap-1 px-1.5 h-[18px] rounded-[4px] border border-line bg-paper text-ink-muted text-[10px] font-medium"
                title="This session is a fork — claude has no memory of the parent turns beyond what's shown here."
              >
                <GitFork className="w-3 h-3" />
                Forked
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted mt-0.5">
            {metaLine}
          </div>
        </div>
        <ContextRingButton
          pct={headerContext.pct}
          known={headerContext.known}
          disabled={!session}
          onClick={() => setShowUsage(true)}
        />
        {subagentRuns.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSubagentsSheet(true)}
            disabled={!session}
            aria-label="Open subagents"
            title={
              subagentRuns.some((r) => r.status === "running")
                ? `Agents (${subagentRuns.filter((r) => r.status === "running").length} live)`
                : "Agents"
            }
            className={cn(
              "relative h-9 w-9 rounded-[8px] border flex items-center justify-center shrink-0 disabled:opacity-40",
              showSubagentsSheet
                ? "bg-indigo-wash/60 border-indigo/40 text-indigo"
                : "bg-paper border-line text-ink-soft hover:bg-paper",
            )}
          >
            <Bot className="w-4 h-4" />
            {subagentRuns.some((r) => r.status === "running") && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-indigo animate-pulse border border-canvas"
                aria-hidden
              />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowTasksDrawer(true)}
          disabled={!session}
          aria-label="Open tasks"
          title="Tasks"
          className="h-9 w-9 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0 disabled:opacity-40"
        >
          <Wrench className="w-4 h-4 text-ink-soft" />
        </button>
        <button
          type="button"
          onClick={() => setShowMore(true)}
          disabled={!session}
          className="h-9 w-9 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0 disabled:opacity-40"
          aria-label="More actions"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      </header>

      {/* Desktop header — shown at md+ (mockup 967-979). Pills are live
          dropdowns bound to PATCH /api/sessions/:id. */}
      <header className="hidden md:flex shrink-0 px-5 py-3 border-b border-line items-center gap-3 bg-canvas">
        <span className={statusDot} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-[14px] font-medium truncate">
              {session?.title ?? "Session"}
            </div>
            {session?.forkedFromSessionId ? (
              <span
                className="shrink-0 inline-flex items-center gap-1 px-1.5 h-[18px] rounded-[4px] border border-line bg-paper text-ink-muted text-[10px] font-medium"
                title="This session is a fork — claude has no memory of the parent turns beyond what's shown here."
              >
                <GitFork className="w-3 h-3" />
                Forked
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-muted mt-0.5">
            {metaLine}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {pendingDiffApprovalId && session?.status === "awaiting" && (
            <Link
              to={`/session/${id}/diff?approvalId=${encodeURIComponent(pendingDiffApprovalId)}`}
              className="h-8 px-2.5 rounded-[6px] bg-klein text-canvas text-[12px] font-medium flex items-center gap-1.5 shadow-card shrink-0 whitespace-nowrap"
              title="Review full diff"
            >
              <Check className="w-3.5 h-3.5" />
              Review diff
            </Link>
          )}
          <ViewModePicker mode={viewMode} onChange={setViewMode} />
          <PillPicker
            label={session ? MODEL_LABEL[session.model] ?? session.model : "—"}
            disabled={!session}
            items={MODEL_IDS.map((m) => ({
              id: m,
              label: MODEL_LABEL[m],
              active: session?.model === m,
            }))}
            onPick={(m) => patchSession({ model: m as ModelId })}
          />
          <PillPicker
            label={session ? MODE_LABEL[session.mode] ?? session.mode : "—"}
            disabled={!session}
            items={MODE_IDS.map((m) => ({
              id: m,
              label: MODE_LABEL[m],
              active: session?.mode === m,
            }))}
            onPick={(m) => patchSession({ mode: m as PermissionMode })}
          />
          <ContextRingButton
            pct={headerContext.pct}
            known={headerContext.known}
            disabled={!session}
            onClick={() =>
              session
                ? navigate(`/usage?session=${encodeURIComponent(session.id)}`)
                : undefined
            }
          />
          {/* Desktop overflow menu — collapses session diff, /btw, settings,
              terminal behind a single "⋯" so the header stays breathable on
              tablet widths (≈ 768–1100px) where the sessions + tasks rails
              compete for space. The tasks-rail toggle stays outside so the
              user can flick the right rail open/closed without a detour. */}
          <DesktopMoreMenu
            disabled={!session}
            onOpenSessionDiff={() =>
              session ? navigate(`/session/${id}/session-diff`) : undefined
            }
            onOpenSideChat={() => setShowSideChat(true)}
            onOpenTasks={() => setShowTasks(true)}
            onOpenTerminal={() => setShowTerminal(true)}
          />
          {subagentRuns.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSubagentsSheet((v) => !v)}
              aria-label="Open subagents"
              aria-pressed={showSubagentsSheet}
              title={
                subagentRuns.some((r) => r.status === "running")
                  ? `Agents (${subagentRuns.filter((r) => r.status === "running").length} live)`
                  : "Agents"
              }
              className={cn(
                "relative h-8 w-8 rounded-[6px] border flex items-center justify-center hover:bg-paper shrink-0",
                showSubagentsSheet
                  ? "bg-indigo-wash/60 border-indigo/40 text-indigo"
                  : "border-line bg-canvas text-ink-soft",
              )}
            >
              <Bot className="w-4 h-4" />
              {subagentRuns.some((r) => r.status === "running") && (
                <span
                  className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-indigo animate-pulse border border-canvas"
                  aria-hidden
                />
              )}
            </button>
          )}
          <button
            onClick={() => setShowSettingsRail((v) => !v)}
            title={
              showSettingsRail ? "Hide settings rail" : "Show settings rail"
            }
            aria-label="Toggle settings rail"
            aria-pressed={showSettingsRail}
            className={cn(
              "h-8 w-8 rounded-[8px] border flex items-center justify-center hover:bg-paper shrink-0",
              showSettingsRail
                ? "border-klein/30 bg-klein-wash/40 text-klein-ink"
                : "border-line bg-canvas text-ink-soft",
            )}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Plan strip — sticky under both mobile and desktop session
          headers. Hidden entirely when the session has no TodoWrite
          plan yet (PlanStrip returns null). Tapping opens PlanSheet
          (bottom sheet on mobile, right slide-over on desktop). */}
      <PlanStrip
        snapshot={planSnapshot}
        onOpen={() => setShowPlanSheet(true)}
      />

      {/* Subagents strip — same always-visible pattern as PlanStrip but
          for Task/Agent/Explore runs (s-17). Sits directly below the
          plan strip so the user can tell at a glance "my agent has 2
          subagents alive, they're doing X, Y". Tapping opens the Tasks
          drawer (mobile) / scrolls the Tasks rail into view (desktop)
          — same trigger as the header Tasks icon. */}
      <SubagentsStrip
        runs={subagentRuns}
        onOpen={() => setShowSubagentsSheet(true)}
      />

      {/* Messages — `flex-1 min-h-0` is the magic pair that lets the child
          scroller take the remaining column height. Without `min-h-0` a
          flex child would grow past the viewport and the composer would
          scroll out. */}
      <div
        ref={scroller}
        onScroll={onScrollerScroll}
        className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4 md:px-6 md:py-6 md:space-y-6"
      >
        {meta?.loadingOlder && (
          <div className="text-center text-[11px] text-ink-muted mono py-2">
            Loading older messages…
          </div>
        )}
        {meta?.initialLoading && pieces.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <div
              className="h-5 w-5 rounded-full border-2 border-line border-t-klein animate-spin"
              aria-hidden
            />
            <div className="text-[12px] text-ink-muted mono">
              Loading transcript…
            </div>
          </div>
        )}
        {!meta?.initialLoading &&
          visiblePieces.length === 0 &&
          viewMode !== "summary" && (
            <div className="text-[13px] text-ink-muted text-center py-8">
              Send your first message to wake claude up.
            </div>
          )}
        {visiblePieces.map((p, i) => (
          <Piece
            key={i}
            p={p}
            viewMode={viewMode}
            session={session}
            project={project}
            // The "edit last user message" pencil is only offered on the
            // newest user bubble — and only when the session is idle (a
            // running turn would race the server-side truncation). We
            // compute the flag inline so Piece doesn't have to know about
            // the whole transcript.
            isLastUserMessage={
              p.kind === "user" && lastUserVisibleIndex === i
            }
            canEdit={session?.status === "idle"}
            onEditLastUserMessage={
              id
                ? async (text) => {
                    // Server truncates events + broadcasts a refresh so
                    // the transcript reloads on its own via the WS +
                    // events refetch path. Propagate errors so the
                    // bubble-level editor can show a hint.
                    await api.editLastUserMessage(id, text);
                  }
                : undefined
            }
            onDecide={(approvalId, decision) =>
              id && resolvePermission(id, approvalId, decision)
            }
            onAnswerAskUserQuestion={(askId, answers, annotations) => {
              if (id) resolveAskUserQuestion(id, askId, answers, annotations);
            }}
            onDecidePlan={(planId, decision) => {
              if (id) resolvePlanAccept(id, planId, decision);
            }}
            onOpenLightbox={(images, index) => setLightbox({ images, index })}
            onOpenPlan={() => setShowPlanSheet(true)}
            onOpenSubagents={() => setShowSubagentsSheet(true)}
            revealedSeq={revealedSeq}
            onToggleReveal={(seq) =>
              setRevealedSeq((current) => (current === seq ? null : seq))
            }
            onClearReveal={() => setRevealedSeq(null)}
            matchedResult={
              p.kind === "tool_use"
                ? matchedResultByToolUseId.get(p.id) ?? null
                : null
            }
            isAbsorbedResult={
              p.kind === "tool_result" && matchedToolUseIds.has(p.toolUseId)
            }
          />
        ))}
        {/* Tail indicator — as long as the session is running, show three
            bouncing dots at the bottom so the user knows claude is working.
            A `pending` UIPiece already renders its own dots; only show this
            fallback when the tail isn't already one. */}
        {session?.status === "running" &&
          (visiblePieces.length === 0 ||
            visiblePieces[visiblePieces.length - 1].kind !== "pending") && (
            <RunningDots />
          )}
        {viewMode === "summary" && (
          <SummaryCards session={session} changes={changes} />
        )}
      </div>

      <Composer
        project={project}
        session={session}
        busy={busy}
        keyboardOffset={kbOffset}
        onSend={(text, attachmentIds) => {
          // Allow empty text when attachments are present (model can read
          // file contents via the @path prefix the server injects).
          if (!id) return;
          if (!text.trim() && (!attachmentIds || attachmentIds.length === 0))
            return;
          sendUserMessage(id, text, attachmentIds);
        }}
        onStop={() => id && interruptSession(id)}
        onOpenSideChat={() => setShowSideChat(true)}
        onClaudexAction={(action) => {
          // Route a picked `claudex-action` slash command to the local UI
          // instead of sending the token over the WS. Each case matches one
          // of the built-ins re-mapped in slash-commands.ts — new actions
          // need a case here or they'll silently no-op.
          switch (action) {
            case "open-session-settings":
              setShowSettings(true);
              return;
            case "open-model-picker":
              // No dedicated model picker yet; the session settings sheet
              // has a Model section at the top, which is the closest thing.
              setShowSettings(true);
              return;
            case "open-usage":
              // Mobile keeps the bottom-sheet Usage panel; desktop jumps
              // straight to the full `/usage` page scoped to this session.
              if (
                typeof window !== "undefined" &&
                window.matchMedia("(min-width: 768px)").matches &&
                session
              ) {
                navigate(`/usage?session=${encodeURIComponent(session.id)}`);
              } else {
                setShowUsage(true);
              }
              return;
            case "open-plugins-settings":
              navigate("/settings?tab=plugins");
              return;
            case "open-slash-help":
            case "clear-transcript":
              // Both are planned but not yet wired. Silent no-op — the
              // picker has already closed so the user sees nothing wrong
              // happen, which is better than an ad-hoc toast system we
              // don't have infra for.
              return;
          }
        }}
      />

      {showMore && session && (
        <ChatMoreSheet
          viewMode={viewMode}
          onPickViewMode={(m) => {
            setViewMode(m);
            setShowMore(false);
          }}
          onOpenSettings={() => {
            setShowMore(false);
            setShowSettings(true);
          }}
          onOpenSideChat={() => {
            setShowMore(false);
            setShowSideChat(true);
          }}
          onOpenTerminal={() => {
            setShowMore(false);
            setShowTerminal(true);
          }}
          onOpenSessionDiff={() => {
            setShowMore(false);
            navigate(`/session/${id}/session-diff`);
          }}
          onClose={() => setShowMore(false)}
        />
      )}
      {showSettings && session && (
        <SessionSettingsSheet
          session={session}
          project={project}
          onClose={() => setShowSettings(false)}
          onUpdated={(next) => setSession(next)}
        />
      )}
      {showSideChat && session && (
        <SideChatDrawer
          parentSession={session}
          onClose={() => setShowSideChat(false)}
        />
      )}
      {showTerminal && session && (
        <TerminalDrawer
          session={session}
          projectPath={project?.path ?? null}
          onClose={() => setShowTerminal(false)}
        />
      )}

      {showUsage && session && (
        <UsagePanel session={session} onClose={() => setShowUsage(false)} />
      )}
      </main>
      {showTasks && (
        <ChatTasksRail
          session={session}
          pieces={pieces}
          pendingApprovalCount={
            pieces.filter((p) => p.kind === "permission_request").length
          }
          onReveal={(attr, revealId) => {
            const el = scroller.current?.querySelector(
              `[data-${attr}="${CSS.escape(revealId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowTasks(false)}
        />
      )}
      {showSettingsRail && session && (
        <SessionSettingsSheet
          variant="rail"
          session={session}
          project={project}
          onClose={() => setShowSettingsRail(false)}
          onUpdated={(next) => setSession(next)}
        />
      )}
      {/* Desktop-only push-mode rails for Plan + Subagents. Mount alongside
          the Tasks / Settings rails so the live transcript stays visible
          beside the panel instead of being covered by a backdrop. Mobile
          keeps the overlay variants that render inside <main> above. Both
          rails are self-hidden under `md:` so mobile never double-renders. */}
      {showPlanSheet && (
        <PlanSheet
          variant="rail"
          snapshot={planSnapshot}
          onReveal={(seq) => {
            const el = scroller.current?.querySelector(
              `[data-event-seq="${String(seq)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowPlanSheet(false)}
        />
      )}
      {showSubagentsSheet && (
        <SubagentsSheet
          variant="rail"
          runs={subagentRuns}
          sessionId={id ?? ""}
          onRevealToolUse={(toolUseId) => {
            const el = scroller.current?.querySelector(
              `[data-tool-use-id="${CSS.escape(toolUseId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowSubagentsSheet(false)}
        />
      )}
      {showTasksDrawer && id && (
        <TasksDrawer
          pieces={pieces}
          sessionId={id}
          onReveal={(attr, revealId) => {
            const el = scroller.current?.querySelector(
              `[data-${attr}="${CSS.escape(revealId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowTasksDrawer(false)}
        />
      )}
      {showPlanSheet && (
        <PlanSheet
          snapshot={planSnapshot}
          onReveal={(seq) => {
            const el = scroller.current?.querySelector(
              `[data-event-seq="${String(seq)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowPlanSheet(false)}
        />
      )}
      {showSubagentsSheet && (
        <SubagentsSheet
          runs={subagentRuns}
          sessionId={id ?? ""}
          onRevealToolUse={(toolUseId) => {
            const el = scroller.current?.querySelector(
              `[data-tool-use-id="${CSS.escape(toolUseId)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowSubagentsSheet(false)}
        />
      )}
      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
      <ToastHost />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop header pill dropdowns — simple button + menu for the 3-state
// picks (model and permission mode). Click-outside + Esc close the menu.
// ---------------------------------------------------------------------------
function PillPicker({
  label,
  items,
  onPick,
  disabled,
}: {
  label: string;
  items: Array<{ id: string; label: string; active: boolean }>;
  onPick: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="h-8 px-2.5 rounded-[6px] border border-line bg-canvas text-[12px] text-ink-soft flex items-center gap-1 hover:bg-paper disabled:opacity-40 whitespace-nowrap"
      >
        <span className="mono whitespace-nowrap">{label}</span>
        <ChevronDown className="w-3 h-3 text-ink-muted shrink-0" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[180px] rounded-[10px] border border-line bg-canvas shadow-lift p-1"
        >
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitemradio"
              aria-checked={it.active}
              onClick={() => {
                onPick(it.id);
                setOpen(false);
              }}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-[6px] text-left text-[13px]",
                it.active
                  ? "bg-klein-wash/40 text-ink"
                  : "text-ink-soft hover:bg-paper/60",
              )}
            >
              <span
                className={cn(
                  "h-3.5 w-3.5 rounded-full border-2 shrink-0 flex items-center justify-center",
                  it.active
                    ? "border-klein bg-klein text-canvas"
                    : "border-line-strong bg-canvas",
                )}
              >
                {it.active && <Check className="w-2 h-2" />}
              </span>
              <span className="mono">{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop header overflow menu — compact popover (not a bottom sheet) that
// folds the session diff, /btw side chat, session settings, and terminal
// actions behind a single "⋯" button. Added because the desktop header
// was overflowing at tablet widths (≈ 768–1100px) with both the sessions
// and tasks rails open, causing the model pill (e.g. "Opus 4.7") to wrap
// mid-word. Keeps the full-width ChatMoreSheet (mobile) untouched.
// ---------------------------------------------------------------------------
function DesktopMoreMenu({
  disabled,
  onOpenSessionDiff,
  onOpenSideChat,
  onOpenTasks,
  onOpenTerminal,
}: {
  disabled?: boolean;
  onOpenSessionDiff: () => void;
  onOpenSideChat: () => void;
  onOpenTasks: () => void;
  onOpenTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        aria-label="More actions"
        className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center text-ink-soft hover:bg-paper disabled:opacity-40"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[220px] rounded-[10px] border border-line bg-canvas shadow-lift p-1"
        >
          <MenuRow
            icon={<GitCompareArrows className="w-4 h-4 text-ink-soft" />}
            label="Session diff"
            onClick={() => pick(onOpenSessionDiff)}
          />
          <MenuRow
            icon={<MessageCircle className="w-4 h-4 text-klein" />}
            label="Side chat (/btw)"
            onClick={() => pick(onOpenSideChat)}
          />
          <MenuRow
            icon={<ListChecks className="w-4 h-4 text-ink-soft" />}
            label="Tasks"
            onClick={() => pick(onOpenTasks)}
          />
          <MenuRow
            icon={<Terminal className="w-4 h-4 text-ink-soft" />}
            label="Open terminal"
            onClick={() => pick(onOpenTerminal)}
          />
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2.5 h-9 rounded-[6px] text-[13px] text-ink-soft hover:bg-paper text-left"
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mobile "more" bottom sheet — houses the buttons evicted from the mobile
// header (view mode, session settings, terminal, /btw side chat). Desktop
// uses the compact DesktopMoreMenu popover above instead, because a full
// bottom sheet is overkill when the overflow is only four items.
// ---------------------------------------------------------------------------
function ChatMoreSheet({
  viewMode,
  onPickViewMode,
  onOpenSettings,
  onOpenSideChat,
  onOpenTerminal,
  onOpenSessionDiff,
  onClose,
}: {
  viewMode: ViewMode;
  onPickViewMode: (m: ViewMode) => void;
  onOpenSettings: () => void;
  onOpenSideChat: () => void;
  onOpenTerminal: () => void;
  onOpenSessionDiff: () => void;
  onClose: () => void;
}) {
  const viewModes: ViewMode[] = ["normal", "verbose", "summary"];
  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end justify-center">
      <div role="dialog" aria-modal="true" aria-label="More actions" className="w-full bg-canvas border-t border-line rounded-t-[20px] shadow-lift p-4">
        <div className="flex justify-center mb-3">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>
        <div className="caps text-ink-muted mb-2">Transcript view</div>
        <div className="space-y-2 mb-4">
          {viewModes.map((m) => {
            const active = viewMode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => onPickViewMode(m)}
                className={cn(
                  "w-full flex items-start gap-3 p-3 rounded-[8px] border text-left",
                  active
                    ? "border-klein bg-klein-wash/40"
                    : "border-line bg-canvas hover:bg-paper/40",
                )}
                aria-pressed={active}
              >
                {active ? (
                  <span className="h-4 w-4 mt-1 rounded-full border-2 border-klein bg-klein shrink-0">
                    <span className="block h-full w-full rounded-full border-2 border-canvas" />
                  </span>
                ) : (
                  <span className="h-4 w-4 mt-1 rounded-full border-2 border-line-strong bg-canvas shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-[14px] font-medium">
                    {VIEW_LABEL[m]}
                  </div>
                  <div className="text-[12px] text-ink-muted mt-0.5">
                    {VIEW_DESCRIPTION[m]}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div className="caps text-ink-muted mb-2">Actions</div>
        <div className="space-y-1">
          <SheetAction
            icon={<MessageCircle className="w-4 h-4 text-klein" />}
            label="Side chat (/btw)"
            onClick={onOpenSideChat}
          />
          <SheetAction
            icon={<GitCompareArrows className="w-4 h-4 text-ink-soft" />}
            label="Session diff"
            onClick={onOpenSessionDiff}
          />
          <SheetAction
            icon={<Settings2 className="w-4 h-4 text-ink-soft" />}
            label="Session settings"
            onClick={onOpenSettings}
          />
          <SheetAction
            icon={<Terminal className="w-4 h-4 text-ink-soft" />}
            label="Open terminal"
            onClick={onOpenTerminal}
          />
        </div>
        <button
          onClick={onClose}
          className="mt-4 w-full h-11 rounded-[8px] border border-line text-[13px]"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function SheetAction({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 h-11 rounded-[8px] border border-line bg-canvas text-[14px] hover:bg-paper"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Piece({
  p,
  viewMode,
  session,
  project,
  onDecide,
  onAnswerAskUserQuestion,
  onDecidePlan,
  onOpenLightbox,
  onOpenPlan,
  onOpenSubagents,
  isLastUserMessage,
  canEdit,
  onEditLastUserMessage,
  revealedSeq,
  onToggleReveal,
  onClearReveal,
  matchedResult,
  isAbsorbedResult,
}: {
  p: UIPiece;
  viewMode: ViewMode;
  session: Session | null;
  project: Project | null;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
  onAnswerAskUserQuestion: (
    askId: string,
    answers: Record<string, string>,
    annotations?: Record<string, AskUserQuestionAnnotation>,
  ) => void;
  onDecidePlan: (planId: string, decision: "accept" | "reject") => void;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
  /** Open the session's plan sheet from an inline TodoWrite pointer.
   *  Omitted when the parent doesn't want to expose the quick-jump
   *  (e.g. embedded preview surfaces). */
  onOpenPlan?: () => void;
  /** Open the subagents drawer/rail from an inline Task/Agent/Explore
   *  pointer. Same omission rule as onOpenPlan. */
  onOpenSubagents?: () => void;
  /** True when this piece is the newest user_message currently visible. */
  isLastUserMessage?: boolean;
  /** True when the session is idle and the user can actually submit an edit. */
  canEdit?: boolean;
  /** Resolves after the server has accepted the edit. Caller handles the
   * subsequent refresh_transcript / events refetch. */
  onEditLastUserMessage?: (text: string) => Promise<void>;
  /** Shared mobile tap-to-reveal state. Only the bubble whose seq matches
   * `revealedSeq` shows its action chips; all others stay hidden until
   * hovered on desktop. */
  revealedSeq?: number | null;
  /** Tap handler — flips `revealedSeq` to this bubble's seq or clears it if
   * already revealed. No-op on desktop (reveal is driven by hover there). */
  onToggleReveal?: (seq: number) => void;
  /** Clears `revealedSeq` unconditionally. Called from inside action chips
   * so running an action dismisses the row. */
  onClearReveal?: () => void;
  /** For tool_use pieces: the tool_result content matched by toolUseId, if
   * present in the same visible list. Triggers the merged input+result
   * rendering. */
  matchedResult?: { content: string; isError: boolean } | null;
  /** For tool_result pieces: true when this result was absorbed into the
   * preceding tool_use's merged block — render nothing here to avoid a
   * duplicate bubble. */
  isAbsorbedResult?: boolean;
}) {
  // Verbose = everything expanded, no truncation. Normal = compact by default,
  // user can click to expand individual tool_use chips and tool_result blocks.
  // Summary mode never reaches this component for tool_use/tool_result, so we
  // only have to distinguish normal vs verbose here.
  const verbose = viewMode === "verbose";
  switch (p.kind) {
    case "user": {
      // User messages are rendered verbatim — never markdown-processed. If the
      // user typed literal `**` or backticks, they probably meant them. But a
      // user turn can still carry images (e.g. CLI synthetic turns that pasted
      // a screenshot), so extract those and render them as thumbs above the
      // (image-stripped) text.
      //
      // The "edit last user message" affordance is only wired on the newest
      // user bubble — older turns would need a cascading-edit UX we don't
      // ship today. Bubbles carrying attachments are also locked down
      // because the server refuses the edit (400 has_attachments), so we
      // detect the attachment case inline and demote the affordance to a
      // static hint.
      const hasAttachments =
        p.kind === "user" &&
        Array.isArray(p.attachments) &&
        p.attachments.length > 0;
      return (
        <UserBubble
          text={p.text}
          attachments={p.attachments}
          createdAt={p.createdAt ?? p.at}
          onOpenLightbox={onOpenLightbox}
          editable={
            !!isLastUserMessage &&
            !!canEdit &&
            !!onEditLastUserMessage &&
            !hasAttachments
          }
          attachmentLock={!!isLastUserMessage && hasAttachments}
          onSubmitEdit={onEditLastUserMessage}
          sessionId={session?.id ?? ""}
          seq={p.seq}
          revealed={p.seq != null && revealedSeq === p.seq}
          onToggleReveal={() => {
            if (p.seq != null) onToggleReveal?.(p.seq);
          }}
          onClearReveal={onClearReveal}
        />
      );
    }
    case "assistant_text": {
      const thisRevealed = p.seq != null && revealedSeq === p.seq;
      return (
        <div
          className="group relative max-w-[72ch] min-w-0"
          data-event-seq={p.seq}
          data-show-actions={thisRevealed ? "true" : "false"}
          onClick={() => {
            if (p.seq != null) onToggleReveal?.(p.seq);
          }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <Logo className="w-3.5 h-3.5" />
            <span className="mono text-[11px] text-ink-muted">claude</span>
          </div>
          <div className="md:[&_.markdown]:text-[15px] md:[&_.markdown]:leading-[1.65]">
            <Markdown source={p.text} />
          </div>
          {(() => {
            const previewUrl = firstHttpUrl(p.text);
            return previewUrl ? <LinkPreview url={previewUrl} /> : null;
          })()}
          {session?.id && (
            <MessageActions
              text={p.text}
              markdown={p.text}
              sessionId={session.id}
              seq={p.seq}
              align="start"
              revealed={thisRevealed}
              onActionComplete={onClearReveal}
            />
          )}
          {p.createdAt && (
            <div
              className="mono text-[10px] text-ink-faint mt-1"
              title={new Date(p.createdAt).toLocaleString()}
            >
              {timeAgoShort(p.createdAt)}
            </div>
          )}
        </div>
      );
    }
    case "thinking":
      // Thinking is only reached in verbose mode (normal/summary filter it
      // out in applyViewMode). Render full.
      return (
        <div className="text-[12.5px] text-ink-muted italic pl-4 border-l-2 border-line whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-w-[72ch]">
          {p.text}
        </div>
      );
    case "tool_use": {
      const diff = toolCallToDiff(p.name, p.input);
      if (diff) {
        // Mid-thread Edit/Write diffs render full-width so the hunk grid
        // isn't clipped; the DiffView itself handles horizontal overflow.
        return (
          <div
            className="w-full"
            data-tool-use-id={p.id}
            data-event-seq={p.seq}
          >
            <DiffView diff={diff} />
            {p.createdAt && (
              <div
                className="mono text-[10px] text-ink-faint mt-1"
                title={new Date(p.createdAt).toLocaleString()}
              >
                {timeAgoShort(p.createdAt)}
              </div>
            )}
          </div>
        );
      }
      // TodoWrite — the full list lives in the persistent PlanStrip
      // + PlanSheet surfaces (mockup s-16). Rendering it again as a
      // fat `N todos` chip in the chat would duplicate state and eat
      // vertical space on every revision. Instead emit a one-line
      // "Plan updated" pointer that opens the sheet. Keep
      // `data-event-seq` for permalink + PlanPanel → transcript
      // reveal, and `data-tool-use-id` so the tasks rail's
      // `onReveal("tool-use-id", ...)` still scrolls to this row.
      if (p.name === "TodoWrite") {
        const rawTodos = (p.input as Record<string, unknown>).todos;
        const todos = Array.isArray(rawTodos) ? rawTodos : [];
        const total = todos.length;
        const doneCount = todos.reduce((acc, t) => {
          if (t && typeof t === "object" && (t as Record<string, unknown>).status === "completed") {
            return acc + 1;
          }
          return acc;
        }, 0);
        return (
          <div data-tool-use-id={p.id} data-event-seq={p.seq}>
            <button
              type="button"
              onClick={() => onOpenPlan?.()}
              className="inline-flex items-center gap-2 py-1 pl-2.5 pr-2.5 rounded-[8px] bg-klein-wash/40 border border-dashed border-klein/35 text-left hover:bg-klein-wash/60 disabled:opacity-60"
              disabled={!onOpenPlan}
              title="Open the plan panel"
            >
              <ListChecks className="w-3.5 h-3.5 text-klein-ink shrink-0" aria-hidden />
              <span className="mono text-[11px] text-klein-ink uppercase tracking-[0.1em]">
                Plan updated
              </span>
              <span className="text-[12.5px] text-ink-soft">
                {total} item{total === 1 ? "" : "s"} · {doneCount} done
              </span>
              <span className="mono text-[11px] text-ink-muted">→ view</span>
            </button>
            {p.createdAt && (
              <div
                className="mono text-[10px] text-ink-faint mt-1"
                title={new Date(p.createdAt).toLocaleString()}
              >
                {timeAgoShort(p.createdAt)}
              </div>
            )}
          </div>
        );
      }
      // Task / Agent / Explore — the subagent-family tools. Fat
      // JSON chips are duplicative: the SubagentsStrip shows the latest
      // activeForm above the thread, and the SubagentsPanel (right rail
      // / bottom sheet) streams the full live transcript. Render a
      // one-line pointer here instead, matching s-17's "Agent started
      // / done" pattern. Keep data-tool-use-id so rail "reveal" clicks
      // still scroll back to this row.
      if (p.name === "Task" || p.name === "Agent" || p.name === "Explore") {
        const resultIsError = matchedResult?.isError === true;
        const hasResult = matchedResult != null;
        const inputObj = p.input as Record<string, unknown>;
        const label =
          typeof inputObj.description === "string"
            ? inputObj.description
            : typeof inputObj.subagent_type === "string"
              ? (inputObj.subagent_type as string)
              : p.name;
        // All three non-error states share the indigo wash so the row
        // reads "this is a subagent pointer" at a glance and is visually
        // distinct from main-agent tool chips (which use klein/neutral).
        // Only the status icon color differentiates running / done. Solid
        // border + slightly heavier bg than the mockup so the pointer
        // stands out from surrounding prose instead of blending in.
        const pillClass = resultIsError
          ? "bg-danger-wash/50 border-danger/40 hover:bg-danger-wash/70"
          : "bg-indigo-wash/60 border-indigo/40 hover:bg-indigo-wash/80";
        const captionClass = resultIsError
          ? "text-danger"
          : "text-indigo";
        return (
          <div data-tool-use-id={p.id} data-event-seq={p.seq}>
            <button
              type="button"
              onClick={() => onOpenSubagents?.()}
              disabled={!onOpenSubagents}
              className={`w-fit max-w-full flex items-center gap-2 py-1.5 pl-2.5 pr-2.5 rounded-[8px] border text-left shadow-card ${pillClass} disabled:opacity-60`}
              title="Open the subagents panel"
            >
              {hasResult && !resultIsError ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  className="w-3.5 h-3.5 text-success shrink-0"
                  aria-hidden
                >
                  <path d="M5 12l5 5 9-10" />
                </svg>
              ) : hasResult && resultIsError ? (
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  className="w-3.5 h-3.5 text-danger shrink-0"
                  aria-hidden
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              ) : (
                <svg
                  className="w-3.5 h-3.5 text-indigo animate-spin shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-6.2-8.6" />
                </svg>
              )}
              <span className={`mono text-[11px] font-semibold ${captionClass} uppercase tracking-[0.1em] shrink-0`}>
                {hasResult
                  ? resultIsError
                    ? `${p.name} failed`
                    : `${p.name} done`
                  : `${p.name} started`}
              </span>
              <span className="text-[12.5px] text-ink font-medium flex-1 min-w-0 truncate">
                {label}
              </span>
              <span className="mono text-[11px] text-indigo/80 shrink-0">
                → view
              </span>
            </button>
            {p.createdAt && (
              <div
                className="mono text-[10px] text-ink-faint mt-1"
                title={new Date(p.createdAt).toLocaleString()}
              >
                {timeAgoShort(p.createdAt)}
              </div>
            )}
          </div>
        );
      }
      return (
        <div data-tool-use-id={p.id} data-event-seq={p.seq}>
          <ToolCallBlock
            name={p.name}
            input={p.input}
            resultContent={matchedResult?.content ?? null}
            isError={matchedResult?.isError ?? false}
            verbose={verbose}
            onOpenLightbox={onOpenLightbox}
          />
          {p.createdAt && (
            <div
              className="mono text-[10px] text-ink-faint mt-1"
              title={new Date(p.createdAt).toLocaleString()}
            >
              {timeAgoShort(p.createdAt)}
            </div>
          )}
        </div>
      );
    }
    case "tool_result": {
      // Absorbed by the merged tool_use block above — render nothing.
      if (isAbsorbedResult) return null;
      const thisRevealed = p.seq != null && revealedSeq === p.seq;
      return (
        <div
          className="group relative"
          data-event-seq={p.seq}
          data-show-actions={thisRevealed ? "true" : "false"}
          onClick={() => {
            if (p.seq != null) onToggleReveal?.(p.seq);
          }}
        >
          <ToolResultBlock
            content={p.content}
            isError={p.isError}
            verbose={verbose}
            onOpenLightbox={onOpenLightbox}
          />
          {session?.id && (
            <MessageActions
              text={p.content}
              sessionId={session.id}
              seq={p.seq}
              align="start"
              revealed={thisRevealed}
              onActionComplete={onClearReveal}
            />
          )}
        </div>
      );
    }
    case "permission_request":
      return (
        <div data-approval-id={p.approvalId} className="max-w-full min-w-0">
          <PermissionCard
            approvalId={p.approvalId}
            toolName={p.toolName}
            input={p.input}
            summary={p.summary}
            session={session}
            project={project}
            onDecide={onDecide}
          />
          {p.createdAt && (
            <div
              className="mono text-[10px] text-ink-faint mt-1"
              title={new Date(p.createdAt).toLocaleString()}
            >
              {timeAgoShort(p.createdAt)}
            </div>
          )}
        </div>
      );
    case "ask_user_question":
      // Wrapped in an ErrorBoundary mirroring the PermissionCard guard —
      // selecting two options in a multi-select variant has been reported
      // to white-screen the whole transcript. Boundary keeps the rest of
      // the chat alive and logs the stack to console so the root cause
      // surfaces next time. Fallback exposes a skip-style button so the
      // user isn't stuck waiting on claude (which won't continue until it
      // gets an ask_user_answer frame).
      return (
        <ErrorBoundary
          label="AskUserQuestionCard"
          fallback={
            <div className="rounded-[12px] border border-danger/40 bg-danger-wash/60 p-3 max-w-[72ch] min-w-0">
              <div className="text-[13px] text-ink font-medium">
                Something went wrong rendering this question.
              </div>
              <div className="text-[12px] text-ink-muted mt-0.5">
                Error logged to the browser console. Click below to send an
                empty answer so claude can continue.
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    onAnswerAskUserQuestion(
                      p.askId,
                      Object.fromEntries(
                        p.questions.map((q) => [q.question, ""]),
                      ),
                    )
                  }
                  className="h-8 px-3 rounded-[6px] border border-danger/40 bg-canvas text-[12px] text-danger"
                >
                  Skip question
                </button>
              </div>
            </div>
          }
        >
          <AskUserQuestionCard
            askId={p.askId}
            questions={p.questions}
            answers={p.answers}
            onSubmit={(answers, annotations) =>
              onAnswerAskUserQuestion(p.askId, answers, annotations)
            }
          />
        </ErrorBoundary>
      );
    case "plan_accept_request":
      return (
        <PlanAcceptCard
          planId={p.planId}
          plan={p.plan}
          decision={p.decision}
          onDecide={(decision) => onDecidePlan(p.planId, decision)}
        />
      );
    case "pending":
      return <PendingBlock stalled={p.stalled} />;
  }
}

// ---------------------------------------------------------------------------
// Pending placeholder — three bouncing dots so the user can tell the request
// is alive. The Agent SDK doesn't surface partial message text, so there's
// nothing to stream in between; the dots are the whole signal.
//
// The `stalled` branch surfaces a muted informational hint after a long
// stretch of silence (see armStallTimer in state/sessions.ts). This is NOT
// an error — claude is almost always still running (long thinking / slow
// tool) — so the styling is intentionally low-key: muted foreground, no
// red, no border. The user can keep waiting or hit Stop.
// ---------------------------------------------------------------------------
function PendingBlock({ stalled }: { stalled: boolean }) {
  if (stalled) {
    return (
      <div className="flex items-center gap-2 max-w-[72ch]" role="status">
        <RunningDots />
        <span className="mono text-[12px] text-ink-muted">
          still working — no output yet. hit Stop above to cancel.
        </span>
      </div>
    );
  }
  return <RunningDots />;
}

// Three bouncing dots, nothing else. Used both as the `pending` piece body
// and as the tail indicator any time the session is in a running state.
function RunningDots() {
  return (
    <div
      className="inline-flex items-center gap-0.5 text-ink-muted"
      aria-live="polite"
      aria-label="working"
    >
      <span className="pending-dot" />
      <span className="pending-dot" style={{ animationDelay: "0.15s" }} />
      <span className="pending-dot" style={{ animationDelay: "0.3s" }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call block — a tool_use + its matching tool_result rendered as ONE
// collapsible unit with a single chevron that toggles both the input JSON and
// the result body. When the result hasn't streamed yet (`resultContent` is
// null) we show a pulsing "running…" tag on the right and only the input in
// the expanded body.
//
// Folded state: single chip — chevron, tool name, summarizeInput on the
// left, summarizeResult (or "running…") on the right.
// Expanded state: dark `<pre>` with pretty-printed input, followed by the
// existing ToolResultBlock (which keeps its own inner "show N more chars"
// affordance so huge results don't blow the viewport even when the outer
// block is open).
//
// Verbose mode: always expanded, no outer toggle. Inner ToolResultBlock
// still truncates overflows because even verbose shouldn't dump 50 KB.
// Error state: folded chip gets a danger dot + subtle danger-wash tint.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared input/output pane. Unifies the visual treatment of tool_use input
// JSON and tool_result text so the pair reads as one coherent unit: same
// dark shell, same mono size, same width, same max-height, same Copy
// affordance. Error state on the output pane carries a danger-accented
// border and a ✗ in the label; otherwise the two panes are visually
// indistinguishable apart from the label.
// ---------------------------------------------------------------------------
function ToolPayloadPane({
  label,
  text,
  isError,
}: {
  label: "input" | "output";
  text: string;
  isError?: boolean;
}) {
  const onCopy = async () => {
    const ok = await copyText(text);
    toast(
      ok ? `${label === "input" ? "Input" : "Output"} copied` : "Copy failed",
    );
  };
  return (
    <div
      className={cn(
        "w-full max-w-[min(80ch,100%)] rounded-[10px] border bg-ink/95",
        isError ? "border-danger/40" : "border-ink-soft/40",
      )}
    >
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <span
          className={cn(
            "caps text-[10px] tracking-wider",
            isError ? "text-danger" : "text-canvas/55",
          )}
        >
          {isError && label === "output" ? (
            <span aria-hidden className="mr-1">
              ✗
            </span>
          ) : null}
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="ml-auto inline-flex items-center gap-1 px-1.5 h-5 rounded-[4px] border border-canvas/15 bg-ink-soft/60 mono text-[10px] text-canvas/70 hover:bg-ink-soft"
          title={`Copy ${label}`}
        >
          <Copy className="w-2.5 h-2.5" aria-hidden />
          copy
        </button>
      </div>
      <pre className="mono text-[12px] leading-[1.55] text-canvas/90 px-3 pb-3 pt-0.5 max-h-[320px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] break-words dark-scroll">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call block (continued)
// ---------------------------------------------------------------------------
function ToolCallBlock({
  name,
  input,
  resultContent,
  isError,
  verbose,
  onOpenLightbox,
}: {
  name: string;
  input: Record<string, unknown>;
  /** Matched tool_result content. `null` when the result hasn't landed yet
   * (tool still running) — chip shows a pulsing indicator. */
  resultContent: string | null;
  isError: boolean;
  verbose: boolean;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
}) {
  const [expanded, setExpanded] = useState(verbose);
  // Keep expand state in sync when the user flips modes mid-session so
  // switching to verbose really does open everything.
  useEffect(() => {
    if (verbose) setExpanded(true);
  }, [verbose]);

  const showBody = expanded || verbose;
  const canToggle = !verbose;
  const pretty = useMemo(() => safeStringify(input), [input]);
  const running = resultContent === null;
  const rightHint = running ? null : summarizeResult(resultContent, isError);
  const ToolIcon = toolIcon(name);

  return (
    <div
      className={cn(
        // Expanded: cap at 80ch so desktop doesn't render the whole card
        // edge-to-edge of the chat column (matches the ToolPayloadPane cap
        // inside — before the single-frame refactor, the inner panes had
        // this cap while the header chip was intrinsically sized, so the
        // visual width was naturally ≤ 80ch). Mobile viewports fall back to
        // 100% via the min(). Collapsed: intrinsic width as before.
        showBody ? "w-full max-w-[min(80ch,100%)]" : "w-fit max-w-full",
        // Single outer frame wrapping header + expanded body. Previously the
        // header chip and the input/result panes floated as separate bordered
        // siblings, which looked loose next to the subagent page's framed
        // look. We now match SubagentRun's `ToolCallCard` — one
        // rounded+bordered container, with the expanded body sitting behind
        // a `border-t` divider. Color variants shift the whole frame.
        "rounded-[10px] border overflow-hidden",
        isError
          ? "bg-danger-wash/40 border-danger/30"
          : running
            ? "bg-klein-wash/50 border-klein/30"
            : "bg-paper border-line",
      )}
    >
      <div className="w-full max-w-full">
        <button
          type="button"
          onClick={() => canToggle && setExpanded((v) => !v)}
          disabled={!canToggle}
          className={cn(
            "w-full flex items-center gap-2 py-1.5 pl-2 pr-3 max-w-full text-left overflow-hidden",
            canToggle &&
              (running ? "hover:bg-klein-wash/70 cursor-pointer" : "hover:bg-paper/60 cursor-pointer"),
          )}
          aria-expanded={showBody}
        >
          {canToggle ? (
            showBody ? (
              <ChevronDown
                className={cn(
                  "w-3 h-3 shrink-0",
                  running ? "text-klein" : "text-ink-muted",
                )}
              />
            ) : (
              <ChevronRight
                className={cn(
                  "w-3 h-3 shrink-0",
                  running ? "text-klein" : "text-ink-muted",
                )}
              />
            )
          ) : (
            <ChevronDown
              className={cn(
                "w-3 h-3 shrink-0",
                running ? "text-klein" : "text-ink-muted",
              )}
            />
          )}
          {isError && (
            <span className="h-1.5 w-1.5 rounded-full bg-danger shrink-0" />
          )}
          <span className="shrink-0 inline-flex" title={name}>
            <ToolIcon
              className={cn(
                "w-3.5 h-3.5",
                running ? "text-klein-ink" : "text-ink-soft",
              )}
              aria-label={name}
            />
          </span>
          <span
            className={cn(
              "mono text-[12px]",
              running ? "text-klein-ink" : "text-ink-soft",
            )}
          >
            {name}
          </span>
          <span className="mono text-[11px] text-ink-muted truncate flex-1 min-w-0">
            {summarizeToolCall(name, input)}
          </span>
          {running ? (
            <Loader2
              className="w-3.5 h-3.5 text-klein animate-spin shrink-0"
              aria-label={`${name} running`}
            />
          ) : rightHint ? (
            <span
              className={cn(
                "mono text-[11px] truncate max-w-[40vw] shrink min-w-0",
                isError ? "text-danger" : "text-ink-muted",
              )}
            >
              {rightHint}
            </span>
          ) : null}
        </button>
      </div>
      {showBody && (
        <div className="border-t border-line/60 bg-canvas/40 px-3 py-2.5 space-y-2">
          <ToolPayloadPane label="input" text={pretty} />
          {!running && (
            <ToolResultBlock
              content={resultContent}
              isError={isError}
              verbose={verbose}
              onOpenLightbox={onOpenLightbox}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool result block. Normal mode truncates to 1200 chars and lets the user
// expand to full. Verbose mode never truncates and never shows the toggle.
// We keep mono + whitespace-pre-wrap because tool results are most often
// command output (Bash stdout, Read file contents) — markdown rendering
// would destroy alignment for those.
// ---------------------------------------------------------------------------

// Matches the sentinel the WS mapper appends to tool_result content when it
// clipped the payload to `TOOL_RESULT_WS_LIMIT` (see
// server/src/transport/ws.ts). The full payload is in the DB — refetching
// the tail via GET /api/sessions/:id/events recovers it.
const TRUNCATION_SUFFIX_RE =
  /\n\n… \[truncated — (\d+) chars dropped\. Refetch transcript to see full content\.\]\s*$/;

function detectTruncation(content: string): {
  cleanText: string;
  dropped: number | null;
} {
  const m = content.match(TRUNCATION_SUFFIX_RE);
  if (!m) return { cleanText: content, dropped: null };
  return {
    cleanText: content.slice(0, content.length - m[0].length),
    dropped: Number(m[1]),
  };
}

function ToolResultBlock({
  content,
  isError,
  verbose,
  onOpenLightbox,
}: {
  content: string;
  isError: boolean;
  verbose: boolean;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
}) {
  // Strip the WS back-pressure truncation marker (if any) before extraction +
  // measurement. We don't want the sentinel text to count against the 1200
  // char budget, AND we want to render a proper action button below the
  // block instead of leaving "Refetch transcript to see full content." as
  // opaque inline text.
  const { cleanText, dropped } = useMemo(
    () => detectTruncation(content),
    [content],
  );
  // Extract any inline images (base64 data URLs, attachment refs, or SDK
  // image blocks) before we measure for truncation — otherwise a single
  // screenshot dominates the "1200 chars" budget and hides the actual text
  // output. Memoized per piece since tool_result bodies can be large.
  const { images, remainingText } = useMemo(
    () => extractImagesFromText(cleanText),
    [cleanText],
  );
  const LIMIT = 1200;
  const overflows = remainingText.length > LIMIT;
  const [expanded, setExpanded] = useState(verbose || !overflows);
  useEffect(() => {
    if (verbose) setExpanded(true);
  }, [verbose]);

  const canToggle = !verbose && overflows;
  const shownText = expanded ? remainingText : remainingText.slice(0, LIMIT);
  const hiddenCount =
    overflows && !expanded ? remainingText.length - LIMIT : 0;
  const hasText = remainingText.trim().length > 0;

  // Pull refetchTail + the URL-bound session id without threading new props
  // through every caller. `refetchTail` hits `/api/sessions/:id/events` with
  // limit=200, which reads the DB directly (the WS truncation only clips the
  // in-flight frame, not the persisted row) — so the fresh tail will carry
  // the full payload for any truncated tool_result inside the window.
  const refetchTail = useSessions((s) => s.refetchTail);
  const { id: routeSessionId } = useParams<{ id: string }>();
  const [refetching, setRefetching] = useState(false);
  const onRefetch = async () => {
    if (!routeSessionId || refetching) return;
    setRefetching(true);
    try {
      await refetchTail(routeSessionId);
    } finally {
      setRefetching(false);
    }
  };

  if (images.length === 0 && !hasText && dropped == null) {
    // Defensive: an empty tool_result (image-only source but stripped, or
    // just plain empty). Drop the whole block — nothing useful to render.
    return null;
  }

  return (
    <div className="max-w-full space-y-1.5">
      {images.length > 0 && (
        <ImageThumbs
          images={images}
          onOpen={(i) => onOpenLightbox(images, i)}
          tone="light"
        />
      )}
      {hasText && (
        <div>
          <ToolPayloadPane label="output" text={shownText} isError={isError} />
          {canToggle && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 block text-[11px] mono text-klein-ink hover:underline"
              aria-expanded={expanded}
            >
              {expanded
                ? "collapse"
                : `show ${hiddenCount.toLocaleString()} more chars`}
            </button>
          )}
        </div>
      )}
      {dropped != null && (
        <button
          type="button"
          onClick={onRefetch}
          disabled={refetching || !routeSessionId}
          className="mt-1 block text-[11px] mono text-klein-ink underline cursor-pointer disabled:opacity-50 disabled:cursor-wait"
          title={`WS frame clipped ${dropped.toLocaleString()} chars. Click to fetch the full payload from the transcript.`}
        >
          {refetching
            ? "Refetching…"
            : `Refetch full content (${dropped.toLocaleString()} chars clipped)`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User message bubble. Split into its own component so the `useMemo` call
// for image extraction sits on a stable hook path (calling hooks inside the
// Piece switch would violate rules-of-hooks because the kind of piece at a
// given list index can change as events arrive).
// ---------------------------------------------------------------------------
function UserBubble({
  text,
  attachments,
  createdAt,
  onOpenLightbox,
  editable,
  attachmentLock,
  onSubmitEdit,
  sessionId,
  seq,
  revealed,
  onToggleReveal,
  onClearReveal,
}: {
  text: string;
  /** Attachment metadata carried on the persisted user_message event.
   * Image MIMEs get rendered as thumbs above the bubble text (merged with
   * any images already extracted from the text body); non-image files get
   * a filename chip so the user can tell *something* was attached. The
   * server serves both shapes at `/api/attachments/:id/raw`. */
  attachments?: Array<{
    id: string;
    filename: string;
    mime: string;
    size: number;
  }>;
  /** ISO timestamp of the persisted user_message event. When present, we
   * render a small muted mono caption BELOW the bubble, right-aligned —
   * visible on both mobile and desktop. Hover reveals the absolute
   * timestamp via `title`. */
  createdAt?: string;
  onOpenLightbox: (images: ImageRef[], index: number) => void;
  /** When true, show a Pencil affordance that opens the inline editor. */
  editable?: boolean;
  /** When true (only possible on the newest bubble) show an inline hint
   * explaining why the Pencil is missing — the message has attachments the
   * server won't let us edit yet. */
  attachmentLock?: boolean;
  /** Resolves when the server has accepted the edit. Required when
   * `editable` is true. */
  onSubmitEdit?: (text: string) => Promise<void>;
  /** Session id + persisted event seq for the per-message action row. The
   * chip row renders BELOW the bubble (right-aligned to match); the pencil
   * affordance stays at the bubble's top-left corner so the two never
   * collide. */
  sessionId: string;
  seq?: number;
  /** Mobile tap-to-reveal flag — when true, the action chips AND the pencil
   * are shown regardless of hover state. Desktop ignores this and uses
   * `group-hover` (see `md:` overrides inside `MessageActions`). */
  revealed?: boolean;
  /** Single-tap handler wired on the bubble surface. Triggers the reveal
   * toggle at the Chat level. No-op on desktop (hover wins there). */
  onToggleReveal?: () => void;
  /** Clears `revealedSeq` after an action fires or when starting the
   * inline editor. */
  onClearReveal?: () => void;
}) {
  const { images: textImages, remainingText } = useMemo(
    () => extractImagesFromText(text),
    [text],
  );
  // Attachments carried on the user_message event. Split into image vs
  // non-image: images go into the ImageThumbs row with the existing lightbox
  // wiring; non-images render as a small chip row so the user can tell a
  // file was attached even if it's a PDF / text / other. Concatenated with
  // `textImages` so the thumb row is a single strip — images the user
  // attached via the composer sit first (they were the user's explicit
  // intent for this turn), followed by whatever the CLI pasted into the
  // text body.
  const { attachmentImages, attachmentFiles } = useMemo(() => {
    const imgs: ImageRef[] = [];
    const files: Array<{
      id: string;
      filename: string;
      mime: string;
      size: number;
    }> = [];
    for (const a of attachments ?? []) {
      if (typeof a.mime === "string" && a.mime.startsWith("image/")) {
        imgs.push({
          src: `/api/attachments/${encodeURIComponent(a.id)}/raw`,
          alt: a.filename || a.mime,
        });
      } else {
        files.push(a);
      }
    }
    return { attachmentImages: imgs, attachmentFiles: files };
  }, [attachments]);
  const images = useMemo(
    () => [...attachmentImages, ...textImages],
    [attachmentImages, textImages],
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the draft buffer in sync with the underlying text whenever it
  // shifts out from under us — e.g. the server just broadcast a new
  // user_message payload after someone else in another tab edited. We
  // only overwrite while NOT editing so an in-progress draft survives
  // unrelated rerenders.
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  const save = async () => {
    if (!onSubmitEdit) return;
    if (draft === text) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmitEdit(draft);
      setEditing(false);
    } catch (err) {
      // ApiError.code carries the server error enum ("not_idle",
      // "has_attachments", etc.). Surface it verbatim so the user sees
      // something actionable rather than a generic "failed".
      const msg =
        err instanceof Error && "code" in err
          ? String((err as { code: string }).code)
          : "edit failed";
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] w-full md:w-[520px] bg-paper border border-line rounded-[14px] rounded-br-[4px] px-3 py-2.5 shadow-card text-[14px] leading-[1.55]">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
                setDraft(text);
              } else if (
                e.key === "Enter" &&
                (e.metaKey || e.ctrlKey) &&
                !saving
              ) {
                e.preventDefault();
                void save();
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            className="w-full bg-canvas border border-line rounded-[10px] p-2 text-[13.5px] leading-[1.55] text-ink focus:outline-none focus:border-klein/60 resize-none mono"
            disabled={saving}
          />
          {error && (
            <div className="mt-1.5 text-[12px] text-danger mono">
              {error === "not_idle"
                ? "Can't edit while claude is working — hit Stop first."
                : error === "has_attachments"
                  ? "Messages with attachments can't be edited yet."
                  : error === "no_user_message"
                    ? "No user message to edit in this session."
                    : `Edit failed: ${error}`}
            </div>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(text);
                setError(null);
              }}
              disabled={saving}
              className="text-[12px] text-ink-muted hover:text-ink px-2 py-1 rounded-[6px] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || draft === text}
              className="text-[12px] text-canvas bg-ink rounded-[6px] px-3 py-1 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save & resend"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-end group relative"
      data-event-seq={seq}
      data-show-actions={revealed ? "true" : "false"}
    >
      <div
        className="relative max-w-[88%] bg-ink text-canvas rounded-[14px] rounded-br-[4px] px-3.5 py-2.5 shadow-card text-[14px] leading-[1.55] md:max-w-[75%] md:text-[15px] md:leading-[1.55] md:px-4 md:py-3"
        onClick={() => onToggleReveal?.()}
      >
        {editable && (
          <button
            type="button"
            title="Edit this message and re-run"
            aria-label="Edit this message and re-run"
            onClick={(e) => {
              // Don't let the click bubble up to the bubble's reveal toggle
              // — opening the editor already dismisses any shown chips via
              // `onClearReveal`.
              e.stopPropagation();
              onClearReveal?.();
              setDraft(text);
              setEditing(true);
              setError(null);
            }}
            className={cn(
              "absolute -top-2 -left-2 h-8 w-8 rounded-full bg-paper text-ink border border-line shadow-card transition-opacity flex items-center justify-center",
              // Desktop and mobile both respect `revealed` (click/tap on
              // the bubble toggles it). Desktop additionally reveals on
              // sustained hover with a 500ms delay — matches the action
              // chip row so scrolling past a bubble doesn't flicker the
              // pencil in and out.
              revealed ? "opacity-100" : "opacity-0",
              "md:group-hover:opacity-100 md:group-hover:delay-500",
              "md:focus:opacity-100 md:focus:delay-0",
            )}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {images.length > 0 && (
          <ImageThumbs
            images={images}
            onOpen={(i) => onOpenLightbox(images, i)}
            tone="dark"
          />
        )}
        {attachmentFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {attachmentFiles.map((a) => (
              <a
                key={a.id}
                href={`/api/attachments/${encodeURIComponent(a.id)}/raw`}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => e.stopPropagation()}
                className="h-8 pl-1.5 pr-2 rounded-[8px] border border-canvas/20 bg-canvas/10 text-[12px] text-canvas/90 hover:bg-canvas/20 flex items-center gap-1.5 whitespace-nowrap no-underline"
                title={`${a.filename} — ${Math.max(1, Math.round(a.size / 1024))}kb`}
              >
                <Paperclip className="w-3 h-3 text-canvas/80" />
                <span className="max-w-[160px] truncate">{a.filename}</span>
                <span className="text-canvas/60 mono text-[10px]">
                  {Math.max(1, Math.round(a.size / 1024))}kb
                </span>
              </a>
            ))}
          </div>
        )}
        {remainingText.trim() && (
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{remainingText}</div>
        )}
      </div>
      {(() => {
        // Preview card sits BELOW the dark bubble, right-aligned with the
        // bubble edge. Rendered outside the bubble so the card inherits
        // the regular paper palette instead of getting inverted.
        const previewUrl = firstHttpUrl(remainingText);
        return previewUrl ? <LinkPreview url={previewUrl} /> : null;
      })()}
      {sessionId && (
        <MessageActions
          text={text}
          sessionId={sessionId}
          seq={seq}
          align="end"
          revealed={revealed}
          onActionComplete={onClearReveal}
        />
      )}
      {(createdAt || attachmentLock) && (
        <div className="mt-1 flex items-center gap-1.5 mono text-[10px] text-ink-faint">
          {attachmentLock && (
            <span
              className="text-ink-muted"
              title="Editing messages with attachments isn't supported yet."
            >
              can't edit (has attachments)
            </span>
          )}
          {createdAt && (
            <span title={new Date(createdAt).toLocaleString()}>
              {timeAgoShort(createdAt)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image thumbnail strip. Used by both `user` bubbles and `tool_result` blocks
// to surface inline images as clickable 120×120 tiles that open the lightbox.
// `tone` only tweaks the border so thumbs sit nicely on dark (user bubble)
// vs light (tool_result) backgrounds.
// ---------------------------------------------------------------------------
function ImageThumbs({
  images,
  onOpen,
  tone,
}: {
  images: ImageRef[];
  onOpen: (index: number) => void;
  tone: "dark" | "light";
}) {
  return (
    <div className="flex gap-2 mb-2 overflow-x-auto no-scrollbar items-start">
      {images.map((img, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onOpen(i)}
          className={cn(
            // Fixed height, width follows the image's natural aspect ratio.
            // min-w keeps extremely tall images from shrinking to a sliver
            // before load; max-w prevents panoramic screenshots from pushing
            // the strip off-screen. The image itself uses object-contain so
            // nothing is cropped.
            "shrink-0 h-[120px] w-auto min-w-[60px] max-w-[240px] rounded-[8px] overflow-hidden cursor-zoom-in bg-canvas",
            tone === "dark"
              ? "border border-canvas/20"
              : "border border-line",
          )}
          aria-label={`Open image ${i + 1} of ${images.length}`}
        >
          <img
            src={img.src}
            alt={img.alt}
            className="h-full w-auto max-w-full object-contain"
            loading="lazy"
          />
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionCard — matches mockup s-05.
//
// Mobile (<md): bottom-sheet shape with stacked action buttons.
// Desktop (md+): modal-card shape with footer actions, 1-up "Blast radius"
// tile (Duration and Network tiles are intentionally omitted — we don't
// track those today, see docs/FEATURES.md Permissions row), and a
// "Remember this decision" checkbox that upgrades "Allow once" to
// "allow_always".
//
// Actions always call onDecide(approvalId, "allow_once" | "allow_always" |
// "deny") so the existing resolvePermission plumbing is unchanged.
// ---------------------------------------------------------------------------
function PermissionCard({
  approvalId,
  toolName,
  input,
  summary: _summary,
  session,
  project,
  onDecide,
}: {
  approvalId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  session: Session | null;
  project: Project | null;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
}) {
  const { id: sessionId } = useParams<{ id: string }>();
  const [remember, setRemember] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const title = deriveTitle(toolName, input);
  const cwd = deriveCwd(session, project);
  const metaLine = deriveMetaLine(session, project);
  const alwaysLabel = deriveAlwaysLabel(toolName, input);
  const command = deriveCommand(toolName, input);
  const blast = deriveBlastRadius(toolName, input);
  const diff = toolCallToDiff(toolName, input);

  // Desktop "Allow once" submits via Enter while the card has focus.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      // Ignore Enter typed into a field (none today, but keep safe).
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
        return;
      }
      e.preventDefault();
      const decision = remember ? "allow_always" : "allow_once";
      onDecide(approvalId, decision);
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [approvalId, remember, onDecide]);

  const allowOnceDecision = remember ? "allow_always" : "allow_once";

  return (
    <>
      {/* Mobile — bottom-sheet shape */}
      <div
        className="md:hidden w-full max-w-full min-w-0 rounded-t-[24px] bg-canvas border-t border-x border-line shadow-lift"
        ref={cardRef}
        tabIndex={-1}
      >
        <div className="flex justify-center pt-3">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>
        <div className="px-5 pt-3 pb-5">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-warn/30 bg-warn-wash text-[#7a4700] text-[10px] font-medium uppercase tracking-[0.1em]">
              <span className="h-1.5 w-1.5 rounded-full bg-warn" />
              permission
            </span>
            <span className="caps text-ink-muted">ask mode</span>
          </div>
          <h3 className="display text-[22px] leading-tight mt-2 break-words [overflow-wrap:anywhere]">{title}</h3>
          <p className="text-[13.5px] text-ink-muted mt-1 break-words [overflow-wrap:anywhere]">
            Claude wants to run this in{" "}
            <span className="mono text-ink">{cwd}</span>
          </p>

          {diff ? (
            <div className="mt-3 w-full space-y-1.5">
              <DiffView diff={diff} />
              {sessionId && (
                <Link
                  to={`/session/${sessionId}/diff?approvalId=${encodeURIComponent(approvalId)}`}
                  className="block text-right mono text-[11px] text-klein-ink hover:underline"
                >
                  Review full diff →
                </Link>
              )}
            </div>
          ) : (
            <CommandBlock command={command} />
          )}

          {/* Blast radius summary */}
          <div
            className={cn(
              "mt-3 rounded-[8px] border p-3",
              blast.danger
                ? "border-danger/30 bg-danger-wash/60"
                : "border-line bg-paper/60",
            )}
          >
            <div className="caps text-ink-muted mb-1.5">Blast radius</div>
            <div className="flex items-center gap-3 text-[12px]">
              <div className="flex-1 min-w-0">
                <div className="text-ink font-medium break-words [overflow-wrap:anywhere]">{blast.title}</div>
                <div className="text-ink-muted mt-0.5 break-words [overflow-wrap:anywhere]">{blast.subtitle}</div>
              </div>
            </div>
          </div>

          {/* Remember toggle — mirrors the desktop card so the primary
              action can upgrade to "Always allow" without needing a
              separate button. Upgrades `allow_once` → `allow_always` at
              decision time via allowOnceDecision. */}
          <label className="mt-4 flex items-center gap-2 text-[13px] select-none">
            <span className="h-4 w-4 rounded-[4px] border border-line-strong bg-canvas flex items-center justify-center shrink-0">
              {remember && <span className="h-2 w-2 bg-klein rounded-[1px]" />}
            </span>
            <input
              type="checkbox"
              className="sr-only"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="flex-1 min-w-0 break-words [overflow-wrap:anywhere]">
              Remember{" "}
              <span className="mono text-[12px] text-ink-muted">
                {alwaysLabel}
              </span>
            </span>
          </label>

          {/* Actions — Deny + primary on one row, primary upgrades to
              Always allow when the remember checkbox is set. */}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onDecide(approvalId, "deny")}
              className="h-12 px-4 rounded-[8px] bg-canvas border border-line font-medium text-danger whitespace-nowrap shrink-0"
            >
              Deny
            </button>
            <button
              type="button"
              onClick={() => onDecide(approvalId, allowOnceDecision)}
              className="flex-1 min-w-0 h-12 rounded-[8px] bg-ink text-canvas font-medium flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <Check className="w-4 h-4" />
              {remember ? "Always allow" : "Allow once"}
            </button>
          </div>
          <div className="mt-3 text-[11px] text-ink-muted flex items-center justify-between">
            <span>
              Saved in <span className="mono">claudex</span>
            </span>
          </div>
        </div>
      </div>

      {/* Desktop — modal-card shape. Left-aligned (no mx-auto) so the
          card sits in the transcript column next to the other pieces
          instead of pulling the reader's eye to the viewport center.

          Wrapped in an ErrorBoundary because a rare crash in the inner
          subtree (historically observed when toggling the "Remember this
          decision" checkbox) was taking the whole Chat screen down with
          it. The fallback still exposes a Deny path so the user isn't
          stuck on a locked permission gate, and the caught error is
          console.error'd so we can diagnose next round. */}
      <ErrorBoundary
        label="PermissionCard-desktop"
        fallback={
          <div className="hidden md:block w-[560px] max-w-full rounded-[14px] bg-canvas border border-danger/40 shadow-lift overflow-hidden">
            <div className="px-6 py-4 flex items-start gap-3">
              <span className="h-8 w-8 rounded-[8px] bg-danger-wash border border-danger/30 flex items-center justify-center text-danger shrink-0">
                <AlertTriangle className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0 text-[13px] text-ink">
                <div className="font-medium">
                  Something went wrong in this permission card.
                </div>
                <div className="text-[12px] text-ink-muted mt-0.5">
                  You can still deny the request below. The error was logged
                  to the browser console.
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-line flex items-center gap-2">
              <button
                type="button"
                onClick={() => onDecide(approvalId, "deny")}
                className="h-10 px-4 rounded-[8px] border border-line bg-canvas text-danger text-[14px] font-medium"
              >
                Deny
              </button>
            </div>
          </div>
        }
      >
      <div
        className="hidden md:block w-[560px] max-w-full rounded-[14px] bg-canvas border border-line shadow-lift overflow-hidden"
        ref={cardRef}
        tabIndex={-1}
      >
        <div className="px-6 pt-5 pb-4 border-b border-line flex items-start gap-4">
          <span className="h-10 w-10 rounded-[10px] bg-warn-wash border border-warn/40 flex items-center justify-center text-warn shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-warn/30 bg-warn-wash text-[#7a4700] text-[10px] font-medium uppercase tracking-[0.1em]">
                <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                permission · ask mode
              </span>
            </div>
            <h3 className="display text-[22px] leading-tight mt-1 break-words [overflow-wrap:anywhere]">{title}</h3>
            <div className="mono text-[12px] text-ink-muted mt-1 truncate">
              {metaLine}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDecide(approvalId, "deny")}
            aria-label="Dismiss (deny)"
            className="h-8 w-8 rounded-[8px] border border-line hover:bg-paper flex items-center justify-center shrink-0"
          >
            <X className="w-4 h-4 text-ink-soft" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {diff ? (
            <div className="w-full space-y-1.5">
              <DiffView diff={diff} />
              {sessionId && (
                <Link
                  to={`/session/${sessionId}/diff?approvalId=${encodeURIComponent(approvalId)}`}
                  className="block text-right mono text-[11px] text-klein-ink hover:underline"
                >
                  Review full diff →
                </Link>
              )}
            </div>
          ) : (
            <CommandBlock command={command} cwd={cwd} desktop />
          )}

          {/* 1-up card row (Duration/Network tiles intentionally omitted — see FEATURES.md). */}
          <div className="grid grid-cols-1 gap-2">
            <div
              className={cn(
                "border rounded-[8px] p-3",
                blast.danger
                  ? "border-danger/30 bg-danger-wash/60"
                  : "border-line bg-paper/50",
              )}
            >
              <div className="caps text-ink-muted">Blast radius</div>
              <div className="text-[13px] mt-1 font-medium break-words [overflow-wrap:anywhere]">{blast.title}</div>
              <div className="text-[11px] text-ink-muted mt-0.5 break-words [overflow-wrap:anywhere]">
                {blast.subtitle}
              </div>
            </div>
          </div>

          <div className="rounded-[8px] border border-line bg-canvas p-3">
            <div className="caps text-ink-muted mb-2">Why Claude is asking</div>
            <div className="text-[13px] text-ink-muted break-words [overflow-wrap:anywhere]">
              Your permission mode is{" "}
              <span className="mono text-ink">ask</span> and you haven't
              approved <span className="mono text-ink">{alwaysLabel}</span>{" "}
              before.
            </div>
            <label className="flex items-center gap-2 mt-3 text-[13px] cursor-pointer select-none">
              <span
                className={cn(
                  "h-4 w-4 rounded-[4px] border border-line-strong bg-canvas flex items-center justify-center shrink-0",
                )}
              >
                {remember && (
                  <span className="h-2 w-2 bg-klein rounded-[1px]" />
                )}
              </span>
              <input
                type="checkbox"
                className="sr-only"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember this decision for matching commands
            </label>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide(approvalId, "deny")}
            className="h-10 px-4 rounded-[8px] border border-line bg-canvas text-danger text-[14px] font-medium whitespace-nowrap shrink-0"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onDecide(approvalId, allowOnceDecision)}
            className="h-10 px-4 rounded-[8px] bg-ink text-canvas text-[14px] font-medium ml-auto inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Check className="w-4 h-4" />
            {remember ? "Always allow" : "Allow once"}
            <kbd className="ml-1 mono text-[11px] px-1 py-0.5 rounded border border-canvas/20 text-canvas/70">
              ⏎
            </kbd>
          </button>
        </div>
      </div>
      </ErrorBoundary>
    </>
  );
}
// Command block — dark terminal-style rendering. Used by the PermissionCard
// when the tool isn't a diff-producing Edit/Write/MultiEdit.
//
// Long bodies (>12 lines OR >1200 chars) default to a collapsed preview of
// the first 8 lines with an "Expand ({N} lines)" klein-ink button, matching
// the plan-accept fold pattern so the permission card doesn't push the
// Allow/Deny actions off-screen. Short bodies render as-is.
const COMMAND_FOLD_LINES = 12;
const COMMAND_FOLD_CHARS = 1200;
const COMMAND_PREVIEW_LINES = 8;

function CommandBlock({
  command,
  cwd,
  desktop,
}: {
  command: { header: string; lines: CommandLine[] };
  cwd?: string;
  desktop?: boolean;
}) {
  const totalLines = command.lines.length;
  const totalChars = command.lines.reduce((sum, line) => {
    if (line.kind === "bash-first") {
      return sum + line.binary.length + line.rest.length;
    }
    return sum + line.text.length;
  }, 0);
  const shouldFold =
    totalLines > COMMAND_FOLD_LINES || totalChars > COMMAND_FOLD_CHARS;
  const [expanded, setExpanded] = useState(false);
  const visibleLines =
    shouldFold && !expanded
      ? command.lines.slice(0, COMMAND_PREVIEW_LINES)
      : command.lines;

  return (
    <div
      className={cn(
        "rounded-[10px] border border-line overflow-hidden bg-ink",
        !desktop && "mt-3",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 bg-ink-soft border-b border-canvas/10">
        <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
        <span className="mono text-[11px] text-canvas/70">{command.header}</span>
        {desktop && cwd && (
          <span className="ml-auto mono text-[11px] text-canvas/50">
            cwd = {cwd}
          </span>
        )}
      </div>
      <div
        className={cn(
          "mono text-[13px] text-canvas leading-[1.55] overflow-x-auto",
          desktop ? "px-4 py-3" : "px-3 py-3",
        )}
      >
        {visibleLines.map((line, i) => (
          <div
            key={i}
            className="whitespace-pre-wrap [overflow-wrap:anywhere] break-all"
          >
            {line.kind === "bash-first" ? (
              <>
                <span className="text-klein-soft">{line.binary}</span>
                {line.rest && <span className="text-canvas">{line.rest}</span>}
              </>
            ) : line.kind === "bash-cont" ? (
              <span className="text-canvas/60">{line.text}</span>
            ) : (
              <span className="text-canvas">{line.text}</span>
            )}
          </div>
        ))}
        {shouldFold && !expanded && (
          <div className="text-canvas/50">…</div>
        )}
        {shouldFold && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-2 text-[11px] mono text-klein-soft underline hover:text-klein-wash"
            aria-expanded={expanded}
          >
            {expanded
              ? "Collapse"
              : `Expand (${totalLines.toLocaleString()} lines)`}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PermissionCard derivations — mapping our generic tool input onto the
// mockup's Bash-flavored copy. Rules follow the instructions in the rebuild
// brief; when a tile can't be computed honestly we omit rather than fake.
// ---------------------------------------------------------------------------

type CommandLine =
  | { kind: "bash-first"; binary: string; rest: string }
  | { kind: "bash-cont"; text: string }
  | { kind: "plain"; text: string };

function basename(p: string): string {
  if (!p) return p;
  const clean = p.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function deriveTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash":
      return "Run a shell command?";
    case "Edit":
      return `Edit ${basename(String(input.file_path ?? ""))}?`;
    case "Write":
      return `Write to ${basename(String(input.file_path ?? ""))}?`;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.length : 0;
      return `Apply ${edits} edits to ${basename(String(input.file_path ?? ""))}?`;
    }
    case "WebFetch":
      return "Fetch a URL?";
    default:
      return `Use ${toolName}?`;
  }
}

function deriveCwd(
  session: Session | null,
  project: Project | null,
): string {
  if (session?.worktreePath) return session.worktreePath;
  if (project?.path) return project.path;
  return "this session";
}

function deriveMetaLine(
  session: Session | null,
  project: Project | null,
): string {
  const name = project?.name ?? "session";
  const branch = session?.branch ?? "main";
  const cwd = session?.worktreePath ?? project?.path ?? "";
  return cwd ? `${name} · ${branch} · ${cwd}` : `${name} · ${branch}`;
}

function deriveAlwaysLabel(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").trim();
    const first = cmd.split(/\s+/)[0] ?? "";
    const second = cmd.split(/\s+/)[1] ?? "";
    if (first && second) return `${first} ${second} *`;
    if (first) return `${first} *`;
    return "Bash *";
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return `${toolName} ${basename(String(input.file_path ?? ""))}`;
  }
  if (toolName === "WebFetch") {
    const url = String(input.url ?? "");
    try {
      const u = new URL(url);
      return `WebFetch ${u.hostname}`;
    } catch {
      return `WebFetch *`;
    }
  }
  return `${toolName} *`;
}

function deriveCommand(
  toolName: string,
  input: Record<string, unknown>,
): { header: string; lines: CommandLine[] } {
  if (toolName === "Bash") {
    const raw = String(input.command ?? "");
    // Split on backslash-continuation then on explicit newlines.
    // The mockup shows "pnpm vitest run \\ --reporter=default \\ --changed origin/main"
    // rendering as three lines; we mimic that by treating backslash-EOL and
    // actual \n identically.
    const segments = raw
      .split(/\\\n|\n/)
      .map((s) => s.replace(/\s+$/, ""));
    const lines: CommandLine[] = segments.map((seg, idx) => {
      if (idx === 0) {
        const trimmed = seg.replace(/^\s+/, "");
        const sp = trimmed.indexOf(" ");
        if (sp === -1) {
          return { kind: "bash-first", binary: trimmed, rest: "" };
        }
        return {
          kind: "bash-first",
          binary: trimmed.slice(0, sp),
          rest: trimmed.slice(sp),
        };
      }
      return { kind: "bash-cont", text: seg };
    });
    return { header: "bash · shell", lines };
  }
  // Non-Bash — pretty-print input JSON inside the same dark block.
  const pretty = safeStringify(input);
  const lines: CommandLine[] = pretty
    .split("\n")
    .map((text) => ({ kind: "plain", text }));
  return { header: `${toolName} · tool`, lines };
}

function deriveBlastRadius(
  toolName: string,
  input: Record<string, unknown>,
): { title: string; subtitle: string; danger: boolean } {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "");
    if (/\b(rm|mv|cp -r|truncate|curl .* \| sh)\b/.test(cmd)) {
      return {
        title: "Destructive shell command",
        subtitle: "May modify or remove files",
        danger: true,
      };
    }
    if (/^(pnpm|npm|yarn|bun|vitest|jest|cargo|go test)\b/.test(cmd.trim())) {
      return {
        title: "Test / build command",
        subtitle: "Will not modify source files",
        danger: false,
      };
    }
    return {
      title: "Shell command",
      subtitle: "Unclear impact",
      danger: false,
    };
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    const filename = basename(String(input.file_path ?? ""));
    const diff = toolCallToDiff(toolName, input);
    const subtitle = diff
      ? `+${diff.addCount} −${diff.delCount}`
      : "pending";
    return {
      title: `Edits ${filename}`,
      subtitle,
      danger: false,
    };
  }
  if (toolName === "WebFetch") {
    const url = String(input.url ?? "");
    let domain = url;
    try {
      domain = new URL(url).hostname;
    } catch {
      /* leave as-is */
    }
    return {
      title: "Network read",
      subtitle: domain,
      danger: false,
    };
  }
  return {
    title: toolName,
    subtitle: "Unclear impact",
    danger: false,
  };
}

// --------------------------------------------------------------------------
// Composer — the bottom input. Supports two in-text triggers that pop a
// bottom-sheet picker (mockup screen 09 "Slash & @ pickers"):
//
//   `@`  at the start of input or after whitespace → file mention picker
//   `/`  with only whitespace before the cursor     → slash command picker
//
// The trigger state tracks the index of the triggering `@` or `/` inside
// `text` plus the query text typed after it, so if the user keeps typing
// while the sheet is open we can pre-filter. On select we splice the token
// into `text` replacing the trigger range.
// --------------------------------------------------------------------------

type Trigger =
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string };

function Composer({
  project,
  session,
  busy,
  onSend,
  onStop,
  onOpenSideChat,
  onClaudexAction,
  keyboardOffset = 0,
}: {
  project: Project | null;
  session: Session | null;
  busy: boolean;
  onSend: (text: string, attachmentIds?: string[]) => void;
  onStop: () => void;
  onOpenSideChat: () => void;
  /**
   * Picker dispatched a claudex-action slash command. Chat maps these to
   * local UI toggles (settings sheet, usage panel, etc.) instead of sending
   * the `/x` token over the wire.
   */
  onClaudexAction?: (action: SlashClaudexAction) => void;
  /**
   * CSS pixels currently hidden under the mobile software keyboard (from
   * `visualViewport`). When > 0 we translate the composer wrapper upward by
   * that amount so it floats above the keyboard instead of disappearing
   * beneath it. Always 0 on desktop (no visual-viewport shrink) — safe to
   * apply unconditionally.
   */
  keyboardOffset?: number;
}) {
  const isArchived = session?.status === "archived";
  // Session errored (SDK crashed mid-turn, watchdog fired, hard runner error)
  // — composer is locked out the same way archived sessions are, but with a
  // different banner + placeholder. The user's next move is to start a new
  // session; trying to queue messages into a dead runner would silently
  // fail. Archived still takes precedence visually if somehow both are true
  // (archived is the final state).
  const isErrored = session?.status === "error";
  const isLocked = isArchived || isErrored;
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  // Prompt history recall (↑ / ↓ like bash/readline). Scoped per-session via
  // localStorage key `claudex.prompt-history.<sessionId>` → JSON array, most-
  // recent LAST, capped at 30. Loaded into a ref (not state) because the
  // history itself doesn't drive rendering; only `historyIndex` and `stashed`
  // do, and those are stored as component state so React schedules updates.
  //
  // historyIndex semantics:
  //   null → not recalling
  //   n    → showing history[history.length - 1 - n]; 0 = most recent entry
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [stashed, setStashed] = useState<string>("");
  // Reload history when the session changes so switching sessions doesn't
  // leak history across them. Silent fallback on malformed JSON.
  useEffect(() => {
    historyRef.current = [];
    setHistoryIndex(null);
    setStashed("");
    const sid = session?.id;
    if (!sid) return;
    try {
      const raw = localStorage.getItem(`claudex.prompt-history.${sid}`);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        historyRef.current = arr.filter((x): x is string => typeof x === "string").slice(-30);
      }
    } catch {
      /* ignore — treat as empty history */
    }
  }, [session?.id]);

  function pushHistory(entry: string) {
    const trimmed = entry.trim();
    if (!trimmed) return;
    const sid = session?.id;
    if (!sid) return;
    const cur = historyRef.current;
    // Dedup adjacent duplicates — if last entry is same, don't append.
    if (cur.length > 0 && cur[cur.length - 1] === trimmed) return;
    const next = [...cur, trimmed].slice(-30);
    historyRef.current = next;
    try {
      localStorage.setItem(
        `claudex.prompt-history.${sid}`,
        JSON.stringify(next),
      );
    } catch {
      /* quota / privacy mode — history just won't persist */
    }
  }

  function setTextAndMoveCaretToEnd(next: string) {
    setText(next);
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(next.length, next.length);
      } catch {
        /* ignore */
      }
    });
  }

  function exitRecall() {
    setHistoryIndex(null);
    setStashed("");
  }
  // Attachments currently staged on the composer — uploaded but not yet sent.
  // Cleared on send (server links them to the appended user_message seq) or
  // on × tap (DELETE /api/attachments/:id removes unlinked rows + the file).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Slash commands are fetched from the server so the picker reflects the
  // user's `~/.claude/commands/*.md` and project-level commands, not just a
  // hardcoded fixture. We fall back to a tiny built-in list if the request
  // fails so the picker is never empty.
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(
    BUILTIN_FALLBACK_SLASH_COMMANDS,
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listSlashCommands(project?.id);
        if (!cancelled && res.commands.length > 0) {
          setSlashCommands(res.commands);
        }
      } catch {
        // Network / auth blip — stick with the fallback list we already have.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id]);
  // When the user explicitly dismisses a picker (Esc / tap backdrop /
  // insert a token), we remember the position of the dismissed sigil so
  // moving the caret back over it doesn't re-pop the picker. Cleared the
  // moment the user types a *new* `@` or `/`.
  const [suppressedAt, setSuppressedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Forwarded ↑/↓/⏎ from the composer textarea into whichever picker is open.
  // Each picker registers move/select via its imperative handle.
  const pickerRef = useRef<PickerHandle | null>(null);

  // Detect / update the active trigger from (text, cursor). Pure — only
  // reads from state, never writes.
  function detectTrigger(nextText: string, cursor: number): Trigger | null {
    // If a trigger was active and its start character is still the right
    // sigil, keep it alive and update the query — even if the user types
    // more characters. Cancel if cursor moves before the sigil or a newline
    // shows up (newlines terminate either picker).
    if (trigger) {
      const ch = nextText[trigger.start];
      const expected = trigger.kind === "slash" ? "/" : "@";
      if (ch !== expected || cursor <= trigger.start) return null;
      const q = nextText.slice(trigger.start + 1, cursor);
      if (q.includes("\n") || q.includes(" ")) {
        // Space / newline ends the trigger — `@foo bar` means "mention foo,
        // then literal bar". `/cmd arg` same. We stop tracking but leave the
        // existing text alone.
        return null;
      }
      return { kind: trigger.kind, start: trigger.start, query: q };
    }

    // Fresh detection: look at the character immediately to the left of the
    // cursor.
    if (cursor <= 0) return null;
    const last = nextText[cursor - 1];
    const sigilPos = cursor - 1;
    // If the user just dismissed a picker at this exact position, don't
    // re-open it. They'll need to delete this character and retype, or
    // place a fresh sigil somewhere else.
    if (suppressedAt === sigilPos) return null;
    if (last === "/") {
      // Only fire if everything before the `/` is whitespace — matches
      // Claude CLI's convention that slash commands are the first token.
      const before = nextText.slice(0, cursor - 1);
      if (/^\s*$/.test(before)) {
        return { kind: "slash", start: sigilPos, query: "" };
      }
      return null;
    }
    if (last === "@") {
      // `@` is valid anywhere after whitespace or at the start of input.
      const prev = cursor >= 2 ? nextText[cursor - 2] : "";
      if (cursor === 1 || /\s/.test(prev)) {
        return { kind: "mention", start: sigilPos, query: "" };
      }
      return null;
    }
    return null;
  }

  // Only called on real *input* — typing a character or pasting. Caret
  // movement (click, arrows) does NOT run this, so moving your cursor back
  // across an old `@` will not yank the picker open unexpectedly.
  function onInputChange(nextText: string, cursor: number) {
    // Clear the "recently dismissed" flag the moment the user changes the
    // character at that position (deletes it, or retypes it somewhere else).
    if (suppressedAt != null && nextText[suppressedAt] !== text[suppressedAt]) {
      setSuppressedAt(null);
    }
    // Any edit clears the "this send was blocked" hint — the user's
    // either fixing it or typing something else entirely, either way the
    // hint is stale.
    if (blockedSlash) setBlockedSlash(null);
    // If the user mutates text while recalling, exit recall mode without
    // restoring `stashed` — the user is editing the recalled entry and
    // taking ownership of it.
    if (historyIndex !== null && nextText !== text) {
      exitRecall();
    }
    setText(nextText);
    setTrigger(detectTrigger(nextText, cursor));
  }

  function dismissPicker() {
    // Remember which sigil the user just dismissed so re-entering the
    // textarea or moving the caret doesn't immediately re-pop the picker.
    if (trigger) setSuppressedAt(trigger.start);
    setTrigger(null);
  }

  function insertToken(token: string) {
    // Replace [trigger.start, cursor) with the token. If no active trigger
    // (shouldn't happen, but defensive), append to the end.
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    const start = trigger?.start ?? cursor;
    const end = cursor;
    const next = text.slice(0, start) + token + " " + text.slice(end);
    setText(next);
    setTrigger(null);
    // The inserted token replaced the sigil, so we definitely don't want
    // the "suppress this sigil position" flag hanging around.
    setSuppressedAt(null);
    // Put the cursor right after the inserted token + space.
    const newPos = start + token.length + 1;
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(newPos, newPos);
      } catch {
        /* older browsers */
      }
    });
  }

  function mentionTokenFor(absPath: string): string {
    if (project) {
      const root = project.path.replace(/\/+$/, "");
      if (absPath === root) return "@.";
      if (absPath.startsWith(root + "/")) {
        return "@" + absPath.slice(root.length + 1);
      }
    }
    // Outside the project root — fall back to the absolute path so we never
    // silently misrepresent the reference.
    return "@" + absPath;
  }

  function handlePickMention(absPath: string) {
    insertToken(mentionTokenFor(absPath));
  }

  function handlePickSlash(cmd: SlashCommand) {
    insertToken("/" + cmd.name);
  }

  // Set of slash commands the server flagged `unsupported`. Used to block
  // sends that start with one of these tokens so the user doesn't send
  // `/doctor` to the SDK and get "isn't available in this environment".
  // We only match the top-of-message slash command: `foo /doctor` still
  // sends (it's content), and so does `/doctor later` with whitespace —
  // the send helper checks the very first token.
  const unsupportedNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of slashCommands) {
      if (c.behavior.kind === "unsupported") s.add(c.name);
    }
    return s;
  }, [slashCommands]);

  // When a send is blocked, surface a one-line hint under the composer.
  // Cleared on the next input/send attempt so it doesn't linger.
  const [blockedSlash, setBlockedSlash] = useState<string | null>(null);

  function leadingUnsupported(text: string): string | null {
    const m = text.match(/^\s*\/([a-z][a-z0-9-]*)(?:\s|$)/i);
    if (!m) return null;
    const name = m[1];
    return unsupportedNames.has(name) ? name : null;
  }

  function openMentionManually() {
    // Manual "@" button when user taps the affordance rather than typing.
    // Insert `@` at the cursor so the trigger detection catches it.
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    const next = text.slice(0, cursor) + "@" + text.slice(cursor);
    setText(next);
    setTrigger({ kind: "mention", start: cursor, query: "" });
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(cursor + 1, cursor + 1);
      } catch {
        /* ignore */
      }
    });
  }

  function openSlashManually() {
    // If the composer is empty or only whitespace, seed a `/` at the end.
    // Otherwise we pop the sheet without rewriting the buffer — the user
    // can still select a command, we just insert at the cursor.
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    if (/^\s*$/.test(text)) {
      const next = text + "/";
      setText(next);
      setTrigger({ kind: "slash", start: next.length - 1, query: "" });
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        try {
          t.setSelectionRange(next.length, next.length);
        } catch {
          /* ignore */
        }
      });
    } else {
      // Fall back to inserting a `/` at the cursor; user can keep typing.
      const next = text.slice(0, cursor) + "/" + text.slice(cursor);
      setText(next);
      setTrigger({ kind: "slash", start: cursor, query: "" });
    }
  }

  const send = () => {
    if (isLocked) return;
    if (!text.trim() && attachments.length === 0) return;
    const blocked = leadingUnsupported(text);
    if (blocked) {
      setBlockedSlash(blocked);
      return;
    }
    setBlockedSlash(null);
    onSend(
      text,
      attachments.length > 0 ? attachments.map((a) => a.id) : undefined,
    );
    // Record in per-session prompt history for ↑/↓ recall. Push the raw
    // text (trimmed inside pushHistory) so the next up-arrow replays exactly
    // what the user sent.
    pushHistory(text);
    exitRecall();
    setText("");
    setTrigger(null);
    setAttachments([]);
    setAttachError(null);
  };

  // Attachment helpers.
  //
  // The composer maintains a local list of uploaded-but-unsent attachments.
  // Each file → one POST /api/sessions/:id/attachments (server returns
  // metadata). Clearing happens on send (server links them to the new
  // user_message seq) or explicit × (which fires DELETE — only works until
  // the message is sent).
  async function uploadOneFile(file: File) {
    if (!session) return;
    // Hard 5MB client-side check so we fail faster than the server.
    if (file.size > 5 * 1024 * 1024) {
      setAttachError(`File too large — max 5MB per file`);
      return;
    }
    try {
      const att = await api.uploadAttachment(session.id, file);
      setAttachments((prev) => [...prev, att]);
      setAttachError(null);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: string }).code)
          : "";
      if (code === "unsupported_mime") {
        setAttachError(`${file.type || "file"} isn't allowed`);
      } else if (code === "file_too_large") {
        setAttachError(`File too large — max 5MB per file`);
      } else {
        setAttachError("Upload failed — try again");
      }
    }
  }

  async function onFilesPicked(files: FileList | File[] | null) {
    if (!files) return;
    // Serialize uploads (server caps one file per request for predictable
    // limits). User waits ~fast enough for handful-of-files scenarios.
    for (const f of Array.from(files)) {
      await uploadOneFile(f);
    }
  }

  async function removeAttachment(id: string) {
    // Optimistic remove — if the DELETE fails (e.g. 404 because the message
    // was already sent in parallel) we'd just leave the chip gone; the
    // server-side row is already linked and won't be cleaned client-side.
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    try {
      await api.deleteAttachment(id);
    } catch {
      /* ignore — the row is either gone or already linked */
    }
  }

  return (
    <>
      {/* Chip rail — mockup 918-924. Horizontally scrolls; tap to pop a
          picker or fire an action. On desktop the /btw link is in the
          header but we keep it here too so the chip rail stays consistent
          across breakpoints. */}
      <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar px-3 pt-2">
        <button
          onClick={openSlashManually}
          type="button"
          disabled={isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft disabled:opacity-40"
        >
          <span className="mono text-klein">/</span>
          Slash
        </button>
        <button
          onClick={openMentionManually}
          type="button"
          disabled={!project || isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft disabled:opacity-40"
        >
          <span className="mono text-klein">@</span>
          File
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!session || isLocked}
          title={
            isArchived
              ? "Session is archived — read-only"
              : isErrored
              ? "Session errored — start a new session to continue"
              : session
              ? "Attach images or text files to this message"
              : "Create or open a session first"
          }
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1.5 whitespace-nowrap text-ink-soft disabled:opacity-40"
        >
          <Paperclip className="w-3 h-3" />
          Attach
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,.md,application/json,.json,application/xml,.xml,text/*"
          className="hidden"
          onChange={(e) => {
            void onFilesPicked(e.target.files);
            // Reset the native input so re-selecting the same file works.
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={onOpenSideChat}
          disabled={!session || isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft disabled:opacity-40"
        >
          <MessageCircle className="w-3 h-3 text-klein" />
          /btw
        </button>
        <button
          type="button"
          onClick={() => {
            // /compact is a real slash command; insert it like any other.
            insertCompact();
          }}
          disabled={isLocked}
          className="h-8 px-3 md:h-7 md:px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft disabled:opacity-40"
        >
          <span className="mono text-klein">/</span>compact
        </button>
      </div>

      {/* Attachment chips — one row per uploaded-but-unsent file. Image
          attachments render a 40x40 thumbnail; non-images render a filename
          chip with size in KB. × removes (DELETE /api/attachments/:id) as
          long as the message hasn't been sent. */}
      {attachments.length > 0 && (
        <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar px-3 pt-2">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="h-10 pl-1 pr-2 rounded-[10px] border border-line bg-paper/70 text-[12px] flex items-center gap-2 whitespace-nowrap"
            >
              {a.previewUrl ? (
                <img
                  src={a.previewUrl}
                  alt={a.filename}
                  className="w-8 h-8 rounded-md object-cover"
                />
              ) : (
                <span className="w-8 h-8 rounded-md bg-ink/5 flex items-center justify-center">
                  <Paperclip className="w-3.5 h-3.5 text-ink-soft" />
                </span>
              )}
              <span className="max-w-[160px] truncate">{a.filename}</span>
              <span className="text-ink-muted mono text-[10px]">
                {Math.max(1, Math.round(a.size / 1024))}kb
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                className="ml-1 min-w-[32px] min-h-[32px] flex items-center justify-center text-ink-muted hover:text-danger"
                aria-label={`Remove ${a.filename}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {attachError && (
        <div
          className="shrink-0 px-4 pt-1 text-[11px] text-danger/80"
          role="status"
        >
          {attachError}
        </div>
      )}

      {isArchived && (
        <div className="text-[11px] text-ink-muted mono px-3 py-1 border-t border-line bg-paper/50 flex items-center gap-1.5">
          <Archive className="w-3 h-3" />
          Archived · read-only — open a new session to continue.
        </div>
      )}
      {isErrored && !isArchived && (
        <div
          className="text-[11px] text-danger mono px-3 py-1 border-t border-line bg-danger-wash/40 flex items-center gap-1.5"
          role="status"
        >
          <span aria-hidden="true">●</span>
          Session errored — start a new session to continue.
        </div>
      )}

      <div
        className="shrink-0 border-t border-line bg-canvas px-3 pt-2 pb-3 mt-2 md:px-5 md:pt-3 md:pb-4"
        style={{
          // Lift the composer above the mobile software keyboard. On
          // desktop `keyboardOffset` stays 0 so `transform` is `undefined`
          // and React omits the style entirely (no layout thrash). We use
          // transform instead of padding so the message thread above keeps
          // its own scroll geometry — only the composer floats up.
          transform: keyboardOffset > 0 ? `translateY(-${keyboardOffset}px)` : undefined,
          transition: "transform 120ms ease-out",
        }}
        onDragOver={(e) => {
          if (!session || isLocked) return;
          e.preventDefault();
          if (!isDragging) setIsDragging(true);
        }}
        onDragLeave={(e) => {
          // Only clear when the drag fully leaves the wrapper, not when
          // passing between children (relatedTarget null = outside).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragging(false);
          }
        }}
        onDrop={(e) => {
          if (!session || isLocked) return;
          e.preventDefault();
          setIsDragging(false);
          void onFilesPicked(e.dataTransfer.files);
        }}
        onPaste={(e) => {
          // Image paste → run it through the same upload path as the
          // Attach button and drag/drop. Pastes bubble up from the child
          // textarea; we only preventDefault when we actually find an
          // image item so plain-text pastes still insert normally.
          //
          // `onPaste` + `ClipboardEvent.clipboardData.items` works on plain
          // HTTP (the site is not a secure context — see CLAUDE.md). Do
          // NOT switch this to `navigator.clipboard.read()`, which is
          // secure-context-only and will silently fail behind the frpc
          // HTTP tunnel.
          if (!session || isLocked) return;
          const items = e.clipboardData?.items;
          if (!items) return;
          const imageFiles: File[] = [];
          for (const item of Array.from(items)) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const f = item.getAsFile();
              if (f) imageFiles.push(f);
            }
          }
          if (imageFiles.length === 0) return;
          e.preventDefault();
          void onFilesPicked(imageFiles);
        }}
      >
        <div
          className={cn(
            "rounded-[12px] border bg-paper/60 p-2 md:rounded-[10px] md:p-2.5 md:bg-paper/50 focus-within:border-klein focus-within:ring-2 focus-within:ring-klein/15 transition-colors",
            isDragging ? "border-klein border-dashed" : "border-line",
          )}
        >
          <HighlightedComposer
            textareaRef={textareaRef}
            value={text}
            onChange={(e) =>
              onInputChange(e.target.value, e.target.selectionEnd ?? 0)
            }
            onKeyDown={(e) => {
              // When a picker is open, route arrow keys + Enter to it so
              // ↑/↓ scroll the list and ⏎ inserts the highlighted row. We
              // keep focus in the textarea so typing / backspacing past the
              // trigger still works naturally. This guard MUST run first so
              // prompt-history recall never steals ↑/↓ from the picker.
              if (trigger && pickerRef.current) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  pickerRef.current.move("down");
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  pickerRef.current.move("up");
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pickerRef.current.select();
                  return;
                }
              }
              // Prompt-history recall (↑/↓ like bash/readline). Only fires
              // when no picker is open (handled above), for a session with
              // prior history, and when the caret is at a sensible edge:
              //   ArrowUp  — caret at 0,0 OR value is empty
              //   ArrowDown — active recall AND caret at end of value
              if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
                const history = historyRef.current;
                if (history.length === 0) {
                  // No recorded prompts yet for this session — do nothing
                  // and let the native caret behavior take over.
                } else {
                  const ta = e.currentTarget;
                  const atStart =
                    (ta.selectionStart === 0 && ta.selectionEnd === 0) ||
                    ta.value.length === 0;
                  if (atStart) {
                    e.preventDefault();
                    if (historyIndex === null) {
                      setStashed(text);
                      setHistoryIndex(0);
                      setTextAndMoveCaretToEnd(history[history.length - 1]);
                    } else if (historyIndex < history.length - 1) {
                      const next = historyIndex + 1;
                      setHistoryIndex(next);
                      setTextAndMoveCaretToEnd(
                        history[history.length - 1 - next],
                      );
                    }
                    return;
                  }
                }
              }
              if (
                e.key === "ArrowDown" &&
                !e.shiftKey &&
                !e.altKey &&
                !e.metaKey &&
                !e.ctrlKey &&
                historyIndex !== null
              ) {
                const ta = e.currentTarget;
                const atEnd =
                  ta.selectionStart === ta.value.length &&
                  ta.selectionEnd === ta.value.length;
                if (atEnd) {
                  e.preventDefault();
                  const history = historyRef.current;
                  if (historyIndex > 0) {
                    const next = historyIndex - 1;
                    setHistoryIndex(next);
                    setTextAndMoveCaretToEnd(
                      history[history.length - 1 - next],
                    );
                  } else {
                    // historyIndex === 0 — restore the user's draft.
                    const toRestore = stashed;
                    exitRecall();
                    setTextAndMoveCaretToEnd(toRestore);
                  }
                  return;
                }
              }
              if (e.key === "Escape" && historyIndex !== null && !trigger) {
                // Escape while recalling (and no picker is eating the key)
                // cancels the recall and restores the stashed draft.
                e.preventDefault();
                const toRestore = stashed;
                exitRecall();
                setTextAndMoveCaretToEnd(toRestore);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
                return;
              }
              if (e.key === "Escape" && trigger) {
                e.preventDefault();
                dismissPicker();
              }
            }}
            placeholder={
              isArchived
                ? "This session is archived — read-only"
                : isErrored
                ? "Session errored — start a new session to continue"
                : busy
                ? "Type while claude thinks — will queue…"
                : "Type a message…  try / or @"
            }
            disabled={isLocked}
          />
          <div className="flex items-center justify-between px-1 mt-1">
            {/* Mobile: show model · mode here (mockup 929). Desktop (mockup
                1066) shows model · mode · {ctx}k ctx on the composer foot. */}
            <div className="mono text-[11px] text-ink-muted">
              {session ? (
                <>
                  {MODEL_LABEL[session.model] ?? session.model} ·{" "}
                  {MODE_LABEL[session.mode] ?? session.mode} ·{" "}
                  <span className="mono">
                    {(() => {
                      // Context window size formatter. Below 1M tokens we keep
                      // the familiar "200k" shape; at or above 1M we switch to
                      // "1m" / "1.2m" so 1,000,000 doesn't render as the
                      // clunky "1000k". The k→m boundary matches StatsSheet's
                      // formatCount so the whole UI agrees on vocabulary.
                      const toks = contextWindowTokens(session.model);
                      if (toks >= 1_000_000) {
                        const m = toks / 1_000_000;
                        return `${m.toFixed(1).replace(/\.0$/, "")}m`;
                      }
                      return `${Math.round(toks / 1000)}k`;
                    })()} ctx
                  </span>
                </>
              ) : (
                "—"
              )}
            </div>
            {isLocked ? null : busy ? (
              text.trim() || attachments.length > 0 ? (
                // While claude is working, if the user has typed something
                // the right-side button flips from Stop to Queue — tapping
                // it sends the draft, which the server queues behind the
                // in-flight turn. Matches the "Type while claude thinks —
                // will queue…" placeholder so the action lines up with the
                // hint. Hitting Stop in this state would throw the draft
                // away, which is the opposite of what a user who just
                // typed wants.
                <>
                  <button
                    type="button"
                    onClick={send}
                    title="Queue message"
                    aria-label="Queue message"
                    className="md:hidden h-8 w-8 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={send}
                    title="Queue message"
                    aria-label="Queue message"
                    className="hidden md:inline-flex h-8 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium items-center gap-1.5 shadow-card"
                  >
                    Queue
                    <Send className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onStop}
                    title="Stop claude"
                    aria-label="Stop claude"
                    className="md:hidden h-8 w-8 rounded-full bg-danger text-canvas flex items-center justify-center shadow-card"
                  >
                    <StopCircle className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={onStop}
                    title="Stop claude"
                    aria-label="Stop claude"
                    className="hidden md:inline-flex h-8 px-3 rounded-[8px] bg-danger text-canvas text-[13px] font-medium items-center gap-1.5 shadow-card"
                  >
                    <StopCircle className="w-4 h-4" />
                    Stop
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  type="button"
                  onClick={send}
                  disabled={!text.trim() && attachments.length === 0}
                  className="md:hidden h-8 w-8 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card disabled:opacity-40"
                  aria-label="Send message"
                >
                  <Send className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={send}
                  disabled={!text.trim() && attachments.length === 0}
                  className="hidden md:inline-flex h-8 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium items-center gap-1.5 shadow-card disabled:opacity-40"
                  aria-label="Send message"
                >
                  Send
                  <Send className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Send-blocked hint — shown when the user tries to send a top-of-
          message slash command we've marked REPL-only. Renders outside the
          composer card so it doesn't steal the focus ring. Cleared by any
          further edit or a successful send. */}
      {blockedSlash && (
        <div
          className="shrink-0 px-4 pb-2 -mt-1 text-[11px] text-danger/80"
          role="status"
        >
          <span className="mono">/{blockedSlash}</span> is CLI-only — can't
          send from claudex.
        </div>
      )}

      {trigger?.kind === "slash" && (
        <SlashCommandSheet
          ref={pickerRef}
          commands={slashCommands}
          initialQuery={trigger.query}
          onPick={handlePickSlash}
          onClaudexAction={(action) => {
            // Close the picker + remove the half-typed `/` sigil so the
            // composer isn't left with a stray "/" after the action runs.
            const el = textareaRef.current;
            const cursor = el?.selectionEnd ?? text.length;
            const start = trigger?.start ?? cursor;
            const next = text.slice(0, start) + text.slice(cursor);
            setText(next);
            setTrigger(null);
            onClaudexAction?.(action);
          }}
          onClose={dismissPicker}
        />
      )}
      {trigger?.kind === "mention" && project && (
        <FileMentionSheet
          ref={pickerRef}
          projectRoot={project.path}
          initialQuery={trigger.query}
          onPick={handlePickMention}
          onClose={dismissPicker}
        />
      )}
    </>
  );

  // Helper: inject `/compact` at the cursor (or at the start of the buffer
  // if empty). Keeps the chip behaviour consistent with typing `/compact`
  // manually.
  function insertCompact() {
    const el = textareaRef.current;
    const cursor = el?.selectionEnd ?? text.length;
    if (/^\s*$/.test(text)) {
      const next = "/compact ";
      setText(next);
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        t.focus();
        try {
          t.setSelectionRange(next.length, next.length);
        } catch {
          /* ignore */
        }
      });
    } else {
      const next = text.slice(0, cursor) + "/compact " + text.slice(cursor);
      setText(next);
    }
  }
}

// ---------------------------------------------------------------------------
// HighlightedComposer — a textarea that renders its content with syntax
// highlighting for `/command` and `@file` tokens. The trick: stack a
// transparent `<textarea>` on top of a `<pre>` mirror that has identical
// padding/font/line-height. The textarea owns the caret + selection, the
// mirror owns the colors. We sync scroll so long-wrapped text stays aligned.
//
// The textarea is the source of truth — its `value`/`onChange` wiring is
// untouched so the parent Composer's trigger detection keeps working.
// ---------------------------------------------------------------------------
function HighlightedComposer({
  textareaRef,
  value,
  onChange,
  onKeyDown,
  placeholder,
  disabled,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const mirrorRef = useRef<HTMLPreElement>(null);

  // Keep the mirror's scroll position in sync with the textarea so that
  // long content stays visually aligned. Fires on both input and scroll
  // (e.g. when the caret moves to a line outside the viewport).
  function syncScroll() {
    const t = textareaRef.current;
    const m = mirrorRef.current;
    if (!t || !m) return;
    m.scrollTop = t.scrollTop;
    m.scrollLeft = t.scrollLeft;
  }

  // Resize the textarea to match its content up to max-h-40 (160px). The
  // CSS clamp means scrollHeight will cap there and the browser takes over
  // with an internal scrollbar — exactly the UX we want (grow with the
  // user's keystrokes, stop at 10-ish lines, scroll within).
  function autoResize() {
    const t = textareaRef.current;
    if (!t) return;
    // Reset then measure so shrinking text also shrinks the box.
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  }

  // Fire autoResize whenever the value changes from outside (slash-command
  // insertion, edit-last-user-message hydration, reset on send, …) so the
  // box tracks programmatic updates too, not just keystrokes.
  useEffect(() => {
    autoResize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const highlighted = useMemo(() => renderHighlighted(value), [value]);

  return (
    <div className="relative">
      <pre
        ref={mirrorRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words font-sans text-[15px] leading-[1.5] text-ink py-1 px-2"
      >
        {highlighted}
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange(e);
          // Run after the textarea updates its own scroll metrics so
          // autoResize sees the new scrollHeight and syncScroll sees the
          // new scrollTop.
          requestAnimationFrame(() => {
            autoResize();
            syncScroll();
          });
        }}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        rows={1}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        className={cn(
          "relative w-full bg-transparent outline-none font-sans text-[15px] leading-[1.5] resize-none min-h-[24px] max-h-40 overflow-y-auto py-1 px-2 text-transparent caret-ink selection:bg-klein/20 selection:text-transparent placeholder:text-ink-muted",
          disabled && "opacity-70 cursor-not-allowed",
        )}
      />
    </div>
  );
}

// Tokenize the composer's raw text into a React fragment list where slash
// commands and file mentions are wrapped in colored spans. Everything else
// renders as plain text so whitespace is preserved.
//
// Regex notes:
// - `/cmd`   must be followed by a word boundary (whitespace or end). Slash-
//   only is NOT a token — users typing "/" shouldn't see a flash of color.
// - `@path`  matches until the next whitespace. `@` alone is also not a token.
// The trailing newline quirk (textarea vs pre sizing): if the string ends
// with `\n`, append a zero-width space so the mirror keeps a full final line.
function renderHighlighted(text: string): React.ReactNode {
  const display = text.endsWith("\n") ? text + "​" : text;
  const pattern = /(\/[a-z][a-z0-9-]*)(?=\s|$)|(@\S+)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(display)) !== null) {
    const start = match.index;
    const token = match[0];
    if (start > last) {
      parts.push(display.slice(last, start));
    }
    parts.push(
      <span key={key++} className="text-klein">
        {token}
      </span>,
    );
    last = start + token.length;
  }
  if (last < display.length) {
    parts.push(display.slice(last));
  }
  return parts;
}

/**
 * One-line honest summary of a tool_result for the folded merged chip.
 *
 *  - isError          → prefix with `✗` (rendered in danger color by caller).
 *  - empty            → `empty`.
 *  - image-only       → `image only` (all textual content was image markers).
 *  - explicit error   → multi-line stack / "Error:" prefix → first line + `✗`.
 *  - short one-liner  → first line verbatim, up to 80 chars.
 *  - otherwise        → `N lines, M chars`.
 */
function summarizeResult(content: string, isError: boolean): string {
  const { remainingText } = extractImagesFromText(content);
  const trimmed = remainingText.trim();
  if (trimmed.length === 0) {
    // Content might have been pure image markers; distinguish so users know
    // the result wasn't just silence.
    if (content.trim().length > 0) return "image only";
    return isError ? "✗ empty" : "empty";
  }
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const looksLikeError =
    isError ||
    /^Error:|Traceback \(most recent call last\):/i.test(trimmed);
  if (looksLikeError) {
    const head = firstLine.length > 80 ? firstLine.slice(0, 78) + "…" : firstLine;
    return `✗ ${head || "error"}`;
  }
  const lineCount = trimmed.split(/\r?\n/).length;
  if (lineCount === 1 && firstLine.length <= 80) return firstLine;
  const lineLbl = `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  const charLbl = `${trimmed.length} char${trimmed.length === 1 ? "" : "s"}`;
  return `${lineLbl}, ${charLbl}`;
}

/**
 * Pretty-print tool input for the expanded chip body. Defensive against
 * circular references (shouldn't happen over the wire, but the JSON we get
 * is ultimately user-controlled so we don't want a single weird call to
 * crash the component).
 */
function safeStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ---------------------------------------------------------------------------
// View-mode filtering + summary card synthesis.
// ---------------------------------------------------------------------------

interface ChangeEntry {
  path: string;
  addCount: number;
  delCount: number;
  /** seq of the first tool_use piece that touched this path — used by the
   * Summary-mode Changes card to scroll into view on click. null when we
   * never saw a seq (in-flight turns etc). */
  firstSeq: number | null;
}

/**
 * Reduce the raw transcript to what the current mode should display, and
 * (in summary mode) pre-compute the list of file changes for the Changes
 * card.
 *
 * - `normal`: strip thinking blocks. Everything else stays.
 * - `verbose`: no filtering.
 * - `summary`: keep user messages + the **last** assistant_text of each
 *   assistant "turn" (the run of non-user pieces between two user messages).
 *   Drop tool_use, tool_result, thinking, and permission_request. The
 *   Changes card below the transcript replaces what those pieces showed.
 */
function applyViewMode(
  pieces: UIPiece[],
  mode: ViewMode,
): { visiblePieces: UIPiece[]; changes: ChangeEntry[] } {
  // Drop pieces that came from inside a subagent (parentToolUseId set)
  // and drop the subagent lifecycle pieces themselves — both are
  // surfaced in the SubagentsStrip / SubagentsPanel instead of inlined
  // in the main thread. Keeping them here would duplicate content + the
  // rail's live-stream rows. See s-17 plan.
  const topLevel = pieces.filter((p) => {
    if (
      p.kind === "subagent_start" ||
      p.kind === "subagent_progress" ||
      p.kind === "subagent_update" ||
      p.kind === "subagent_end" ||
      p.kind === "subagent_tool_progress"
    ) {
      return false;
    }
    if (
      (p.kind === "assistant_text" ||
        p.kind === "thinking" ||
        p.kind === "tool_use" ||
        p.kind === "tool_result") &&
      typeof p.parentToolUseId === "string" &&
      p.parentToolUseId.length > 0
    ) {
      return false;
    }
    return true;
  });
  if (mode === "verbose") {
    return { visiblePieces: topLevel, changes: [] };
  }
  if (mode === "normal") {
    return {
      visiblePieces: topLevel.filter((p) => p.kind !== "thinking"),
      changes: [],
    };
  }
  // summary — walk the list, collect user pieces verbatim, and for every
  // run of assistant activity keep only the final assistant_text.
  const out: UIPiece[] = [];
  let pendingTextIdx = -1; // index into `out` of the last assistant_text
  for (const p of topLevel) {
    if (p.kind === "user") {
      out.push(p);
      pendingTextIdx = -1;
      continue;
    }
    if (p.kind === "assistant_text") {
      if (pendingTextIdx !== -1) {
        // Replace the previous assistant_text in this turn — we only want
        // the last one.
        out[pendingTextIdx] = p;
      } else {
        out.push(p);
        pendingTextIdx = out.length - 1;
      }
      continue;
    }
    // tool_use / tool_result / thinking / permission_request /
    // ask_user_question are all suppressed in summary mode.
  }
  // Aggregate Edit/Write/MultiEdit tool_use pieces into a de-duplicated
  // changes list. Adds/dels are summed across calls touching the same path;
  // paths with zero net change (e.g. an edit that added 3 lines and a later
  // edit that removed those same 3) are dropped — per mockup s-07 the
  // Changes card is a scan-mode signal, not an audit log.
  const changesMap = new Map<string, ChangeEntry>();
  for (const p of topLevel) {
    if (p.kind !== "tool_use") continue;
    const d = diffForToolCall(p.name, p.input);
    if (!d) continue;
    const existing = changesMap.get(d.path);
    if (existing) {
      existing.addCount += d.addCount;
      existing.delCount += d.delCount;
    } else {
      changesMap.set(d.path, {
        path: d.path,
        addCount: d.addCount,
        delCount: d.delCount,
        firstSeq: p.seq ?? null,
      });
    }
  }
  const changes = Array.from(changesMap.values()).filter(
    (c) => c.addCount > 0 || c.delCount > 0,
  );
  return { visiblePieces: out, changes };
}

// ---------------------------------------------------------------------------
// Summary cards — Outcome + Changes (mockup s-07 right column).
// PR card is planned but not yet wired (no git integration yet).
// ---------------------------------------------------------------------------

function SummaryCards({
  session,
  changes,
}: {
  session: Session | null;
  changes: ChangeEntry[];
}) {
  const outcome = outcomeFor(session);
  // Clicking a change row scrolls to the first tool_use event for that
  // path. In summary mode those pieces are hidden from the transcript, so
  // we hop to the underlying DOM node by seq — the hash listener in the
  // scroller effect picks up the change. Best-effort: if the seq was
  // never set (unseq'd optimistic piece) we log-and-no-op.
  const handleJump = (c: ChangeEntry) => {
    if (c.firstSeq == null) {
      // eslint-disable-next-line no-console
      console.debug("[summary] no seq for path", c.path);
      return;
    }
    const hash = `#seq-${c.firstSeq}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    const el = document.querySelector(
      `[data-event-seq="${c.firstSeq}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div className="space-y-3 max-w-[72ch]">
      <div className="rounded-[8px] border border-line bg-paper/50 p-3">
        <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          Outcome
        </div>
        <div className="mt-1 text-[13.5px] font-medium leading-snug">
          {outcome}
        </div>
      </div>
      <div className="rounded-[8px] border border-line bg-canvas p-3">
        <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          Changes
        </div>
        {changes.length === 0 ? (
          <div className="mt-1 text-[12.5px] text-ink-muted">
            No file changes yet.
          </div>
        ) : (
          <div className="mt-1">
            {changes.map((c) => {
              const clickable = c.firstSeq != null;
              return (
                <button
                  key={c.path}
                  type="button"
                  onClick={() => handleJump(c)}
                  disabled={!clickable}
                  title={
                    clickable
                      ? "Jump to this change in the transcript"
                      : undefined
                  }
                  className={cn(
                    "w-full flex items-center gap-2 mono text-[12px] text-ink-soft text-left py-0.5 px-1 -mx-1 rounded-[4px]",
                    clickable
                      ? "hover:bg-paper/60 cursor-pointer"
                      : "cursor-default",
                  )}
                >
                  <span className="truncate min-w-0 flex-1">{c.path}</span>
                  <span className="shrink-0 text-ink-muted">·</span>
                  {c.addCount > 0 && (
                    <span className="text-success shrink-0">
                      +{c.addCount}
                    </span>
                  )}
                  {c.delCount > 0 && (
                    <span className="text-danger shrink-0">
                      −{c.delCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function outcomeFor(session: Session | null): string {
  if (!session) return "Session loading…";
  switch (session.status) {
    case "running":
      return "Session in progress.";
    case "cli_running":
      return "External `claude` CLI is running for this session.";
    case "awaiting":
      return "Waiting on you — permission or reply required.";
    case "idle":
      return "Session idle — ready for the next turn.";
    case "archived":
      return "Session archived.";
    case "error":
      return "Session hit a terminal error.";
    default:
      return "Session in progress.";
  }
}
