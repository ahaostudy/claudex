import { useEffect, useState } from "react";

interface Health {
  status: string;
  version: string;
  time: string;
}

export function PlaceholderScreen() {
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setHealth)
      .catch((e: Error) => setErr(e.message));
  }, []);

  return (
    <main className="min-h-full flex items-center justify-center p-8">
      <div className="max-w-md w-full">
        <div className="flex items-center gap-2 mb-6">
          <svg viewBox="0 0 32 32" className="w-5 h-5">
            <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
            <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
          </svg>
          <span className="mono text-[13px]">claudex</span>
          <span className="text-[11px] uppercase tracking-[0.14em] text-ink-muted ml-2">
            scaffold · P0
          </span>
        </div>
        <h1 className="display text-[2rem] leading-tight mb-4">
          Remote control for the <em className="not-italic text-klein">claude</em> on your own machine.
        </h1>
        <p className="text-[15px] text-ink-muted leading-relaxed mb-8">
          This page is a placeholder while we wire up the real screens. The server
          health probe below tells us the backend is reachable through the Vite proxy.
        </p>
        <div className="rounded-[10px] border border-line bg-paper/50 p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted mb-2">
            Backend health
          </div>
          {health ? (
            <div className="mono text-[13px] leading-relaxed">
              status: <span className="text-success">{health.status}</span>
              <br />
              version: {health.version}
              <br />
              time: {health.time}
            </div>
          ) : err ? (
            <div className="mono text-[13px] text-danger">error: {err}</div>
          ) : (
            <div className="mono text-[13px] text-ink-muted">probing…</div>
          )}
        </div>
      </div>
    </main>
  );
}
