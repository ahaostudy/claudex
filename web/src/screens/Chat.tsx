import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, Send } from "lucide-react";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type { Session } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { DiffView, toolCallToDiff } from "@/components/DiffView";

export function ChatScreen() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const {
    transcripts,
    init,
    ensureTranscript,
    subscribeSession,
    sendUserMessage,
    resolvePermission,
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

  const pieces = id ? transcripts[id] ?? [] : [];

  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: "smooth",
    });
  }, [pieces.length]);

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
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {pieces.length === 0 && (
          <div className="text-[13px] text-ink-muted text-center py-8">
            Send your first message to wake claude up.
          </div>
        )}
        {pieces.map((p, i) => (
          <Piece key={i} p={p} onDecide={(approvalId, decision) => id && resolvePermission(id, approvalId, decision)} />
        ))}
      </div>

      <Composer
        onSend={(text) => {
          if (!text.trim() || !id) return;
          sendUserMessage(id, text);
        }}
      />
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

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="border-t border-line bg-canvas px-3 pt-2 pb-3">
      <div className="rounded-[12px] border border-line bg-paper/60 p-2 flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend(text);
              setText("");
            }
          }}
          rows={1}
          placeholder="Type a message…"
          className="flex-1 bg-transparent outline-none text-[15px] resize-none min-h-[24px] max-h-40 py-1 px-2"
        />
        <button
          onClick={() => {
            onSend(text);
            setText("");
          }}
          disabled={!text.trim()}
          className="h-9 w-9 rounded-full bg-klein text-canvas flex items-center justify-center shadow-card disabled:opacity-40"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
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
