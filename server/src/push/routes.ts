import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import webpush from "web-push";
import {
  PushSubscribeRequest,
  type PushStateResponse,
  type PushSubscribeResponse,
  type PushTestResponse,
  type VapidPublicResponse,
} from "@claudex/shared";
import { PushSubscriptionStore } from "./store.js";
import { configureWebPush, type VapidKeys } from "./vapid.js";
import type { AuditStore } from "../audit/store.js";

// -----------------------------------------------------------------------------
// Push routes
//
// All login-gated. Surfaces:
//   GET  /api/push/vapid-public       — hands the browser the applicationServerKey
//   POST /api/push/subscriptions      — register this device
//   DEL  /api/push/subscriptions/:id  — revoke one device
//   DEL  /api/push/subscriptions      — revoke all ("disable notifications")
//   GET  /api/push/state              — enabled + device list for Settings
//   POST /api/push/test               — fire a test push to every device
//
// The send fan-out lives here too, exposed as `sendPushToAll`. SessionManager
// calls it fire-and-forget when a permission_request arrives. Any subscription
// that returns 404/410 from web-push gets pruned on the spot so the device
// list stays honest.
// -----------------------------------------------------------------------------

/**
 * Minimal logger contract. Accepts pino's native `Logger` and Fastify's
 * `FastifyBaseLogger` interchangeably — we only use `warn`.
 */
type WarnLogger = { warn: (obj: unknown, msg?: string) => void } | undefined;

export interface PushRoutesDeps {
  db: Database.Database;
  vapid: VapidKeys;
  logger?: WarnLogger;
  audit?: AuditStore;
}

export interface PushPayload {
  title: string;
  body: string;
  data: { sessionId: string; url: string };
}

export interface PushSender {
  sendToAll(payload: PushPayload): Promise<{ sent: number; pruned: number }>;
}

/**
 * Build a pusher that can be handed to other modules (e.g. SessionManager)
 * after `registerPushRoutes` has run. Pulls the store fresh from `deps.db`
 * on every call so tests that swap databases don't cache a stale reference.
 */
export function createPushSender(deps: PushRoutesDeps): PushSender {
  configureWebPush(deps.vapid);
  const store = new PushSubscriptionStore(deps.db);

  async function sendToAll(
    payload: PushPayload,
  ): Promise<{ sent: number; pruned: number }> {
    const subs = store.list();
    if (subs.length === 0) return { sent: 0, pruned: 0 };

    const body = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;

    await Promise.all(
      subs.map(async (s) => {
        const sub = {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        };
        try {
          await webpush.sendNotification(sub, body);
          store.touchLastUsed(s.id);
          sent += 1;
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          // 404 / 410 = the push service says this subscription is dead
          // (browser unsubscribed, PWA uninstalled, etc). Drop it so we don't
          // keep retrying indefinitely. Other errors (timeouts, network) are
          // transient and we leave the row in place.
          if (statusCode === 404 || statusCode === 410) {
            store.deleteByEndpoint(s.endpoint);
            pruned += 1;
          } else {
            deps.logger?.warn?.(
              { err, endpoint: s.endpoint, statusCode },
              "web-push send failed",
            );
          }
        }
      }),
    );

    return { sent, pruned };
  }

  return { sendToAll };
}

export async function registerPushRoutes(
  app: FastifyInstance,
  deps: PushRoutesDeps,
  sender: PushSender,
): Promise<void> {
  const store = new PushSubscriptionStore(deps.db);

  app.get(
    "/api/push/vapid-public",
    { preHandler: app.requireAuth as any },
    async () => {
      const body: VapidPublicResponse = { publicKey: deps.vapid.publicKey };
      return body;
    },
  );

  app.post(
    "/api/push/subscriptions",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const parsed = PushSubscribeRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request" });
      }
      // Prefer the body-provided userAgent (client may post the browser's
      // navigator.userAgent verbatim), fall back to the request header.
      const ua =
        parsed.data.userAgent ??
        (typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : null);
      const row = store.upsert({
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: ua,
      });
      // Audit: pairing a new push device is security-relevant — that device
      // can now receive permission-request pings that reveal what claude is
      // doing. user-agent goes in `detail` so the Security card can render
      // "New push device: Safari on iPhone".
      deps.audit?.append({
        userId: (req as { userId?: string }).userId ?? null,
        event: "push_subscribed",
        target: row.id,
        detail: ua ?? null,
        ip: (req as { ip?: string }).ip ?? null,
        userAgent: ua ?? null,
      });
      const body: PushSubscribeResponse = { id: row.id, enabled: true };
      return reply.send(body);
    },
  );

  app.delete(
    "/api/push/subscriptions/:id",
    { preHandler: app.requireAuth as any },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = store.findById(id);
      const ok = store.deleteById(id);
      if (!ok) return reply.code(404).send({ error: "not_found" });
      // Audit: device revocation. Capture the UA from the row we just
      // deleted so the Security card can say which device dropped off.
      deps.audit?.append({
        userId: (req as { userId?: string }).userId ?? null,
        event: "push_revoked",
        target: id,
        detail: existing?.userAgent ?? null,
        ip: (req as { ip?: string }).ip ?? null,
        userAgent:
          typeof req.headers["user-agent"] === "string"
            ? req.headers["user-agent"]
            : null,
      });
      return reply.send({ ok: true });
    },
  );

  app.delete(
    "/api/push/subscriptions",
    { preHandler: app.requireAuth as any },
    async (_req, reply) => {
      const removed = store.deleteAll();
      return reply.send({ ok: true, removed });
    },
  );

  app.get(
    "/api/push/state",
    { preHandler: app.requireAuth as any },
    async () => {
      const devices = store.listDevices();
      const body: PushStateResponse = {
        enabled: devices.length > 0,
        devices,
      };
      return body;
    },
  );

  app.post(
    "/api/push/test",
    { preHandler: app.requireAuth as any },
    async () => {
      const result = await sender.sendToAll({
        title: "claudex · test",
        body: "Push is working on this device.",
        data: { sessionId: "", url: "/settings?tab=notifications" },
      });
      const body: PushTestResponse = result;
      return body;
    },
  );
}
