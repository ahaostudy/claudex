import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Mail, ShieldCheck } from "lucide-react";
import { useAuth } from "@/state/auth";
import { cn } from "@/lib/cn";

export function LoginScreen() {
  const navigate = useNavigate();
  const { login, verifyTotp, challengeId, error, clearError, user } =
    useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  const onCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(username, password);
    } catch {
      /* error in store */
    } finally {
      setBusy(false);
    }
  };

  const onCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await verifyTotp(code);
    } catch {
      /* error in store */
    } finally {
      setBusy(false);
    }
  };

  const step = challengeId ? "totp" : "credentials";

  return (
    <main className="min-h-screen flex items-center justify-center px-5 py-10 bg-canvas">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center gap-2 mb-8">
          <svg viewBox="0 0 32 32" className="w-6 h-6">
            <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
            <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
          </svg>
          <span className="mono text-[13px]">claudex</span>
        </div>

        <h1 className="display text-[2.1rem] leading-[1.05] mb-2">
          {step === "credentials" ? "Welcome back." : "One last step."}
        </h1>
        <p className="text-[15px] text-ink-muted mb-7">
          {step === "credentials"
            ? "Sign in to this claudex instance."
            : "Enter the six-digit code from your authenticator."}
        </p>

        <Stepper current={step === "credentials" ? 0 : 1} />

        <div className="mt-8">
          {step === "credentials" ? (
            <form onSubmit={onCredentials} className="space-y-4">
              <LabeledInput
                label="Username"
                icon={<Mail className="w-4 h-4" />}
                value={username}
                onChange={(v) => {
                  clearError();
                  setUsername(v);
                }}
                autoFocus
              />
              <LabeledInput
                label="Password"
                icon={<Lock className="w-4 h-4" />}
                type="password"
                value={password}
                onChange={(v) => {
                  clearError();
                  setPassword(v);
                }}
              />
              {error && <ErrorBanner>{error}</ErrorBanner>}
              <button
                type="submit"
                disabled={busy || !username || password.length < 1}
                className={cn(
                  "w-full h-12 rounded-[8px] bg-ink text-canvas font-medium transition-opacity",
                  "disabled:opacity-50 disabled:pointer-events-none",
                )}
              >
                {busy ? "Signing in…" : "Continue"}
              </button>
              <div className="text-[12px] text-ink-muted flex items-center gap-1.5 pt-1">
                <ShieldCheck className="w-3.5 h-3.5 text-success" />
                Session cookie is bound to this browser.
              </div>
            </form>
          ) : (
            <form onSubmit={onCode} className="space-y-4">
              <TotpInput value={code} onChange={setCode} />
              {error && <ErrorBanner>{error}</ErrorBanner>}
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className={cn(
                  "w-full h-12 rounded-[8px] bg-ink text-canvas font-medium transition-opacity",
                  "disabled:opacity-50 disabled:pointer-events-none",
                )}
              >
                {busy ? "Verifying…" : "Unlock"}
              </button>
              <div className="text-[12px] text-ink-muted pt-1">
                Codes rotate every 30 seconds.
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}

function Stepper({ current }: { current: 0 | 1 }) {
  const labels = ["Sign in", "Verify"];
  return (
    <div className="flex items-center gap-2 text-[11px] text-ink-muted">
      {labels.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <span
            className={cn(
              "mono h-5 w-5 inline-flex items-center justify-center rounded-full border",
              current === i
                ? "bg-klein text-canvas border-klein"
                : i < current
                  ? "bg-canvas text-ink border-line-strong"
                  : "bg-canvas border-line-strong text-ink-muted",
            )}
          >
            {i + 1}
          </span>
          <span
            className={cn(
              "uppercase tracking-[0.14em]",
              current === i ? "text-ink" : "",
            )}
          >
            {label}
          </span>
          {i < labels.length - 1 && (
            <span className="h-px w-8 bg-line-strong mx-1" />
          )}
        </div>
      ))}
    </div>
  );
}

function LabeledInput({
  label,
  icon,
  value,
  onChange,
  type = "text",
  autoFocus,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-[13px] font-medium mb-1.5 text-ink-soft">{label}</div>
      <div className="flex items-center gap-2 px-3 h-11 bg-canvas border border-line rounded-[8px] focus-within:border-klein focus-within:shadow-[0_0_0_3px_rgba(204,120,92,0.22)] transition-shadow">
        <span className="text-ink-muted">{icon}</span>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete={type === "password" ? "current-password" : "username"}
          className="flex-1 bg-transparent outline-none text-[15px]"
        />
      </div>
    </label>
  );
}

function TotpInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const digits = value.padEnd(6).split("").slice(0, 6);
  return (
    <div>
      <div className="text-[13px] font-medium mb-1.5 text-ink-soft">
        Authenticator code
      </div>
      <input
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        autoFocus
        value={value}
        onChange={(e) =>
          onChange(e.target.value.replace(/\D/g, "").slice(0, 6))
        }
        className="sr-only"
        id="totp-hidden"
      />
      <label
        htmlFor="totp-hidden"
        className="grid grid-cols-6 gap-2 mono cursor-text"
      >
        {digits.map((d, i) => {
          const filled = d.trim().length > 0;
          const isNext = !filled && value.length === i;
          return (
            <div
              key={i}
              className={cn(
                "h-14 rounded-[8px] border bg-canvas flex items-center justify-center text-[22px]",
                filled ? "border-line-strong" : "border-line",
                isNext && "border-klein shadow-[0_0_0_3px_rgba(204,120,92,0.18)]",
              )}
            >
              {d.trim() || (isNext ? <span className="text-klein">_</span> : "")}
            </div>
          );
        })}
      </label>
    </div>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] border border-danger/30 bg-danger-wash text-[#7a1d21] text-[13px] px-3 py-2">
      {children}
    </div>
  );
}
