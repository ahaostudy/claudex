import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bell,
  BellOff,
  ChevronLeft,
  KeyRound,
  Palette,
  Plug,
  Server,
  Shield,
  Sliders,
  Terminal as TerminalIcon,
  Trash2,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/state/auth";
import { api, ApiError } from "@/api/client";
import type { PushDevice, UserEnvResponse } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { AppShell } from "@/components/AppShell";
import {
  deviceLabel,
  detectPushSupport,
  getPushState,
  isCurrentDeviceSubscribed,
  revokeDevice,
  sendTestPush,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push";

// ---------------------------------------------------------------------------
// Settings — mockup s-12 structure.
//
// Layout shape
//   AppShell                     // global nav (logo column on desktop)
//     ├ header                   // caps "Settings" + display {activeTab}
//     ├ profile card             // avatar + username + "self-hosted" + 2FA
//     └ body
//         ├ left rail (md+)      // 240px inner rail, 8 entries
//         ├ chip row (<md)       // horizontal filter chips, 8 entries
//         └ content              // caps + display + lede + panels
//
// Honesty rule: we match the mockup's visual structure (header, inner rail,
// card language), but if we don't have the data to fill a section, we render
// an explicit empty state instead of fabricating a paired-browsers list,
// an audit log, or an exposure panel.
//
// URL state: `?tab=security` preserves the active subtab across refreshes.
// ---------------------------------------------------------------------------

type Tab =
  | "account"
  | "security"
  | "notifications"
  | "appearance"
  | "mcp"
  | "plugins"
  | "environment"
  | "advanced";

interface TabSpec {
  id: Tab;
  label: string;
  icon: typeof UserIcon;
  // caps header — "Settings · {caps}"
  caps: string;
  // display title at the top of the content area
  title: string;
  // lede under the display title (mockup pattern)
  lede: string;
}

const TABS: TabSpec[] = [
  {
    id: "account",
    label: "Account",
    icon: UserIcon,
    caps: "account",
    title: "Your local claudex credentials.",
    lede: "One user account lives on this machine. Change the password here; everything else is rotated via the CLI.",
  },
  {
    id: "security",
    label: "Security",
    icon: Shield,
    caps: "security",
    title: "Keep this door locked.",
    lede: "claudex exposes a surface to your machine. Treat it like SSH: strong password, 2FA, scoped access, auditable log.",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    caps: "notifications",
    title: "Know when Claude needs you.",
    lede: "claudex can push a notification when a permission request arrives. Works best installed to your home screen.",
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    caps: "appearance",
    title: "Light theme today.",
    lede: "Dark and text-size live here later. For now claudex ships with a single calm-paper theme.",
  },
  {
    id: "mcp",
    label: "MCP servers",
    icon: Server,
    caps: "mcp servers",
    title: "Read-only view of your MCP config.",
    lede: "Your MCP servers come from ~/.claude/settings.json — claudex does not edit that file. This pane will reflect what's there once we parse the mcpServers block.",
  },
  {
    id: "plugins",
    label: "Plugins",
    icon: Plug,
    caps: "plugins",
    title: "Read-only view of ~/.claude/plugins/.",
    lede: "Installed plugins come from the claude CLI. Use `claude plugin install …` to add them; they'll show up here.",
  },
  {
    id: "environment",
    label: "Environment",
    icon: TerminalIcon,
    caps: "environment",
    title: "Read-only view of ~/.claude/settings.json.",
    lede: "A handful of safe fields so you can confirm claudex is looking at the same config the CLI uses.",
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: Sliders,
    caps: "advanced",
    title: "Low-level knobs and power-user settings.",
    lede: "Nothing here yet. Future home for JWT rotation, worktree defaults, and exposure diagnostics.",
  },
];

function isTab(value: string | null | undefined): value is Tab {
  return TABS.some((t) => t.id === value);
}

export function SettingsScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const fromParams = params.get("tab");
  const tab: Tab = isTab(fromParams) ? fromParams : "account";
  const spec = TABS.find((t) => t.id === tab)!;

  const setTab = (next: Tab) => {
    const nextParams = new URLSearchParams(params);
    if (next === "account") nextParams.delete("tab");
    else nextParams.set("tab", next);
    setParams(nextParams, { replace: true });
  };

  return (
    <AppShell tab="settings">
      {/* Mobile-first header — caps "Settings" + display {tab}. Back button on
          mobile jumps to /sessions (AppShell's default tab). Desktop hides the
          back chevron because the sidebar already provides orientation. */}
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-4 sm:px-5 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/sessions")}
          aria-label="Back"
          className="md:hidden h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="caps text-ink-muted">Settings</div>
          <div className="display text-[17px] leading-tight truncate">
            {spec.label}
          </div>
        </div>
        <div className="ml-auto text-[12px] text-ink-muted hidden sm:inline">
          signed in as <span className="mono">{user?.username ?? "—"}</span>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Profile card — matches mockup lines 2062–2066, honest variant.
            Rendered on every subtab so the user always sees who they are. */}
        <ProfileCard />

        <div className="md:grid md:grid-cols-[240px_minmax(0,1fr)]">
          {/* Desktop inner rail: 8 entries, active = bg-canvas+border+shadow.
              Mockup lines 2097–2111. */}
          <aside className="hidden md:block border-r border-line bg-paper/40 overflow-y-auto">
            <div className="p-4 flex items-center gap-2">
              <svg viewBox="0 0 32 32" className="w-4 h-4">
                <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
                <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
              </svg>
              <span className="mono text-[13px]">settings</span>
            </div>
            <div className="px-4 caps text-ink-muted mb-2">Settings</div>
            <nav className="px-3 space-y-0.5 text-[13px]">
              {TABS.map(({ id, label, icon: Icon }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={cn(
                      "w-full text-left flex items-center gap-2 px-2.5 h-8 rounded-[6px]",
                      active
                        ? "bg-canvas border border-line shadow-card"
                        : "hover:bg-canvas/60 border border-transparent text-ink-soft",
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Mobile filter-chip row: same 8 entries, horizontal scroll. */}
          <nav className="md:hidden flex gap-1.5 px-3 py-2.5 overflow-x-auto no-scrollbar border-b border-line">
            {TABS.map(({ id, label, icon: Icon }) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[12px] border",
                    active
                      ? "bg-ink text-canvas border-ink"
                      : "bg-canvas text-ink-soft border-line",
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
          </nav>

          <section className="min-w-0 p-5 sm:p-8 pb-24 md:pb-10">
            <div className="max-w-[760px]">
              <div className="caps text-ink-muted">
                Settings · {spec.caps}
              </div>
              <h1 className="display text-[24px] md:text-[28px] leading-tight mt-1">
                {spec.title}
              </h1>
              <p className="text-[14px] md:text-[15px] text-ink-muted mt-2 max-w-[60ch]">
                {spec.lede}
              </p>

              <div className="mt-7 space-y-5">
                {tab === "account" && <AccountPanel />}
                {tab === "security" && <SecurityPanel />}
                {tab === "notifications" && <NotificationsPanel />}
                {tab === "appearance" && <AppearancePanel />}
                {tab === "mcp" && <McpPanel onPlugins={() => setTab("plugins")} />}
                {tab === "plugins" && <PluginsPanel />}
                {tab === "environment" && <EnvironmentPanel />}
                {tab === "advanced" && <AdvancedPanel />}
              </div>
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

// ----------------------------------------------------------------------------
// Profile card — mockup lines 2062–2066, honest variant:
//   - avatar = first char of username
//   - name line = username (no display name; we don't collect one)
//   - sub line = "self-hosted" (we don't have plan tiers)
//   - 2FA pill always shows "2FA on" — TOTP is mandatory
//   - no email (we don't collect one)
// ----------------------------------------------------------------------------

function ProfileCard() {
  const { user } = useAuth();
  const initial = user?.username?.[0]?.toUpperCase() ?? "?";
  return (
    <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-line">
      <div className="h-12 w-12 rounded-full bg-ink text-canvas flex items-center justify-center text-[16px] font-medium">
        {initial}
      </div>
      <div className="min-w-0">
        <div className="font-medium truncate">{user?.username ?? "—"}</div>
        <div className="text-[12px] text-ink-muted">self-hosted</div>
      </div>
      <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-success/30 bg-success-wash text-[#1f5f21] text-[10px] font-medium uppercase tracking-[0.1em] shrink-0">
        2FA on
      </span>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Account — unchanged behavior. Rows + change-password flow.
// ----------------------------------------------------------------------------

function AccountPanel() {
  const { user } = useAuth();
  const [showChange, setShowChange] = useState(false);
  return (
    <>
      <Card>
        <Row label="Username" value={<span className="mono">{user?.username ?? "—"}</span>} />
        <Row
          label="Created"
          value={user ? new Date(user.createdAt).toLocaleString() : "—"}
        />
        <Row
          label="Two-factor"
          value={
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-success/30 bg-success-wash text-[#1f5f21] text-[10px] font-medium uppercase tracking-[0.1em]">
              enabled
            </span>
          }
        />
        <div className="px-4 py-3 border-t border-line bg-paper/40 flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowChange(true)}
            className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] inline-flex items-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Change password
          </button>
          <span className="text-[11.5px] text-ink-muted ml-1">
            Requires your current password.
          </span>
        </div>
      </Card>
      {showChange && (
        <ChangePasswordModal onClose={() => setShowChange(false)} />
      )}
    </>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (next.length < 8) {
      setErr("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setErr("New password and confirmation don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword({
        currentPassword: current,
        newPassword: next,
      });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "invalid_credentials") {
          setErr("Current password is incorrect.");
        } else if (e.code === "same_password") {
          setErr("New password must be different from the current one.");
        } else if (e.code === "bad_request") {
          setErr("New password must be at least 8 characters.");
        } else {
          setErr(e.code);
        }
      } else {
        setErr("change failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-end sm:items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5"
      >
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">Security</div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              Change password
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        {done ? (
          <div className="space-y-4">
            <div className="text-[14px]">
              Password updated. Your current tab stays signed in; other tabs
              with the old session will continue working until their cookie
              expires.
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full h-10 rounded-[8px] bg-ink text-canvas text-[14px] font-medium"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <LabeledInput
              label="Current password"
              type="password"
              value={current}
              onChange={setCurrent}
              autoFocus
            />
            <LabeledInput
              label="New password"
              type="password"
              value={next}
              onChange={setNext}
            />
            <LabeledInput
              label="Confirm new password"
              type="password"
              value={confirm}
              onChange={setConfirm}
            />
            {err && (
              <div className="text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
                {err}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full h-10 rounded-[8px] bg-ink text-canvas text-[14px] font-medium disabled:opacity-50"
            >
              {busy ? "Updating…" : "Update password"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <div className="caps text-ink-muted mb-1">{label}</div>
      <input
        className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </label>
  );
}

// ----------------------------------------------------------------------------
// Security — mockup lines 2119–2135, stripped honest version.
//
// Shipped: enabled pill + Issuer.
// Omitted (and why):
//   - Recovery codes tile  — we don't track "8 of 10 unused"
//   - Last used tile       — we don't record TOTP usage timestamps
//   - Regenerate codes btn — no rotation flow yet
//   - Move to hardware key — no flow
//   - Disable 2FA          — TOTP is mandatory
//   - Paired browsers card — no per-JWT tracking
//   - Exposure / audit log — no data source
// ----------------------------------------------------------------------------

function SecurityPanel() {
  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-4 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded-[8px] bg-klein-wash border border-klein/20 flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-klein" />
        </div>
        <div className="min-w-0">
          <div className="display text-[18px] leading-tight">
            Two-factor authentication
          </div>
          <div className="text-[13px] text-ink-muted mt-0.5">
            Required. Rotates every 30 seconds via an authenticator app.
          </div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-success/30 bg-success-wash text-[#1f5f21] text-[10px] font-medium uppercase tracking-[0.1em] shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          enabled
        </span>
      </div>

      <div className="grid grid-cols-1 text-[13px]">
        <div className="px-5 py-4">
          <div className="caps text-ink-muted">Issuer</div>
          <div className="mt-1 mono">claudex</div>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-line bg-paper/40 text-[12.5px] text-ink-muted">
        Recovery codes, "last used", paired browsers, regenerate/disable flows
        are planned. Rotate via <span className="mono">pnpm reset-credentials</span> for now.
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Notifications — real enable/disable flow + device list.
//
// Three states the panel can be in, driven by local browser capability and
// server-side subscription count:
//   1. capability lost       — browser doesn't support SW/Push, OR page is
//                              on insecure origin (frpc-over-HTTP). Render a
//                              constraint card; no enable button.
//   2. not enabled here yet  — browser supports push, but this device hasn't
//                              subscribed. Render the "Enable on this device"
//                              primary button; list any other subscribed
//                              devices separately.
//   3. enabled               — this browser has a live PushSubscription.
//                              Render the "disable" button + Send test +
//                              device list with per-device revoke.
//
// The server's `GET /api/push/state` gives us the device list; we pair it
// with `navigator.serviceWorker.getRegistration().pushManager.getSubscription()`
// to know whether *this* browser is one of those devices.
// ----------------------------------------------------------------------------

function NotificationsPanel() {
  const [support] = useState(() => detectPushSupport());
  const [permission, setPermission] = useState<NotificationPermission | "unknown">(
    () =>
      typeof window !== "undefined" && "Notification" in window
        ? Notification.permission
        : "unknown",
  );
  const [currentSubscribed, setCurrentSubscribed] = useState<boolean | null>(
    null,
  );
  const [devices, setDevices] = useState<PushDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  async function refresh() {
    try {
      if (support === "ready") {
        setCurrentSubscribed(await isCurrentDeviceSubscribed());
      } else {
        setCurrentSubscribed(false);
      }
      const state = await getPushState();
      setDevices(state.devices);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    }
  }

  useEffect(() => {
    void refresh();
    // We intentionally don't poll — push state only changes on user action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function enable() {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      await subscribeToPush();
      setPermission(Notification.permission);
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "permission_denied") {
        setErr(
          "Notification permission was denied. You can re-enable it in your browser's site settings for this origin, then try again.",
        );
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      await unsubscribeFromPush();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRevoke(id: string) {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      await revokeDevice(id);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doTest() {
    setErr(null);
    setTestMsg(null);
    setBusy(true);
    try {
      const res = await sendTestPush();
      if (res.sent === 0) {
        setTestMsg(
          "No devices to notify. Enable notifications on at least one device first.",
        );
      } else {
        setTestMsg(
          `Sent to ${res.sent} device${res.sent === 1 ? "" : "s"}${
            res.pruned > 0 ? ` · pruned ${res.pruned} stale` : ""
          }.`,
        );
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canEnable = support === "ready" && currentSubscribed === false;

  return (
    <div className="space-y-5">
      {support !== "ready" && (
        <Card>
          <div className="px-4 py-4 text-[13px] text-ink-soft">
            {support === "insecure" ? (
              <>
                This browser considers the current origin insecure. Push
                notifications require HTTPS — run claudex behind a TLS tunnel
                such as Cloudflare Tunnel, Tailscale, or Caddy. Plain-HTTP
                frpc will not deliver pushes, especially on iOS Safari.
              </>
            ) : (
              <>
                This browser doesn't support Web Push or Service Workers. On
                iOS, install claudex to your Home Screen (Share → "Add to Home
                Screen") and reopen from there — that path enables push
                notifications on iOS 16.4+.
              </>
            )}
          </div>
        </Card>
      )}

      {support === "ready" && (
        <Card>
          <div className="px-4 sm:px-5 py-4 flex items-center gap-4">
            <div
              className={cn(
                "h-9 w-9 rounded-[8px] border flex items-center justify-center shrink-0",
                currentSubscribed
                  ? "bg-klein-wash border-klein/20"
                  : "bg-paper border-line",
              )}
            >
              {currentSubscribed ? (
                <Bell className="w-4 h-4 text-klein" />
              ) : (
                <BellOff className="w-4 h-4 text-ink-muted" />
              )}
            </div>
            <div className="min-w-0">
              <div className="display text-[16px] leading-tight">
                {currentSubscribed
                  ? "Notifications on for this device"
                  : "Notifications off on this device"}
              </div>
              <div className="text-[12.5px] text-ink-muted mt-0.5">
                {permission === "denied"
                  ? "Browser permission denied. Flip it in site settings to re-enable."
                  : currentSubscribed
                    ? "Claude will ping you here when a permission request arrives."
                    : "Enable to receive a push when Claude asks for permission."}
              </div>
            </div>
            <div className="ml-auto shrink-0">
              {currentSubscribed ? (
                <button
                  type="button"
                  onClick={disable}
                  disabled={busy}
                  className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] disabled:opacity-50"
                >
                  Disable
                </button>
              ) : (
                <button
                  type="button"
                  onClick={enable}
                  disabled={busy || !canEnable || permission === "denied"}
                  className="h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium disabled:opacity-50"
                >
                  {busy ? "Enabling…" : "Enable on this device"}
                </button>
              )}
            </div>
          </div>
          <div className="px-4 sm:px-5 py-3 border-t border-line bg-paper/40 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={doTest}
              disabled={busy || (devices?.length ?? 0) === 0}
              className="h-8 px-3 rounded-[8px] border border-line bg-canvas text-[12.5px] disabled:opacity-50"
            >
              Send test
            </button>
            {testMsg && (
              <span className="text-[12px] text-ink-muted">{testMsg}</span>
            )}
            {err && (
              <span className="text-[12px] text-danger bg-danger-wash rounded-[6px] px-2 py-1 border border-danger/30">
                {err}
              </span>
            )}
          </div>
        </Card>
      )}

      <Card header={`Registered devices · ${devices?.length ?? 0}`}>
        {devices === null ? (
          <div className="px-4 py-6 text-[13px] mono text-ink-muted">loading…</div>
        ) : devices.length === 0 ? (
          <div className="px-4 py-4 text-[13px] text-ink-muted">
            No devices registered. Open this page on each phone / browser you
            want to be notified on, and tap{" "}
            <span className="mono">Enable on this device</span>.
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-3 px-4 py-3 text-[13.5px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{deviceLabel(d)}</div>
                  <div className="mono text-[11px] text-ink-muted truncate">
                    added {relativeTime(d.createdAt)}
                    {d.lastUsedAt
                      ? ` · last notified ${relativeTime(d.lastUsedAt)}`
                      : " · never notified"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => doRevoke(d.id)}
                  disabled={busy}
                  className="h-8 px-2 rounded-[6px] border border-line bg-canvas text-[12px] text-ink-soft inline-flex items-center gap-1.5 disabled:opacity-50"
                  aria-label="Revoke device"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="text-[12px] text-ink-muted leading-relaxed">
        Requires HTTPS on the URL you open claudex from. Plain-HTTP frpc
        tunnels won't deliver push — the browser blocks service-worker
        registration on insecure origins. On iOS (16.4+), you must install
        claudex to the Home Screen via Safari's Share sheet and open from
        there; desktop Safari / Chrome / Firefox work over any HTTPS origin.
      </div>
    </div>
  );
}

/**
 * Loose "2m ago" / "3h ago" / "4d ago" formatter — matches the rest of the
 * app's relative-time language without pulling in a date library. Returns
 * the localized string on anything older than a week.
 */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  if (s < 90) return "1m ago";
  const m = Math.round(s / 60);
  if (m < 45) return `${m}m ago`;
  if (m < 90) return "1h ago";
  const h = Math.round(m / 60);
  if (h < 22) return `${h}h ago`;
  if (h < 36) return "1d ago";
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// ----------------------------------------------------------------------------
// Appearance — light theme note + disabled affordances (no-op toggles).
// ----------------------------------------------------------------------------

function AppearancePanel() {
  return (
    <Card>
      <Row
        label="Theme"
        value={
          <div className="inline-flex items-center gap-1 p-1 bg-paper border border-line rounded-[8px]">
            <span className="px-3 h-7 flex items-center rounded-[6px] bg-canvas shadow-card border border-line text-[12.5px]">
              Light
            </span>
            <span
              title="Not implemented yet"
              className="px-3 h-7 flex items-center rounded-[6px] text-[12.5px] text-ink-muted opacity-60"
            >
              Dark (soon)
            </span>
          </div>
        }
      />
      <div className="px-4 py-3 border-t border-line bg-paper/40">
        <div className="caps text-ink-muted mb-2">Text size</div>
        <input
          type="range"
          min={0}
          max={2}
          step={1}
          defaultValue={1}
          disabled
          className="w-full accent-ink opacity-60 cursor-not-allowed"
        />
        <div className="text-[11.5px] text-ink-muted mt-1">
          Dynamic type coming soon. Pinch-to-zoom on mobile still works.
        </div>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// MCP servers — empty state with a nudge toward the Plugins tab (adjacent
// concept, and plugins are the one piece of the Claude env we can surface).
// ----------------------------------------------------------------------------

function McpPanel({ onPlugins }: { onPlugins: () => void }) {
  return (
    <EmptyCard
      icon={Server}
      title="Not parsed yet."
      body={
        <>
          Once we parse <span className="mono">~/.claude/settings.json#mcpServers</span>{" "}
          this pane will list each configured server with its transport and command.
          In the meantime, your installed plugins are visible under{" "}
          <button
            type="button"
            onClick={onPlugins}
            className="underline underline-offset-2 hover:text-ink"
          >
            Plugins
          </button>
          .
        </>
      }
    />
  );
}

// ----------------------------------------------------------------------------
// Plugins — existing plugin list from /api/user/env.
// ----------------------------------------------------------------------------

function PluginsPanel() {
  const [env, setEnv] = useState<UserEnvResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserEnv()
      .then(setEnv)
      .catch((e) => setErr(e instanceof ApiError ? e.code : "load failed"));
  }, []);

  if (err) {
    return (
      <Card>
        <div className="px-4 py-4 text-[13px] text-danger">{err}</div>
      </Card>
    );
  }

  if (!env) {
    return (
      <Card>
        <div className="px-4 py-6 text-[13px] mono text-ink-muted">loading…</div>
      </Card>
    );
  }

  const count = env.plugins.length;
  const enabledCount = env.plugins.filter((p) => p.enabled).length;

  return (
    <Card
      header={
        count === 0
          ? "No plugins installed. Use `claude plugin install …` in the CLI."
          : `${enabledCount} enabled · ${count} installed`
      }
    >
      {count === 0 ? (
        <div className="px-4 py-4 text-[13px] text-ink-muted">
          claudex does not install plugins itself — run{" "}
          <span className="mono">claude plugin install …</span> on this host
          and they'll show up here.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {env.plugins.map((p) => (
            <li
              key={p.key}
              className="flex items-center gap-3 px-4 py-3 text-[13.5px]"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{p.name}</div>
                <div className="mono text-[11px] text-ink-muted truncate">
                  {p.marketplace ?? "—"}
                  {p.version ? ` · ${p.version}` : ""}
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border text-[10px] font-medium uppercase tracking-[0.1em]",
                  p.enabled
                    ? "border-success/30 bg-success-wash text-[#1f5f21]"
                    : "border-line bg-paper text-ink-muted",
                )}
              >
                {p.enabled ? "enabled" : "disabled"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Environment — read-only dump of a few safe fields from /api/user/env.
// ----------------------------------------------------------------------------

function EnvironmentPanel() {
  const [env, setEnv] = useState<UserEnvResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUserEnv()
      .then(setEnv)
      .catch((e) => setErr(e instanceof ApiError ? e.code : "load failed"));
  }, []);

  if (err) {
    return (
      <Card>
        <div className="px-4 py-4 text-[13px] text-danger">{err}</div>
      </Card>
    );
  }
  if (!env) {
    return (
      <Card>
        <div className="px-4 py-6 text-[13px] mono text-ink-muted">loading…</div>
      </Card>
    );
  }

  return (
    <Card>
      <Row
        label="Session user"
        value={<span className="mono">{env.user.username}</span>}
      />
      <Row
        label="Config dir"
        value={<span className="mono truncate">{env.claudeDir}</span>}
      />
      <Row
        label="settings.json"
        value={
          env.settingsReadable ? (
            <span className="text-success text-[12px]">readable</span>
          ) : (
            <span className="text-ink-muted text-[12px]">missing</span>
          )
        }
      />
      <div className="px-4 py-3 border-t border-line bg-paper/40 text-[12px] text-ink-muted">
        claudex never writes to <span className="mono">~/.claude/</span>. All of
        its own state lives under <span className="mono">~/.claudex/</span>.
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Advanced — empty state only.
// ----------------------------------------------------------------------------

function AdvancedPanel() {
  return (
    <EmptyCard
      icon={Sliders}
      title="Nothing here yet."
      body="Future home for JWT secret rotation, worktree defaults, cookie lifetime, and exposure diagnostics."
    />
  );
}

// ----------------------------------------------------------------------------
// Small layout atoms
// ----------------------------------------------------------------------------

function Card({
  header,
  children,
}: {
  header?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      {header && (
        <div className="px-4 sm:px-5 py-3 border-b border-line text-[12.5px] text-ink-muted">
          {header}
        </div>
      )}
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 sm:px-5 py-3 text-[13.5px]">
      <div className="text-ink-muted text-[12px] uppercase tracking-[0.1em] w-28 shrink-0">
        {label}
      </div>
      <div className="min-w-0 flex-1 truncate text-ink">{value}</div>
    </div>
  );
}

function EmptyCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof UserIcon;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="rounded-[12px] border border-dashed border-line bg-paper/30 px-5 py-6 flex items-start gap-4">
      <div className="h-9 w-9 rounded-[8px] bg-canvas border border-line flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-ink-muted" />
      </div>
      <div className="min-w-0">
        <div className="display text-[16px] leading-tight">{title}</div>
        <div className="text-[13px] text-ink-muted mt-1 max-w-[60ch]">
          {body}
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-line bg-canvas text-[10px] font-medium uppercase tracking-[0.1em] text-ink-muted">
          not tracked yet
        </div>
      </div>
    </div>
  );
}
