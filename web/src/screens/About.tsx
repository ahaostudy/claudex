import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ExternalLink, Info } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type { MetaResponse } from "@claudex/shared";
import { AppShell } from "@/components/AppShell";
import { timeAgoLong } from "@/lib/format";

// ---------------------------------------------------------------------------
// About — static "what am I running?" surface. Reached from the Settings
// sidebar (a separate `/about` route rather than a subtab, because About
// isn't really Settings — it's a logical neighbour).
//
// Everything is a plain label/value row. When we know the commit sha we
// render the short form as a GitHub blob link; otherwise a muted "—".
// ---------------------------------------------------------------------------

const GITHUB_REPO = "https://github.com/ahaostudy/claudex";

export function AboutScreen() {
  const navigate = useNavigate();
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((e) => setErr(e instanceof ApiError ? e.code : "load failed"));
  }, []);

  return (
    <AppShell tab="settings">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-4 sm:px-5 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate("/settings")}
          aria-label="Back"
          className="md:hidden h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="caps text-ink-muted">Settings</div>
          <div className="display text-[17px] leading-tight truncate">About</div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <section className="p-5 sm:p-8 pb-24 md:pb-10">
          <div className="max-w-[760px]">
            <div className="caps text-ink-muted">Settings · about</div>
            <h1 className="display text-[24px] md:text-[28px] leading-tight mt-1">
              What am I running?
            </h1>
            <p className="text-[14px] md:text-[15px] text-ink-muted mt-2 max-w-[60ch]">
              Server build info for this claudex install — handy when filing a
              bug or comparing machines.
            </p>

            <div className="mt-7 space-y-5">
              {err ? (
                <div className="rounded-[12px] border border-danger/30 bg-danger-wash p-4 text-[13px] text-danger">
                  Couldn't load server info: <span className="mono">{err}</span>
                </div>
              ) : !meta ? (
                <div className="rounded-[12px] border border-line bg-canvas px-4 py-6 text-[13px] mono text-ink-muted">
                  loading…
                </div>
              ) : (
                <MetaCard meta={meta} />
              )}

              <FooterLinks commit={meta?.commit ?? null} />
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function MetaCard({ meta }: { meta: MetaResponse }) {
  const commitHref =
    meta.commit !== null ? `${GITHUB_REPO}/commit/${meta.commit}` : null;
  return (
    <div className="rounded-[12px] border border-line bg-canvas overflow-hidden">
      <Row
        label="Version"
        value={<span className="mono">v{meta.version}</span>}
      />
      <Row
        label="Commit"
        value={
          meta.commitShort && commitHref ? (
            <a
              href={commitHref}
              target="_blank"
              rel="noreferrer noopener"
              className="mono inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink"
            >
              {meta.commitShort}
              <ExternalLink className="w-3 h-3" />
            </a>
          ) : (
            <span className="text-ink-muted">—</span>
          )
        }
      />
      <Row
        label="Built"
        value={
          <span>
            <span>{timeAgoLong(meta.buildTime)}</span>
            <span className="text-ink-muted mono text-[11px] ml-2">
              {new Date(meta.buildTime).toLocaleString()}
            </span>
          </span>
        }
      />
      <Row
        label="Node"
        value={<span className="mono">v{meta.nodeVersion}</span>}
      />
      <Row
        label="SQLite"
        value={<span className="mono">v{meta.sqliteVersion}</span>}
      />
      <Row
        label="Platform"
        value={<span className="mono">{meta.platform}</span>}
      />
      <Row
        label="Uptime"
        value={<span className="mono">{formatUptime(meta.uptimeSec)}</span>}
      />
    </div>
  );
}

// Uptime renderer — bigger buckets than `timeAgoShort` (which caps at "w"),
// so a long-running server reads "3d 4h" instead of "3d". Uses floor division
// so a process that's been up for 59 seconds reads "59s", not "0m".
function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh > 0 ? `${d}d ${hh}h` : `${d}d`;
}

function FooterLinks({ commit }: { commit: string | null }) {
  return (
    <div className="rounded-[12px] border border-dashed border-line bg-paper/30 px-5 py-4 flex items-start gap-4">
      <div className="h-9 w-9 rounded-[8px] bg-canvas border border-line flex items-center justify-center shrink-0">
        <Info className="w-4 h-4 text-ink-muted" />
      </div>
      <div className="min-w-0 text-[13px] text-ink-soft space-y-1">
        <div>
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink"
          >
            Source on GitHub
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div>
          <a
            href={
              commit
                ? `${GITHUB_REPO}/blob/${commit}/docs/FEATURES.md`
                : `${GITHUB_REPO}/blob/main/docs/FEATURES.md`
            }
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-ink"
          >
            Feature ledger (FEATURES.md)
            <ExternalLink className="w-3 h-3" />
          </a>
          <span className="text-ink-muted text-[12px] ml-2">
            {commit
              ? "pinned to this build"
              : "main branch (no local commit detected)"}
          </span>
        </div>
      </div>
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
    <div className="flex items-center gap-4 px-4 sm:px-5 py-3 text-[13.5px] border-b border-line last:border-b-0">
      <div className="text-ink-muted text-[12px] uppercase tracking-[0.1em] w-28 shrink-0">
        {label}
      </div>
      <div className="min-w-0 flex-1 truncate text-ink">{value}</div>
    </div>
  );
}
