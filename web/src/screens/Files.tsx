import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Search,
  X,
} from "lucide-react";
import type {
  BrowseEntry,
  BrowseReadResponse,
  Project,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Files browser (mockup s-14). Read-only, general-purpose host filesystem
// viewer — not project-scoped. Defaults to the user's home directory and
// supports Home / Up / Root navigation so the user can browse anywhere on
// the host.
//
// This used to be a project-scoped tree view keyed to a Project row, but
// that made the Files tab useless for anyone trying to look at a file
// outside a project they'd already registered. The tree expansion model
// also didn't play well with crossing into directories above the project
// root, so we collapsed it to a flat one-directory-at-a-time list — same
// UX as FolderPicker and the @-file mention sheet, which were already
// doing this right.
//
// Non-goals for this cut:
//   - Editing (read-only only)
//   - Full-text search across files (we only filter the current listing)
//   - Syntax highlighting (plain <pre> with line numbers; fine for now)
//   - Git status annotations (those live in the project-scoped /api/files/*
//     endpoints; re-adding them here would require walking up to find a
//     .git and running git-status per viewed directory — scope creep)
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelTime(mtimeMs: number): string {
  const diffMs = Date.now() - mtimeMs;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Copy text to the clipboard with an HTTP (non-secure-context) fallback.
 *  claudex is served over plain HTTP through an frpc tunnel, so
 *  `navigator.clipboard.writeText` is undefined on the user's mobile; we
 *  fall back to a hidden textarea + execCommand. */
function copyText(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* give up silently — nothing else to try */
  }
  ta.remove();
}

function errorMessage(code: string): string {
  switch (code) {
    case "not_absolute":
      return "Path must be absolute.";
    case "not_found":
      return "This path does not exist on the host.";
    case "not_a_directory":
      return "That path is a file, not a folder.";
    case "is_a_directory":
      return "That path is a folder, not a file.";
    case "permission_denied":
      return "Permission denied. The server can't read this path.";
    case "binary_file":
      return "Binary file — no preview available.";
    default:
      return `Couldn't load this path (${code}).`;
  }
}

// ---- screen ----------------------------------------------------------------

interface BrowseData {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export function FilesScreen() {
  // current directory the listing is showing
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [browse, setBrowse] = useState<BrowseData | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // selected file preview
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<BrowseReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // projects (for the "jump to project" dropdown — a convenience, not the
  // primary nav anymore)
  const [projects, setProjects] = useState<Project[]>([]);

  const [searchQuery, setSearchQuery] = useState("");
  // Persist the show-hidden preference so users who want to see dotfiles
  // don't have to re-enable the toggle every time. localStorage is fine on
  // an HTTP (non-secure-context) origin. Guarded against missing `window`
  // for safety even though this component only ever runs in the browser.
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("claudex:files:showHidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleHidden = useCallback(() => {
    setShowHidden((v) => {
      const next = !v;
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            "claudex:files:showHidden",
            next ? "1" : "0",
          );
        }
      } catch {
        /* quota / private mode — ignore */
      }
      return next;
    });
  }, []);

  // First render: fetch user's home directory and land there.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = await api.browseHome();
        if (cancelled) return;
        setCurrentPath(home.path);
      } catch {
        // Very unlikely, but if /api/browse/home fails we still try "/" so
        // the screen isn't permanently stuck.
        if (!cancelled) setCurrentPath("/");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load listing whenever `currentPath` changes.
  useEffect(() => {
    if (!currentPath) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    // Reset search when changing directories — stale filter would hide
    // everything in the new folder.
    setSearchQuery("");
    (async () => {
      try {
        const res = await api.browse(currentPath);
        if (cancelled) return;
        setBrowse(res);
      } catch (e) {
        if (cancelled) return;
        setListError(e instanceof ApiError ? e.code : "load_failed");
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  // Best-effort: load projects once so the "jump to project" dropdown works.
  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openFile = useCallback(async (absPath: string) => {
    setSelectedFilePath(absPath);
    setFileLoading(true);
    setFileError(null);
    try {
      const res = await api.browseRead(absPath);
      setFileData(res);
    } catch (e) {
      setFileError(
        e instanceof ApiError ? errorMessage(e.code) : "Couldn't load this file.",
      );
      setFileData(null);
    } finally {
      setFileLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => {
    setSelectedFilePath(null);
    setFileData(null);
    setFileError(null);
  }, []);

  const goHome = useCallback(async () => {
    try {
      const home = await api.browseHome();
      setCurrentPath(home.path);
    } catch {
      /* ignore — toolbar button is best-effort */
    }
  }, []);

  const goRoot = useCallback(() => {
    // POSIX filesystem root. Windows users would need a drive letter here
    // but claudex is a Mac/Linux-first product and "/" is the right default.
    setCurrentPath("/");
  }, []);

  const goUp = useCallback(() => {
    if (browse?.parent) setCurrentPath(browse.parent);
  }, [browse]);

  const goToProject = useCallback((projectPath: string) => {
    setCurrentPath(projectPath);
  }, []);

  const visibleEntries = useMemo(() => {
    if (!browse) return [] as BrowseEntry[];
    const base = browse.entries.filter((e) => showHidden || !e.isHidden);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return base;
    return base.filter((e) => e.name.toLowerCase().includes(q));
  }, [browse, showHidden, searchQuery]);

  const hiddenCount = browse
    ? browse.entries.filter((e) => e.isHidden).length
    : 0;

  return (
    <AppShell tab="files">
      {/* Mobile */}
      <div className="flex-1 min-h-0 flex flex-col md:hidden overflow-hidden">
        <MobileFilesView
          currentPath={currentPath}
          browse={browse}
          listLoading={listLoading}
          listError={listError}
          visibleEntries={visibleEntries}
          hiddenCount={hiddenCount}
          showHidden={showHidden}
          onToggleHidden={toggleHidden}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedFilePath={selectedFilePath}
          fileData={fileData}
          fileLoading={fileLoading}
          fileError={fileError}
          onNavigate={setCurrentPath}
          onOpenFile={openFile}
          onClosePreview={closePreview}
          onHome={goHome}
          onRoot={goRoot}
          onUp={goUp}
          projects={projects}
          onGoToProject={goToProject}
        />
      </div>
      {/* Desktop */}
      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">
        <DesktopFilesView
          currentPath={currentPath}
          browse={browse}
          listLoading={listLoading}
          listError={listError}
          visibleEntries={visibleEntries}
          hiddenCount={hiddenCount}
          showHidden={showHidden}
          onToggleHidden={toggleHidden}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          selectedFilePath={selectedFilePath}
          fileData={fileData}
          fileLoading={fileLoading}
          fileError={fileError}
          onNavigate={setCurrentPath}
          onOpenFile={openFile}
          onClosePreview={closePreview}
          onHome={goHome}
          onRoot={goRoot}
          onUp={goUp}
          projects={projects}
          onGoToProject={goToProject}
        />
      </div>
    </AppShell>
  );
}

// ---- shared row ------------------------------------------------------------

function EntryRow({
  entry,
  active,
  onClick,
  variant,
}: {
  entry: BrowseEntry;
  active: boolean;
  onClick: () => void;
  variant: "mobile" | "desktop";
}) {
  const isMobile = variant === "mobile";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 text-left border-l-2",
        isMobile ? "px-4 py-2.5 text-[14px]" : "px-3 py-1.5 text-[13px]",
        active
          ? "bg-klein-wash/50 border-l-klein"
          : "hover:bg-canvas/60 border-l-transparent",
      )}
    >
      {entry.isDir ? (
        <Folder
          className={cn(
            "shrink-0 text-klein",
            isMobile ? "w-4 h-4" : "w-3.5 h-3.5",
          )}
        />
      ) : (
        <FileIcon
          className={cn(
            "shrink-0 text-ink-faint",
            isMobile ? "w-4 h-4" : "w-3.5 h-3.5",
          )}
        />
      )}
      <span
        className={cn(
          "mono flex-1 truncate",
          active ? "text-ink" : entry.isHidden ? "text-ink-faint" : "text-ink-soft",
        )}
      >
        {entry.name}
      </span>
      {!entry.isDir && entry.size !== undefined && (
        <span className="mono text-[10px] text-ink-faint shrink-0">
          {formatSize(entry.size)}
        </span>
      )}
      {entry.isDir && (
        <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
      )}
    </button>
  );
}

// ---- toolbar ---------------------------------------------------------------

function Toolbar({
  onHome,
  onRoot,
  onUp,
  canUp,
  compact,
}: {
  onHome: () => void;
  onRoot: () => void;
  onUp: () => void;
  canUp: boolean;
  compact?: boolean;
}) {
  const size = compact ? "h-7 px-2 text-[11px]" : "h-8 px-2.5 text-[12px]";
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      <ToolbarButton onClick={onHome} icon={<Home className="w-3.5 h-3.5" />} label="Home" size={size} />
      <ToolbarButton onClick={onRoot} icon={<HardDrive className="w-3.5 h-3.5" />} label="Root" size={size} />
      <ToolbarButton
        onClick={canUp ? onUp : undefined}
        icon={<ChevronRight className="w-3.5 h-3.5 rotate-180" />}
        label="Up"
        disabled={!canUp}
        size={size}
      />
    </div>
  );
}

/**
 * Toggle for hidden entries (leading-dot). Pulled out of the main Toolbar
 * so it has a fixed, always-visible position on the right edge — otherwise
 * the scrolling toolbar on a 390px viewport hides it off-screen, which is
 * how users miss that the Files screen can show hidden directories at all.
 *
 * Visual language:
 *   - Off (default): outlined eye with a count badge (`12` hidden here)
 *   - On: filled Klein-wash pill with EyeOff — "you are in show-hidden mode"
 * The state is persisted in localStorage so the preference sticks across
 * navigations and page reloads.
 */
function HiddenToggle({
  showHidden,
  onToggle,
  hiddenCount,
  compact,
}: {
  showHidden: boolean;
  onToggle: () => void;
  hiddenCount: number;
  compact?: boolean;
}) {
  const size = compact ? "h-7 px-2 text-[11px]" : "h-8 px-2.5 text-[12px]";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={showHidden}
      title={
        showHidden
          ? "Hide entries starting with a dot"
          : `Show hidden entries (${hiddenCount} here)`
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[6px] border shrink-0",
        size,
        showHidden
          ? "border-klein/50 bg-klein-wash text-klein-ink"
          : "border-line bg-paper text-ink-soft hover:bg-paper/60",
      )}
    >
      {showHidden ? (
        <EyeOff className="w-3.5 h-3.5" />
      ) : (
        <Eye className="w-3.5 h-3.5" />
      )}
      <span>{showHidden ? "Hidden" : "Show hidden"}</span>
      {!showHidden && hiddenCount > 0 && (
        <span className="mono text-[10px] px-1 rounded-[3px] bg-canvas border border-line text-ink-muted">
          {hiddenCount}
        </span>
      )}
    </button>
  );
}

function ToolbarButton({
  onClick,
  icon,
  label,
  disabled,
  size,
}: {
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  size: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[6px] border border-line shrink-0",
        size,
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

function ProjectJumpSelect({
  projects,
  onGoToProject,
  compact,
}: {
  projects: Project[];
  onGoToProject: (path: string) => void;
  compact?: boolean;
}) {
  if (projects.length === 0) return null;
  return (
    <div className="relative shrink-0">
      <select
        value=""
        onChange={(e) => {
          const pr = projects.find((p) => p.id === e.target.value);
          if (pr) onGoToProject(pr.path);
          // reset so the same option can be selected again
          e.target.value = "";
        }}
        className={cn(
          "appearance-none pl-2.5 pr-7 rounded-[6px] bg-paper border border-line mono cursor-pointer",
          compact ? "h-7 text-[11px]" : "h-8 text-[12px]",
        )}
        title="Jump to a project's root"
      >
        <option value="">Jump to project…</option>
        {projects.map((pr) => (
          <option key={pr.id} value={pr.id}>
            {pr.name}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
        <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
      </span>
    </div>
  );
}

// ---- breadcrumb ------------------------------------------------------------
//
// Turns `/Users/haowu/Code/AI/claudex` into a set of clickable segments. Each
// segment navigates to the absolute path up to and including itself. The
// leading "/" is rendered as its own clickable root segment so the user can
// jump straight to `/` from anywhere.

interface Crumb {
  label: string;
  path: string;
}

function buildCrumbs(absPath: string): Crumb[] {
  if (!absPath || absPath === "/") {
    return [{ label: "/", path: "/" }];
  }
  const parts = absPath.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    crumbs.push({ label: p, path: acc });
  }
  return crumbs;
}

function Breadcrumb({
  path,
  onNavigate,
  className,
}: {
  path: string;
  onNavigate: (p: string) => void;
  className?: string;
}) {
  const crumbs = buildCrumbs(path);
  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto mono text-[11.5px] text-ink-muted",
        className,
      )}
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={c.path} className="inline-flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate(c.path)}
              className={cn(
                "hover:text-ink",
                last && "text-ink",
              )}
              title={c.path}
            >
              {c.label}
            </button>
            {!last && <span className="text-ink-faint">/</span>}
          </span>
        );
      })}
    </div>
  );
}

// ---- preview panel ---------------------------------------------------------

function PreviewPanel({
  fileData,
  loading,
  error,
}: {
  fileData: BrowseReadResponse | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] text-ink-muted mono">
        loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-[13px] text-danger mono px-6 text-center">
        {error}
      </div>
    );
  }
  if (!fileData) {
    return (
      <div className="flex-1 flex items-center justify-center text-center px-8">
        <p className="text-[13px] text-ink-muted">
          Select a file to preview its contents.
        </p>
      </div>
    );
  }
  const lines = fileData.content.split("\n");
  return (
    <div className="flex-1 overflow-auto bg-canvas">
      <div className="mono text-[12.5px] leading-[1.7] px-5 py-4">
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-[42px_1fr]">
            <span className="text-right pr-3 text-ink-faint select-none">
              {i + 1}
            </span>
            <span className="whitespace-pre">{line}</span>
          </div>
        ))}
        {fileData.truncated && (
          <div className="grid grid-cols-[42px_1fr]">
            <span className="text-right pr-3 text-ink-faint select-none">…</span>
            <span className="text-ink-faint">file truncated at 1 MB</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- mobile view -----------------------------------------------------------

interface FilesViewProps {
  currentPath: string | null;
  browse: BrowseData | null;
  listLoading: boolean;
  listError: string | null;
  visibleEntries: BrowseEntry[];
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  selectedFilePath: string | null;
  fileData: BrowseReadResponse | null;
  fileLoading: boolean;
  fileError: string | null;
  onNavigate: (absPath: string) => void;
  onOpenFile: (absPath: string) => void;
  onClosePreview: () => void;
  onHome: () => void;
  onRoot: () => void;
  onUp: () => void;
  projects: Project[];
  onGoToProject: (path: string) => void;
}

function MobileFilesView(p: FilesViewProps) {
  return (
    <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-3 pt-3 pb-2 bg-canvas/95 backdrop-blur border-b border-line shrink-0 space-y-2">
        {/* Breadcrumb row */}
        <Breadcrumb
          path={p.currentPath ?? ""}
          onNavigate={p.onNavigate}
          className="px-1"
        />
        {/* Nav row: Home/Root/Up on the left (scrollable if it overflows),
            Show-hidden toggle pinned to the right so it's always visible
            on a 390px viewport — that was the original UX bug: the toggle
            was buried inside the scrolling toolbar where users never saw
            it. */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 min-w-0 overflow-x-auto">
            <Toolbar
              onHome={p.onHome}
              onRoot={p.onRoot}
              onUp={p.onUp}
              canUp={!!p.browse?.parent}
            />
          </div>
          <HiddenToggle
            showHidden={p.showHidden}
            onToggle={p.onToggleHidden}
            hiddenCount={p.hiddenCount}
          />
        </div>
        {/* Search + jump-to-project */}
        <div className="flex items-center gap-1.5">
          <div className="flex-1 flex items-center gap-2 h-9 px-3 bg-paper border border-line rounded-[8px]">
            <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <input
              type="text"
              placeholder="Filter this folder…"
              value={p.searchQuery}
              onChange={(e) => p.onSearchChange(e.target.value)}
              className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted"
            />
            {p.searchQuery && (
              <button
                type="button"
                onClick={() => p.onSearchChange("")}
                className="text-ink-muted"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <ProjectJumpSelect
            projects={p.projects}
            onGoToProject={p.onGoToProject}
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {p.listLoading && (
          <div className="px-4 py-4 text-[13px] text-ink-muted mono">loading…</div>
        )}
        {p.listError && !p.listLoading && (
          <div className="px-4 py-4 text-[13px] text-danger mono">
            {errorMessage(p.listError)}
          </div>
        )}
        {!p.listLoading && !p.listError && p.visibleEntries.length === 0 && (
          <div className="px-4 py-6 text-[13px] text-ink-muted text-center">
            {p.browse?.entries.length === 0
              ? "This folder is empty."
              : p.searchQuery
              ? `Nothing in this folder matches “${p.searchQuery}”.`
              : "No visible entries. Toggle dotfiles to see hidden items."}
          </div>
        )}
        {!p.listLoading &&
          p.visibleEntries.map((e) => (
            <EntryRow
              key={e.path}
              entry={e}
              active={p.selectedFilePath === e.path}
              onClick={() =>
                e.isDir ? p.onNavigate(e.path) : p.onOpenFile(e.path)
              }
              variant="mobile"
            />
          ))}
      </div>

      {(p.fileData || p.fileLoading || p.fileError) && p.selectedFilePath && (
        <MobilePreviewSheet
          absPath={p.selectedFilePath}
          fileData={p.fileData}
          loading={p.fileLoading}
          error={p.fileError}
          onClose={p.onClosePreview}
        />
      )}
    </div>
  );
}

function MobilePreviewSheet({
  absPath,
  fileData,
  loading,
  error,
  onClose,
}: {
  absPath: string;
  fileData: BrowseReadResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 bg-canvas flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-line bg-canvas/95 backdrop-blur">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to file tree"
          className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="mono text-[13px] truncate" title={absPath}>
            {fileData?.name ?? absPath.split("/").pop() ?? absPath}
          </div>
          {fileData && (
            <div className="mono text-[11px] text-ink-muted truncate">
              {fileData.lines} lines · {formatSize(fileData.sizeBytes)}
              {fileData.truncated ? " · truncated" : ""}
            </div>
          )}
        </div>
        <button
          type="button"
          className="h-8 px-2.5 rounded-[8px] border border-line bg-canvas text-[12px] shrink-0"
          onClick={() => copyText(absPath)}
        >
          Copy path
        </button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto bg-canvas">
        {loading && (
          <div className="p-6 text-center mono text-[12.5px] text-ink-muted">
            loading…
          </div>
        )}
        {error && !loading && (
          <div className="p-6 text-center mono text-[12.5px] text-danger">
            {error}
          </div>
        )}
        {fileData && !loading && !error && (
          <div className="mono text-[12.5px] leading-[1.7] px-4 py-3">
            {fileData.content.split("\n").map((line, i) => (
              <div key={i} className="grid grid-cols-[40px_1fr] gap-1">
                <span className="text-right pr-2 text-ink-faint select-none">
                  {i + 1}
                </span>
                <span className="whitespace-pre-wrap break-all [overflow-wrap:anywhere]">
                  {line || " "}
                </span>
              </div>
            ))}
            {fileData.truncated && (
              <div className="grid grid-cols-[40px_1fr] gap-1 mt-2">
                <span className="text-right pr-2 text-ink-faint select-none">
                  …
                </span>
                <span className="text-ink-faint">file truncated at 1 MB</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- desktop view ----------------------------------------------------------

function DesktopFilesView(p: FilesViewProps) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-[300px_minmax(0,1fr)_240px] overflow-hidden">
      {/* Left: listing */}
      <aside className="border-r border-line bg-paper/40 flex flex-col overflow-hidden">
        <div className="px-3 py-2.5 border-b border-line shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="w-3.5 h-3.5 text-klein shrink-0" />
            <Breadcrumb
              path={p.currentPath ?? ""}
              onNavigate={p.onNavigate}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0 overflow-x-auto">
              <Toolbar
                onHome={p.onHome}
                onRoot={p.onRoot}
                onUp={p.onUp}
                canUp={!!p.browse?.parent}
                compact
              />
            </div>
            <HiddenToggle
              showHidden={p.showHidden}
              onToggle={p.onToggleHidden}
              hiddenCount={p.hiddenCount}
              compact
            />
          </div>
          <div className="flex items-center gap-1.5">
            <ProjectJumpSelect
              projects={p.projects}
              onGoToProject={p.onGoToProject}
              compact
            />
            <div className="flex-1 flex items-center gap-2 h-7 px-2.5 bg-canvas border border-line rounded-[6px]">
              <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
              <input
                type="text"
                placeholder="Filter…"
                value={p.searchQuery}
                onChange={(e) => p.onSearchChange(e.target.value)}
                className="flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-muted"
              />
              {p.searchQuery && (
                <button
                  type="button"
                  onClick={() => p.onSearchChange("")}
                  className="text-ink-muted"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {p.listLoading && (
            <div className="px-3 py-2 text-[12px] text-ink-muted mono">loading…</div>
          )}
          {p.listError && !p.listLoading && (
            <div className="px-3 py-2 text-[12px] text-danger mono">
              {errorMessage(p.listError)}
            </div>
          )}
          {!p.listLoading && !p.listError && p.visibleEntries.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-ink-muted text-center">
              {p.browse?.entries.length === 0
                ? "This folder is empty."
                : p.searchQuery
                ? `Nothing matches “${p.searchQuery}”.`
                : "No visible entries."}
            </div>
          )}
          {!p.listLoading &&
            p.visibleEntries.map((e) => (
              <EntryRow
                key={e.path}
                entry={e}
                active={p.selectedFilePath === e.path}
                onClick={() =>
                  e.isDir ? p.onNavigate(e.path) : p.onOpenFile(e.path)
                }
                variant="desktop"
              />
            ))}
        </div>
      </aside>

      {/* Middle: preview */}
      <section className="min-w-0 flex flex-col overflow-hidden border-r border-line">
        {p.fileData || p.fileLoading || p.fileError ? (
          <>
            <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
              <FileIcon className="w-3.5 h-3.5 text-ink-faint shrink-0" />
              <div className="min-w-0 flex-1">
                <div
                  className="mono text-[13px] truncate"
                  title={p.selectedFilePath ?? ""}
                >
                  {p.selectedFilePath ?? "…"}
                </div>
                {p.fileData && (
                  <div className="mono text-[11px] text-ink-muted truncate">
                    {p.fileData.lines} lines · {formatSize(p.fileData.sizeBytes)}
                    {p.fileData.mtimeMs
                      ? ` · modified ${formatRelTime(p.fileData.mtimeMs)}`
                      : ""}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="h-8 px-3 rounded-[8px] border border-line bg-canvas text-[12px] disabled:opacity-50"
                disabled={!p.selectedFilePath}
                onClick={() =>
                  p.selectedFilePath && copyText(p.selectedFilePath)
                }
              >
                Copy path
              </button>
            </div>
            <PreviewPanel
              fileData={p.fileData}
              loading={p.fileLoading}
              error={p.fileError}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center px-8">
            <p className="text-[13px] text-ink-muted">
              Select a file to preview its contents.
            </p>
          </div>
        )}
      </section>

      {/* Right: meta */}
      <aside className="border-l border-line bg-paper/40 flex flex-col overflow-y-auto">
        <div className="px-4 py-3 border-b border-line caps text-ink-muted shrink-0">
          File
        </div>
        {p.fileData ? (
          <div className="px-4 py-3 text-[12.5px] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">Size</span>
              <span className="mono">{formatSize(p.fileData.sizeBytes)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">Lines</span>
              <span className="mono">{p.fileData.lines}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">Modified</span>
              <span className="mono">{formatRelTime(p.fileData.mtimeMs)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-ink-muted">Mode</span>
              <span className="mono">{p.fileData.mode}</span>
            </div>
          </div>
        ) : (
          <div className="px-4 py-3 text-[12px] text-ink-faint">
            No file selected.
          </div>
        )}
        <div className="mt-auto mx-3 my-3">
          <div className="p-3 rounded-[8px] bg-canvas border border-line text-[12px] text-ink-muted leading-[1.5]">
            Files is read-only. claudex shows what's on disk — it doesn't
            write. Use the Chat to have claude edit the file.
          </div>
        </div>
      </aside>
    </div>
  );
}
