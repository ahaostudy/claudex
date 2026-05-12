import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Eye, EyeOff, Folder, Home, Pencil, X } from "lucide-react";
import { api, ApiError } from "@/api/client";
import type { BrowseEntry } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { isAbsolutePath } from "@/lib/path";

/**
 * Full-screen (mobile) / modal (desktop) directory picker. The server exposes
 * GET /api/browse which returns immediate children of a path; this component
 * walks the tree by issuing one request per directory the user drills into.
 *
 * The user picks a directory by tapping the top "Select this folder" button,
 * which returns the currently-displayed path (whatever `data.path` is).
 */
export function FolderPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath?: string;
  onPick: (absPath: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [data, setData] = useState<{
    path: string;
    parent: string | null;
    entries: BrowseEntry[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Manual path entry. Mobile users with no way to drill through
  // `C:\Users\…` into another drive (e.g. `D:\Code`) rely on this to
  // jump laterally across the filesystem.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setErr(null);
      try {
        // First render with no initial path → go to home.
        if (!path) {
          const home = await api.browseHome();
          if (cancelled) return;
          setPath(home.path);
          return;
        }
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

  const visible = data
    ? data.entries.filter((e) => showHidden || !e.isHidden)
    : [];
  const hiddenCount = data
    ? data.entries.filter((e) => e.isHidden).length
    : 0;

  return (
    <div className="fixed inset-0 z-30 bg-ink/50 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[92vh] sm:max-h-[78vh]">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-line">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Pick a folder
            </div>
            {editing ? (
              <form
                className="mt-1 flex items-stretch gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = draft.trim();
                  if (!input) return;
                  if (!isAbsolutePath(input)) {
                    setErr("not_absolute");
                    return;
                  }
                  setErr(null);
                  setEditing(false);
                  setPath(input);
                }}
              >
                <input
                  ref={editInputRef}
                  className="flex-1 min-w-0 h-8 px-2 bg-canvas border border-line rounded-[6px] mono text-[12px] text-ink outline-none focus:border-klein"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="/Users/you or D:\\Code"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label="Enter absolute path"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setEditing(false);
                    }
                  }}
                />
                <button
                  type="submit"
                  className="h-8 w-8 rounded-[6px] bg-ink text-canvas flex items-center justify-center shrink-0"
                  aria-label="Go to path"
                  title="Go"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(data?.path ?? path ?? "");
                  setEditing(true);
                  queueMicrotask(() => {
                    const el = editInputRef.current;
                    if (el) {
                      el.focus();
                      el.select();
                    }
                  });
                }}
                title="Tap to edit — paste or type any absolute path (e.g. D:\\Code)"
                className="mt-0.5 w-full flex items-center gap-1.5 text-left group"
              >
                <span className="mono text-[12px] text-ink-soft truncate">
                  {data?.path ?? path ?? "…"}
                </span>
                <Pencil className="w-3 h-3 text-ink-faint group-hover:text-ink shrink-0" />
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center shrink-0"
            aria-label="close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line overflow-x-auto">
          <ToolbarButton
            onClick={async () => {
              try {
                const home = await api.browseHome();
                setPath(home.path);
              } catch {
                /* ignore */
              }
            }}
            icon={<Home className="w-3.5 h-3.5" />}
            label="Home"
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
          ) : visible.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              {data?.entries.length === 0
                ? "This folder is empty."
                : "No visible entries. Toggle dotfiles to see hidden items."}
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {visible.map((e) => (
                <li key={e.path}>
                  <button
                    disabled={!e.isDir}
                    onClick={() => e.isDir && setPath(e.path)}
                    className={cn(
                      "w-full flex items-center gap-3 px-4 py-3 text-left",
                      e.isDir
                        ? "hover:bg-paper/60"
                        : "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <Folder
                      className={cn(
                        "w-4 h-4 shrink-0",
                        e.isDir ? "text-klein-ink" : "text-ink-faint",
                      )}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-[14px]",
                        e.isHidden && "text-ink-muted",
                        !e.isDir && "mono text-[12px]",
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

        {/* Footer — the "confirm" action */}
        <div className="border-t border-line p-3 flex items-center gap-2 bg-canvas">
          <div className="text-[11px] text-ink-muted flex-1 truncate">
            Tap a folder to descend. Confirm below to select.
          </div>
          <button
            onClick={() => data && onPick(data.path)}
            disabled={!data}
            className="h-10 px-4 rounded-[8px] bg-ink text-canvas font-medium text-[13px] disabled:opacity-50"
          >
            Select this folder
          </button>
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
