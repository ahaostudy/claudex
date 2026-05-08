import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight, Eye, EyeOff, File, Folder, Home, X } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type { BrowseEntry } from "@claudex/shared";
import { cn } from "@/lib/cn";
import type { PickerHandle } from "./SlashCommandSheet";
import { usePullToDismiss } from "@/hooks/usePullToDismiss";

/**
 * File-mention picker.
 *
 * Two layouts share a single implementation:
 *   - **Mobile** (<md): full-width bottom sheet with a search pill, a
 *     folder toolbar (Home / Up / dotfile toggle), and a tappable list.
 *   - **Desktop** (≥md): an anchored popover above the composer, following
 *     mockup s-09 — header strip with `@` + current folder-prefix query +
 *     matches count, a divide-y list, and a compact footer hint. The
 *     parent renders this as a child of a `relative` composer wrapper; we
 *     position via `md:absolute md:bottom-full md:mb-2`.
 *
 * We intentionally OMIT the mockup's per-row metadata (`TypeScript · 42
 * lines` / `edited 2m ago`) — the `/api/browse` endpoint only returns the
 * dirent name + kind + hidden flag. Adding mtime + byte-level language
 * detection would mean new server fields, which is out of scope here.
 *
 * When the picked path is inside `projectRoot`, the Composer inserts a
 * path relative to the root (matching `@path` Claude Code convention).
 * Outside the root we fall back to an absolute path so we never silently
 * misrepresent the reference.
 */
export const FileMentionSheet = forwardRef<
  PickerHandle,
  {
    /** Absolute host path of the session's project. Sheet opens here. */
    projectRoot: string;
    /** Text typed after the trigger `@`, used to pre-filter the current dir. */
    initialQuery: string;
    /** Absolute path of the picked file or folder. */
    onPick: (absPath: string) => void;
    onClose: () => void;
  }
>(function FileMentionSheet(
  { projectRoot, initialQuery, onPick, onClose },
  ref,
) {
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
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

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
    // If the query ends in `/` or contains one, only the trailing segment is
    // useful for filtering this directory's names — preceding segments are
    // implicitly the path context the user's already typed.
    const needle = q.includes("/") ? q.slice(q.lastIndexOf("/") + 1) : q;
    if (!needle) return base;
    return base.filter((e) => e.name.toLowerCase().includes(needle));
  }, [data, showHidden, query]);

  // Clamp selection when the underlying list changes.
  useEffect(() => {
    if (selected >= filtered.length) {
      setSelected(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selected]);

  const hiddenCount = data ? data.entries.filter((e) => e.isHidden).length : 0;

  // Folder-prefix slice of the query — the part up to and including the last
  // `/`, e.g. `lib/da` → `lib/`. Shown in the desktop popover header to echo
  // the mockup's "@ lib/" affordance. When the query has no `/`, the slice
  // is empty and we just render `@`.
  const folderPrefix = useMemo(() => {
    const q = query;
    const idx = q.lastIndexOf("/");
    return idx >= 0 ? q.slice(0, idx + 1) : "";
  }, [query]);

  function activate(entry: BrowseEntry) {
    if (entry.isDir) setPath(entry.path);
    else onPick(entry.path);
  }

  useImperativeHandle(
    ref,
    () => ({
      move: (dir) => {
        if (filtered.length === 0) return;
        setSelected((i) => {
          if (dir === "down") return (i + 1) % filtered.length;
          return (i - 1 + filtered.length) % filtered.length;
        });
      },
      select: () => {
        const e = filtered[selected];
        if (e) activate(e);
      },
    }),
    [filtered, selected],
  );

  // Keep the selected row in view when it changes (keyboard nav).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-picker-row="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Pull-to-dismiss — mobile only. Desktop uses the separate popover block
  // below and never attaches these handlers.
  const pull = usePullToDismiss(onClose);

  // The desktop popover renders essentially the same list rows as mobile,
  // but with a slim header strip + divide-y list + footer-only hint. We
  // branch layout with responsive utilities rather than two components so
  // state (path, selection, query) stays unified.
  const matchLabel = `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}`;

  const rowList = (
    <div ref={listRef}>
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
          {filtered.map((e, i) => {
            const isSelected = i === selected;
            return (
              <li key={e.path}>
                <button
                  data-picker-row={i}
                  onClick={() => activate(e)}
                  onMouseEnter={() => setSelected(i)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 text-left",
                    isSelected
                      ? "bg-klein-wash/40 border-l-2 border-klein"
                      : "border-l-2 border-transparent hover:bg-paper/60",
                  )}
                >
                  {e.isDir ? (
                    <Folder className="w-4 h-4 shrink-0 text-klein-ink" />
                  ) : (
                    <File className="w-4 h-4 shrink-0 text-ink-faint" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate mono text-[13px]",
                      e.isHidden && "text-ink-muted",
                    )}
                  >
                    {highlightMatch(e.name, trailingNeedle(query))}
                  </span>
                  {e.isDir && (
                    <ChevronRight className="w-4 h-4 text-ink-faint shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
    <>
      {/* Mobile: full-screen sheet. Desktop hides this variant with `md:hidden`. */}
      <div
        className="fixed inset-0 z-30 bg-ink/50 flex items-end justify-center md:hidden"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mention a file"
          className={cn(
            "w-full bg-canvas border-t border-line rounded-t-[24px] shadow-lift flex flex-col max-h-[92vh] touch-pan-y",
            pull.releasing && "transition-transform duration-200",
          )}
          style={pull.style}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle — also the pull-to-dismiss grip on mobile. */}
          <div
            className="flex justify-center pt-3 pb-2 -mb-2 cursor-grab touch-none select-none"
            {...pull.handlers}
          >
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
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(0);
                }}
                onKeyDown={(e) => handleSearchKey(e)}
                placeholder="Filter in this folder…"
                className="flex-1 bg-transparent outline-none text-[15px]"
              />
              <span className="caps text-ink-muted">{matchLabel}</span>
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
          <div className="flex-1 overflow-y-auto">{rowList}</div>

          {/* Footer hint */}
          <div className="px-4 py-3 border-t border-line flex items-center text-[11px] text-ink-muted">
            <span>↑↓ navigate · ⏎ insert · esc close</span>
            <span className="ml-auto caps">@ files only</span>
          </div>
        </div>
      </div>

      {/* Desktop: anchored popover above the composer. Mirror mockup s-09. */}
      <div
        className="hidden md:block fixed inset-0 z-30"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mention a file"
          className="absolute left-1/2 -translate-x-1/2 bottom-[150px] w-[min(520px,calc(100vw-40px))] rounded-[12px] border border-line bg-canvas shadow-lift overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header strip */}
          <div className="px-3 py-2 border-b border-line bg-paper/60 flex items-center gap-2">
            <span className="mono text-klein">@</span>
            {folderPrefix ? (
              <span className="mono text-[13px] truncate" title={folderPrefix}>
                {folderPrefix}
              </span>
            ) : (
              <span
                className="mono text-[12px] text-ink-muted truncate"
                title={data?.path ?? path}
              >
                {shortenHostPath(data?.path ?? path, projectRoot)}
              </span>
            )}
            <span className="ml-auto caps text-ink-muted">
              {matchLabel} · ↑↓ navigate
            </span>
          </div>

          {/* Toolbar (slimmer on desktop — same controls as mobile) */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-line bg-paper/30 overflow-x-auto">
            <ToolbarButton
              onClick={() => setPath(projectRoot)}
              icon={<Home className="w-3.5 h-3.5" />}
              label="Root"
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
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="inline-flex items-center gap-1.5 h-7 px-2 rounded-[6px] border border-line bg-paper text-[11px] text-ink-soft"
            >
              {showHidden ? (
                <EyeOff className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              {showHidden ? "Hide dotfiles" : `Show dotfiles (${hiddenCount})`}
            </button>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
              }}
              onKeyDown={(e) => handleSearchKey(e)}
              placeholder="Filter…"
              className="ml-auto h-7 px-2 min-w-0 flex-1 max-w-[180px] bg-paper border border-line rounded-[6px] outline-none text-[12px]"
            />
          </div>

          {/* Body */}
          <div className="max-h-[340px] overflow-y-auto">{rowList}</div>

          {/* Footer */}
          <div className="flex items-center justify-between px-3 py-2 bg-paper border-t border-line text-[11px] text-ink-muted">
            <span>↑↓ navigate · ⏎ insert · esc close</span>
            <span className="caps">@ files only</span>
          </div>
        </div>
      </div>
    </>
  );

  function handleSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = filtered[selected];
      if (entry) activate(entry);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) {
        setSelected((i) => (i + 1) % filtered.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0) {
        setSelected((i) => (i - 1 + filtered.length) % filtered.length);
      }
    }
  }
});

/** Trailing path segment of the query — the part after the last `/`. */
function trailingNeedle(query: string): string {
  const q = query.trim();
  if (!q) return "";
  const idx = q.lastIndexOf("/");
  return idx >= 0 ? q.slice(idx + 1) : q;
}

/**
 * Wrap the first case-insensitive occurrence of `query` inside `target`
 * in a klein-colored span. Matches the slash-picker highlight rule.
 */
function highlightMatch(target: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return target;
  const idx = target.toLowerCase().indexOf(q);
  if (idx < 0) return target;
  const before = target.slice(0, idx);
  const match = target.slice(idx, idx + q.length);
  const after = target.slice(idx + q.length);
  return (
    <>
      {before}
      <span className="text-klein">{match}</span>
      {after}
    </>
  );
}

/**
 * Render a host path relative to the project root when possible — the
 * popover header has limited width, so `lib/` reads better than the full
 * absolute path. Falls back to the absolute path when outside the root.
 */
function shortenHostPath(abs: string, projectRoot: string): string {
  if (abs === projectRoot) return ".";
  if (abs.startsWith(projectRoot + "/")) {
    return abs.slice(projectRoot.length + 1) + "/";
  }
  return abs;
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
