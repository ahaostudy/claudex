import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Session } from "@claudex/shared";
import { cn } from "@/lib/cn";

/**
 * TerminalDrawer — a PTY attached to the session's cwd (worktree if present,
 * else the project root). Works as a bottom sheet on mobile (full screen)
 * and a lower-half panel on desktop. We lean on xterm.js for the actual
 * rendering; our job is the WS plumbing + the layout chrome.
 *
 * WS protocol mirrors server/src/transport/pty.ts:
 *   server → client:
 *     { type: "data",  data: string }
 *     { type: "error", code, message }
 *     { type: "exit",  exitCode, signal }
 *   client → server:
 *     { type: "data",   data: string }
 *     { type: "resize", cols, rows }
 *
 * We don't attempt reconnect — a terminal session is stateful; a transient
 * disconnect is usually more helpful to surface than to paper over.
 *
 * iOS Safari: xterm.js works but the on-screen keyboard can be finicky. We
 * use a textarea-style focus path (tap the terminal → focus) and rely on
 * xterm's own IME handling for text input. `convertEol` makes `\n` coming
 * from server processes render as CRLF, which matters inside a pty on some
 * terminals. We haven't lab-tested this on a physical iOS device; see the
 * README note in the drawer's comment block at the top of the file.
 */
export function TerminalDrawer({
  session,
  projectPath,
  onClose,
}: {
  session: Session;
  /** Falls back to the project root when the session isn't on a worktree. */
  projectPath: string | null;
  onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<
    "connecting" | "open" | "closed" | "error"
  >("connecting");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const cwd = session.worktreePath ?? projectPath ?? "(project)";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: true,
      // Match the app's light palette (see web/tailwind.config / globals.css).
      // background == canvas, foreground == ink, cursor == klein.
      theme: {
        background: "#faf9f5",
        foreground: "#1f1e1d",
        cursor: "#cc785c",
        cursorAccent: "#faf9f5",
        selectionBackground: "#cc785c33",
        // Keep ANSI colors reasonable on a light background. Defaults are
        // tuned for dark, so we nudge a few toward readability.
        black: "#1f1e1d",
        red: "#b91c1c",
        green: "#15803d",
        yellow: "#a16207",
        blue: "#1e40af",
        magenta: "#9d174d",
        cyan: "#0e7490",
        white: "#3a3936",
        brightBlack: "#6b6967",
        brightRed: "#dc2626",
        brightGreen: "#16a34a",
        brightYellow: "#ca8a04",
        brightBlue: "#2563eb",
        brightMagenta: "#be185d",
        brightCyan: "#0891b2",
        brightWhite: "#1f1e1d",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // First fit — measure actual available space.
    try {
      fit.fit();
    } catch {
      /* element not sized yet — ResizeObserver below will pick it up */
    }
    const initialCols = term.cols || 80;
    const initialRows = term.rows || 24;

    // --- open websocket ---
    const wsUrl = buildWsUrl(session.id, initialCols, initialRows);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setPhase("open");
      // Try to focus the terminal so keyboard goes straight in. On iOS this
      // might not actually pop the keyboard until the user taps — that's
      // expected.
      requestAnimationFrame(() => term.focus());
    };
    ws.onmessage = (ev) => {
      let frame: { type?: string; data?: unknown; code?: string; message?: string; exitCode?: number };
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.type === "data" && typeof frame.data === "string") {
        term.write(frame.data);
        return;
      }
      if (frame.type === "error") {
        setErrMsg(`${frame.code ?? "error"}: ${frame.message ?? ""}`);
        setPhase("error");
        term.write(
          `\r\n\x1b[31m[claudex] ${frame.code ?? "error"}: ${frame.message ?? ""}\x1b[0m\r\n`,
        );
        return;
      }
      if (frame.type === "exit") {
        const code = frame.exitCode ?? 0;
        term.write(
          `\r\n\x1b[2m[claudex] shell exited (${code}). Close and reopen to start a new one.\x1b[0m\r\n`,
        );
        setPhase("closed");
        return;
      }
    };
    ws.onclose = () => {
      if (phase !== "error") setPhase("closed");
    };
    ws.onerror = () => {
      setPhase("error");
      setErrMsg((m) => m ?? "WebSocket error");
    };

    // --- term → ws ---
    const dataSub = term.onData((chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data: chunk }));
      }
    });

    // --- resize observer ---
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    ro.observe(host);

    // --- cleanup ---
    return () => {
      dataSub.dispose();
      ro.disconnect();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
    // We intentionally only run this on session.id — remount the terminal if
    // the user switches sessions (unlikely here since the component is
    // mounted from the Chat screen keyed to a specific session, but safe).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return (
    <div className="fixed inset-0 z-40 flex items-end md:items-stretch md:justify-end">
      <button
        aria-label="Close terminal"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]"
      />
      <aside
        className={cn(
          "relative bg-canvas border-t border-line shadow-card flex flex-col",
          // Mobile: full-height bottom sheet (feels right at 390px — anything
          // shorter and the keyboard eats the prompt).
          "w-full h-full",
          // Desktop: lower half, right side. Terminal is traditionally a
          // bottom pane; we put it there.
          "md:h-[55vh] md:rounded-t-[12px] md:border md:rounded-[12px] md:w-[min(920px,90vw)] md:m-6",
        )}
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper/40 shrink-0">
          <span className="mono text-[11px] text-ink-muted uppercase tracking-[0.12em]">
            terminal
          </span>
          <span className="mono text-[11.5px] text-ink-soft truncate" title={cwd}>
            {cwd}
          </span>
          <span
            className={cn(
              "ml-auto mono text-[10px]",
              phase === "open" && "text-success",
              phase === "connecting" && "text-ink-muted",
              phase === "closed" && "text-ink-muted",
              phase === "error" && "text-danger",
            )}
          >
            {phase === "connecting"
              ? "connecting…"
              : phase === "open"
                ? "● live"
                : phase === "closed"
                  ? "closed"
                  : `error`}
          </span>
          <button
            onClick={onClose}
            aria-label="Close terminal"
            className="h-7 w-7 rounded-[6px] border border-line bg-canvas flex items-center justify-center hover:bg-paper"
          >
            <X className="w-3.5 h-3.5 text-ink-soft" />
          </button>
        </header>
        {errMsg && phase === "error" && (
          <div className="px-3 py-1.5 text-[11.5px] text-danger bg-danger-wash/30 border-b border-danger/30">
            {errMsg}
          </div>
        )}
        {/*
          The terminal host. xterm renders into a positioned child, so the
          wrapper needs to be a positioned container with a stable size. We
          give it full flex-grow + a tiny padding so the text doesn't touch
          the border.
        */}
        <div className="flex-1 min-h-0 bg-canvas p-2">
          <div
            ref={hostRef}
            className="w-full h-full"
            // xterm handles its own focus; the parent click should fall through
            onClick={() => termRef.current?.focus()}
          />
        </div>
      </aside>
    </div>
  );
}

function buildWsUrl(
  sessionId: string,
  cols: number,
  rows: number,
): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  return `${proto}//${loc.host}/pty?${params.toString()}`;
}
