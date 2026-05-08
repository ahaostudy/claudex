import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Eye, EyeOff, File, Folder, Home, X } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type { BrowseEntry } from "@claudex/shared";
import { cn } from "@/lib/cn";

/**
 * File-mention picker. Same bottom-sheet shape as FolderPicker but:
 *  - files are tappable (not just folders)
 *  - picking a file calls `onPick` with the chosen absolute path
 *  - a visible "project root" strip reminds the user where @ paths resolve
 *
 * When the picked path is inside `projectRoot`, the Composer inserts a path
 * relative to the root (matching `@path` Claude Code convention). If the
 * user browses above the project root, we fall back to an absolute path so
 * we never silently mangle the reference.
 *
 * Mirrors mockup screen 09 (Pickers): the desktop popover in the mockup is a
 * list of "lib/date.ts — TypeScript · 42 lines" rows; we can't afford that
 * metadata without a heavier backend, so we render just the name + a mono
 * absolute-or-relative path hint per row.
 */
export function FileMentionSheet({
  projectRoot,
  initialQuery,
  onPick,
  onClose,
}: {
  /** Absolute host path of the session's project. Sheet opens here. */
  projectRoot: string;
  /** Text typed after the trigger `@`, used to pre-filter the current dir. */
  initialQuery: string;
  /** Absolute path of the picked file or folder. */
  onPick: (absPath: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string>(projectRoot);
  const [data, setData] = useState<{
    path: string;
    parent: string | null;
    entries: BrowseEntry[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        const res = await api.browse(path);
        if (cancelled) return;
        setData(res);
      } catch (e: unknown) {
        if (cancelled) return;
        const code = e instanceof ApiError ? e.code : "error";
        setErr(errorMessage(code));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [path]);

  const filtered = useMemo(() => {
    if (!data) return [] as BrowseEntry[];
    const base = data.entries.filter((e) => showHidden || !e.isHidden);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((e) => e.name.toLowerCase().includes(q));
  }, [data, showHidden, query]);

  const hiddenCount = data ? data.entries.filter((e) => e.isHidden).length : 0;

  return (
    <div
      className="fixed inset-0 z-30 bg-ink/50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[92vh] sm:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Mention a file
            </div>
            <div
              className="mono text-[12px] text-ink-soft truncate mt-0.5"
              title={data?.path ?? path}
            >
              {data?.path ?? path}
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center shrink-0"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Project root hint */}
        <div className="px-4 pb-2 flex items-center gap-2">
          <span className="caps text-ink-muted shrink-0">Project</span>
          <span
            className="mono text-[11px] text-ink-muted truncate"
            title={projectRoot}
          >
            {projectRoot}
          </span>
        </div>

        {/* Search */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 h-10 px-3 rounded-[8px] bg-paper border border-line">
            <span className="mono text-klein text-[15px] leading-none">@</span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered[0]) {
                    if (filtered[0].isDir) setPath(filtered[0].path);
                    else onPick(filtered[0].path);
                  }
                }
              }}
              placeholder="Filter in this folder…"
              className="flex-1 bg-transparent outline-none text-[15px]"
            />
            <span className="caps text-ink-muted">
              {filtered.length} {filtered.length === 1 ? "match" : "matches"}
            </span>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-y border-line overflow-x-auto">
          <ToolbarButton
            onClick={() => setPath(projectRoot)}
            icon={<Home className="w-3.5 h-3.5" />}
            label="Project root"
          />
          {data?.parent ? (
            <ToolbarButton
              onClick={() => setPath(data.parent!)}
              icon={<ChevronRight className="w-3.5 h-3.5 rotate-180" />}
              label="Up"
            />
          ) : (
            <ToolbarButton
              disabled
              icon={<ChevronRight className="w-3.5 h-3.5 rotate-180" />}
              label="Up"
            />
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] border border-line bg-paper text-[12px] text-ink-soft"
            >
              {showHidden ? (
                <EyeOff className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              {showHidden ? "Hide dotfiles" : `Show dotfiles (${hiddenCount})`}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && !data ? (
            <div className="text-[13px] text-ink-muted text-center py-10 mono">
              loading…
            </div>
          ) : err ? (
            <div className="p-4">
              <div className="rounded-[8px] border border-danger/30 bg-danger-wash text-[#7a1d21] text-[13px] px-3 py-2">
                {err}
              </div>
              {data?.parent && (
                <button
                  onClick={() => setPath(data.parent!)}
                  className="mt-3 w-full h-10 rounded-[8px] border border-line bg-canvas text-[13px]"
                >
                  Go up one level
                </button>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              {data?.entries.length === 0
                ? "This folder is empty."
                : query.trim()
                ? `Nothing in this folder matches “${query}”.`
                : "No visible entries. Toggle dotfiles to see hidden items."}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {filtered.map((e) => (
                <li key={e.path}>
                  <button
                    onClick={() =>
                      e.isDir ? setPath(e.path) : onPick(e.path)
                    }
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-paper/60"
                  >
                    {e.isDir ? (
                      <Folder className="w-4 h-4 shrink-0 text-klein-ink" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-ink-faint" />
                    )}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[14px]",
                        e.isHidden && "text-ink-muted",
                        !e.isDir && "mono text-[13px]",
                      )}
                    >
                      {e.name}
                    </span>
                    {e.isDir && (
                      <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-3 border-t border-line flex items-center text-[11px] text-ink-muted">
          <span>Tap a file to insert · tap a folder to descend</span>
          <span className="ml-auto mono">esc close</span>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  icon,
  label,
  disabled,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] border border-line text-[12px] shrink-0",
        disabled
          ? "bg-paper/40 text-ink-faint cursor-not-allowed"
          : "bg-canvas text-ink-soft hover:bg-paper/60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function errorMessage(code: string): string {
  switch (code) {
    case "not_absolute":
      return "Path must be absolute.";
    case "not_found":
      return "This folder does not exist on the host.";
    case "not_a_directory":
      return "That path is a file, not a folder.";
    case "permission_denied":
      return "Permission denied. The server can't read this folder.";
    default:
      return `Couldn't list this folder (${code}).`;
  }
}
