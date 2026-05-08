import type { ClientFrame, ServerFrame } from "@claudex/shared";

export type WsListener = (frame: ServerFrame) => void;
export type WsStateListener = (state: WsDiagnostics) => void;

export interface WsDiagnostics {
  phase: "connecting" | "open" | "acked" | "closed" | "error";
  lastError?: string;
  reconnectIn?: number; // ms until next attempt
  attempts: number;
  lastFrameAt?: number;
  lastCloseCode?: number;
  lastCloseReason?: string;
}

export interface WsClient {
  send(frame: ClientFrame): void;
  subscribe(listener: WsListener): () => void;
  onState(listener: WsStateListener): () => void;
  close(): void;
  readonly connected: boolean;
  readonly diagnostics: WsDiagnostics;
}

/**
 * Auto-reconnecting WS client. Exposes a simple send/subscribe surface; the
 * store layer decides which frames matter.
 *
 * iOS Safari quirks handled here:
 * - After backgrounding, a socket may appear "open" but dead. We track the
 *   time since the last frame (hello_ack or server ping) and force a
 *   reconnect from a visibility-change listener.
 * - Safari sometimes skips the `close` event after an abrupt network drop,
 *   so a visibility→reconnect path is the only way to recover.
 */
export function createWsClient(url: string): WsClient {
  const listeners = new Set<WsListener>();
  const stateListeners = new Set<WsStateListener>();
  let socket: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  const diag: WsDiagnostics = {
    phase: "connecting",
    attempts: 0,
  };
  const emitState = () => {
    for (const l of stateListeners) l({ ...diag });
  };

  const scheduleReconnect = (backoffMs: number) => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    diag.reconnectIn = backoffMs;
    emitState();
    reconnectTimer = setTimeout(() => {
      diag.reconnectIn = undefined;
      connect();
    }, backoffMs);
  };

  const connect = () => {
    if (disposed) return;
    diag.attempts += 1;
    diag.phase = "connecting";
    emitState();
    try {
      socket = new WebSocket(url);
    } catch (err) {
      diag.phase = "error";
      diag.lastError = err instanceof Error ? err.message : String(err);
      emitState();
      scheduleReconnect(Math.min(1000 * diag.attempts, 5000));
      return;
    }

    socket.addEventListener("open", () => {
      connected = true;
      diag.phase = "open";
      diag.attempts = 0;
      diag.lastError = undefined;
      emitState();
      try {
        socket?.send(
          JSON.stringify({ type: "hello", resume: {} } satisfies ClientFrame),
        );
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("message", (ev) => {
      diag.lastFrameAt = Date.now();
      let frame: ServerFrame;
      try {
        frame = JSON.parse(ev.data as string) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "hello_ack" && diag.phase !== "acked") {
        diag.phase = "acked";
        emitState();
      }
      for (const l of listeners) l(frame);
    });
    socket.addEventListener("close", (ev: CloseEvent) => {
      connected = false;
      diag.phase = "closed";
      diag.lastCloseCode = ev.code;
      diag.lastCloseReason = ev.reason || undefined;
      emitState();
      if (disposed) return;
      scheduleReconnect(Math.min(1000 + 500 * diag.attempts, 5000));
    });
    socket.addEventListener("error", () => {
      diag.phase = "error";
      diag.lastError = "socket error";
      emitState();
      // Let `close` drive the reconnect. Don't close() here — some iOS
      // versions fire `error` before `open` completes and we'd double-reconnect.
    });
  };

  // iOS Safari — when the page comes back from background, a socket can be
  // silently dead. Nudge it.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (disposed || document.visibilityState !== "visible") return;
      // If the socket isn't OPEN when we come back to the foreground, reconnect.
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        connect();
        return;
      }
      // If it *claims* to be open but we haven't heard from the server in a
      // while, force a reconnect so we don't sit on a half-dead socket.
      const idle = Date.now() - (diag.lastFrameAt ?? 0);
      if (idle > 60_000) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
    });
  }

  connect();

  return {
    get connected() {
      return connected;
    },
    get diagnostics() {
      return { ...diag };
    },
    send(frame) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onState(listener) {
      stateListeners.add(listener);
      // Emit once so subscribers get current state without waiting for a change.
      queueMicrotask(() => listener({ ...diag }));
      return () => stateListeners.delete(listener);
    },
    close() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      listeners.clear();
      stateListeners.clear();
    },
  };
}
