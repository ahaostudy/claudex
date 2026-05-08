import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  KeyRound,
  Shield,
  Palette,
  Plug,
  User as UserIcon,
} from "lucide-react";
import { useAuth } from "@/state/auth";
import { api, ApiError } from "@/api/client";
import type { UserEnvResponse } from "@claudex/shared";
import { cn } from "@/lib/cn";

// Tabs mirror mockup s-12 in spirit: a small, focused set that actually
// maps onto things claudex controls today. Notifications / Environment /
// Advanced / Exposure from the mockup are future work and intentionally
// omitted rather than shown as dead buttons.
type Tab = "account" | "security" | "appearance" | "mcp";

const TABS: Array<{ id: Tab; label: string; icon: typeof UserIcon }> = [
  { id: "account", label: "Account", icon: UserIcon },
  { id: "security", label: "Security", icon: Shield },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "mcp", label: "Plugins", icon: Plug },
];

export function SettingsScreen() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("account");

  return (
    <main className="min-h-screen bg-canvas">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-4 sm:px-5 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate("/")}
          title="Back"
          className="h-8 w-8 rounded-[8px] border border-line bg-paper flex items-center justify-center text-ink-soft"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div>
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            Settings
          </div>
          <div className="display text-[17px] leading-tight">
            {TABS.find((t) => t.id === tab)?.label}
          </div>
        </div>
        <div className="ml-auto text-[12px] text-ink-muted hidden sm:inline">
          signed in as <span className="mono">{user?.username}</span>
        </div>
      </header>

      <div className="max-w-[1100px] mx-auto flex flex-col lg:flex-row">
        {/* Tab list: horizontal scroll on mobile, left rail on desktop. */}
        <aside className="lg:w-[220px] lg:shrink-0 border-b lg:border-b-0 lg:border-r border-line bg-paper/30">
          <nav
            className={cn(
              "flex lg:flex-col gap-1 px-3 py-3 overflow-x-auto",
              "lg:sticky lg:top-[57px] lg:overflow-x-visible",
            )}
          >
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  "shrink-0 inline-flex items-center gap-2 px-3 h-9 rounded-[8px] text-[13px]",
                  tab === id
                    ? "bg-canvas shadow-card border border-line text-ink"
                    : "text-ink-muted hover:text-ink hover:bg-canvas/40",
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="flex-1 min-w-0 p-5 sm:p-8 pb-24 space-y-5">
          {tab === "account" && <AccountPanel />}
          {tab === "security" && <SecurityPanel />}
          {tab === "appearance" && <AppearancePanel />}
          {tab === "mcp" && <PluginsPanel />}
        </section>
      </div>
    </main>
  );
}

// ----------------------------------------------------------------------------
// Account
// ----------------------------------------------------------------------------

function AccountPanel() {
  const { user } = useAuth();
  const [showChange, setShowChange] = useState(false);
  return (
    <>
      <Card
        title="Account"
        subtitle="Your local claudex credentials. Only one user exists today."
      >
        <Row label="Username" value={<span className="mono">{user?.username}</span>} />
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
        <div className="px-4 py-3 border-t border-line bg-paper/40 flex items-center gap-2">
          <button
            onClick={() => setShowChange(true)}
            className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] inline-flex items-center gap-1.5"
          >
            <KeyRound className="w-3.5 h-3.5" />
            Change password
          </button>
          <span className="text-[11.5px] text-ink-muted ml-2">
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
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Security
            </div>
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
      <div className="text-[11.5px] uppercase tracking-[0.12em] text-ink-muted mb-1">
        {label}
      </div>
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
// Security
// ----------------------------------------------------------------------------

// Intentionally thin for MVP. The mockup's paired-browsers list and audit
// log require tracking active JWT jti values + request metadata that
// claudex doesn't persist yet — we surface the 2FA state honestly and
// leave the rest as disabled placeholders rather than lie about them.
function SecurityPanel() {
  return (
    <>
      <Card
        title="Two-factor authentication"
        subtitle="Required. Rotates every 30 seconds via an authenticator app."
      >
        <Row
          label="Status"
          value={
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-success/30 bg-success-wash text-[#1f5f21] text-[10px] font-medium uppercase tracking-[0.1em]">
              enabled
            </span>
          }
        />
        <Row
          label="Issuer"
          value={<span className="mono">claudex</span>}
        />
        <div className="px-4 py-3 border-t border-line bg-paper/40 flex items-center gap-2 flex-wrap">
          <button
            disabled
            title="Not implemented yet"
            className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] text-ink-muted opacity-60 cursor-not-allowed"
          >
            Regenerate recovery codes
          </button>
          <span className="text-[11.5px] text-ink-muted">
            Coming soon — rotate via <span className="mono">pnpm reset-credentials</span> for now.
          </span>
        </div>
      </Card>

      <Card
        title="Paired browsers"
        subtitle="claudex doesn't track individual sessions yet. Only the current cookie is known."
      >
        <div className="px-4 py-4 text-[13px] text-ink-muted">
          Paired-browsers list is planned. The session cookie expires after
          30 days; to sign out everywhere, change the password — new logins
          will still work but the JWT secret rotation is not implemented yet.
        </div>
      </Card>
    </>
  );
}

// ----------------------------------------------------------------------------
// Appearance
// ----------------------------------------------------------------------------

function AppearancePanel() {
  return (
    <>
      <Card
        title="Theme"
        subtitle="claudex ships with a single calm-paper theme. Dark mode is on the roadmap."
      >
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
          <div className="text-[11.5px] uppercase tracking-[0.12em] text-ink-muted mb-2">
            Text size
          </div>
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
    </>
  );
}

// ----------------------------------------------------------------------------
// Plugins (read-only reflection of ~/.claude/settings.json + installed_plugins.json)
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
      <Card title="Plugins" subtitle="Something went wrong reading your Claude settings.">
        <div className="px-4 py-4 text-[13px] text-danger">{err}</div>
      </Card>
    );
  }

  if (!env) {
    return (
      <Card title="Plugins" subtitle="Reading ~/.claude …">
        <div className="px-4 py-6 text-[13px] mono text-ink-muted">
          loading…
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card
        title="Claude CLI environment"
        subtitle="Read-only reflection of what the claude CLI has loaded on this host."
      >
        <Row
          label="Config dir"
          value={<span className="mono truncate">{env.claudeDir}</span>}
        />
        <Row
          label="settings.json"
          value={
            env.settingsReadable ? (
              <span className="text-success text-[12px]">found</span>
            ) : (
              <span className="text-ink-muted text-[12px]">missing</span>
            )
          }
        />
      </Card>

      <Card
        title="Plugins"
        subtitle={
          env.plugins.length === 0
            ? "No plugins installed. Manage with `claude plugin` in the CLI."
            : `${env.plugins.filter((p) => p.enabled).length} enabled · ${env.plugins.length} installed`
        }
      >
        {env.plugins.length === 0 ? (
          <div className="px-4 py-4 text-[13px] text-ink-muted">
            claudex does not install plugins itself — use{" "}
            <span className="mono">claude plugin install …</span> on this
            host and they'll show up here.
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
    </>
  );
}

// ----------------------------------------------------------------------------
// Small layout atoms
// ----------------------------------------------------------------------------

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      <div className="px-4 sm:px-5 py-4 border-b border-line">
        <div className="display text-[17px] leading-tight">{title}</div>
        {subtitle && (
          <div className="text-[12.5px] text-ink-muted mt-0.5 max-w-[60ch]">
            {subtitle}
          </div>
        )}
      </div>
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
