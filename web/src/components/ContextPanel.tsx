import { useEffect, useState } from "react";
import { X, Cpu, Zap, Puzzle, Brain, BookOpen, ChevronRight } from "lucide-react";
import type { Session, UsageSummaryResponse, UserEnvResponse, MemoryResponse } from "@claudex/shared";
import { api } from "@/api/client";
import { contextWindowTokens, formatTokens, formatUsd } from "@/lib/usage";
import { estimateCostUsd, getModelLabel } from "@/lib/pricing";

/**
 * Context panel — slides in from the right on desktop, bottom sheet on mobile.
 * Replaces the old desktop navigate-to-/usage flow with a rich inline popup
 * that covers model, context usage, token stats, cost, skills, plugins, and
 * project memory in one place.
 *
 * Data is fetched on open: usage summary (existing endpoint), user env
 * (skills + plugins), and project memory (CLAUDE.md preview). All three
 * requests fire in parallel and failures are surfaced inline.
 */
export function ContextPanel({
  session,
  customModels,
  onClose,
}: {
  session: Session;
  customModels?: { id: string; label: string }[] | null;
  onClose: () => void;
}) {
  const [usage, setUsage] = useState<UsageSummaryResponse | null>(null);
  const [env, setEnv] = useState<UserEnvResponse | null>(null);
  const [memory, setMemory] = useState<MemoryResponse | null>(null);
  const [usageErr, setUsageErr] = useState<string | null>(null);
  const [envErr, setEnvErr] = useState<string | null>(null);
  const [memoryErr, setMemoryErr] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  // Trigger enter animation on mount.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Fetch all data in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await api.getUsageSummary(session.id);
        if (!cancelled) setUsage(u);
      } catch (e) {
        if (!cancelled) setUsageErr(e instanceof Error ? e.message : "load_failed");
      }
    })();
    (async () => {
      try {
        const e = await api.getUserEnv();
        if (!cancelled) setEnv(e);
      } catch (e) {
        if (!cancelled) setEnvErr(e instanceof Error ? e.message : "load_failed");
      }
    })();
    (async () => {
      try {
        const m = await api.getProjectMemory(session.projectId);
        if (!cancelled) setMemory(m);
      } catch (e) {
        if (!cancelled) setMemoryErr(e instanceof Error ? e.message : "load_failed");
      }
    })();
    return () => { cancelled = true; };
  }, [session.id, session.projectId]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Context % calculation (same logic as UsagePanel).
  const cw = contextWindowTokens(session.model);
  const lastTurnInput = usage?.lastTurnInput ?? 0;
  const contextKnown = usage?.lastTurnContextKnown ?? false;
  const contextPct = contextKnown ? Math.min(1, lastTurnInput / cw) : 0;

  const modelLabel = getModelLabel(session.model, customModels);
  const enabledSkills = (env?.plugins ?? []).filter((p) => p.enabled && p.key.startsWith("skill-creator") === false && p.marketplace);
  const enabledPlugins = (env?.plugins ?? []).filter((p) => p.enabled && (p.key.startsWith("skill-creator") || !p.marketplace));
  const memoryFiles = memory?.files ?? [];

  return (
    <div
      className="fixed inset-0 z-30 flex items-end sm:items-stretch sm:justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Session context"
    >
      {/* Backdrop — invisible on desktop (panel is self-contained), visible on mobile. */}
      <button
        aria-label="Close"
        onClick={onClose}
        className={`
          absolute inset-0 bg-ink/20 backdrop-blur-[1px]
          transition-opacity duration-300 ease-out
          sm:bg-transparent sm:backdrop-blur-none
          ${visible ? "opacity-100" : "opacity-0"}
        `}
      />

      {/* Panel */}
      <div
        className={`
          relative w-full sm:w-[420px] sm:h-full
          bg-canvas sm:border-l border-line
          rounded-t-[18px] sm:rounded-none
          shadow-lift sm:shadow-[-20px_0_60px_-30px_rgba(31,30,29,0.18)]
          flex flex-col
          transition-transform duration-350 ease-out
          ${visible ? "translate-x-0" : "translate-x-full"}
          sm:translate-y-0
          ${visible ? "translate-y-0" : "translate-y-4 sm:translate-y-0"}
          max-h-[88vh] sm:max-h-full
        `}
      >
        {/* Mobile drag handle */}
        <div className="flex justify-center pt-2 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header */}
        <div className="px-5 py-4 border-b border-line flex items-center gap-3 shrink-0">
          <div className="min-w-0">
            <div className="display text-[18px] leading-tight">Session Context</div>
            <div className="mono text-[11px] text-ink-muted mt-0.5">
              {session.title}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center hover:bg-line transition-colors duration-150"
            aria-label="Close context panel"
          >
            <X className="w-4 h-4 text-ink-soft" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* ---- Model & Effort ---- */}
          <Section icon={<Cpu className="w-3.5 h-3.5" />} label="Model">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium">{modelLabel}</span>
              <span className="mono text-[11px] text-ink-muted bg-paper border border-line rounded-[4px] px-1.5 py-0.5">
                {session.effort ?? "medium"}
              </span>
            </div>
          </Section>

          {/* ---- Context Ring ---- */}
          <Section icon={<Zap className="w-3.5 h-3.5" />} label="Context Window">
            <div className="flex items-center gap-4">
              <Ring pct={contextPct} known={contextKnown} size={80} />
              <div className="min-w-0">
                {contextKnown ? (
                  <>
                    <div className="display text-[22px] leading-none">
                      {Math.round(contextPct * 100)}%
                    </div>
                    <div className="mono text-[11px] text-ink-muted mt-1">
                      {formatTokens(lastTurnInput)} / {formatTokens(cw)}
                    </div>
                  </>
                ) : (
                  <div className="text-[13px] text-ink-muted leading-snug">
                    {usage && usage.turnCount === 0
                      ? "No turns yet — send a message to see context usage."
                      : "Historical turn — next turn will reflect real context."}
                  </div>
                )}
              </div>
            </div>
          </Section>

          {/* ---- Token Stats ---- */}
          <Section icon={<Zap className="w-3.5 h-3.5" />} label="Tokens · this session">
            {usageErr ? (
              <ErrLine msg={usageErr} />
            ) : !usage ? (
              <Skeleton />
            ) : usage.turnCount === 0 ? (
              <div className="text-[13px] text-ink-muted">No completed turns yet.</div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Input" value={formatTokens(usage.totalInput)} />
                <Stat label="Output" value={formatTokens(usage.totalOutput)} />
                <Stat label="Total" value={formatTokens(usage.totalInput + usage.totalOutput)} />
              </div>
            )}
          </Section>

          {/* ---- Cost Estimate ---- */}
          <Section icon={<Zap className="w-3.5 h-3.5" />} label="Cost Estimate">
            <div className="display text-[24px] leading-none">
              {formatUsd(
                usage
                  ? usage.perModel.reduce(
                      (n, r) => n + estimateCostUsd(r.model, r.inputTokens, r.outputTokens),
                      0,
                    )
                  : 0,
              )}
            </div>
            <div className="text-[11px] text-ink-muted mt-1 leading-snug">
              Front-end estimate from published per-token rates. Upper bound —
              does not account for prompt caching discounts.
            </div>
          </Section>

          {/* ---- Skills ---- */}
          <Section icon={<Puzzle className="w-3.5 h-3.5" />} label="Skills">
            {envErr ? (
              <ErrLine msg={envErr} />
            ) : !env ? (
              <Skeleton />
            ) : enabledSkills.length === 0 ? (
              <div className="text-[13px] text-ink-muted">No skills enabled.</div>
            ) : (
              <div className="space-y-1">
                {enabledSkills.map((s) => (
                  <Chip key={s.key} label={s.name} sub={s.marketplace ?? undefined} />
                ))}
              </div>
            )}
          </Section>

          {/* ---- Plugins ---- */}
          <Section icon={<Puzzle className="w-3.5 h-3.5" />} label="Plugins">
            {envErr ? (
              <ErrLine msg={envErr} />
            ) : !env ? (
              <Skeleton />
            ) : enabledPlugins.length === 0 ? (
              <div className="text-[13px] text-ink-muted">No plugins enabled.</div>
            ) : (
              <div className="space-y-1">
                {enabledPlugins.map((p) => (
                  <Chip key={p.key} label={p.name} sub={p.version ?? undefined} />
                ))}
              </div>
            )}
          </Section>

          {/* ---- Memory (CLAUDE.md) ---- */}
          <Section icon={<Brain className="w-3.5 h-3.5" />} label="Memory">
            {memoryErr ? (
              <ErrLine msg={memoryErr} />
            ) : !memory ? (
              <Skeleton />
            ) : memoryFiles.length === 0 ? (
              <div className="text-[13px] text-ink-muted">No CLAUDE.md files found.</div>
            ) : (
              <div className="space-y-3">
                {memoryFiles.map((f) => (
                  <MemoryCard key={f.path} file={f} />
                ))}
              </div>
            )}
          </Section>

          {/* ---- Deep link to full usage page ---- */}
          <div className="pt-1 pb-2">
            <a
              href={`/usage?session=${encodeURIComponent(session.id)}`}
              className="inline-flex items-center gap-1 text-[13px] text-klein hover:underline"
            >
              Full usage analytics
              <ChevronRight className="w-3.5 h-3.5" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[10px] border border-line bg-paper/60 p-4">
      <div className="caps text-[10px] tracking-wider text-ink-muted mb-2 flex items-center gap-1.5">
        <span className="text-ink-faint">{icon}</span>
        {label}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] tracking-wider text-ink-muted uppercase">{label}</div>
      <div className="mono text-[13px] mt-0.5">{value}</div>
    </div>
  );
}

function Chip({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] py-0.5">
      <span className="h-1.5 w-1.5 rounded-full bg-klein shrink-0" />
      <span className="truncate">{label}</span>
      {sub && (
        <span className="mono text-[10px] text-ink-muted shrink-0">{sub}</span>
      )}
    </div>
  );
}

function MemoryCard({ file }: { file: MemoryResponse["files"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const preview = file.content.slice(0, expanded ? undefined : 200);
  const truncated = !expanded && (file.content.length > 200 || file.truncated);

  return (
    <div className="rounded-[8px] border border-line bg-canvas overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper/60">
        <BookOpen className="w-3 h-3 text-ink-muted" />
        <span className="text-[11px] text-ink-muted mono truncate">
          {file.path.split("/").pop()}
        </span>
        <span className="mono text-[10px] text-ink-muted/60 ml-auto shrink-0">
          {file.scope}
        </span>
      </div>
      <pre className="text-[11px] leading-relaxed text-ink-soft p-3 overflow-x-auto whitespace-pre-wrap break-all font-mono">
        {preview}
        {truncated && (
          <button
            onClick={() => setExpanded(true)}
            className="text-klein hover:underline ml-1"
          >
            …show more
          </button>
        )}
      </pre>
    </div>
  );
}

function Ring({
  pct,
  known,
  size,
}: {
  pct: number;
  known: boolean;
  size: number;
}) {
  const r = size / 2 - 5;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - Math.max(0, Math.min(1, pct)));
  const center = size / 2;

  return (
    <div className="relative shrink-0">
      <svg width={size} height={size}>
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke="#e8e4d8"
          strokeWidth={5}
        />
        <circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={known ? "#cc785c" : "#cc785c66"}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="display text-[16px]">
          {known ? `${Math.round(pct * 100)}%` : "—"}
        </span>
      </div>
    </div>
  );
}

function ErrLine({ msg }: { msg: string }) {
  return (
    <div className="text-[12px] text-danger">{msg}</div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 bg-line rounded-[3px] animate-pulse w-2/3" />
      <div className="h-3 bg-line rounded-[3px] animate-pulse w-1/2" />
    </div>
  );
}
