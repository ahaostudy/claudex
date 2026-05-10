import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  Search,
  X,
} from "lucide-react";
import type {
  Project,
  FilesTreeEntry,
  FilesReadResponse,
  FilesStatusResponse,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Files browser (mockup s-14). Read-only project file viewer.
//
// Mobile: project chip + breadcrumb + tree list (one level at a time). Tap
//   a folder to drill in; tap a file to show a preview strip below.
// Desktop: 3-col grid [260px | 1fr | 240px] — tree | preview | meta. Follows
//   the mockup layout; "Files is read-only" hint sits in the meta panel
//   footer so users know claudex won't write here.
//
// Non-goals for this cut:
//   - Editing (read-only only)
//   - Full-text search across files (we only filter the loaded tree)
//   - Syntax highlighting (plain <pre> with line numbers; fine for now)
// ---------------------------------------------------------------------------

// ---- small helpers ---------------------------------------------------------

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

function gitBadge(status: "M" | "A" | "D" | "R" | null) {
  if (!status) return null;
  const colors: Record<string, string> = {
    M: "bg-warn/15 text-[#7a4700]",
    A: "bg-success/15 text-success",
    D: "bg-danger/15 text-danger",
    R: "bg-klein/15 text-klein",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center px-1 rounded-[3px] text-[9px] font-medium uppercase tracking-[0.1em] shrink-0",
        colors[status] ?? "bg-warn/15 text-[#7a4700]",
      )}
    >
      {status}
    </span>
  );
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

// ---- tree node model --------------------------------------------------------

interface TreeNode {
  entry: FilesTreeEntry;
  depth: number;
  expanded: boolean;
}

// ---- screen ----------------------------------------------------------------

export function FilesScreen() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<FilesReadResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<FilesStatusResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (cancelled) return;
        setProjects(r.projects);
        if (r.projects.length > 0 && !selectedProjectId) {
          setSelectedProjectId(r.projects[0].id);
        }
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
    // intentionally only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRoot = useCallback(async (projectId: string) => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const res = await api.filesTree(projectId, "");
      const nodes: TreeNode[] = res.entries.map((e) => ({
        entry: e,
        depth: 0,
        expanded: false,
      }));
      setTreeNodes(nodes);
    } catch (e) {
      setTreeError(e instanceof ApiError ? e.code : "load_failed");
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    setTreeNodes([]);
    setSelectedRelPath(null);
    setFileData(null);
    setFileError(null);
    setSearchQuery("");
    void loadRoot(selectedProjectId);
    api.filesStatus(selectedProjectId).then(setGitStatus).catch(() => {});
  }, [selectedProjectId, loadRoot]);

  /** Toggle a folder node's expand state. On expand, fetch the folder's
   *  immediate children and splice them in right after the parent row, so
   *  the flat list reads like an indented tree. On collapse, remove every
   *  row with depth > parent.depth that comes after the parent until we
   *  hit a row of equal or shallower depth. */
  const toggleFolder = useCallback(
    async (idx: number) => {
      if (!selectedProjectId) return;
      const node = treeNodes[idx];
      if (!node) return;
      if (node.expanded) {
        setTreeNodes((prev) => {
          const next = [...prev];
          next[idx] = { ...node, expanded: false };
          let i = idx + 1;
          while (i < next.length && next[i].depth > node.depth) {
            next.splice(i, 1);
          }
          return next;
        });
        return;
      }
      try {
        const res = await api.filesTree(selectedProjectId, node.entry.relPath);
        const children: TreeNode[] = res.entries.map((e) => ({
          entry: e,
          depth: node.depth + 1,
          expanded: false,
        }));
        setTreeNodes((prev) => {
          const next = [...prev];
          next[idx] = { ...node, expanded: true };
          next.splice(idx + 1, 0, ...children);
          return next;
        });
      } catch {
        /* silently fail the expand */
      }
    },
    [selectedProjectId, treeNodes],
  );

  const openFile = useCallback(
    async (relPath: string) => {
      if (!selectedProjectId) return;
      setSelectedRelPath(relPath);
      setFileLoading(true);
      setFileError(null);
      try {
        const res = await api.filesRead(selectedProjectId, relPath);
        setFileData(res);
      } catch (e) {
        setFileError(
          e instanceof ApiError && e.code === "binary_file"
            ? "Binary file — no preview available"
            : e instanceof ApiError
              ? e.code
              : "load_failed",
        );
        setFileData(null);
      } finally {
        setFileLoading(false);
      }
    },
    [selectedProjectId],
  );

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const visibleNodes = searchQuery.trim()
    ? treeNodes.filter((n) =>
        n.entry.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : treeNodes;

  return (
    <AppShell tab="files">
      {/* Mobile */}
      <div className="flex-1 min-h-0 flex flex-col md:hidden overflow-hidden">
        <MobileFilesView
          projects={projects}
          selectedProject={selectedProject}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
          selectedRelPath={selectedRelPath}
          gitStatus={gitStatus}
          treeNodes={visibleNodes}
          treeLoading={treeLoading}
          treeError={treeError}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onToggleFolder={toggleFolder}
          onOpenFile={openFile}
          fileData={fileData}
          fileLoading={fileLoading}
          fileError={fileError}
        />
      </div>
      {/* Desktop */}
      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">
        <DesktopFilesView
          projects={projects}
          selectedProject={selectedProject}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
          selectedRelPath={selectedRelPath}
          gitStatus={gitStatus}
          treeNodes={visibleNodes}
          treeLoading={treeLoading}
          treeError={treeError}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onToggleFolder={toggleFolder}
          onOpenFile={openFile}
          fileData={fileData}
          fileLoading={fileLoading}
          fileError={fileError}
        />
      </div>
    </AppShell>
  );
}

// ---- tree row (shared between mobile + desktop) ----------------------------

interface TreeRowProps {
  entry: FilesTreeEntry;
  indent: number;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
  variant: "mobile" | "desktop";
}

function TreeRow({
  entry,
  indent,
  active,
  expanded,
  onClick,
  variant,
}: TreeRowProps) {
  const isMobile = variant === "mobile";
  const basePad = isMobile ? 16 : 12;
  const perLevel = isMobile ? 20 : 16;
  const paddingLeft = basePad + indent * perLevel;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-1.5 pr-3 text-left border-l-2",
        isMobile ? "py-2 text-[14px]" : "py-1 text-[13px]",
        active
          ? "bg-klein-wash/50 border-l-klein"
          : "hover:bg-canvas/60 border-l-transparent",
      )}
      style={{ paddingLeft }}
    >
      {entry.isDir ? (
        <>
          {expanded ? (
            <ChevronDown
              className={cn(
                "shrink-0 text-ink-muted",
                isMobile ? "w-3.5 h-3.5" : "w-3 h-3",
              )}
            />
          ) : (
            <ChevronRight
              className={cn(
                "shrink-0 text-ink-muted",
                isMobile ? "w-3.5 h-3.5" : "w-3 h-3",
              )}
            />
          )}
          <Folder
            className={cn(
              "shrink-0 text-klein",
              isMobile ? "w-4 h-4" : "w-3.5 h-3.5",
            )}
          />
        </>
      ) : (
        <>
          <span className={cn("shrink-0", isMobile ? "w-3.5 h-3.5" : "w-3 h-3")} />
          <FileIcon
            className={cn(
              "shrink-0 text-ink-faint",
              isMobile ? "w-4 h-4" : "w-3.5 h-3.5",
            )}
          />
        </>
      )}
      <span
        className={cn(
          "mono flex-1 truncate",
          active ? "text-ink" : entry.isHidden ? "text-ink-faint" : "text-ink-soft",
        )}
      >
        {entry.name}
      </span>
      {gitBadge(entry.gitStatus)}
      {entry.additions !== null && entry.additions > 0 && (
        <span className="mono text-[10px] text-success">+{entry.additions}</span>
      )}
      {entry.deletions !== null && entry.deletions > 0 && (
        <span className="mono text-[10px] text-danger">−{entry.deletions}</span>
      )}
      {!entry.isDir &&
        entry.gitStatus === null &&
        entry.size !== undefined && (
          <span className="mono text-[10px] text-ink-faint">
            {formatSize(entry.size)}
          </span>
        )}
    </button>
  );
}

// ---- preview panel with line numbers ---------------------------------------

function PreviewPanel({
  fileData,
  loading,
  error,
}: {
  fileData: FilesReadResponse | null;
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
  projects: Project[];
  selectedProject: Project | null;
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  selectedRelPath: string | null;
  gitStatus: FilesStatusResponse | null;
  treeNodes: TreeNode[];
  treeLoading: boolean;
  treeError: string | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onToggleFolder: (idx: number) => void;
  onOpenFile: (relPath: string) => void;
  fileData: FilesReadResponse | null;
  fileLoading: boolean;
  fileError: string | null;
}

function MobileFilesView(p: FilesViewProps) {
  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="px-4 pt-3 pb-3 bg-canvas/95 backdrop-blur border-b border-line shrink-0">
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={p.selectedProjectId ?? ""}
              onChange={(e) => p.onSelectProject(e.target.value)}
              className="appearance-none h-9 pl-2.5 pr-6 rounded-[8px] bg-paper border border-line mono text-[12px] cursor-pointer"
            >
              {p.projects.length === 0 && <option value="">No projects</option>}
              {p.projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
              <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
            </span>
          </div>
          <div className="flex-1 flex items-center gap-2 h-9 px-3 bg-paper border border-line rounded-[8px]">
            <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <input
              type="text"
              placeholder="Find file by name…"
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
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {p.gitStatus && p.gitStatus.isGitRepo && (
          <div className="px-4 py-2.5 bg-paper/60 flex items-center gap-2 text-[11px] border-b border-line/60">
            <span className="caps text-ink-muted">working tree</span>
            <span className="mono text-ink-soft">
              <span className="text-success">+{p.gitStatus.totalAdditions}</span>{" "}
              <span className="text-danger">−{p.gitStatus.totalDeletions}</span>
            </span>
            <span className="ml-auto mono text-ink-muted">
              {p.gitStatus.changedCount} changed
            </span>
          </div>
        )}
        {p.treeLoading && (
          <div className="px-4 py-4 text-[13px] text-ink-muted mono">loading…</div>
        )}
        {p.treeError && (
          <div className="px-4 py-4 text-[13px] text-danger mono">{p.treeError}</div>
        )}
        {!p.treeLoading && p.treeNodes.length === 0 && !p.searchQuery && (
          <div className="px-4 py-4 text-[13px] text-ink-muted">
            {p.projects.length === 0 ? "No projects added yet." : "Empty directory."}
          </div>
        )}
        {!p.treeLoading &&
          p.treeNodes.map((node, idx) => (
            <TreeRow
              key={`${node.entry.relPath}::${idx}`}
              entry={node.entry}
              indent={node.depth}
              active={p.selectedRelPath === node.entry.relPath}
              expanded={node.expanded}
              onClick={() =>
                node.entry.isDir
                  ? void p.onToggleFolder(idx)
                  : void p.onOpenFile(node.entry.relPath)
              }
              variant="mobile"
            />
          ))}

        {(p.fileData || p.fileLoading || p.fileError) && (
          <MobilePreviewStrip
            fileData={p.fileData}
            loading={p.fileLoading}
            error={p.fileError}
          />
        )}
      </div>
    </div>
  );
}

function MobilePreviewStrip({
  fileData,
  loading,
  error,
}: {
  fileData: FilesReadResponse | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <div className="mx-3 my-4 border border-line rounded-[10px] overflow-hidden bg-paper/40">
      <div className="flex items-center gap-2 px-3 py-2 bg-canvas border-b border-line">
        <FileIcon className="w-3.5 h-3.5 text-ink-faint shrink-0" />
        <span className="mono text-[12px] truncate flex-1">
          {fileData?.relPath ?? "…"}
        </span>
        {fileData && (
          <span className="mono text-[11px] text-ink-muted shrink-0">
            {fileData.lines} lines
          </span>
        )}
      </div>
      {loading && (
        <div className="p-3 mono text-[11.5px] text-ink-muted">loading…</div>
      )}
      {error && <div className="p-3 mono text-[11.5px] text-danger">{error}</div>}
      {fileData && !loading && !error && (
        <div className="mono text-[11.5px] leading-[1.6] p-3 max-h-64 overflow-auto">
          {fileData.content
            .split("\n")
            .slice(0, 80)
            .map((line, i) => (
              <div key={i} className="grid grid-cols-[28px_1fr] gap-1">
                <span className="text-right text-ink-faint select-none">
                  {i + 1}
                </span>
                <span className="whitespace-pre">{line}</span>
              </div>
            ))}
          {fileData.content.split("\n").length > 80 && (
            <div className="mt-2 text-ink-faint text-[11px]">
              …{fileData.lines - 80} more lines
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-line bg-canvas">
        <button
          type="button"
          className="h-7 px-2.5 rounded-[6px] border border-line text-[12px] disabled:opacity-50"
          disabled={!fileData}
          onClick={() => fileData && copyText(fileData.relPath)}
        >
          Copy path
        </button>
        {fileData?.gitStatus && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-ink-muted">
            {gitBadge(fileData.gitStatus)}
            {fileData.additions !== null && fileData.additions > 0 && (
              <span className="mono text-success">+{fileData.additions}</span>
            )}
            {fileData.deletions !== null && fileData.deletions > 0 && (
              <span className="mono text-danger">−{fileData.deletions}</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// ---- desktop view ----------------------------------------------------------

function DesktopFilesView(p: FilesViewProps) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-[260px_minmax(0,1fr)_240px] overflow-hidden">
      {/* Left: tree */}
      <aside className="border-r border-line bg-paper/40 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-line flex items-center gap-2 shrink-0">
          <span className="h-1.5 w-1.5 rounded-full bg-klein shrink-0" />
          <select
            value={p.selectedProjectId ?? ""}
            onChange={(e) => p.onSelectProject(e.target.value)}
            className="flex-1 bg-transparent mono text-[12px] outline-none cursor-pointer truncate"
          >
            {p.projects.length === 0 && <option value="">No projects</option>}
            {p.projects.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.name}
              </option>
            ))}
          </select>
          {p.gitStatus?.branch && (
            <span className="mono text-[11px] text-ink-muted shrink-0">
              {p.gitStatus.branch}
            </span>
          )}
        </div>
        <div className="px-3 py-2 border-b border-line shrink-0">
          <div className="flex items-center gap-2 h-8 px-2.5 bg-canvas border border-line rounded-[6px]">
            <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
            <input
              type="text"
              placeholder="Find file…"
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
        <div className="flex-1 min-h-0 overflow-y-auto py-2 text-[13px]">
          {p.treeLoading && (
            <div className="px-3 py-2 text-[12px] text-ink-muted mono">loading…</div>
          )}
          {p.treeError && (
            <div className="px-3 py-2 text-[12px] text-danger mono">{p.treeError}</div>
          )}
          {!p.treeLoading &&
            p.treeNodes.map((node, idx) => (
              <TreeRow
                key={`${node.entry.relPath}::${idx}`}
                entry={node.entry}
                indent={node.depth}
                active={p.selectedRelPath === node.entry.relPath}
                expanded={node.expanded}
                onClick={() =>
                  node.entry.isDir
                    ? void p.onToggleFolder(idx)
                    : void p.onOpenFile(node.entry.relPath)
                }
                variant="desktop"
              />
            ))}
        </div>
        <div className="px-4 py-2 border-t border-line flex items-center gap-2 text-[11px] text-ink-muted shrink-0">
          {p.gitStatus && p.gitStatus.isGitRepo ? (
            <>
              <span className="mono">
                <span className="text-success">+{p.gitStatus.totalAdditions}</span>{" "}
                <span className="text-danger">−{p.gitStatus.totalDeletions}</span>
              </span>
              <span className="ml-auto mono">
                {p.gitStatus.changedCount} changed
              </span>
            </>
          ) : (
            <span className="text-ink-faint">
              {p.selectedProject ? "No git repo" : "Select a project"}
            </span>
          )}
        </div>
      </aside>

      {/* Middle: preview */}
      <section className="min-w-0 flex flex-col overflow-hidden border-r border-line">
        {p.fileData || p.fileLoading || p.fileError ? (
          <>
            <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
              <FileIcon className="w-3.5 h-3.5 text-ink-faint shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mono text-[13px] truncate">
                  {p.fileData?.relPath ?? "…"}
                </div>
                {p.fileData && (
                  <div className="mono text-[11px] text-ink-muted truncate">
                    {p.fileData.additions !== null && p.fileData.additions > 0 && (
                      <>
                        <span className="text-success">+{p.fileData.additions}</span>{" "}
                      </>
                    )}
                    {p.fileData.deletions !== null &&
                      p.fileData.deletions > 0 && (
                        <>
                          <span className="text-danger">
                            −{p.fileData.deletions}
                          </span>
                          {" · "}
                        </>
                      )}
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
                disabled={!p.fileData}
                onClick={() => p.fileData && copyText(p.fileData.relPath)}
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
            {p.fileData.gitStatus && (
              <div className="flex items-center justify-between">
                <span className="text-ink-muted">Status</span>
                {gitBadge(p.fileData.gitStatus)}
              </div>
            )}
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
