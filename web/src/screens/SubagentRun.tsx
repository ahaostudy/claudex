import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import { summarizeToolCall, toolIcon } from "@/lib/tool-summary";
import { Markdown } from "@/components/Markdown";
import { useSessions, useSubagentRuns } from "@/state/sessions";
import type {
  SubagentRun,
  SubagentStreamEvent,
  UIPiece,
} from "@/state/sessions";

/**
 * Dedicated full-page view of a single subagent run (Task / Agent / Explore).
 * Route: `/session/:id/subagent/:taskId`. Twin of the SubagentsSheet drawer,
 * but rendered at full viewport width with chat-style blocks (fuller tool
 * call cards with inline results, wider assistant text) so a user can read
 * the complete subagent transcript without the 420px sheet constraint.
 *
 * Opened from: the "Open" link on each RunCard in SubagentsPanel. Back
 * button returns to the parent session. Standalone navigation is safe —
 * the page calls `ensureTranscript(sessionId)` on mount so reloading this
 * URL directly still works.
 */
export function SubagentRunScreen() {
  const { id, taskId } = useParams();
  const navigate = useNavigate();
  const ensureTranscript = useSessions((s) => s.ensureTranscript);
  const subscribeSession = useSessions((s) => s.subscribeSession);
  const sessionRow = useSessions((s) =>
    id ? s.sessions.find((x) => x.id === id) : undefined,
  );
  const refreshSessions = useSessions((s) => s.refreshSessions);

  useEffect(() => {
    if (!id) return;
    ensureTranscript(id).catch(() => undefined);
    refreshSessions().catch(() => undefined);
  }, [id, ensureTranscript, refreshSessions]);

  // Subscribe to WS so live updates from the parent session reach this
  // screen too — otherwise opening the standalone page while the subagent
  // is still running would freeze the last rendered transcript until a
  // manual reload.
  useEffect(() => {
    if (!id) return;
    subscribeSession(id);
  }, [id, subscribeSession]);

  const runs = useSubagentRuns(id ?? "");
  const run = useMemo(
    () => runs.find((r) => r.taskId === taskId) ?? null,
    [runs, taskId],
  );

  // Tick every second for the mm:ss elapsed counter while the run is
  // live. Same pattern as SubagentsPanel — a single interval at the
  // screen level.
  const isLive = run?.status === "running";
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isLive) return;
    const h = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [isLive]);

  // Auto-scroll the transcript to the bottom as new stream events arrive
  // (and once after initial load). Mirrors the tail-append pattern in
  // Chat.tsx so a live subagent run follows the latest activity without
  // requiring the user to scroll manually on mobile.
  const scroller = useRef<HTMLDivElement>(null);
  const streamLen = run?.stream.length ?? 0;
  const prevTailLenRef = useRef(0);
  useEffect(() => {
    const grew = streamLen > prevTailLenRef.current;
    prevTailLenRef.current = streamLen;
    if (!grew) return;
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [streamLen]);

  // One-shot instant jump after the run first becomes available — lands
  // big completed transcripts at the tail without a visible animation.
  const runLoaded = run !== null;
  const didInitialJumpRef = useRef(false);
  useEffect(() => {
    if (!runLoaded) return;
    if (didInitialJumpRef.current) return;
    didInitialJumpRef.current = true;
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }, [runLoaded]);

  return (
    // `h-screen` (not `min-h-screen`) pins the root to exactly the
    // viewport height. Without a fixed height, the inner `flex-1
    // min-h-0 overflow-y-auto` scroller has nothing to scroll *against*
    // — the parent grows with its content and the whole page becomes
    // static. With h-screen, header stays put + the scroller gets the
    // remaining height and handles long transcripts correctly on both
    // mobile Safari and desktop.
    <div className="h-screen flex flex-col bg-canvas">
      <Header
        run={run}
        sessionId={id ?? ""}
        sessionTitle={sessionRow?.title ?? null}
        onBack={() => {
          if (id) navigate(`/session/${id}`);
          else navigate("/sessions");
        }}
      />
      <div
        ref={scroller}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {run ? (
          <RunView run={run} />
        ) : (
          <EmptyState runsKnown={runs.length > 0} sessionId={id ?? ""} />
        )}
      </div>
    </div>
  );
}

function Header({
  run,
  sessionId,
  sessionTitle,
  onBack,
}: {
  run: SubagentRun | null;
  sessionId: string;
  sessionTitle: string | null;
  onBack: () => void;
}) {
  const tint = statusTint(run?.status ?? "running");
  return (
    <header className="sticky top-0 z-10 bg-canvas border-b border-line">
      <div className="max-w-[860px] mx-auto px-3 md:px-6 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="h-9 w-9 rounded-[8px] border border-line bg-paper flex items-center justify-center shrink-0"
          aria-label="Back to session"
          title="Back"
        >
          <ArrowLeft className="w-4 h-4 text-ink-soft" />
        </button>
        <span
          className={cn(
            "inline-flex items-center justify-center h-9 w-9 rounded-[8px] border shrink-0",
            tint.chip,
          )}
          aria-label="Agent"
          title="Agent"
        >
          <Bot className="w-4 h-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            {run?.agentType && (
              <span className="mono text-[11px] text-ink-soft truncate max-w-[22ch]">
                {run.agentType}
              </span>
            )}
            <span className="text-[13px] md:text-[14px] font-medium text-ink truncate">
              {run?.description || "(subagent run)"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-ink-muted mt-0.5 min-w-0">
            <StatusLabel run={run} />
            {sessionTitle && sessionId && (
              <>
                <span aria-hidden className="text-ink-faint">·</span>
                <Link
                  to={`/session/${sessionId}`}
                  className="truncate hover:text-ink-soft underline-offset-2 hover:underline"
                  title={`Back to ${sessionTitle}`}
                >
                  {sessionTitle}
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function StatusLabel({ run }: { run: SubagentRun | null }) {
  if (!run) return <span className="mono shrink-0">—</span>;
  if (run.status === "running") {
    return (
      <span className="inline-flex items-center gap-1 mono whitespace-nowrap shrink-0">
        <Loader2 className="w-3 h-3 animate-spin text-indigo" aria-hidden />
        running · {formatElapsedClock(run.startedAt)}
      </span>
    );
  }
  if (run.status === "failed") {
    return (
      <span className="mono text-danger whitespace-nowrap shrink-0">
        failed · {timeAgoShort(run.endedAt ?? run.startedAt)}
      </span>
    );
  }
  if (run.status === "stopped") {
    return (
      <span className="mono whitespace-nowrap shrink-0">
        stopped · {timeAgoShort(run.endedAt ?? run.startedAt)}
      </span>
    );
  }
  return (
    <span className="mono whitespace-nowrap shrink-0">
      completed · {timeAgoShort(run.endedAt ?? run.startedAt)}
    </span>
  );
}

function formatElapsedClock(startedAtIso: string | null | undefined): string {
  if (!startedAtIso) return "—";
  const started = Date.parse(startedAtIso);
  if (!Number.isFinite(started) || started <= 0) return "—";
  const elapsed = Math.max(0, Math.round((Date.now() - started) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function statusTint(status: SubagentRun["status"]): { chip: string } {
  if (status === "running") {
    return {
      chip: "border-indigo/40 text-indigo bg-indigo-wash/60",
    };
  }
  if (status === "failed") {
    return {
      chip: "border-danger/30 text-danger bg-danger-wash/60",
    };
  }
  if (status === "stopped") {
    return {
      chip: "border-line text-ink-soft bg-paper",
    };
  }
  return { chip: "border-line text-ink-soft bg-paper" };
}

function EmptyState({
  runsKnown,
  sessionId,
}: {
  runsKnown: boolean;
  sessionId: string;
}) {
  return (
    <div className="max-w-[860px] mx-auto px-4 py-10 text-center">
      <div className="text-[14px] text-ink-muted mb-2">
        {runsKnown
          ? "Subagent run not found in this session."
          : "Loading session transcript…"}
      </div>
      {sessionId && (
        <Link
          to={`/session/${sessionId}`}
          className="text-[13px] text-klein hover:underline"
        >
          Back to session
        </Link>
      )}
    </div>
  );
}

function RunView({ run }: { run: SubagentRun }) {
  return (
    // `pb-[calc(env(safe-area-inset-bottom)+40px)]` keeps the last
    // message clear of the iPhone home-bar and rounded screen corners —
    // without it, the bottom of the final bubble is clipped on the sides
    // as it scrolls into the curved region. 40px gives a little extra
    // breathing room below even on devices with zero inset.
    <div className="max-w-[860px] mx-auto px-3 md:px-6 pt-4 pb-[calc(env(safe-area-inset-bottom)+40px)] space-y-4">
      <PromptCard prompt={run.prompt} />
      <StreamList run={run} />
      <FooterCard run={run} />
    </div>
  );
}

function PromptCard({ prompt }: { prompt: string | null }) {
  if (!prompt) return null;
  return (
    <section>
      <div className="uppercase tracking-[0.12em] text-[10px] font-medium text-ink-muted mb-1.5 flex items-center gap-2">
        Prompt
        <button
          type="button"
          className="inline-flex items-center gap-1 text-ink-muted hover:text-ink-soft"
          onClick={() => {
            void copyText(prompt);
          }}
          title="Copy prompt"
        >
          <Copy className="w-3 h-3" aria-hidden />
        </button>
      </div>
      <pre className="mono text-[12px] leading-[1.55] text-ink-soft bg-paper border border-line rounded-[10px] px-3 py-2.5 whitespace-pre-wrap break-words max-h-[260px] overflow-y-auto">
        {prompt}
      </pre>
    </section>
  );
}

function StreamList({ run }: { run: SubagentRun }) {
  const stream = run.stream;

  // Pair tool_use with tool_result so each expanded tool block can show
  // its paired output inline. Any orphan tool_result (no preceding
  // tool_use in-stream) still renders standalone so the user isn't blind.
  const resultsById = useMemo(() => {
    const map = new Map<
      string,
      Extract<UIPiece, { kind: "tool_result" }>
    >();
    for (const ev of stream) {
      if (ev.piece.kind === "tool_result") {
        map.set(ev.piece.toolUseId, ev.piece);
      }
    }
    return map;
  }, [stream]);

  const toolUseIds = useMemo(() => {
    const set = new Set<string>();
    for (const ev of stream) {
      if (ev.piece.kind === "tool_use") set.add(ev.piece.id);
    }
    return set;
  }, [stream]);

  const renderable = useMemo(
    () =>
      stream.filter((ev) => {
        if (ev.piece.kind !== "tool_result") return true;
        return !toolUseIds.has(ev.piece.toolUseId);
      }),
    [stream, toolUseIds],
  );

  const isLive = run.status === "running";

  if (renderable.length === 0) {
    return (
      <section>
        <div className="uppercase tracking-[0.12em] text-[10px] font-medium text-indigo mb-1.5">
          {isLive ? "Live stream" : "Transcript"}
        </div>
        {run.summary ? (
          <div className="text-[13px] leading-[1.6] text-ink-soft whitespace-pre-wrap break-words bg-paper/60 border border-line rounded-[10px] px-3 py-3">
            <div className="uppercase tracking-[0.12em] text-[10px] font-medium text-ink-muted mb-1">
              Summary
            </div>
            {run.summary}
          </div>
        ) : (
          <div className="text-[12.5px] text-ink-muted italic px-1">
            {isLive
              ? "Waiting for the first tool call…"
              : "No inline activity was captured for this run."}
          </div>
        )}
      </section>
    );
  }

  return (
    <section>
      <div className="uppercase tracking-[0.12em] text-[10px] font-medium text-indigo mb-1.5 flex items-center gap-2">
        {isLive ? "Live stream" : "Transcript"}
        <span className="mono text-[10px] text-ink-muted">
          · {renderable.length} {renderable.length === 1 ? "event" : "events"}
        </span>
      </div>
      <div className="space-y-2.5">
        {renderable.map((ev, idx) => (
          <StreamItem
            key={`${ev.seq}-${idx}`}
            event={ev}
            resultsById={resultsById}
            trailingCaret={
              isLive &&
              idx === renderable.length - 1 &&
              (ev.piece.kind === "assistant_text" ||
                ev.piece.kind === "thinking")
            }
          />
        ))}
      </div>
    </section>
  );
}

function StreamItem({
  event,
  resultsById,
  trailingCaret,
}: {
  event: SubagentStreamEvent;
  resultsById: Map<string, Extract<UIPiece, { kind: "tool_result" }>>;
  trailingCaret: boolean;
}) {
  const p = event.piece;
  if (p.kind === "assistant_text") {
    return (
      <div className="bg-paper/40 border border-line rounded-[10px] px-3 py-2.5">
        <div className="text-[13px] leading-[1.6] text-ink whitespace-pre-wrap break-words markdown-body">
          <Markdown source={p.text} />
          {trailingCaret && <InlineCaret />}
        </div>
      </div>
    );
  }
  if (p.kind === "thinking") {
    return (
      <div className="border border-dashed border-line rounded-[10px] px-3 py-2.5 bg-paper/20">
        <div className="uppercase tracking-[0.12em] text-[10px] font-medium text-ink-muted mb-1">
          Thinking
        </div>
        <div className="text-[12.5px] leading-[1.6] text-ink-muted italic whitespace-pre-wrap break-words">
          {p.text}
          {trailingCaret && <InlineCaret />}
        </div>
      </div>
    );
  }
  if (p.kind === "tool_use") {
    const result = resultsById.get(p.id) ?? null;
    return <ToolCallCard use={p} result={result} />;
  }
  if (p.kind === "tool_result") {
    return <OrphanResult piece={p} />;
  }
  return null;
}

function ToolCallCard({
  use,
  result,
}: {
  use: Extract<UIPiece, { kind: "tool_use" }>;
  result: Extract<UIPiece, { kind: "tool_result" }> | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = toolIcon(use.name);
  const summary = summarizeToolCall(use.name, use.input);
  const inFlight = !result;
  const failed = result?.isError === true;
  const inputJson = useMemo(() => {
    try {
      return JSON.stringify(use.input ?? {}, null, 2);
    } catch {
      return String(use.input);
    }
  }, [use.input]);
  return (
    <div
      className={cn(
        "rounded-[10px] border overflow-clip",
        inFlight
          ? "border-klein/30 bg-klein-wash/40"
          : failed
            ? "border-danger/25 bg-danger-wash/30"
            : "border-line bg-paper/40",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-paper/60",
          expanded && "sticky top-0 z-10",
          expanded &&
            (inFlight
              ? "bg-klein-wash"
              : failed
                ? "bg-danger-wash"
                : "bg-paper"),
        )}
      >
        <Icon
          className={cn(
            "w-3.5 h-3.5 shrink-0",
            inFlight
              ? "text-klein-ink"
              : failed
                ? "text-danger"
                : "text-ink-soft",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "mono text-[11px] shrink-0",
            inFlight ? "text-klein-ink" : failed ? "text-danger" : "text-ink",
          )}
        >
          {use.name}
        </span>
        <span className="mono text-[11px] text-ink-muted truncate flex-1">
          {summary || "—"}
        </span>
        {inFlight ? (
          <Loader2
            className="w-3.5 h-3.5 text-klein animate-spin shrink-0"
            aria-hidden
          />
        ) : (
          <span
            className={cn(
              "mono text-[10px] shrink-0",
              failed ? "text-danger" : "text-success",
            )}
          >
            {failed ? "error" : "ok"}
          </span>
        )}
        <ChevronRight
          className={cn(
            "w-3 h-3 text-ink-muted shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      </button>
      {expanded && (
        <div className="border-t border-line/60 bg-canvas/40 px-3 py-2.5 space-y-2">
          <ExpandedBlock label="Input">
            <pre className="mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words">
              {inputJson}
            </pre>
          </ExpandedBlock>
          {result && (
            <ExpandedBlock
              label={failed ? "Error output" : "Result"}
              tone={failed ? "danger" : "default"}
            >
              <pre className="mono text-[11.5px] leading-[1.5] whitespace-pre-wrap break-words">
                {result.content || "(empty)"}
              </pre>
            </ExpandedBlock>
          )}
          {!result && (
            <div className="mono text-[11px] text-klein-ink italic">
              Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedBlock({
  label,
  tone = "default",
  children,
}: {
  label: string;
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className={cn(
          "uppercase tracking-[0.12em] text-[10px] font-medium mb-1",
          tone === "danger" ? "text-danger" : "text-ink-muted",
        )}
      >
        {label}
      </div>
      <div
        className={cn(
          "rounded-[8px] border px-2.5 py-2 max-h-[320px] overflow-auto",
          tone === "danger"
            ? "border-danger/20 bg-danger-wash/40 text-danger"
            : "border-line bg-paper text-ink-soft",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function OrphanResult({
  piece,
}: {
  piece: Extract<UIPiece, { kind: "tool_result" }>;
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] border px-3 py-2.5",
        piece.isError
          ? "border-danger/25 bg-danger-wash/40"
          : "border-line bg-paper/40",
      )}
    >
      <div className="uppercase tracking-[0.12em] text-[10px] font-medium text-ink-muted mb-1">
        {piece.isError ? "Tool error" : "Tool result"}
      </div>
      <pre className="mono text-[11.5px] leading-[1.55] text-ink-soft whitespace-pre-wrap break-words max-h-[260px] overflow-auto">
        {piece.content || "(empty)"}
      </pre>
    </div>
  );
}

function FooterCard({ run }: { run: SubagentRun }) {
  const usageBits: string[] = [];
  if (typeof run.usage.totalTokens === "number") {
    usageBits.push(`${run.usage.totalTokens.toLocaleString()} tokens`);
  }
  if (typeof run.usage.toolUses === "number") {
    usageBits.push(`${run.usage.toolUses} tool uses`);
  }
  if (typeof run.usage.durationMs === "number") {
    const secs = Math.round(run.usage.durationMs / 1000);
    if (secs >= 60) {
      usageBits.push(`${Math.floor(secs / 60)}m ${secs % 60}s`);
    } else {
      usageBits.push(`${secs}s`);
    }
  }
  if (!usageBits.length && !run.outputFile && !run.error) return null;
  return (
    <section className="rounded-[10px] border border-line bg-paper/30 px-3 py-3 space-y-2">
      {usageBits.length > 0 && (
        <div className="mono text-[11px] text-ink-muted">
          {usageBits.join(" · ")}
        </div>
      )}
      {run.outputFile && (
        <div className="flex items-center gap-2 mono text-[11px] text-ink-muted truncate">
          <ExternalLink className="w-3 h-3 shrink-0" aria-hidden />
          <span className="truncate" title={run.outputFile}>
            {run.outputFile}
          </span>
        </div>
      )}
      {run.error && (
        <div className="text-[12px] text-danger whitespace-pre-wrap break-words">
          {run.error}
        </div>
      )}
    </section>
  );
}

function InlineCaret() {
  return (
    <span
      aria-hidden
      className="inline-block w-[2px] h-[0.95em] align-[-0.1em] ml-[3px] bg-indigo animate-pulse"
    />
  );
}
