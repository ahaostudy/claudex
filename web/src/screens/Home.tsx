import { useAuth } from "@/state/auth";

export function HomeScreen() {
  const { user, logout } = useAuth();
  return (
    <main className="min-h-screen p-8">
      <header className="flex items-center gap-3 mb-8">
        <svg viewBox="0 0 32 32" className="w-5 h-5">
          <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
          <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
        </svg>
        <span className="mono text-[13px]">claudex</span>
        <span className="ml-auto text-[12px] text-ink-muted">
          signed in as <span className="mono">{user?.username}</span>
        </span>
        <button
          onClick={() => logout()}
          className="text-[12px] text-ink-muted hover:text-ink"
        >
          Sign out
        </button>
      </header>
      <div className="max-w-xl">
        <h1 className="display text-[2rem] leading-tight mb-3">
          Signed in. Next up: sessions.
        </h1>
        <p className="text-[15px] text-ink-muted leading-relaxed">
          Authentication works. Session management, WebSocket streaming and the
          claude subprocess land in P2. This is a deliberate stop for P1 verification.
        </p>
      </div>
    </main>
  );
}
