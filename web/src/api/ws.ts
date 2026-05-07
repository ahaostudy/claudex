import type { ClientFrame, ServerFrame } from "@claudex/shared";

export type WsListener = (frame: ServerFrame) => void;

export interface WsClient {
  send(frame: ClientFrame): void;
  subscribe(listener: WsListener): () => void;
  close(): void;
  readonly connected: boolean;
}

/**
 * Auto-reconnecting WS client. Exposes a simple send/subscribe surface; the
 * store layer decides which frames matter.
 */
export function createWsClient(url: string): WsClient {
  const listeners = new Set<WsListener>();
  let socket: WebSocket | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;

  const connect = () => {
    if (disposed) return;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      connected = true;
      socket?.send(JSON.stringify({ type: "hello", resume: {} } satisfies ClientFrame));
    });
    socket.addEventListener("message", (ev) => {
      try {
        const frame = JSON.parse(ev.data as string) as ServerFrame;
        for (const l of listeners) l(frame);
      } catch {
        /* ignore */
      }
    });
    socket.addEventListener("close", () => {
      connected = false;
      if (disposed) return;
      // exponential-ish backoff, capped at 5s
      reconnectTimer = setTimeout(connect, 1000);
    });
    socket.addEventListener("error", () => {
      socket?.close();
    });
  };

  connect();

  return {
    get connected() {
      return connected;
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
    close() {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      listeners.clear();
    },
  };
}
