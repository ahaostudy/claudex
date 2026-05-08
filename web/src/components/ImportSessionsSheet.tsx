import { useEffect, useMemo, useState } from "react";
import { X, FolderGit2, Check, RefreshCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { api, ApiError } from "@/api/client";
import type { CliSessionSummary, Session } from "@claudex/shared";

/**
 * Adopt `claude` CLI sessions from `~/.claude/projects/...` into claudex.
 *
 * Lists every JSONL session the CLI has on disk that isn't already adopted,
 * lets the user pick a subset, and calls `POST /api/cli/sessions/import`.
 * After a successful import the caller decides what to do (navigate home,
 * refresh a list, etc.) via the `onImported` callback — this sheet is
 * intentionally agnostic so it can be hung off any entry point later.
 *
 * Wiring status: this component is NOT mounted from any screen yet. To
 * attach it from Home.tsx add a button that toggles `showImport` and
 * render `<ImportSessionsSheet onClose={…} onImported={refreshSessions} />`.
 */
export function ImportSessionsSheet({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: (imported: Session[]) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CliSessionSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCliSessions();
      setCandidates(res.sessions);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Failed to load CLI sessions: ${err.code}`
          : "Failed to load CLI sessions",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((s) => selected.has(s.sessionId));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const s of filtered) next.delete(s.sessionId);
      } else {
        for (const s of filtered) next.add(s.sessionId);
      }
      return next;
    });
  }

  async function handleImport() {
    if (selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const res = await api.importCliSessions(Array.from(selected));
      onImported?.(res.imported);
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `Import failed: ${err.code}`
          : "Import failed",
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      // The AppShell's MobileTabBar is `fixed ... z-30` and is a later DOM
      // sibling of the sheet's mount point. With equal z-index the tab bar
      // paints on top, clipping the sheet's "Import selected" footer on
      // mobile. Bump to z-40 so the sheet (and every sheet sibling at or
      // below z-30) sits above the tab bar. Matches TerminalDrawer /
      // Routines dialog patterns.
      className="fixed inset-0 z-40 bg-ink/50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-2xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[85vh] sm:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Import from CLI
            </div>
            <div className="text-[14px] text-ink">
              Adopt sessions from{" "}
              <span className="mono text-ink-muted">~/.claude/projects/</span>
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center shrink-0 disabled:opacity-40"
            aria-label="refresh"
          >
            <RefreshCcw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center shrink-0"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search + select-all */}
        <div className="px-4 pb-3 flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 h-10 px-3 rounded-[8px] bg-paper border border-line">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder="Filter by title or path…"
              className="flex-1 bg-transparent outline-none text-[15px]"
            />
            <span className="caps text-ink-muted">
              {filtered.length} / {candidates.length}
            </span>
          </div>
          <button
            onClick={toggleAllFiltered}
            disabled={filtered.length === 0}
            className="h-10 px-3 rounded-[8px] border border-line text-[13px] disabled:opacity-40"
          >
            {allFilteredSelected ? "Clear" : "Select all"}
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto border-t border-line">
          {loading ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              Scanning ~/.claude/projects…
            </div>
          ) : error ? (
            <div className="text-[13px] text-red-600 text-center py-10 px-4">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10 px-4">
              {candidates.length === 0
                ? "No CLI sessions found (or all have been adopted)."
                : `No sessions match "${query}".`}
            </div>
          ) : (
            filtered.map((s) => {
              const isSelected = selected.has(s.sessionId);
              return (
                <button
                  key={s.sessionId}
                  onClick={() => toggle(s.sessionId)}
                  className={cn(
                    "w-full flex items-start gap-3 px-4 py-3 text-left border-b border-line hover:bg-paper/40",
                    isSelected && "bg-klein-wash/40",
                  )}
                >
                  <span
                    className={cn(
                      "h-5 w-5 rounded-[5px] border flex items-center justify-center shrink-0 mt-0.5",
                      isSelected
                        ? "bg-klein border-klein text-canvas"
                        : "bg-paper border-line",
                    )}
                  >
                    {isSelected && <Check className="w-3.5 h-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium truncate">
                      {s.title}
                    </div>
                    <div className="text-[12px] text-ink-muted mono truncate flex items-center gap-1">
                      <FolderGit2 className="w-3 h-3 shrink-0" />
                      <span className="truncate">{s.cwd}</span>
                    </div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      {s.lineCount} lines · {formatSize(s.fileSize)} ·{" "}
                      {formatRelative(s.lastModified)}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-line flex items-center gap-2">
          <div className="text-[12px] text-ink-muted">
            {selected.size} selected
          </div>
          <button
            onClick={handleImport}
            disabled={selected.size === 0 || importing}
            className={cn(
              "ml-auto h-10 px-4 rounded-[8px] text-[13px] font-medium",
              selected.size === 0 || importing
                ? "bg-paper text-ink-muted border border-line"
                : "bg-klein text-canvas",
            )}
          >
            {importing
              ? "Importing…"
              : `Import selected${selected.size > 0 ? ` (${selected.size})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
