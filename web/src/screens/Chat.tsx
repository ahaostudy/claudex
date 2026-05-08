import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AtSign, ChevronLeft, Send, Settings2, Slash } from "lucide-react";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type { Project, Session } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { DiffView, toolCallToDiff } from "@/components/DiffView";
import { diffForToolCall } from "@/lib/diff";
import { SessionSettingsSheet } from "@/components/SessionSettingsSheet";
import { SlashCommandSheet } from "@/components/SlashCommandSheet";
import { FileMentionSheet } from "@/components/FileMentionSheet";
import { ViewModePicker } from "@/components/ViewModePicker";
import type { SlashCommand } from "@/lib/slash-commands";
import type { UIPiece, ViewMode } from "@/state/sessions";

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const {
    transcripts,
    init,
    ensureTranscript,
    subscribeSession,
    sendUserMessage,
    resolvePermission,
    viewMode,
    setViewMode,
  } = useSessions();

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!id) return;
    api.getSession(id).then((r) => setSession(r.session));
    ensureTranscript(id);
    subscribeSession(id);
  }, [id, ensureTranscript, subscribeSession]);

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
          <Piece key={i} p={p} onDecide={(approvalId, decision) => id && resolvePermission(id, approvalId, decision)} />
        ))}
        {viewMode === "summary" && (
          <SummaryCards session={session} changes={changes} />
        )}
      </div>

      <Composer
        project={project}
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
    </main>
  );
}

function Piece({
  p,
  onDecide,
}: {
  p: import("@/state/sessions").UIPiece;
  onDecide: (
    approvalId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ) => void;
}) {
  switch (p.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[88%] bg-ink text-canvas rounded-[14px] rounded-br-[4px] px-3.5 py-2.5 shadow-card text-[14px] leading-[1.55]">
            {p.text}
          </div>
        </div>
      );
    case "assistant_text":
      return (
        <div className="text-[14.5px] text-ink leading-[1.6] max-w-[72ch]">
          <div className="flex items-center gap-2 mb-1.5">
            <svg viewBox="0 0 32 32" className="w-3.5 h-3.5">
              <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
              <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
            </svg>
            <span className="mono text-[11px] text-ink-muted">claude</span>
          </div>
          <div className="whitespace-pre-wrap">{p.text}</div>
        </div>
      );
    case "thinking":
      return (
        <div className="text-[12.5px] text-ink-muted italic pl-4 border-l-2 border-line">
          {p.text}
        </div>
      );
    case "tool_use": {
      const diff = toolCallToDiff(p.name, p.input);
      if (diff) {
        return <DiffView diff={diff} />;
      }
      return (
        <div className="flex items-center gap-2 py-1.5 pl-2 pr-3 rounded-[8px] bg-paper border border-line w-fit max-w-full">
          <span className="mono text-[12px] text-ink-soft">{p.name}</span>
          <span className="mono text-[11px] text-ink-muted truncate max-w-[60vw]">
            {summarizeInput(p.input)}
          </span>
        </div>
      );
    }
    case "tool_result":
      return (
        <div
          className={cn(
            "mono text-[12px] whitespace-pre-wrap px-3 py-2 rounded-[8px] border w-fit max-w-full",
            p.isError
              ? "bg-danger-wash border-danger/30 text-[#7a1d21]"
              : "bg-paper border-line text-ink-soft",
          )}
        >
          {truncate(p.content, 1200)}
        </div>
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
  }
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
  onSend,
}: {
  project: Project | null;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Detect / update the active trigger from (text, cursor).
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
    if (last === "/") {
      // Only fire if everything before the `/` is whitespace — matches
      // Claude CLI's convention that slash commands are the first token.
      const before = nextText.slice(0, cursor - 1);
      if (/^\s*$/.test(before)) {
        return { kind: "slash", start: cursor - 1, query: "" };
      }
      return null;
    }
    if (last === "@") {
      // `@` is valid anywhere after whitespace or at the start of input.
      const prev = cursor >= 2 ? nextText[cursor - 2] : "";
      if (cursor === 1 || /\s/.test(prev)) {
        return { kind: "mention", start: cursor - 1, query: "" };
      }
      return null;
    }
    return null;
  }

  function updateFromEvent(nextText: string, cursor: number) {
    setText(nextText);
    setTrigger(detectTrigger(nextText, cursor));
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
              updateFromEvent(e.target.value, e.target.selectionEnd ?? 0)
            }
            onKeyUp={(e) => {
              // Track caret moves via arrow keys too — otherwise moving left
              // across an `@` doesn't reopen the sheet.
              const el = e.currentTarget;
              setTrigger(detectTrigger(el.value, el.selectionEnd ?? 0));
            }}
            onClick={(e) => {
              const el = e.currentTarget;
              setTrigger(detectTrigger(el.value, el.selectionEnd ?? 0));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Type a message…  try / or @"
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
          initialQuery={trigger.query}
          onPick={handlePickSlash}
          onClose={() => setTrigger(null)}
        />
      )}
      {trigger?.kind === "mention" && project && (
        <FileMentionSheet
          projectRoot={project.path}
          initialQuery={trigger.query}
          onPick={handlePickMention}
          onClose={() => setTrigger(null)}
        />
      )}
    </>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 118) + "…" : s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[truncated ${s.length - max} chars]`;
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
