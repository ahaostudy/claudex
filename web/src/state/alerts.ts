import { create } from "zustand";
import type { Alert } from "@claudex/shared";
import { api } from "@/api/client";

// -----------------------------------------------------------------------------
// Alerts Zustand slice.
//
// Source of truth for the alerts list across the app (AppShell badge,
// /alerts screen). Populated from REST (`GET /api/alerts`) and kept fresh
// by the `alerts_update` WS frame — when the server fires it, a listener
// wired in state/sessions.ts calls `fetchAlerts()` here to reconcile.
//
// State model matches the server's: an alert has two orthogonal bits
// (seenAt, resolvedAt). The UI filters into Unread / Active / All buckets
// rather than deleting rows, mirroring the "state transitions, not
// deletion" server design.
// -----------------------------------------------------------------------------

interface AlertsState {
  alerts: Alert[];
  /** Unseen count, computed whenever the list is replaced so AppShell can
   *  read a primitive number rather than recomputing on every render. */
  unseenCount: number;
  /** True between `fetchAlerts` kickoff and first resolution. Drives the
   *  spinner on the Alerts screen. */
  loading: boolean;

  fetchAlerts(): Promise<void>;
  /** Mark one alert seen. Optimistically updates local state; on server
   *  failure the next WS-driven refetch will reconcile. */
  markSeen(id: string): Promise<void>;
  /** Bulk mark-seen. Called by the Alerts screen on mount so the badge
   *  clears as soon as the user looks at the list. */
  markAllSeen(): Promise<void>;
  /** User-initiated dismiss — stamps both resolved_at AND seen_at on the
   *  server, so the alert drops out of Unread and Active on the next
   *  refetch. Kept in the All tab as an archival row. */
  dismiss(id: string): Promise<void>;
}

function computeUnseen(list: Alert[]): number {
  let n = 0;
  for (const a of list) if (a.seenAt === null) n++;
  return n;
}

export const useAlerts = create<AlertsState>((set, get) => ({
  alerts: [],
  unseenCount: 0,
  loading: false,

  async fetchAlerts() {
    set({ loading: true });
    try {
      const res = await api.listAlerts();
      set({
        alerts: res.alerts,
        unseenCount: res.unseenCount,
        loading: false,
      });
    } catch {
      // Keep existing state on failure; drop the loading flag so the UI
      // doesn't wedge on a spinner.
      set({ loading: false });
    }
  },

  async markSeen(id: string) {
    // Optimistic local update.
    const now = new Date().toISOString();
    const next = get().alerts.map((a) =>
      a.id === id && a.seenAt === null ? { ...a, seenAt: now } : a,
    );
    set({ alerts: next, unseenCount: computeUnseen(next) });
    try {
      await api.markAlertSeen(id);
    } catch {
      /* WS alerts_update will reconcile */
    }
  },

  async markAllSeen() {
    const now = new Date().toISOString();
    const next = get().alerts.map((a) =>
      a.seenAt === null ? { ...a, seenAt: now } : a,
    );
    set({ alerts: next, unseenCount: 0 });
    try {
      await api.markAllAlertsSeen();
    } catch {
      /* reconcile via WS */
    }
  },

  async dismiss(id: string) {
    const now = new Date().toISOString();
    const next = get().alerts.map((a) =>
      a.id === id
        ? {
            ...a,
            seenAt: a.seenAt ?? now,
            resolvedAt: a.resolvedAt ?? now,
          }
        : a,
    );
    set({ alerts: next, unseenCount: computeUnseen(next) });
    try {
      await api.dismissAlert(id);
    } catch {
      /* reconcile via WS */
    }
  },
}));
