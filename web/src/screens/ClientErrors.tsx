import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, Bug, RefreshCcw, Trash2, CheckCircle2, RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { api, ApiError } from "@/api/client";
import type { ClientError, ClientErrorKind } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { timeAgoShort } from "@/lib/format";

// ---------------------------------------------------------------------------
// ClientErrors screen (/errors)
//
// Shows every browser-side crash the UI has reported to
// `/api/client-errors`. Three filter tabs (open / resolved / all), per-row
// actions (resolve | reopen | delete), and two bulk actions at the top
// ("Resolve all open" / "Clear resolved").
//
// Rows are dedup'd server-side by fingerprint — the `count` column tells
// you "this same error fired N times", and `lastSeenAt` is the most
// recent occurrence. A resolved error that fires again auto-reopens (the
// server clears resolved_at on upsert), which is the behavior you want
// for regression detection.
// ---------------------------------------------------------------------------

type StatusFilter = "open" | "resolved" | "all";

function kindBadge(kind: ClientErrorKind): { label: string; cls: string } {
  switch (kind) {
    case "render":
      return { label: "render", cls: "bg-danger-wash/60 border-danger/40 text-danger" };
    case "uncaught":
      return { label: "uncaught", cls: "bg-warn-wash/60 border-warn/40 text-warn" };
    case "unhandledrejection":
      return { label: "rejection", cls: "bg-warn-wash/60 border-warn/40 text-warn" };
    case "console-error":
      return { label: "console", cls: "bg-paper border-line text-ink-muted" };
  }
}

export function ClientErrorsScreen() {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [errors, setErrors] = useState<ClientError[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [resolvedCount, setResolvedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listClientErrors({ status, limit: 100 });
      setErrors(r.errors);
      setOpenCount(r.openCount);
      setResolvedCount(r.resolvedCount);
    } catch (e) {
      if (e instanceof ApiError) setErr(`${e.code} (${e.status})`);
      else setErr(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh every 10s so a fresh crash surfaces without manual reload,
  // but only while the tab is visible — no point polling on a backgrounded
  // phone tab.
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    timer = window.setInterval(tick, 10_000);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [refresh]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onResolve = async (id: string) => {
    try {
      await api.resolveClientError(id);
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };
  const onReopen = async (id: string) => {
    try {
      await api.reopenClientError(id);
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };
  const onDelete = async (id: string) => {
    if (!window.confirm("Delete this error record?")) return;
    try {
      await api.deleteClientError(id);
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };
  const onResolveAll = async () => {
    if (!window.confirm(`Mark all ${openCount} open error(s) resolved?`)) return;
    setBulkBusy(true);
    try {
      await api.resolveAllClientErrors();
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBulkBusy(false);
    }
  };
  const onDeleteResolved = async () => {
    if (!window.confirm(`Delete all ${resolvedCount} resolved error(s)?`)) return;
    setBulkBusy(true);
    try {
      await api.deleteResolvedClientErrors();
      await refresh();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBulkBusy(false);
    }
  };

  const total = openCount + resolvedCount;

  return (
    <AppShell tab="settings">
      <header className="shrink-0 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted flex items-center gap-1.5">
            <Link to="/settings" className="hover:text-ink">Settings</Link>
            <span>/</span>
            <span>Client errors</span>
          </div>
          <h1 className="display text-[20px] md:text-[26px] leading-tight mt-0.5">
            Browser crash log
          </h1>
        </div>
        <span className="ml-auto mono text-[11px] text-ink-muted">
          {openCount} open · {resolvedCount} resolved
        </span>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {/* Filter tabs + bulk actions */}
        <div className="flex items-center gap-2 flex-wrap mb-3">
          {(["open", "resolved", "all"] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                "px-2.5 py-1 rounded-[6px] text-[12px] border transition-colors",
                status === s
                  ? "bg-ink text-canvas border-ink"
                  : "bg-paper text-ink-muted border-line hover:text-ink",
              )}
            >
              {s}
              {s === "open" && openCount > 0 && (
                <span className="ml-1.5 mono text-[10px] opacity-80">
                  {openCount}
                </span>
              )}
              {s === "resolved" && resolvedCount > 0 && (
                <span className="ml-1.5 mono text-[10px] opacity-80">
                  {resolvedCount}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-[12px] border border-line text-ink-muted hover:text-ink disabled:opacity-50"
            aria-label="Refresh"
          >
            <RefreshCcw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
            refresh
          </button>
        </div>

        {(openCount > 0 || resolvedCount > 0) && (
          <div className="flex items-center gap-2 mb-3">
            {openCount > 0 && (
              <button
                type="button"
                onClick={onResolveAll}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] border border-line text-ink hover:bg-paper disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Resolve all open
              </button>
            )}
            {resolvedCount > 0 && (
              <button
                type="button"
                onClick={onDeleteResolved}
                disabled={bulkBusy}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] border border-danger/40 text-danger hover:bg-danger-wash/30 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear resolved
              </button>
            )}
          </div>
        )}

        {err && (
          <div className="mb-3 rounded-[8px] border border-danger/40 bg-danger-wash/60 p-3 text-[12px] text-danger">
            {err}
          </div>
        )}

        {total === 0 && !loading ? (
          <div className="flex-1 flex items-center justify-center py-16">
            <div className="max-w-[42ch] text-center">
              <div className="inline-flex h-10 w-10 rounded-full bg-paper border border-line items-center justify-center mb-3">
                <Bug className="w-4 h-4 text-ink-muted" />
              </div>
              <div className="display text-[20px] mb-1">No errors reported.</div>
              <p className="text-[13px] text-ink-muted leading-relaxed">
                Browser crashes, unhandled promise rejections, and
                console.error calls get captured here. If the UI
                white-screens, this is where the stack trace lands.
              </p>
            </div>
          </div>
        ) : errors.length === 0 && !loading ? (
          <div className="text-[12px] text-ink-muted px-1 py-6">
            Nothing matches "{status}".
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {errors.map((e) => {
              const badge = kindBadge(e.kind);
              const open = expanded.has(e.id);
              const resolved = e.resolvedAt !== null;
              return (
                <li
                  key={e.id}
                  className={cn(
                    "border rounded-[8px] bg-paper",
                    resolved ? "border-line opacity-70" : "border-line",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggle(e.id)}
                    className="w-full text-left px-3 py-2.5 flex items-start gap-2"
                  >
                    <span className="mt-0.5 text-ink-muted">
                      {open ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span
                          className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded-[4px] text-[10px] border mono",
                            badge.cls,
                          )}
                        >
                          {badge.label}
                        </span>
                        {e.count > 1 && (
                          <span className="mono text-[10px] text-ink-muted">
                            ×{e.count}
                          </span>
                        )}
                        {resolved && (
                          <span className="mono text-[10px] text-ink-muted inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            resolved
                          </span>
                        )}
                        <span className="ml-auto mono text-[10px] text-ink-muted">
                          {timeAgoShort(e.lastSeenAt)}
                        </span>
                      </span>
                      <span className="block mt-1 text-[13px] text-ink break-words">
                        {e.message.split("\n")[0]}
                      </span>
                      {e.url && (
                        <span className="block mt-1 mono text-[10px] text-ink-muted truncate">
                          {e.url}
                        </span>
                      )}
                    </span>
                  </button>

                  {open && (
                    <div className="px-3 pb-3 pt-1 border-t border-line/60">
                      {e.message.split("\n").length > 1 && (
                        <pre className="mono text-[11px] whitespace-pre-wrap break-words text-ink-muted bg-canvas/60 rounded-[6px] p-2 mb-2">
                          {e.message}
                        </pre>
                      )}
                      {e.stack && (
                        <details open>
                          <summary className="caps text-[10px] text-ink-muted cursor-pointer">
                            Stack
                          </summary>
                          <pre className="mono text-[11px] whitespace-pre-wrap break-words text-ink-muted bg-canvas/60 rounded-[6px] p-2 mt-1">
                            {e.stack}
                          </pre>
                        </details>
                      )}
                      {e.componentStack && (
                        <details>
                          <summary className="caps text-[10px] text-ink-muted cursor-pointer mt-2">
                            Component stack
                          </summary>
                          <pre className="mono text-[11px] whitespace-pre-wrap break-words text-ink-muted bg-canvas/60 rounded-[6px] p-2 mt-1">
                            {e.componentStack}
                          </pre>
                        </details>
                      )}
                      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-muted">
                        <div>
                          <span className="caps text-[10px]">First seen</span>
                          <div className="mono">{new Date(e.firstSeenAt).toLocaleString()}</div>
                        </div>
                        <div>
                          <span className="caps text-[10px]">Last seen</span>
                          <div className="mono">{new Date(e.lastSeenAt).toLocaleString()}</div>
                        </div>
                        {e.userAgent && (
                          <div className="col-span-2">
                            <span className="caps text-[10px]">User agent</span>
                            <div className="mono break-all">{e.userAgent}</div>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 flex items-center gap-2 flex-wrap">
                        {resolved ? (
                          <button
                            type="button"
                            onClick={() => void onReopen(e.id)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] border border-line text-ink hover:bg-canvas"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reopen
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void onResolve(e.id)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] border border-ink bg-ink text-canvas hover:opacity-90"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Mark resolved
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void onDelete(e.id)}
                          className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] border border-danger/40 text-danger hover:bg-danger-wash/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {loading && errors.length === 0 && (
          <div className="flex items-center justify-center py-10 text-[12px] text-ink-muted inline-flex gap-2">
            <AlertOctagon className="w-3.5 h-3.5" />
            loading…
          </div>
        )}
      </section>
    </AppShell>
  );
}
