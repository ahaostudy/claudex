import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AtSign,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Send,
  Settings2,
  Slash,
  Square,
} from "lucide-react";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type { Project, Session } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { DiffView, toolCallToDiff } from "@/components/DiffView";
import { diffForToolCall } from "@/lib/diff";
import { SessionSettingsSheet } from "@/components/SessionSettingsSheet";
import { SideChatDrawer } from "@/components/SideChatDrawer";
import { SlashCommandSheet } from "@/components/SlashCommandSheet";
import { FileMentionSheet } from "@/components/FileMentionSheet";
import { ViewModePicker } from "@/components/ViewModePicker";
import { ContextRingButton, UsagePanel } from "@/components/UsagePanel";
import { Markdown } from "@/components/Markdown";
import type { SlashCommand } from "@/lib/slash-commands";
import { BUILTIN_FALLBACK_SLASH_COMMANDS } from "@/lib/slash-commands";
import type { UIPiece, ViewMode } from "@/state/sessions";

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  // `/btw` side chat drawer. One drawer per main session; the server keeps
  // the actual child session alive across close/re-open so the conversation
  // is preserved.
  const [showSideChat, setShowSideChat] = useState(false);
  const {
    transcripts,
    init,
    ensureTranscript,
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
      // Refresh-time: if the server says this session is currently running,
      // drop an inline "claude is processing" marker into the transcript so
      // the user sees something's in flight. First real WS frame (or a
      // session_update back to idle) will clear it. See state/sessions.ts
      // for the lifecycle.
      if (r.session.status === "running" || r.session.status === "awaiting") {
        ensurePendingFor(id);
      }
    });
    ensureTranscript(id);
    subscribeSession(id);
  }, [id, ensureTranscript, subscribeSession, ensurePendingFor]);

  // Resolve the session's project so the @-mention sheet can default to its
  // root and we can insert relative paths. Best-effort — if it fails the
  // sheet simply won't be offered.
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
      .catch(() => {
        /* ignore — composer gracefully degrades without project */
      });
    return () => {
      cancelled = true;
    };
  }, [session?.projectId]);

  const pieces = id ? transcripts[id] ?? [] : [];

  // Apply the view-mode filter to the raw transcript. Summary mode also
  // synthesizes a Changes card from Edit/Write/MultiEdit tool calls, so we
  // compute that in the same memo.
  const { visiblePieces, changes } = useMemo(
    () => applyViewMode(pieces, viewMode),
    [pieces, viewMode],
  );

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: "smooth",
    });
  }, [visiblePieces.length]);

  if (!id) return null;

  return (
    <main className="min-h-screen flex flex-col bg-canvas">
      <header className="sticky top-0 z-10 bg-canvas/95 backdrop-blur border-b border-line px-3 py-2.5 flex items-center gap-2">
        <Link
          to="/"
          className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center"
        >
          <ChevronLeft className="w-4 h-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium truncate">
            {session?.title ?? "Session"}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-muted mt-0.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                session?.status === "running" && "bg-success animate-pulse",
                session?.status === "awaiting" && "bg-warn",
                session?.status === "idle" && "bg-ink-faint",
                session?.status === "archived" && "bg-line-strong",
                session?.status === "error" && "bg-danger",
                !session && "bg-line-strong",
              )}
            />
            <span className="mono">{session?.model}</span>
            <span>·</span>
            <span>{session?.mode}</span>
          </div>
        </div>
        <ViewModePicker mode={viewMode} onChange={setViewMode} />
        <ContextRingButton
          // TODO(contextPct): server never populates contextPct yet, so the
          // ring is always empty. UI renders it anyway as the entry point to
          // the Usage panel, which has real token/cost data.
          pct={session?.stats.contextPct ?? 0}
          known={false}
          disabled={!session}
          onClick={() => setShowUsage(true)}
        />
        {(session?.status === "running" || session?.status === "awaiting") && (
          <button
            onClick={() => id && interruptSession(id)}
            title="Stop claude"
            aria-label="Stop claude"
            className="h-8 w-8 rounded-[8px] border border-danger/40 bg-danger-wash text-danger flex items-center justify-center hover:bg-danger-wash/80"
          >
            <Square className="w-4 h-4" fill="currentColor" />
          </button>
        )}
        <button
          onClick={() => setShowSideChat(true)}
          disabled={!session}
          title="Ask on the side (/btw)"
          aria-label="Open side chat"
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
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {visiblePieces.length === 0 && viewMode !== "summary" && (
          <div className="text-[13px] text-ink-muted text-center py-8">
            Send your first message to wake claude up.
          </div>
        )}
        {visiblePieces.map((p, i) => (
          <Piece
            key={i}
            p={p}
            viewMode={viewMode}
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
        busy={
          session?.status === "running" || session?.status === "awaiting"
        }
        onSend={(text) => {
          if (!text.trim() || !id) return;
          sendUserMessage(id, text);
        }}
      />

      {showSettings && session && (
        <SessionSettingsSheet
          session={session}
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

      {showUsage && session && (
        <UsagePanel session={session} onClose={() => setShowUsage(false)} />
      )}
    </main>
  );
}

function Piece({
  p,
  viewMode,
  onDecide,
}: {
  p: UIPiece;
  viewMode: ViewMode;
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
        // DiffView is already compact and information-dense — same in both
        // modes. No collapse affordance.
        return <DiffView diff={diff} />;
      }
      return <ToolUseBlock name={p.name} input={p.input} verbose={verbose} />;
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
        <PermissionCard
          approvalId={p.approvalId}
          toolName={p.toolName}
          input={p.input}
          summary={p.summary}
          onDecide={onDecide}
        />
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

function PermissionCard({
  approvalId,
  toolName,
  input,
  summary,
  onDecide,
}: {
  approvalId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
}) {
  const diff = toolCallToDiff(toolName, input);
  return (
    <div className="rounded-[12px] border border-warn/40 bg-warn-wash/40 p-3 space-y-3">
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="h-2 w-2 rounded-full bg-warn" />
          <span className="text-[11px] uppercase tracking-[0.12em] text-[#7a4700]">
            permission · {toolName}
          </span>
        </div>
        <div className="display text-[16px] leading-tight">{summary}</div>
      </div>
      {diff ? (
        <DiffView diff={diff} />
      ) : (
        <div className="mono text-[12px] text-canvas bg-ink rounded-[8px] px-3 py-2 whitespace-pre-wrap overflow-x-auto">
          {JSON.stringify(input, null, 2)}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onDecide(approvalId, "allow_once")}
          className="flex-1 min-w-[120px] h-10 rounded-[8px] bg-ink text-canvas font-medium text-[13px]"
        >
          Allow once
        </button>
        <button
          onClick={() => onDecide(approvalId, "allow_always")}
          className="flex-1 min-w-[120px] h-10 rounded-[8px] border border-line bg-canvas text-ink text-[13px]"
        >
          Always
        </button>
        <button
          onClick={() => onDecide(approvalId, "deny")}
          className="h-10 px-3 rounded-[8px] border border-line bg-canvas text-danger text-[13px]"
        >
          Deny
        </button>
      </div>
    </div>
  );
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
  busy,
  onSend,
}: {
  project: Project | null;
  busy: boolean;
  onSend: (text: string) => void;
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
    onSend(text);
    setText("");
    setTrigger(null);
  };

  return (
    <>
      <div className="border-t border-line bg-canvas px-3 pt-2 pb-3">
        <div className="rounded-[12px] border border-line bg-paper/60 p-2 flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) =>
              onInputChange(e.target.value, e.target.selectionEnd ?? 0)
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
                return;
              }
              if (e.key === "Escape" && trigger) {
                // Give the user a keyboard-level escape hatch from the picker
                // without losing the typed text.
                e.preventDefault();
                dismissPicker();
              }
            }}
            rows={1}
            placeholder={
              busy
                ? "Type while claude thinks — will queue…"
                : "Type a message…  try / or @"
            }
            className="flex-1 bg-transparent outline-none text-[15px] resize-none min-h-[24px] max-h-40 py-1 px-2"
          />
          <div className="flex items-center gap-1">
            <button
              onClick={openSlashManually}
              title="Slash commands"
              className="h-9 w-9 rounded-[8px] border border-line bg-canvas text-ink-soft flex items-center justify-center"
              aria-label="Insert slash command"
            >
              <Slash className="w-4 h-4" />
            </button>
            <button
              onClick={openMentionManually}
              disabled={!project}
              title={project ? "Mention a file" : "Project unavailable"}
              className="h-9 w-9 rounded-[8px] border border-line bg-canvas text-ink-soft flex items-center justify-center disabled:opacity-40"
              aria-label="Insert file mention"
            >
              <AtSign className="w-4 h-4" />
            </button>
            <button
              onClick={send}
              disabled={!text.trim()}
              className="h-9 w-9 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card disabled:opacity-40"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {trigger?.kind === "slash" && (
        <SlashCommandSheet
          commands={slashCommands}
          initialQuery={trigger.query}
          onPick={handlePickSlash}
          onClose={dismissPicker}
        />
      )}
      {trigger?.kind === "mention" && project && (
        <FileMentionSheet
          projectRoot={project.path}
          initialQuery={trigger.query}
          onPick={handlePickMention}
          onClose={dismissPicker}
        />
      )}
    </>
  );
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
