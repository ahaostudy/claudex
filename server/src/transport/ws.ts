import type { FastifyInstance, FastifyRequest } from "fastify";
import websocket, { type WebSocket } from "@fastify/websocket";
import { ClientFrame, type ServerFrame } from "@claudex/shared";
import {
  ACCESS_COOKIE_NAME,
  verifyAccessToken,
  UserStore,
} from "../auth/index.js";
import type { SessionManager } from "../sessions/manager.js";
import type { RunnerEvent } from "../sessions/runner.js";
import type Database from "better-sqlite3";

export interface WsDeps {
  manager: SessionManager;
  db: Database.Database;
  jwtSecret: Uint8Array;
}

/**
 * Registers /ws. One WebSocket per authenticated browser tab, multiplexed
 * across any number of sessions the client subscribes to.
 */
export async function registerWsRoute(
  app: FastifyInstance,
  deps: WsDeps,
): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // Per-connection subscription state.
  interface ConnState {
    userId: string;
    subs: Set<string>;
    send: (frame: ServerFrame) => void;
  }
  // Map of sessionId → set of connections, so per-session broadcasts are
  // O(subscribers).
  const subscribers = new Map<string, Set<ConnState>>();
  // Every authenticated connection also lands in this "global" set. Used to
  // deliver cross-session frames (`session_update`, `user_message`) to tabs
  // that haven't explicitly subscribed to a specific sessionId — notably the
  // Home/sessions-list screen, which needs live status dots without pinning
  // one conversation. Turn payloads (assistant_text_delta, thinking,
  // tool_use, tool_result, permission_request, turn_end) still go only to
  // per-session subscribers so that idle tabs don't get firehosed.
  const globalSessionSubs = new Set<ConnState>();

  // Frame types that describe *cross-session* state (identity of a session
  // as it appears in a list view). Everything else is turn-scoped and stays
  // gated on an explicit `subscribe`.
  const GLOBAL_FRAME_TYPES = new Set<ServerFrame["type"]>([
    "session_update",
    "user_message",
    "refresh_transcript",
  ]);

  // Wire the runner-event broadcast into the ws layer. This is a one-time
  // bridge: the SessionManager broadcasts already carries event.type. We
  // translate each event to a ServerFrame.
  const bridgeBroadcast = (sessionId: string, event: RunnerEvent): void => {
    const frame = runnerEventToFrame(sessionId, event);
    if (!frame) return;
    const bucket = subscribers.get(sessionId);
    const sent = new Set<ConnState>();
    if (bucket) {
      for (const conn of bucket) {
        conn.send(frame);
        sent.add(conn);
      }
    }
    if (GLOBAL_FRAME_TYPES.has(frame.type)) {
      for (const conn of globalSessionSubs) {
        if (sent.has(conn)) continue;
        conn.send(frame);
      }
    }
  };

  // Patch the broadcast target. SessionManager was created before WS was
  // registered (ordering in buildApp), so we expose a setter.
  attachBroadcaster(deps.manager, bridgeBroadcast);

  app.get(
    "/ws",
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const ua = String(req.headers["user-agent"] ?? "").slice(0, 80);
      const xfp = String(req.headers["x-forwarded-proto"] ?? "");
      const host = String(req.headers.host ?? "");
      const hasCookie = !!req.cookies?.[ACCESS_COOKIE_NAME];
      req.log?.info(
        { ua, xfp, host, hasCookie },
        "ws handshake begin",
      );

      const userId = await authenticateSocket(req, deps);
      if (!userId) {
        req.log?.warn({ host, hasCookie }, "ws handshake rejected: unauthenticated");
        socket.send(
          JSON.stringify({
            type: "error",
            sessionId: null,
            code: "unauthenticated",
            message: "unauthenticated",
          } satisfies ServerFrame),
        );
        socket.close();
        return;
      }

      const subs = new Set<string>();
      const state: ConnState = {
        userId,
        subs,
        send: (frame) => {
          try {
            socket.send(JSON.stringify(frame));
          } catch {
            // socket torn down; ignore
          }
        },
      };

      state.send({ type: "hello_ack", serverVersion: "0.0.1" });
      // Every authed tab joins the global sessions channel so Home/list
      // screens receive `session_update` + `user_message` without needing
      // to subscribe to each sessionId individually.
      globalSessionSubs.add(state);
      req.log?.info({ userId }, "ws handshake ok, hello_ack sent");

      socket.on("message", (raw: Buffer | string) => {
        let parsed;
        try {
          const obj = JSON.parse(raw.toString());
          parsed = ClientFrame.safeParse(obj);
        } catch {
          state.send({
            type: "error",
            sessionId: null,
            code: "bad_frame",
            message: "invalid JSON",
          });
          return;
        }
        if (!parsed.success) {
          state.send({
            type: "error",
            sessionId: null,
            code: "bad_frame",
            message: parsed.error.issues[0]?.message ?? "schema violation",
          });
          return;
        }
        handleClientFrame(parsed.data, state, subscribers, deps).catch((err) => {
          state.send({
            type: "error",
            sessionId: null,
            code: "handler_error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
      });

      socket.on("close", () => {
        for (const id of subs) {
          subscribers.get(id)?.delete(state);
        }
        subs.clear();
        globalSessionSubs.delete(state);
      });
    },
  );
}

async function authenticateSocket(
  req: FastifyRequest,
  deps: WsDeps,
): Promise<string | null> {
  const token = req.cookies?.[ACCESS_COOKIE_NAME];
  if (!token) return null;
  try {
    const claims = await verifyAccessToken(deps.jwtSecret, token);
    const user = new UserStore(deps.db).findById(claims.userId);
    return user?.id ?? null;
  } catch {
    return null;
  }
}

async function handleClientFrame(
  frame: ReturnType<typeof ClientFrame.parse>,
  state: {
    userId: string;
    subs: Set<string>;
    send: (f: ServerFrame) => void;
  },
  subscribers: Map<string, Set<typeof state>>,
  deps: WsDeps,
): Promise<void> {
  switch (frame.type) {
    case "hello":
      // resume-on-reconnect: could replay events from sinceSeq here; deferred.
      return;
    case "subscribe": {
      state.subs.add(frame.sessionId);
      let bucket = subscribers.get(frame.sessionId);
      if (!bucket) {
        bucket = new Set();
        subscribers.set(frame.sessionId, bucket);
      }
      bucket.add(state);
      return;
    }
    case "unsubscribe": {
      state.subs.delete(frame.sessionId);
      subscribers.get(frame.sessionId)?.delete(state);
      return;
    }
    case "user_message": {
      await deps.manager.sendUserMessage(frame.sessionId, frame.content);
      return;
    }
    case "interrupt": {
      await deps.manager.interrupt(frame.sessionId);
      return;
    }
    case "permission_decision": {
      deps.manager.resolvePermission(
        frame.sessionId,
        frame.approvalId,
        frame.decision,
      );
      return;
    }
  }
}

// -----------------------------------------------------------------------------
// Runner event → WS frame mapping
// -----------------------------------------------------------------------------

function runnerEventToFrame(
  sessionId: string,
  event: RunnerEvent,
): ServerFrame | null {
  switch (event.type) {
    case "status":
      return {
        type: "session_update",
        sessionId,
        status:
          event.status === "terminated"
            ? "idle"
            : event.status === "starting"
              ? "running"
              : event.status,
      };
    case "sdk_session_id":
      return null; // nothing to tell the browser
    case "assistant_text":
      return {
        type: "assistant_text_delta",
        sessionId,
        messageId: event.messageId,
        seq: 0, // not used on wire; replay handled via REST /events
        text: event.text,
      };
    case "thinking":
      return {
        type: "thinking",
        sessionId,
        seq: 0,
        text: event.text,
      };
    case "tool_use":
      return {
        type: "tool_use",
        sessionId,
        seq: 0,
        toolUseId: event.toolUseId,
        name: event.name,
        input: event.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        sessionId,
        seq: 0,
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError,
      };
    case "permission_request":
      return {
        type: "permission_request",
        sessionId,
        seq: 0,
        approvalId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.input,
        summary: event.title,
        blastRadius: null,
      };
    case "turn_end":
      return {
        type: "turn_end",
        sessionId,
        seq: 0,
        stopReason: event.stopReason,
      };
    case "user_message":
      return {
        type: "user_message",
        sessionId,
        content: event.text,
        createdAt: event.at,
      };
    case "refresh_transcript":
      return {
        type: "refresh_transcript",
        sessionId,
      };
    case "error":
      return {
        type: "error",
        sessionId,
        code: event.code,
        message: event.message,
      };
  }
}

// Hook: SessionManager's broadcaster is set once; this is here so buildApp
// can create the manager with a no-op broadcaster and attach the real one
// after WS is registered. We do it by reflection to avoid an extra interface
// dance.
function attachBroadcaster(
  manager: SessionManager,
  broadcast: (sessionId: string, event: RunnerEvent) => void,
): void {
  (manager as any).deps.broadcast = broadcast;
}
