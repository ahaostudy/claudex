import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Bell,
  BellOff,
  Bug,
  ChevronLeft,
  Copy,
  Download,
  FolderOpen,
  Info,
  KeyRound,
  Palette,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  Shield,
  Sliders,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/state/auth";
import { api, ApiError, type WorktreeSummary } from "@/api/client";
import type { Project, PushDevice, UserEnvResponse, AuditEvent, ToolGrant, ImportAllResponse } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { timeAgoShort, timeAgoLong } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
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
import { useFocusReturn } from "@/hooks/useFocusReturn";

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
    lede: "Prune stale claudex-managed git worktrees. More power-user knobs (JWT rotation, exposure diagnostics) live here later.",
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
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-4 sm:px-5 py-2.5 flex items-center gap-2">
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

      <div className="flex-1 min-h-0 flex flex-col md:min-h-0 overflow-y-auto md:overflow-hidden">
        {/* Profile card — matches mockup lines 2062–2066, honest variant.
            Rendered on every subtab so the user always sees who they are.
            On desktop it stays pinned above the split rail/content below; on
            mobile the whole column scrolls as one unit so `overflow-y-auto`
            only applies below md. */}
        <div className="shrink-0">
          <ProfileCard />
        </div>

        <div className="md:grid md:grid-cols-[240px_minmax(0,1fr)] md:flex-1 md:min-h-0">
          {/* Desktop inner rail: 8 entries, active = bg-canvas+border+shadow.
              Mockup lines 2097–2111. Independently scrollable on desktop —
              shrink-0 on its column so a long tab list can't push the content
              area off-screen. */}
          <aside className="hidden md:flex md:flex-col border-r border-line bg-paper/40 overflow-y-auto min-h-0 shrink-0">
            <div className="p-4 flex items-center gap-2">
              <svg viewBox="0 0 32 32" className="w-4 h-4">
                <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
                <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
              </svg>
              <span className="mono text-[13px]">claudex</span>
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
              {/* "About" lives at the bottom of the rail but is a separate
                  route (`/about`), not a Tab. It's a neighbour of Settings
                  rather than a subtab — navigating instead of flipping the
                  tab param avoids polluting the Tab union with something
                  that doesn't share the rail's content-area contract. */}
              <button
                type="button"
                onClick={() => navigate("/errors")}
                className={cn(
                  "w-full text-left flex items-center gap-2 px-2.5 h-8 rounded-[6px]",
                  "hover:bg-canvas/60 border border-transparent text-ink-soft",
                )}
              >
                <Bug className="w-3.5 h-3.5" />
                Client errors
              </button>
              <button
                type="button"
                onClick={() => navigate("/about")}
                className={cn(
                  "w-full text-left flex items-center gap-2 px-2.5 h-8 rounded-[6px]",
                  "hover:bg-canvas/60 border border-transparent text-ink-soft",
                )}
              >
                <Info className="w-3.5 h-3.5" />
                About
              </button>
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
                      ? "bg-klein text-canvas border-klein"
                      : "bg-canvas text-ink-soft border-line",
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
            {/* "About" navigates to `/about` rather than flipping the tab. */}
            <button
              type="button"
              onClick={() => navigate("/errors")}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[12px] border",
                "bg-canvas text-ink-soft border-line",
              )}
            >
              <Bug className="w-3.5 h-3.5" />
              Client errors
            </button>
            <button
              type="button"
              onClick={() => navigate("/about")}
              className={cn(
                "shrink-0 inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[12px] border",
                "bg-canvas text-ink-soft border-line",
              )}
            >
              <Info className="w-3.5 h-3.5" />
              About
            </button>
          </nav>

          <section className="min-w-0 p-5 sm:p-8 pb-24 md:pb-10 md:overflow-y-auto md:min-h-0">
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
        {user?.createdAt && (
          <div className="text-[11px] text-ink-muted mt-0.5">
            since {new Date(user.createdAt).toLocaleDateString()}
          </div>
        )}
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
  useFocusReturn();
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-password-modal-title"
        className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5"
      >
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">Security</div>
            <h2 id="change-password-modal-title" className="display text-[1.25rem] leading-tight mt-0.5">
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
// Security — mockup lines 2119–2135 + 2163–2173 (audit log card).
//
// Shipped: enabled pill + Issuer + Audit log list (server-backed).
// Omitted (and why):
//   - Recovery codes tile  — we don't track "8 of 10 unused"
//   - Last used tile       — we don't record TOTP usage timestamps
//   - Regenerate codes btn — no rotation flow yet
//   - Move to hardware key — no flow
//   - Disable 2FA          — TOTP is mandatory
//   - Paired browsers card — no per-JWT tracking
// ----------------------------------------------------------------------------

function SecurityPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const fullLog = searchParams.get("audit") === "1";
  return (
    <div className="space-y-5">
      <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
        <div className="flex items-center gap-4 px-5 py-4 border-b border-line">
          <div className="h-10 w-10 rounded-[10px] bg-klein-wash flex items-center justify-center text-klein-ink shrink-0">
            <Shield className="w-5 h-5" />
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

        <div className="grid grid-cols-3 divide-x divide-line text-[13px]">
          <div className="px-5 py-4">
            <div className="caps text-ink-muted">Issuer</div>
            <div className="mt-1 mono">claudex</div>
          </div>
          <div className="px-5 py-4">
            <div className="caps text-ink-muted">Recovery codes</div>
            <div className="mt-1 text-ink-muted">—</div>
          </div>
          <div className="px-5 py-4">
            <div className="caps text-ink-muted">Last used</div>
            <div className="mt-1 text-ink-muted">—</div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-line bg-paper/40 text-[12.5px] text-ink-muted">
          Disable-2FA, paired browsers, and "last used" tracking are planned.
          Rotate via <span className="mono">pnpm reset-credentials</span> for now.
        </div>
      </div>

      <RecoveryCodesCard />

      <GrantedToolsCard />

      <TrustedProjectsCard />

      <AuditLogCard
        expanded={fullLog}
        onExpand={() => {
          const next = new URLSearchParams(searchParams);
          next.set("audit", "1");
          setSearchParams(next, { replace: true });
        }}
        onCollapse={() => {
          const next = new URLSearchParams(searchParams);
          next.delete("audit");
          setSearchParams(next, { replace: true });
        }}
      />
    </div>
  );
}

// Recovery-codes card — sits between the 2FA card and the Trusted projects
// card on the Security tab. Mirrors the TrustedProjectsCard's two-click
// commit pattern for the dangerous action (Regenerate invalidates every
// previous code) and renders plaintext exactly once, in a modal, after a
// successful regenerate. `remaining === 0` surfaces a warning pill so the
// user nags themselves into rotating before they're locked out.
function RecoveryCodesCard() {
  const [state, setState] = useState<
    { remaining: number; generatedAt?: string } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  // Two-click arming for the Regenerate button — analogous to the Untrust
  // flow elsewhere on this tab. Cleared on a 3s timeout so a stray first
  // click doesn't linger as a hot button.
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  async function refresh() {
    setErr(null);
    try {
      const res = await api.getRecoveryCodesState();
      setState({
        remaining: res.remaining,
        ...(res.generatedAt ? { generatedAt: res.generatedAt } : {}),
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);

  async function regenerate() {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setBusy(true);
    setErr(null);
    try {
      const res = await api.regenerateRecoveryCodes();
      setFreshCodes(res.codes);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "regenerate failed");
    } finally {
      setBusy(false);
    }
  }

  const remaining = state?.remaining ?? 0;
  const generatedAt = state?.generatedAt;
  const exhausted = state !== null && remaining === 0;

  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0">
          <KeyRound className="w-4 h-4 text-ink-muted" />
        </div>
        <div className="min-w-0">
          <div className="display text-[18px] leading-tight">
            Recovery codes
          </div>
          <div className="text-[13px] text-ink-muted mt-0.5">
            Single-use fallbacks if you lose your authenticator. Each code
            works once.
          </div>
        </div>
        {exhausted ? (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-warn/40 bg-warn-wash text-[#7a4700] text-[10px] font-medium uppercase tracking-[0.1em] shrink-0">
            no codes left
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-line bg-paper text-ink-soft text-[10px] font-medium uppercase tracking-[0.1em] shrink-0">
            {state === null ? "…" : `${remaining} of 10`}
          </span>
        )}
      </div>

      <div className="px-5 py-4 text-[13px] text-ink-soft">
        {state === null ? (
          <span className="mono text-ink-muted">loading…</span>
        ) : (
          <>
            <div>
              <span className="font-medium">{remaining} of 10 unused.</span>{" "}
              {generatedAt
                ? `Generated ${timeAgoShort(generatedAt)}.`
                : "No codes generated yet."}
            </div>
            {exhausted && (
              <div className="mt-2 text-[12.5px] text-[#7a4700]">
                You have no recovery codes left. Regenerate before you lose your
                authenticator — otherwise you'll need to reset from the CLI.
              </div>
            )}
          </>
        )}
      </div>

      <div className="px-5 py-3 border-t border-line bg-paper/40 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={regenerate}
          disabled={busy}
          className={cn(
            "h-9 px-3 rounded-[8px] text-[13px] inline-flex items-center gap-1.5 disabled:opacity-50",
            armed
              ? "border border-danger/40 bg-danger-wash text-danger font-medium"
              : "border border-line bg-canvas text-ink-soft hover:bg-paper",
          )}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {busy
            ? "Generating…"
            : armed
              ? "Click again to replace all"
              : "Regenerate codes"}
        </button>
        <span className="text-[11.5px] text-ink-muted ml-1">
          Replaces the existing batch; old printouts stop working.
        </span>
      </div>

      {err && (
        <div className="m-4 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
          {err}
        </div>
      )}

      {freshCodes && (
        <RecoveryCodesModal
          codes={freshCodes}
          onClose={() => setFreshCodes(null)}
        />
      )}
    </div>
  );
}

// One-time display of the 10 plaintext codes after a successful regenerate.
// Server stores only hashes so there's no "show me again" path — the modal
// is the single, final chance to capture them. Copy-all + Download-as-.txt
// affordances make that capture trivial on mobile.
function RecoveryCodesModal({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  useFocusReturn();
  const [copied, setCopied] = useState(false);

  async function copyAll() {
    const ok = await copyText(codes.join("\n"));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
    /* on failure: user can still tap-hold to select */
  }

  function download() {
    const header = [
      "# claudex recovery codes",
      `# generated ${new Date().toISOString()}`,
      "# each code works ONCE; keep offline",
      "",
    ].join("\n");
    const blob = new Blob([header + codes.join("\n") + "\n"], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "claudex-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-30 bg-ink/30 flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="recovery-codes-modal-title" className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5">
        <div className="flex items-center mb-4">
          <div>
            <div className="caps text-ink-muted">Security</div>
            <h2 id="recovery-codes-modal-title" className="display text-[1.25rem] leading-tight mt-0.5">
              New recovery codes
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="text-[13px] text-ink-muted mb-3">
          Save these now — they will not be shown again. Each code signs you in
          once if you lose access to your authenticator.
        </div>
        <ul className="mono text-[13.5px] rounded-[8px] border border-line bg-paper/40 divide-y divide-line">
          {codes.map((c) => (
            <li key={c} className="px-3 py-2">
              {c}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={copyAll}
            className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] inline-flex items-center gap-1.5"
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? "Copied" : "Copy all"}
          </button>
          <button
            type="button"
            onClick={download}
            className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Download as .txt
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-9 px-3 rounded-[8px] bg-ink text-canvas text-[13px] font-medium"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// Granted-tools card. Lists every `tool_grants` row on this machine — global
// first (biggest blast radius → most important to audit), then session rows.
// Each row shows a scope pill, the tool name + signature (monospace, because
// the signature is often an exact command like `pnpm vitest run *` or a
// path), the owning session title if any, a short relative time, and a
// Revoke button. "Revoke all" is two-click armed for 3s and iterates the
// current list, refetching after each batch — keeps the UI in sync without
// baking a bulk endpoint into the server.
function GrantedToolsCard() {
  const [grants, setGrants] = useState<ToolGrant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [armedAll, setArmedAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  async function refresh() {
    setErr(null);
    try {
      const res = await api.listAllGrants();
      setGrants(res.grants);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!armedAll) return;
    const t = window.setTimeout(() => setArmedAll(false), 3000);
    return () => window.clearTimeout(t);
  }, [armedAll]);

  async function revokeOne(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      await api.revokeGrant(id);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "revoke failed");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAll() {
    if (!grants || grants.length === 0) return;
    if (!armedAll) {
      setArmedAll(true);
      return;
    }
    setArmedAll(false);
    setBusyAll(true);
    setErr(null);
    try {
      // Snapshot the list so a concurrent mutation (e.g. a permission prompt
      // auto-grant arriving mid-revoke) doesn't make us revoke rows we never
      // saw. Ignore individual failures — a grant that vanished between the
      // list and the delete is effectively already revoked.
      const ids = grants.map((g) => g.id);
      await Promise.all(
        ids.map((id) =>
          api.revokeGrant(id).catch(() => {
            /* best-effort */
          }),
        ),
      );
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "revoke failed");
    } finally {
      setBusyAll(false);
    }
  }

  const globalCount = grants?.filter((g) => g.scope === "global").length ?? 0;
  const sessionCount = grants?.filter((g) => g.scope === "session").length ?? 0;

  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-ink-muted" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="display text-[18px] leading-tight">
            Granted tools
          </div>
          <div className="text-[13px] text-ink-muted mt-0.5">
            {grants === null
              ? "Tools you auto-approved via \"Always\" on a permission prompt."
              : `${globalCount} global · ${sessionCount} session`}
          </div>
        </div>
      </div>
      {err ? (
        // Error wins over loading: previously `grants === null` kept the
        // "loading…" row up even after the fetch had failed, so the user
        // waited forever for data that was never coming. Render the banner
        // first and offer a retry; only fall back to the loading row when we
        // have neither data nor an error yet.
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded-[8px] border border-danger/30 bg-danger-wash px-3 py-2 text-[13px] text-danger">
            Couldn't load granted tools: <span className="mono">{err}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 h-8 px-3 rounded-[8px] border border-danger/40 bg-canvas text-[12.5px] text-danger font-medium"
          >
            Retry
          </button>
        </div>
      ) : grants === null ? (
        <div className="px-5 py-5 text-[13px] mono text-ink-muted">loading…</div>
      ) : grants.length === 0 ? (
        <div className="px-5 py-5 text-[13px] text-ink-muted">
          No tools have been granted yet. "Always" on a permission prompt adds
          one here.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {grants.map((g) => {
            const busy = busyId === g.id;
            return (
              <li
                key={g.id}
                className="flex items-center gap-3 px-5 py-3 text-[13px]"
              >
                <span
                  className={cn(
                    "shrink-0 inline-flex items-center h-5 px-1.5 rounded-[4px] text-[10px] mono uppercase tracking-[0.1em] border",
                    g.scope === "global"
                      ? "bg-klein-wash text-klein-ink border-klein/30"
                      : "bg-paper text-ink-muted border-line",
                  )}
                  title={
                    g.scope === "global"
                      ? "Applies to every session"
                      : "Scoped to one session"
                  }
                >
                  {g.scope}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mono text-[12.5px] truncate">
                    <span className="text-ink-soft">{g.toolName}</span>
                    {g.signature ? (
                      <>
                        <span className="text-ink-muted"> </span>
                        <span className="text-ink-muted">{g.signature}</span>
                      </>
                    ) : null}
                  </div>
                  <div className="text-[11px] text-ink-muted truncate mt-0.5">
                    {g.scope === "global"
                      ? "All sessions"
                      : g.sessionTitle || "—"}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] mono text-ink-muted tabular-nums">
                  {timeAgoShort(g.createdAt)}
                </span>
                <button
                  type="button"
                  onClick={() => revokeOne(g.id)}
                  disabled={busy || busyAll}
                  className="shrink-0 h-8 px-3 rounded-[8px] text-[12.5px] border border-line bg-canvas text-ink-soft hover:bg-paper hover:text-danger disabled:opacity-50"
                >
                  {busy ? "…" : "Revoke"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {grants && grants.length > 0 && (
        <div className="px-5 py-3 border-t border-line bg-paper/40 flex items-center justify-end">
          <button
            type="button"
            onClick={revokeAll}
            disabled={busyAll}
            className={cn(
              "h-8 px-3 rounded-[8px] text-[12.5px] border disabled:opacity-50",
              armedAll
                ? "border-danger/40 bg-danger-wash text-danger font-medium"
                : "border-line bg-canvas text-ink-soft hover:bg-paper hover:text-danger",
            )}
          >
            {busyAll
              ? "Revoking…"
              : armedAll
                ? "Click again to confirm"
                : "Revoke all"}
          </button>
        </div>
      )}
      {grants !== null && err && (
        <div className="m-4 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
          {err}
        </div>
      )}
    </div>
  );
}

// Trusted-projects card. Lists every project row with its trust state and a
// one-click toggle. Untrusting is the dangerous direction (future sessions
// under that project will refuse to spawn), so we require a second click to
// confirm — the row flips into a "click again" affordance for ~3 seconds
// and reverts if the user looks away. Trusting is a single click because the
// user has presumably already been prompted once via the NewSessionSheet.
function TrustedProjectsCard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // When non-null, the "Untrust" button on that row has been clicked once
  // and is armed — a second click commits. Cleared on timeout or on toggle.
  const [confirmUntrustId, setConfirmUntrustId] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await api.listProjects();
      setProjects(res.projects);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Auto-disarm the untrust confirm after 3s so a stray click doesn't linger
  // as a hot commit button in the UI.
  useEffect(() => {
    if (!confirmUntrustId) return;
    const t = window.setTimeout(() => setConfirmUntrustId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmUntrustId]);

  async function toggle(p: Project) {
    setErr(null);
    if (p.trusted) {
      // Two-click commit for untrust.
      if (confirmUntrustId !== p.id) {
        setConfirmUntrustId(p.id);
        return;
      }
      setConfirmUntrustId(null);
    }
    setBusyId(p.id);
    try {
      const res = await api.trustProject(p.id, !p.trusted);
      setProjects((prev) =>
        prev ? prev.map((x) => (x.id === p.id ? res.project : x)) : prev,
      );
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "update failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-line">
        <div className="h-9 w-9 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0">
          <FolderOpen className="w-4 h-4 text-ink-muted" />
        </div>
        <div className="min-w-0">
          <div className="display text-[18px] leading-tight">
            Trusted projects
          </div>
          <div className="text-[13px] text-ink-muted mt-0.5">
            Untrusting a project blocks future sessions under it until you
            re-confirm. Existing sessions keep running.
          </div>
        </div>
      </div>
      {projects === null && err ? (
        // Error wins over loading: a failed refresh leaves `projects` as null
        // and would otherwise keep the spinner spinning forever. Render the
        // banner with a retry button and let the user try again.
        <div className="px-5 py-4 flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded-[8px] border border-danger/30 bg-danger-wash px-3 py-2 text-[13px] text-danger">
            Couldn't load projects: <span className="mono">{err}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 h-8 px-3 rounded-[8px] border border-danger/40 bg-canvas text-[12.5px] text-danger font-medium"
          >
            Retry
          </button>
        </div>
      ) : projects === null ? (
        <div className="px-5 py-5 text-[13px] mono text-ink-muted">loading…</div>
      ) : projects.length === 0 ? (
        <div className="px-5 py-5 text-[13px] text-ink-muted">
          No projects yet. Add one from the New Session sheet.
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {projects.map((p) => {
            const armed = confirmUntrustId === p.id;
            const busy = busyId === p.id;
            return (
              <li
                key={p.id}
                className="flex items-center gap-3 px-5 py-3 text-[13px]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="mono text-[11px] text-ink-muted truncate">
                    {p.path}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border text-[10px] font-medium uppercase tracking-[0.1em]",
                    p.trusted
                      ? "border-success/30 bg-success-wash text-[#1f5f21]"
                      : "border-warn/30 bg-warn-wash text-[#7a4700]",
                  )}
                >
                  {p.trusted ? "trusted" : "untrusted"}
                </span>
                <button
                  type="button"
                  onClick={() => toggle(p)}
                  disabled={busy}
                  className={cn(
                    "shrink-0 h-8 px-3 rounded-[8px] text-[12.5px] border disabled:opacity-50",
                    p.trusted
                      ? armed
                        ? "border-danger/40 bg-danger-wash text-danger font-medium"
                        : "border-line bg-canvas text-ink-soft hover:bg-paper"
                      : "border-ink bg-ink text-canvas font-medium",
                  )}
                >
                  {busy
                    ? "…"
                    : p.trusted
                      ? armed
                        ? "Click again to confirm"
                        : "Untrust"
                      : "Trust"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {projects !== null && err && (
        <div className="m-4 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
          {err}
        </div>
      )}
    </div>
  );
}

// Compose a short human-readable sentence per audit event. Open-ended on
// purpose: unknown events fall back to `<event>` so new server-side kinds
// don't require a UI deploy to show up.
function renderAuditDetail(row: AuditEvent): string {
  // `deviceLabel` takes a PushDevice; we only have a UA string — wrap the UA
  // in a stub device so the classifier works without a second branch.
  const uaLabel = (ua: string | null | undefined) =>
    ua
      ? deviceLabel({
          id: "",
          userAgent: ua,
          createdAt: "",
          lastUsedAt: null,
        })
      : "unknown device";
  switch (row.event) {
    case "login":
      return `2FA verified from ${uaLabel(row.userAgent)}`;
    case "login_failed":
      return `Failed login attempt from ${row.ip ?? "unknown IP"}`;
    case "logout":
      return "Signed out";
    case "password_changed":
      return "Password changed";
    case "totp_failed":
      return `Wrong 2FA code from ${row.ip ?? "unknown IP"}`;
    case "session_deleted":
      return `Deleted session "${row.detail ?? "untitled"}"`;
    case "permission_granted":
      return `Granted: ${row.detail ?? "tool allow"}`;
    case "permission_denied":
      return `Denied: ${row.detail ?? "tool deny"}`;
    case "push_subscribed":
      return `New push device: ${uaLabel(row.detail)}`;
    case "push_revoked":
      return `Removed push device: ${uaLabel(row.detail)}`;
    case "project_trusted":
      return row.detail ?? "Project trusted";
    case "project_untrusted":
      return row.detail ?? "Project untrusted";
    default:
      return row.detail ? `${row.event}: ${row.detail}` : row.event;
  }
}

function AuditLogCard({
  expanded,
  onExpand,
  onCollapse,
}: {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  const PAGE_SIZE = 50;
  // Initial "inline" view shows up to 6 rows; the full-log sheet shows every
  // row the card has loaded so far. Stashing the since cutoff in state keeps
  // pagination calls aligned with the initial query's filter.
  const sinceRef = useRef<string>("");

  useEffect(() => {
    // Last 30 days — matches the card's header phrasing so totalCount is
    // honest about what we're showing.
    sinceRef.current = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    setRows(null);
    setReachedEnd(false);
    setErr(null);
    void (async () => {
      try {
        const res = await api.listAudit({
          limit: PAGE_SIZE,
          since: sinceRef.current,
        });
        setRows(res.events);
        setTotalCount(res.totalCount);
        if (res.events.length < PAGE_SIZE) setReachedEnd(true);
      } catch (e) {
        setErr(e instanceof ApiError ? e.code : "load failed");
      }
    })();
  }, [expanded]);

  async function loadMore() {
    if (!rows || rows.length === 0 || loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const cursor = rows[rows.length - 1]!.createdAt;
      const res = await api.listAudit({
        limit: PAGE_SIZE,
        since: sinceRef.current,
        before: cursor,
      });
      setRows((prev) => (prev ? [...prev, ...res.events] : res.events));
      setTotalCount(res.totalCount);
      if (res.events.length < PAGE_SIZE) setReachedEnd(true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    } finally {
      setLoadingMore(false);
    }
  }

  if (err && rows === null) {
    return (
      <div className="rounded-[12px] border border-line bg-canvas p-5 text-[13px] text-ink-muted">
        Couldn't load audit log: <span className="mono">{err}</span>
      </div>
    );
  }
  if (rows === null) {
    return (
      <div className="rounded-[12px] border border-line bg-canvas p-5 text-[13px] text-ink-muted">
        Loading audit log…
      </div>
    );
  }

  const visible = expanded ? rows : rows.slice(0, 6);
  // "Show more" is eligible only in the expanded sheet (the inline view
  // already caps at 6) and disabled once we've either matched totalCount or
  // seen a short page. The error banner sits above it so a failure during
  // pagination doesn't swallow already-loaded rows.
  const hasMore = expanded && !reachedEnd && rows.length < totalCount;

  return (
    <div className="rounded-[12px] border border-line bg-canvas p-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-[10px] bg-paper flex items-center justify-center text-ink-muted shrink-0">
          <ScrollText className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="caps text-ink-muted">Audit log</div>
          <div className="display text-[18px] mt-0.5">
            {totalCount} event{totalCount === 1 ? "" : "s"} · past 30 days
          </div>
        </div>
      </div>
      {visible.length === 0 ? (
        <div className="mt-3 text-[12.5px] text-ink-muted">
          No security-relevant events yet. Logins, password changes, and
          permission decisions will show up here.
        </div>
      ) : (
        <div className="mt-3 space-y-2 text-[12.5px]">
          {visible.map((row) => (
            <div key={row.id} className="flex items-start gap-2">
              <span className="mono text-ink-muted w-12 mt-0.5 shrink-0">
                {timeAgoShort(row.createdAt)}
              </span>
              <span className="min-w-0 break-words">
                {renderAuditDetail(row)}
              </span>
            </div>
          ))}
        </div>
      )}
      {expanded && err && (
        <div className="mt-3 text-[12px] text-danger bg-danger-wash rounded-[6px] px-2 py-1 border border-danger/30">
          {err}
        </div>
      )}
      {expanded ? (
        <div className="mt-3 flex flex-col gap-2">
          {hasMore && (
            <button
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="h-8 px-3 rounded-[8px] border border-line bg-paper text-[12.5px] w-full disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          )}
          <button
            onClick={onCollapse}
            className="h-8 px-3 rounded-[8px] border border-line bg-paper text-[12.5px] w-full"
          >
            Collapse
          </button>
        </div>
      ) : (
        rows.length > 6 && (
          <button
            onClick={onExpand}
            className="mt-3 h-8 px-3 rounded-[8px] border border-line bg-paper text-[12.5px] w-full"
          >
            Open full log
          </button>
        )
      )}
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
                    added {timeAgoLong(d.createdAt)}
                    {d.lastUsedAt
                      ? ` · last notified ${timeAgoLong(d.lastUsedAt)}`
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

  if (count === 0) {
    return (
      <EmptyCard
        icon={Plug}
        title="No plugins installed."
        body={
          <>
            claudex does not install plugins itself — run{" "}
            <span className="mono">claude plugin install …</span> on this host
            and they'll show up here.
          </>
        }
      />
    );
  }

  return (
    <Card
      header={`${enabledCount} enabled · ${count} installed`}
    >
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
// Advanced — Worktrees pruning.
//
// Today when a session is deleted or worktree creation half-fails, stale
// `claude/*` branches + `.claude/worktrees/*` dirs accumulate in user projects.
// This panel surfaces them so the user can clean up. Linked rows (a session
// row still owns them) render with a green dot and no action; orphan rows
// render with a red dot and a Remove button. A bulk "Prune N orphans" action
// sits at the bottom when any orphans exist.
// ----------------------------------------------------------------------------

function AdvancedPanel() {
  return (
    <div className="space-y-5">
      <AppVersionCard />
      <RestartServerCard />
      <AdvancedWorktreesCard />
      <BackupCard />
    </div>
  );
}

// Bundle version readout + hard-refresh button. The hard-refresh path is
// necessary because claudex runs over plain HTTP through the frpc tunnel,
// and iOS Safari will happily serve a months-old index.html from its HTTP
// cache even after the server ships a new bundle. Server-side we set
// `Cache-Control: no-cache` on index.html (both the fastify-static mount
// and the SPA fallback in server/src/transport/app.ts), so fresh loads
// revalidate — but caches already populated under the old (no-header)
// regime are sticky. This button exists to break that deadlock from the
// UI without making the user dig through Safari → Settings → Website Data.
function AppVersionCard() {
  const [bundleName, setBundleName] = useState<string>("unknown");
  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    // Read the hashed JS filename directly off the live <script> tag so
    // the user can eyeball which bundle is actually running. Not the
    // build-time version — this reflects what the browser loaded, which
    // is the whole point.
    const script = document.querySelector<HTMLScriptElement>(
      'script[type="module"][src*="/assets/"]',
    );
    if (script?.src) {
      const match = script.src.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
      if (match) setBundleName(match[1]);
    }
  }, []);

  async function forceReload() {
    setIsReloading(true);
    // Opportunistic: purge any Cache API stores the browser may have
    // against this origin. `caches` may be undefined on plain HTTP in
    // some browsers (secure-context-only variants), so guard it.
    try {
      if (typeof caches !== "undefined") {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
    } catch {
      /* ignore — best effort */
    }
    // Append a cache-busting query param and `replace()` into it so the
    // browser treats this as a fresh URL and bypasses its HTTP cache for
    // index.html. The server's SPA fallback ignores query strings, so the
    // path still resolves to the current index.html — which references
    // the latest hashed /assets bundle. Preserves the pathname and hash
    // so deep links like `/session/abc#seq-5` don't lose state.
    const url = new URL(window.location.href);
    url.searchParams.set("_r", Date.now().toString(36));
    window.location.replace(url.toString());
  }

  return (
    <Card header="App version">
      <Row
        label="Bundle"
        value={<span className="mono text-[12px]">{bundleName}</span>}
      />
      <div className="px-4 sm:px-5 py-3 space-y-2">
        <button
          type="button"
          onClick={forceReload}
          disabled={isReloading}
          className="h-9 px-3.5 rounded-md border border-line bg-canvas hover:bg-paper text-[13.5px] font-medium text-ink disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isReloading ? "Reloading…" : "Force reload (clear cache)"}
        </button>
        <div className="text-[12px] text-ink-muted">
          Bypass the browser's HTTP cache and fetch the freshest bundle. Use
          after a server update if the app feels stuck on an old version.
        </div>
      </div>
    </Card>
  );
}

// Restart-the-running-server button. POST /api/admin/restart spawns a
// detached worker, replies 200, then SIGTERMs itself — the worker waits
// for the port to drain and execs `pnpm exec tsx src/index.ts`. Because
// the server dies ~150ms after responding, the browser's fetch may or
// may not receive the body; we treat any post-send error as "restart is
// underway" and show the same polling UI regardless.
//
// After triggering we poll GET /api/health until a successful response,
// then force-reload the page so the UI re-connects to the fresh server.
// Health polls are cheap and give the user a countdown instead of a
// blank "please wait"; cap at ~30s (matches the detach worker's
// port-drain ceiling) before surfacing a failure hint.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function RestartServerCard() {
  const [status, setStatus] = useState<
    "idle" | "confirming" | "restarting" | "waiting" | "done" | "failed"
  >("idle");
  const [err, setErr] = useState<string | null>(null);

  async function triggerRestart() {
    setStatus("restarting");
    setErr(null);
    try {
      await api.adminRestart();
    } catch {
      // Expected: the server usually drops the TCP connection before the
      // JSON body flushes. Silent-ok — we'll verify via /api/health.
    }
    setStatus("waiting");
    await waitForHealth();
  }

  async function waitForHealth() {
    const deadline = Date.now() + 35_000;
    // Give the old server a beat to tear down before the first poll so
    // we don't race a 200 from the dying process.
    await sleep(500);
    while (Date.now() < deadline) {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) {
          setStatus("done");
          // Force a fresh bundle in case the deploy included new assets.
          await sleep(400);
          const url = new URL(window.location.href);
          url.searchParams.set("_r", Date.now().toString(36));
          window.location.replace(url.toString());
          return;
        }
      } catch {
        /* server is still coming up; keep polling */
      }
      await sleep(800);
    }
    setStatus("failed");
    setErr("Timed out waiting for the server to come back up.");
  }

  const busy = status === "restarting" || status === "waiting";
  const buttonLabel =
    status === "idle"
      ? "Restart server"
      : status === "confirming"
        ? "Confirm restart?"
        : status === "restarting"
          ? "Sending restart…"
          : status === "waiting"
            ? "Waiting for server…"
            : status === "done"
              ? "Server back up"
              : "Restart failed";

  return (
    <Card header="Restart server">
      <div className="px-4 sm:px-5 py-3 space-y-2">
        {status === "confirming" ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={triggerRestart}
              className="h-9 px-3.5 rounded-md bg-danger text-canvas text-[13.5px] font-medium hover:opacity-90"
            >
              Yes, restart now
            </button>
            <button
              type="button"
              onClick={() => setStatus("idle")}
              className="h-9 px-3.5 rounded-md border border-line bg-canvas hover:bg-paper text-[13.5px] text-ink"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setStatus("confirming")}
            disabled={busy}
            className="h-9 px-3.5 rounded-md border border-line bg-canvas hover:bg-paper text-[13.5px] font-medium text-ink disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {buttonLabel}
          </button>
        )}
        <div className="text-[12px] text-ink-muted">
          Re-exec{"s "}
          <span className="mono">pnpm exec tsx src/index.ts</span> in place.
          Active sessions survive — their transcripts are on disk — but any
          in-flight tool call will show as interrupted. Safe to run after a
          deploy; use the script{" "}
          <span className="mono">scripts/restart.mjs</span> instead if you're
          at a terminal and don't want a page reload.
        </div>
        {err && (
          <div className="text-[12px] text-danger mono">{err}</div>
        )}
      </div>
    </Card>
  );
}

function AdvancedWorktreesCard() {
  const [worktrees, setWorktrees] = useState<WorktreeSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setErr(null);
    try {
      const res = await api.listWorktrees();
      setWorktrees(res.worktrees);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function prune(items: WorktreeSummary[]) {
    if (items.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.pruneWorktrees(
        items.map((w) => ({
          projectId: w.projectId,
          branch: w.branch,
          path: w.path,
        })),
      );
      const firstError = res.results.find((r) => !r.removed)?.error;
      if (firstError) {
        setErr(firstError);
      }
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "prune failed");
    } finally {
      setBusy(false);
    }
  }

  const orphans = (worktrees ?? []).filter((w) => w.status === "orphaned");

  // Error wins over loading AND over the "no worktrees" empty state. A failed
  // initial fetch would previously fall through to the empty card — which
  // looks identical to a fresh install with no worktrees, hiding the fact
  // that we never got a response. Render the banner with a retry and bail.
  if (worktrees === null && err) {
    return (
      <Card header="Claudex-managed git worktrees across your projects.">
        <div className="px-4 py-4 flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded-[8px] border border-danger/30 bg-danger-wash px-3 py-2 text-[13px] text-danger">
            Couldn't load worktrees: <span className="mono">{err}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="shrink-0 h-8 px-3 rounded-[8px] border border-danger/40 bg-canvas text-[12.5px] text-danger font-medium"
          >
            Retry
          </button>
        </div>
      </Card>
    );
  }

  if (worktrees !== null && worktrees.length === 0) {
    return (
      <EmptyCard
        icon={FolderOpen}
        title="No claudex-managed worktrees."
        body={
          <>
            When you create a session with{" "}
            <span className="mono">worktree: true</span>, git branches under{" "}
            <span className="mono">claude/</span> and directories under{" "}
            <span className="mono">.claude/worktrees/</span> show up here so you
            can clean up anything left behind.
          </>
        }
      />
    );
  }

  return (
    <Card
      header="Claudex-managed git worktrees across your projects."
    >
      {worktrees === null ? (
        <div className="px-4 py-6 text-[13px] mono text-ink-muted">
          loading…
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {worktrees.map((w) => (
            <li
              key={`${w.projectId}:${w.branch}`}
              className="px-4 py-3 flex items-center gap-3"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  w.status === "orphaned" ? "bg-danger" : "bg-success",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="mono text-[13px] truncate">{w.branch}</div>
                <div className="mono text-[11px] text-ink-muted truncate">
                  {w.path}
                </div>
                <div className="text-[11px] text-ink-muted mt-0.5">
                  {w.projectName} · {w.status}
                </div>
              </div>
              {w.status === "orphaned" && (
                <button
                  type="button"
                  onClick={() => prune([w])}
                  disabled={busy}
                  className="h-7 px-2 text-[11px] rounded-[4px] border border-line text-danger shrink-0 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {orphans.length > 0 && (
        <div className="px-4 py-2 border-t border-line">
          <button
            type="button"
            onClick={() => prune(orphans)}
            disabled={busy}
            className="h-8 px-3 rounded-[8px] bg-danger/10 border border-danger/40 text-danger text-[13px] disabled:opacity-50"
          >
            Prune {orphans.length} orphan{orphans.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
      {err && (
        <div className="px-4 py-2 border-t border-line text-[12px] text-danger bg-danger-wash">
          {err}
        </div>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------------------
// Advanced — Full-data backup + restore.
//
// Export goes through a plain <a href="/api/export/all" download> so the
// browser handles the JSON download natively — no Blob juggling. Import
// accepts a drag-drop or file-picker bundle and POSTs it as multipart to
// /api/import/all; on success we show an honest "imported N … skipped M …"
// summary. Secrets are not included in the export (see docs/FEATURES.md) and
// push subscriptions / users / recovery codes are skipped on import.
// ----------------------------------------------------------------------------

function BackupCard() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportAllResponse | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const res = await api.importAll(file);
      setResult(res);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "import failed");
    } finally {
      setBusy(false);
    }
  }

  function onDrop(ev: React.DragEvent<HTMLDivElement>) {
    ev.preventDefault();
    setDragOver(false);
    const file = ev.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  function onPickChange(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (file) void handleFile(file);
    // Reset so selecting the same file twice fires change again.
    ev.target.value = "";
  }

  const importedTotal = result
    ? result.imported.projects +
      result.imported.sessions +
      result.imported.events +
      result.imported.routines +
      result.imported.queue +
      result.imported.audit
    : 0;

  return (
    <Card header="Backup & restore">
      <div className="px-4 py-4 space-y-2">
        <div className="text-[13.5px] text-ink">Export everything</div>
        <div className="text-[12.5px] text-ink-muted max-w-[65ch]">
          Downloads a JSON bundle of every project, session, event, routine,
          and queued prompt on this machine. Secrets stay on this machine —
          hashes, TOTP, push keys, and JWT secrets are <em>not</em> exported.
        </div>
        <div>
          <a
            href={api.exportAllUrl()}
            download
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[8px] border border-line bg-paper/40 text-[13px] text-ink hover:bg-paper/70"
          >
            <Download className="w-3.5 h-3.5" />
            Download bundle
          </a>
        </div>
      </div>
      <div className="px-4 py-4 space-y-2">
        <div className="text-[13.5px] text-ink">Import from bundle</div>
        <div className="text-[12.5px] text-ink-muted max-w-[65ch]">
          Merges a previously exported bundle into this instance. Existing
          projects with the same path are left alone; sessions and their
          events are always added as new rows. Push subscriptions, grants,
          and attachment files are skipped.
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[8px] border border-line bg-paper/40 text-[13px] text-ink hover:bg-paper/70 disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            {busy ? "Importing…" : "Upload bundle"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={onPickChange}
          />
          <div
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              "flex-1 min-w-[200px] h-10 rounded-[8px] border border-dashed flex items-center justify-center text-[12px]",
              dragOver
                ? "border-accent text-accent bg-accent/5"
                : "border-line text-ink-muted",
              busy && "opacity-50 pointer-events-none",
            )}
          >
            {dragOver ? "Drop to import" : "or drop a .json bundle here"}
          </div>
        </div>
        {result && (
          <div className="rounded-[8px] border border-line bg-paper/40 px-3 py-2 text-[12px] text-ink space-y-0.5">
            <div>
              Imported {importedTotal} row{importedTotal === 1 ? "" : "s"}:{" "}
              {result.imported.projects} project
              {result.imported.projects === 1 ? "" : "s"},{" "}
              {result.imported.sessions} session
              {result.imported.sessions === 1 ? "" : "s"},{" "}
              {result.imported.events} event
              {result.imported.events === 1 ? "" : "s"},{" "}
              {result.imported.routines} routine
              {result.imported.routines === 1 ? "" : "s"},{" "}
              {result.imported.queue} queued,{" "}
              {result.imported.audit} audit.
            </div>
            {(result.skipped.projectsByPath > 0 ||
              result.skipped.sessionsBySdkId > 0 ||
              result.skipped.grants > 0 ||
              result.skipped.attachments > 0) && (
              <div className="text-ink-muted">
                Skipped: {result.skipped.projectsByPath} existing project
                {result.skipped.projectsByPath === 1 ? "" : "s"},{" "}
                {result.skipped.sessionsBySdkId} already-adopted session
                {result.skipped.sessionsBySdkId === 1 ? "" : "s"},{" "}
                {result.skipped.grants} grant
                {result.skipped.grants === 1 ? "" : "s"},{" "}
                {result.skipped.attachments} attachment
                {result.skipped.attachments === 1 ? "" : "s"}.
              </div>
            )}
            {result.versionMismatch && (
              <div className="text-ink-muted">
                Bundle was produced by a different claudex version; import
                proceeded but some fields may be new or missing.
              </div>
            )}
          </div>
        )}
        {err && (
          <div className="rounded-[8px] border border-danger/40 bg-danger-wash px-3 py-2 text-[12px] text-danger">
            {err}
          </div>
        )}
      </div>
    </Card>
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
