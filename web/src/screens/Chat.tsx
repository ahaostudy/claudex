import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  MoreVertical,
  PanelRight,
  Paperclip,
  Send,
  Settings2,
  StopCircle,
  Terminal,
  X,
} from "lucide-react";
import { ChatSessionsRail } from "@/components/ChatSessionsRail";
import { ChatTasksRail } from "@/components/ChatTasksRail";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type {
  ModelId,
  PermissionMode,
  Project,
  Session,
  SlashClaudexAction,
} from "@claudex/shared";
import { cn } from "@/lib/cn";
import { DiffView, toolCallToDiff } from "@/components/DiffView";
import { diffForToolCall } from "@/lib/diff";
import { SessionSettingsSheet } from "@/components/SessionSettingsSheet";
import { SideChatDrawer } from "@/components/SideChatDrawer";
import { SlashCommandSheet, type PickerHandle } from "@/components/SlashCommandSheet";
import { FileMentionSheet } from "@/components/FileMentionSheet";
import { TerminalDrawer } from "@/components/TerminalDrawer";
import { ViewModePicker } from "@/components/ViewModePicker";
import { ContextRingButton, UsagePanel } from "@/components/UsagePanel";
import { Markdown } from "@/components/Markdown";
import type { SlashCommand } from "@/lib/slash-commands";
import { BUILTIN_FALLBACK_SLASH_COMMANDS } from "@/lib/slash-commands";
import type { UIPiece, ViewMode } from "@/state/sessions";
import { contextWindowTokens } from "@/lib/usage";

// ---------------------------------------------------------------------------
// Model / mode label tables shared by the desktop header pills and the chat
// overflow sheet. Keep these in sync with NewSessionSheet in Home.
// ---------------------------------------------------------------------------
const MODEL_LABEL: Record<ModelId, string> = {
  "claude-opus-4-7": "Opus 4.7",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
};
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

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showSideChat, setShowSideChat] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  // Mobile three-dot menu. Desktop uses header pills instead.
  const [showMore, setShowMore] = useState(false);
  // Desktop tasks rail visibility. Persisted across navigations so users
  // who prefer the condensed layout stay condensed. Mobile ignores this —
  // the rail itself is `hidden md:flex`.
  const [showTasks, setShowTasks] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = window.localStorage.getItem("claudex.chat.tasksRail");
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
        "claudex.chat.tasksRail",
        showTasks ? "1" : "0",
      );
    } catch {
      /* private browsing etc. — ignore */
    }
  }, [showTasks]);
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
    viewMode,
    setViewMode,
  } = useSessions();

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
    if (grew) {
      scroller.current?.scrollTo({
        top: scroller.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [visiblePieces.length, id, transcripts]);

  // One-shot: after the initial transcript load finishes, jump to the
  // bottom instantly so big imported sessions land at the tail.
  const didInitialJumpRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !meta || meta.initialLoading) return;
    if (didInitialJumpRef.current === id) return;
    if (pieces.length === 0) return;
    didInitialJumpRef.current = id;
    // rAF so the browser has painted the rows once; otherwise
    // scrollHeight can be stale right after the state write.
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [id, meta?.initialLoading, pieces.length]);

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
    <div className="flex h-full bg-canvas overflow-hidden">
      <ChatSessionsRail currentId={id} />
      <main className="flex flex-col flex-1 min-w-0 min-h-0">
      {/* Mobile header — shown below md breakpoint (mockup 860-868). */}
      <header className="md:hidden shrink-0 px-4 py-2.5 border-b border-line flex items-center gap-2 bg-canvas">
        <button
          type="button"
          onClick={() => navigate("/sessions")}
          className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0"
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
        <button
          type="button"
          onClick={() => setShowMore(true)}
          disabled={!session}
          className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0 disabled:opacity-40"
          aria-label="More actions"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      </header>

      {/* Desktop header — shown at md+ (mockup 967-979). Pills are live
          dropdowns bound to PATCH /api/sessions/:id. */}
      <header className="hidden md:flex shrink-0 px-5 py-3 border-b border-line items-center gap-3 bg-canvas">
        <Link
          to="/sessions"
          className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0"
          aria-label="Back to sessions"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <span className={statusDot} />
        <div className="min-w-0">
          <div className="text-[14px] font-medium truncate">
            {session?.title ?? "Session"}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-muted mt-0.5">
            {metaLine}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {pendingDiffApprovalId && session?.status === "awaiting" && (
            <Link
              to={`/session/${id}/diff?approvalId=${encodeURIComponent(pendingDiffApprovalId)}`}
              className="h-8 px-2.5 rounded-[6px] bg-klein text-canvas text-[12px] font-medium flex items-center gap-1.5 shadow-card"
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
          {/* /btw button — kept on desktop header because the chip rail
              also has it, but desktop users are pointer-first so the direct
              affordance is worth the slot. Mobile moves it to the chip rail
              only. */}
          <button
            onClick={() => setShowSideChat(true)}
            disabled={!session}
            title="Ask on the side (/btw)"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper disabled:opacity-40"
          >
            <MessageCircle className="w-4 h-4 text-klein" />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            disabled={!session}
            title="Session settings"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper disabled:opacity-40"
          >
            <Settings2 className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowTerminal(true)}
            disabled={!session}
            title="Open terminal in session cwd"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper disabled:opacity-40"
          >
            <Terminal className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowTasks((v) => !v)}
            title={showTasks ? "Hide tasks rail" : "Show tasks rail"}
            aria-label="Toggle tasks rail"
            aria-pressed={showTasks}
            className={cn(
              "h-8 w-8 rounded-[8px] border flex items-center justify-center hover:bg-paper",
              showTasks
                ? "border-klein/30 bg-klein-wash/40 text-klein-ink"
                : "border-line bg-canvas text-ink-soft",
            )}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Messages — `flex-1 min-h-0` is the magic pair that lets the child
          scroller take the remaining column height. Without `min-h-0` a
          flex child would grow past the viewport and the composer would
          scroll out. */}
      <div
        ref={scroller}
        onScroll={onScrollerScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4"
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
            onDecide={(approvalId, decision) =>
              id && resolvePermission(id, approvalId, decision)
            }
          />
        ))}
        {viewMode === "summary" && (
          <SummaryCards session={session} changes={changes} />
        )}
      </div>

      <Composer
        project={project}
        session={session}
        busy={busy}
        onSend={(text) => {
          if (!text.trim() || !id) return;
          sendUserMessage(id, text);
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
          pendingApprovalCount={pieces.filter(
            (p) => p.kind === "permission_request",
          ).length}
          onReveal={(attr, id) => {
            const el = scroller.current?.querySelector(
              `[data-${attr}="${CSS.escape(id)}"]`,
            );
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }}
          onClose={() => setShowTasks(false)}
        />
      )}
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
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        className="h-8 px-2.5 rounded-[6px] border border-line bg-canvas text-[12px] text-ink-soft flex items-center gap-1 hover:bg-paper disabled:opacity-40"
      >
        <span className="mono">{label}</span>
        <ChevronDown className="w-3 h-3 text-ink-muted" />
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
// Mobile "more" bottom sheet — houses the buttons evicted from the mobile
// header (view mode, session settings, terminal, /btw side chat). Desktop
// never opens this because those affordances are in the header pills.
// ---------------------------------------------------------------------------
function ChatMoreSheet({
  viewMode,
  onPickViewMode,
  onOpenSettings,
  onOpenSideChat,
  onOpenTerminal,
  onClose,
}: {
  viewMode: ViewMode;
  onPickViewMode: (m: ViewMode) => void;
  onOpenSettings: () => void;
  onOpenSideChat: () => void;
  onOpenTerminal: () => void;
  onClose: () => void;
}) {
  const viewModes: ViewMode[] = ["normal", "verbose", "summary"];
  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end justify-center">
      <div className="w-full bg-canvas border-t border-line rounded-t-[20px] shadow-lift p-4">
        <div className="flex justify-center mb-3">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>
        <div className="caps text-ink-muted mb-2">Transcript view</div>
        <div className="grid grid-cols-3 gap-1.5 mb-4">
          {viewModes.map((m) => (
            <button
              key={m}
              onClick={() => onPickViewMode(m)}
              className={cn(
                "h-10 rounded-[8px] text-[13px] font-medium border",
                viewMode === m
                  ? "border-klein bg-klein-wash/40 text-ink"
                  : "border-line bg-canvas text-ink-soft",
              )}
            >
              {VIEW_LABEL[m]}
            </button>
          ))}
        </div>
        <div className="caps text-ink-muted mb-2">Actions</div>
        <div className="space-y-1">
          <SheetAction
            icon={<MessageCircle className="w-4 h-4 text-klein" />}
            label="Side chat (/btw)"
            onClick={onOpenSideChat}
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
}: {
  p: UIPiece;
  viewMode: ViewMode;
  session: Session | null;
  project: Project | null;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
}) {
  // Verbose = everything expanded, no truncation. Normal = compact by default,
  // user can click to expand individual tool_use chips and tool_result blocks.
  // Summary mode never reaches this component for tool_use/tool_result, so we
  // only have to distinguish normal vs verbose here.
  const verbose = viewMode === "verbose";
  switch (p.kind) {
    case "user":
      // User messages are rendered verbatim — never markdown-processed. If the
      // user typed literal `**` or backticks, they probably meant them.
      return (
        <div className="flex justify-end">
          <div className="max-w-[88%] bg-ink text-canvas rounded-[14px] rounded-br-[4px] px-3.5 py-2.5 shadow-card text-[14px] leading-[1.55] whitespace-pre-wrap">
            {p.text}
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="max-w-[72ch]">
          <div className="flex items-center gap-2 mb-1.5">
            <svg viewBox="0 0 32 32" className="w-3.5 h-3.5">
              <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
              <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
            </svg>
            <span className="mono text-[11px] text-ink-muted">claude</span>
          </div>
          <Markdown source={p.text} />
        </div>
      );
    case "thinking":
      // Thinking is only reached in verbose mode (normal/summary filter it
      // out in applyViewMode). Render full.
      return (
        <div className="text-[12.5px] text-ink-muted italic pl-4 border-l-2 border-line whitespace-pre-wrap max-w-[72ch]">
          {p.text}
        </div>
      );
    case "tool_use": {
      const diff = toolCallToDiff(p.name, p.input);
      if (diff) {
        // Mid-thread Edit/Write diffs render full-width so the hunk grid
        // isn't clipped; the DiffView itself handles horizontal overflow.
        return (
          <div className="w-full" data-tool-use-id={p.id}>
            <DiffView diff={diff} />
          </div>
        );
      }
      return (
        <div data-tool-use-id={p.id}>
          <ToolUseBlock name={p.name} input={p.input} verbose={verbose} />
        </div>
      );
    }
    case "tool_result":
      return (
        <ToolResultBlock
          content={p.content}
          isError={p.isError}
          verbose={verbose}
        />
      );
    case "permission_request":
      return (
        <div data-approval-id={p.approvalId}>
          <PermissionCard
            approvalId={p.approvalId}
            toolName={p.toolName}
            input={p.input}
            summary={p.summary}
            session={session}
            project={project}
            onDecide={onDecide}
          />
        </div>
      );
    case "pending":
      return <PendingBlock stalled={p.stalled} />;
  }
}

// ---------------------------------------------------------------------------
// Pending placeholder — the "claude is thinking" inline marker.
//
// The Agent SDK doesn't surface partial message text: a reply lands all-at-once
// after `message_stop`. This block fills the gap between user send and the
// first substantive frame so the user can tell the request is alive.
// Mentions the limitation in a second line so power users understand why
// the reply doesn't stream word-by-word. See memory/project_streaming_deferred.md.
// ---------------------------------------------------------------------------
function PendingBlock({ stalled }: { stalled: boolean }) {
  return (
    <div className="max-w-[72ch]">
      <div className="flex items-center gap-2 mb-1.5">
        <svg viewBox="0 0 32 32" className="w-3.5 h-3.5">
          <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
          <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
        </svg>
        <span className="mono text-[11px] text-ink-muted">claude</span>
      </div>
      {stalled ? (
        <div
          className={cn(
            "mono text-[12.5px] text-danger pl-3 border-l-2 border-danger/60",
          )}
          role="status"
        >
          no response in 30s — the request may be stuck. you can keep typing
          or hit Stop above to cancel.
        </div>
      ) : (
        <div className="pl-3 border-l-2 border-line">
          <div
            className={cn(
              "mono text-[12.5px] text-ink-muted flex items-center gap-1.5",
            )}
            aria-live="polite"
          >
            <span>Thinking</span>
            <span className="inline-flex gap-0.5">
              <span className="pending-dot" />
              <span className="pending-dot" style={{ animationDelay: "0.15s" }} />
              <span className="pending-dot" style={{ animationDelay: "0.3s" }} />
            </span>
          </div>
          <div className="text-[11px] text-ink-faint mt-1 italic">
            (claude won't stream this reply — the SDK ships each message whole,
            so expect it to land all at once.)
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool-use chip with an optional expansion into full pretty-printed input.
//
// Normal mode: single-line chip; chevron reveals the full JSON on click.
// Verbose mode: always expanded, no toggle — the chevron would be noise.
// ---------------------------------------------------------------------------
function ToolUseBlock({
  name,
  input,
  verbose,
}: {
  name: string;
  input: Record<string, unknown>;
  verbose: boolean;
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

  return (
    <div className="w-fit max-w-full">
      <button
        type="button"
        onClick={() => canToggle && setExpanded((v) => !v)}
        disabled={!canToggle}
        className={cn(
          "flex items-center gap-2 py-1.5 pl-1.5 pr-3 rounded-[8px] bg-paper border border-line max-w-full text-left",
          canToggle && "hover:bg-paper/80 cursor-pointer",
        )}
        aria-expanded={showBody}
      >
        {canToggle ? (
          showBody ? (
            <ChevronDown className="w-3 h-3 text-ink-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-ink-muted shrink-0" />
          )
        ) : (
          <ChevronDown className="w-3 h-3 text-ink-muted shrink-0" />
        )}
        <span className="mono text-[12px] text-ink-soft">{name}</span>
        <span className="mono text-[11px] text-ink-muted truncate max-w-[60vw]">
          {summarizeInput(input)}
        </span>
      </button>
      {showBody && (
        <pre className="mono text-[11.5px] text-canvas bg-ink rounded-[8px] mt-1 px-3 py-2 whitespace-pre-wrap break-all overflow-x-auto max-w-full">
          {pretty}
        </pre>
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
function ToolResultBlock({
  content,
  isError,
  verbose,
}: {
  content: string;
  isError: boolean;
  verbose: boolean;
}) {
  const LIMIT = 1200;
  const overflows = content.length > LIMIT;
  const [expanded, setExpanded] = useState(verbose || !overflows);
  useEffect(() => {
    if (verbose) setExpanded(true);
  }, [verbose]);

  const canToggle = !verbose && overflows;
  const shownText = expanded ? content : content.slice(0, LIMIT);
  const hiddenCount = overflows && !expanded ? content.length - LIMIT : 0;

  return (
    <div
      className={cn(
        "mono text-[12px] whitespace-pre-wrap px-3 py-2 rounded-[8px] border w-fit max-w-full",
        isError
          ? "bg-danger-wash border-danger/30 text-[#7a1d21]"
          : "bg-paper border-line text-ink-soft",
      )}
    >
      {shownText}
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
        className="md:hidden rounded-t-[24px] bg-canvas border-t border-x border-line shadow-lift"
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
          <h3 className="display text-[22px] leading-tight mt-2">{title}</h3>
          <p className="text-[13.5px] text-ink-muted mt-1">
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
              <div className="flex-1">
                <div className="text-ink font-medium">{blast.title}</div>
                <div className="text-ink-muted mt-0.5">{blast.subtitle}</div>
              </div>
            </div>
          </div>

          {/* Actions — stacked on mobile */}
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={() => onDecide(approvalId, "allow_once")}
              className="w-full h-12 rounded-[8px] bg-ink text-canvas font-medium flex items-center justify-center gap-2"
            >
              <Check className="w-4 h-4" />
              Allow once
            </button>
            <button
              type="button"
              onClick={() => onDecide(approvalId, "allow_always")}
              className="w-full h-12 rounded-[8px] bg-canvas border border-line font-medium text-ink flex items-center justify-center gap-2"
            >
              Always allow{" "}
              <span className="mono text-[12px] text-ink-muted">
                {alwaysLabel}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onDecide(approvalId, "deny")}
              className="w-full h-12 rounded-[8px] bg-canvas border border-line font-medium text-danger"
            >
              Deny
            </button>
          </div>
          <div className="mt-3 text-[11px] text-ink-muted flex items-center justify-between">
            <span>
              Saved in <span className="mono">claudex</span>
            </span>
          </div>
        </div>
      </div>

      {/* Desktop — modal-card shape */}
      <div
        className="hidden md:block w-[560px] max-w-full mx-auto rounded-[14px] bg-canvas border border-line shadow-lift overflow-hidden"
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
            <h3 className="display text-[24px] leading-tight mt-1">{title}</h3>
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
              <div className="text-[13px] mt-1 font-medium">{blast.title}</div>
              <div className="text-[11px] text-ink-muted mt-0.5">
                {blast.subtitle}
              </div>
            </div>
          </div>

          <div className="rounded-[8px] border border-line bg-canvas p-3">
            <div className="caps text-ink-muted mb-2">Why Claude is asking</div>
            <div className="text-[13px] text-ink-muted">
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
            className="h-10 px-4 rounded-[8px] border border-line bg-canvas text-danger text-[14px] font-medium"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onDecide(approvalId, "allow_always")}
            className="h-10 px-4 rounded-[8px] border border-line bg-canvas text-ink text-[14px] font-medium"
          >
            Always allow{" "}
            <span className="mono text-[12px] text-ink-muted ml-1">
              {alwaysLabel}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onDecide(approvalId, allowOnceDecision)}
            className="h-10 px-4 rounded-[8px] bg-ink text-canvas text-[14px] font-medium ml-auto inline-flex items-center gap-1.5"
          >
            <Check className="w-4 h-4" />
            Allow once
            <kbd className="ml-1 mono text-[11px] px-1 py-0.5 rounded border border-canvas/20 text-canvas/70">
              ⏎
            </kbd>
          </button>
        </div>
      </div>
    </>
  );
}

// Command block — dark terminal-style rendering. Used by the PermissionCard
// when the tool isn't a diff-producing Edit/Write/MultiEdit.
function CommandBlock({
  command,
  cwd,
  desktop,
}: {
  command: { header: string; lines: CommandLine[] };
  cwd?: string;
  desktop?: boolean;
}) {
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
        {command.lines.map((line, i) => (
          <div key={i} className="whitespace-pre">
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
}: {
  project: Project | null;
  session: Session | null;
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onOpenSideChat: () => void;
  /**
   * Picker dispatched a claudex-action slash command. Chat maps these to
   * local UI toggles (settings sheet, usage panel, etc.) instead of sending
   * the `/x` token over the wire.
   */
  onClaudexAction?: (action: SlashClaudexAction) => void;
}) {
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
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
    if (!text.trim()) return;
    const blocked = leadingUnsupported(text);
    if (blocked) {
      setBlockedSlash(blocked);
      return;
    }
    setBlockedSlash(null);
    onSend(text);
    setText("");
    setTrigger(null);
  };

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
          className="h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft"
        >
          <span className="mono text-klein">/</span>
          Slash
        </button>
        <button
          onClick={openMentionManually}
          type="button"
          disabled={!project}
          className="h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft disabled:opacity-40"
        >
          <span className="mono text-klein">@</span>
          File
        </button>
        <button
          type="button"
          disabled
          title="Attachments not implemented yet"
          className="h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1.5 whitespace-nowrap text-ink-soft opacity-50"
        >
          <Paperclip className="w-3 h-3" />
          Attach
        </button>
        <button
          type="button"
          onClick={onOpenSideChat}
          disabled={!session}
          className="h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft disabled:opacity-40"
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
          className="h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] flex items-center gap-1 whitespace-nowrap text-ink-soft"
        >
          <span className="mono text-klein">/</span>compact
        </button>
      </div>

      <div className="shrink-0 border-t border-line bg-canvas px-3 pt-2 pb-3 mt-2">
        <div className="rounded-[12px] border border-line bg-paper/60 p-2 focus-within:border-klein focus-within:ring-2 focus-within:ring-klein/15 transition-colors">
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
              // trigger still works naturally.
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
              busy
                ? "Type while claude thinks — will queue…"
                : "Type a message…  try / or @"
            }
          />
          <div className="flex items-center justify-between px-1 mt-1">
            {/* Mobile: show model · mode here (mockup 929). Desktop already
                has them as pills in the header, so on md+ we just reserve
                the spacer. */}
            <div className="mono text-[11px] text-ink-muted md:opacity-0">
              {session
                ? `${MODEL_LABEL[session.model] ?? session.model} · ${MODE_LABEL[session.mode] ?? session.mode}`
                : "—"}
            </div>
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                title="Stop claude"
                aria-label="Stop claude"
                className="h-8 w-8 rounded-full bg-danger text-canvas flex items-center justify-center shadow-card"
              >
                <StopCircle className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!text.trim()}
                className="h-8 w-8 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card disabled:opacity-40"
                aria-label="Send message"
              >
                <Send className="w-4 h-4" />
              </button>
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
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
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
          // Run after the textarea updates its own scroll metrics.
          requestAnimationFrame(syncScroll);
        }}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        rows={1}
        placeholder={placeholder}
        spellCheck={false}
        className="relative w-full bg-transparent outline-none text-[15px] leading-[1.5] resize-none min-h-[24px] max-h-40 py-1 px-2 text-transparent caret-ink selection:bg-klein/20 selection:text-transparent placeholder:text-ink-muted"
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

function summarizeInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 118) + "…" : s;
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
  if (mode === "verbose") {
    return { visiblePieces: pieces, changes: [] };
  }
  if (mode === "normal") {
    return {
      visiblePieces: pieces.filter((p) => p.kind !== "thinking"),
      changes: [],
    };
  }
  // summary — walk the list, collect user pieces verbatim, and for every
  // run of assistant activity keep only the final assistant_text.
  const out: UIPiece[] = [];
  let pendingTextIdx = -1; // index into `out` of the last assistant_text
  for (const p of pieces) {
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
    // tool_use / tool_result / thinking / permission_request are all
    // suppressed in summary mode.
  }
  // Aggregate Edit/Write/MultiEdit tool_use pieces into a de-duplicated
  // changes list (latest stats win for a given path).
  const changesMap = new Map<string, ChangeEntry>();
  for (const p of pieces) {
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
      });
    }
  }
  return { visiblePieces: out, changes: Array.from(changesMap.values()) };
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
  return (
    <div className="space-y-3 max-w-[72ch]">
      <div className="rounded-[8px] border border-line bg-paper/50 p-3">
        <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          Outcome
        </div>
        <div className="display text-[15px] leading-tight mt-1">
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
          <div className="mt-1 space-y-0.5">
            {changes.map((c) => (
              <div
                key={c.path}
                className="mono text-[12px] text-ink-soft flex items-center gap-2"
              >
                <span className="truncate">{c.path}</span>
                <span className="shrink-0">·</span>
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
              </div>
            ))}
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
