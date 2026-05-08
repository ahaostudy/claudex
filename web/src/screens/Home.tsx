import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, GitBranch, Pencil, Trash2, FolderOpen, Settings2, X, Download, Search } from "lucide-react";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { api, ApiError } from "@/api/client";
import type { Project, Session, ModelId, PermissionMode } from "@claudex/shared";
import { FolderPicker } from "@/components/FolderPicker";
import { AppShell } from "@/components/AppShell";
import { ImportSessionsSheet } from "@/components/ImportSessionsSheet";
import { cn } from "@/lib/cn";

// Status dot colors for the flat row layout. `running` and `awaiting` get a
// soft glow ring (box-shadow) to match the mockup (s-02 lines 513, 533).
const STATUS_DOT: Record<string, string> = {
  running: "bg-success",
  awaiting: "bg-warn",
  idle: "bg-ink-faint",
  archived: "bg-line-strong",
  error: "bg-danger",
};
const DOT_GLOW: Record<string, string> = {
  running: "0 0 0 4px rgba(63,145,66,0.18)",
  awaiting: "0 0 0 4px rgba(217,119,6,0.18)",
  idle: "",
  archived: "",
  error: "0 0 0 4px rgba(185,28,28,0.18)",
};

// Compact label for model ids shown in the row meta line.
function shortModel(id: string): string {
  if (id === "claude-opus-4-7") return "opus-4.7";
  if (id === "claude-sonnet-4-6") return "sonnet-4.6";
  if (id === "claude-haiku-4-5") return "haiku-4.5";
  return id;
}

// ---------------------------------------------------------------------------
// Filter chip rail (mockup s-02 lines 492–500).
//
// Six chips that slice the session list. Active chip pill-fills with ink;
// inactive chips are canvas w/ a subtle border. Counts and status dots
// (running = green, awaiting = warn) render inline so the rail surfaces
// "what needs you" at a glance.
//
// State lives in the URL (`?filter=running`) so back/forward Just Works and
// links to a filtered view are shareable. Clicking the active chip clears
// the filter by removing the param.
//
// Caveats worth calling out:
//   - "Scheduled" is visually present but greyed: the session model doesn't
//     carry a `nextRunAt` link to routines today, so we have nothing to
//     filter by. It'll light up the day we wire routines→sessions.
//   - "Mine" is a no-op on a single-user install. Rendered at 60% opacity
//     so it's visible (preserves the mockup's chip set) without lying.
//   - "Archived" swaps the data source to `listSessions({archived:true})` —
//     see `archivedSessions` state. The default source excludes archived.
// ---------------------------------------------------------------------------

type FilterId =
  | "all"
  | "running"
  | "awaiting"
  | "scheduled"
  | "mine"
  | "archived";

function chipMatches(s: Session, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      // Default view is non-archived; archived rows are fetched separately
      // and only surfaced via the "archived" chip.
      return s.status !== "archived";
    case "running":
      return s.status === "running";
    case "awaiting":
      return s.status === "awaiting";
    case "scheduled":
      // No session<->routine link exists yet. Render the chip but match
      // nothing so the list empties to the "no matches" message.
      return false;
    case "mine":
      // Single-user: every session is "mine". Acts as a no-op / identity
      // filter and lets the chip appear without deceiving.
      return s.status !== "archived";
    case "archived":
      // `archivedSessions` is the source set here, so everything already
      // passes; kept explicit for symmetry.
      return s.status === "archived";
  }
}

export function HomeScreen() {
  const { user } = useAuth();
  const {
    init,
    sessions,
    refreshSessions,
    loadingSessions,
    connected,
    wsDiag,
  } = useSessions();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeProjectId = searchParams.get("project");
  const activeFilter = (searchParams.get("filter") ?? "all") as FilterId;
  const [showNew, setShowNew] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showWsDiag, setShowWsDiag] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Cmd+K / Ctrl+K focuses the desktop search input from anywhere on the
  // page. preventDefault so the browser's own "search bookmarks" binding
  // doesn't fight us. Works even when another input is focused — users
  // expect to jump into search without first clicking out of the composer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    init();
    refreshSessions();
  }, [init, refreshSessions]);

  // Archived-chip data: fetched on demand so the default list call can stay
  // cheap. We keep this separate from the global sessions store because
  // archived rows don't get live WS updates anyway (they're read-only) and
  // merging them into the store would confuse every other screen.
  useEffect(() => {
    if (activeFilter !== "archived") return;
    let cancelled = false;
    api
      .listSessions({ archived: true })
      .then((r) => {
        if (cancelled) return;
        // The server returns archived + live in one list when archived=1;
        // narrow to archived so the chip's filter is honest.
        setArchivedSessions(r.sessions.filter((s) => s.status === "archived"));
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [activeFilter]);

  // Projects list is its own fetch — sessions carry projectId but no name,
  // and we want the group header to show the project's display name even if
  // there are no sessions yet under it (though empty groups are hidden).
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

  // Build ordered groups: bucket sessions by projectId, drop empty buckets,
  // sort sessions inside each bucket newest-first, sort groups by their
  // newest session's timestamp. Wrapped in useMemo so the layout is stable
  // across renders caused by WS status ticks.
  // The source set depends on the active filter chip. "Archived" switches
  // to the separately-fetched archived list; everything else uses the live
  // sessions store (which already excludes archived). "All" is the default.
  const sourceSessions =
    activeFilter === "archived" ? archivedSessions : sessions;
  const groups = useMemo(() => {
    const byProject = new Map<string, Session[]>();
    const projectLookup = new Map(projects.map((p) => [p.id, p] as const));
    const q = searchQuery.trim().toLowerCase();
    for (const s of sourceSessions) {
      // Hide side-chat children from the Home list. They appear inline in
      // their parent chat's side drawer, not as top-level rows.
      if (s.parentSessionId) continue;
      if (!chipMatches(s, activeFilter)) continue;
      if (q) {
        // Substring match across title / project name / branch. Placeholder
        // copy says "files" too, but we don't index file content — keep the
        // copy aspirational and the matcher honest (title/project/branch only).
        const project = projectLookup.get(s.projectId);
        const haystack = [
          s.title ?? "",
          project?.name ?? "",
          s.branch ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      const list = byProject.get(s.projectId);
      if (list) list.push(s);
      else byProject.set(s.projectId, [s]);
    }
    const sortKey = (s: Session) =>
      Date.parse(s.lastMessageAt ?? s.updatedAt) || 0;
    const out: Array<{ project: Project | null; projectId: string; sessions: Session[] }> = [];
    for (const [projectId, list] of byProject) {
      list.sort((a, b) => sortKey(b) - sortKey(a));
      out.push({
        project: projectLookup.get(projectId) ?? null,
        projectId,
        sessions: list,
      });
    }
    out.sort(
      (a, b) => sortKey(b.sessions[0]) - sortKey(a.sessions[0]),
    );
    return out;
  }, [sourceSessions, projects, activeFilter, searchQuery]);

  const filteredGroups = useMemo(() => {
    if (!activeProjectId) return groups;
    return groups.filter((g) => g.projectId === activeProjectId);
  }, [groups, activeProjectId]);

  const activeProject = activeProjectId
    ? projects.find((p) => p.id === activeProjectId) ?? null
    : null;

  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("project");
    setSearchParams(next, { replace: true });
  };

  const visibleSessionCount = filteredGroups.reduce(
    (n, g) => n + g.sessions.length,
    0,
  );

  // Counts surfaced on the filter chips. Running / awaiting come from the
  // live list (archived rows can't be in either state). "All" is the
  // non-archived top-level count — the same set "All" would show when
  // clicked, minus any project filter which is orthogonal.
  const filterCounts = useMemo(() => {
    let all = 0;
    let running = 0;
    let awaiting = 0;
    for (const s of sessions) {
      if (s.parentSessionId) continue;
      if (s.status === "archived") continue;
      all += 1;
      if (s.status === "running") running += 1;
      else if (s.status === "awaiting") awaiting += 1;
    }
    return { all, running, awaiting };
  }, [sessions]);

  return (
    <AppShell tab="sessions">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Sessions</div>
          <h1 className="display text-[1.25rem] leading-tight mt-0.5">
            {activeProject ? activeProject.name : "All projects"}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => setShowWsDiag((v) => !v)}
          title="WebSocket diagnostics"
          className={`inline-flex items-center gap-1.5 ml-1 px-1.5 py-0.5 rounded-[4px] border border-line bg-paper text-[10px] uppercase tracking-[0.1em] ${
            connected ? "text-success" : "text-ink-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected
                ? "bg-success animate-pulse"
                : wsDiag.phase === "connecting" || wsDiag.phase === "open"
                  ? "bg-warn"
                  : "bg-danger"
            }`}
          />
          {connected ? "live" : wsDiag.phase}
        </button>
        <span className="hidden md:inline text-[12px] text-ink-muted ml-2">
          signed in as <span className="mono">{user?.username}</span>
        </span>
        {/* Desktop-only search (mockup s-02 lines 480-490). Mobile header is
            too narrow to fit a usable input so it stays as-is. Cmd/Ctrl+K
            jumps focus here from anywhere. */}
        <div className="hidden md:flex flex-1 max-w-md mx-auto items-center gap-2 h-9 px-3 bg-paper border border-line rounded-[8px]">
          <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sessions, projects, files…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-ink placeholder:text-ink-muted"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
              title="Clear search"
              className="shrink-0 h-4 w-4 rounded-full flex items-center justify-center text-ink-muted hover:text-ink hover:bg-line/60"
            >
              <X className="w-3 h-3" />
            </button>
          ) : (
            <span className="ml-auto text-[11px] text-ink-faint mono shrink-0">⌘K</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            title="Import existing CLI sessions"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper"
          >
            <Download className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowProjects(true)}
            title="Manage projects"
            className="h-8 w-8 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper"
          >
            <Settings2 className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">New session</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        <FilterChipRail
          active={activeFilter}
          counts={filterCounts}
          onPick={(id) => {
            const next = new URLSearchParams(searchParams);
            if (id === "all" || id === activeFilter) next.delete("filter");
            else next.set("filter", id);
            setSearchParams(next, { replace: true });
          }}
        />
        <div className="px-4 md:px-6 py-3 flex items-center gap-3">
          <span className="mono text-[11px] text-ink-muted">
            {loadingSessions
              ? "loading…"
              : activeProjectId
                ? `${visibleSessionCount} in this project · ${sessions.length} total`
                : `${sessions.length} total`}
          </span>
          {activeProjectId && (
            <button
              type="button"
              onClick={clearFilter}
              className="inline-flex items-center gap-1 px-2 h-6 rounded-full border border-line bg-paper text-[11px] text-ink-soft hover:bg-canvas"
            >
              <X className="w-3 h-3" />
              clear filter
            </button>
          )}
        </div>

        {sessions.length === 0 && !loadingSessions ? (
          <div className="px-4 md:px-6 pb-6">
            <EmptyState onNew={() => setShowNew(true)} />
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="px-4 md:px-6 pb-6 text-[13px] text-ink-muted">
            {searchQuery.trim()
              ? `No matches for "${searchQuery.trim()}". Try a different filter chip or clear the search.`
              : activeFilter === "all"
                ? "No sessions in this project yet."
                : activeFilter === "scheduled"
                  ? "No scheduled sessions yet — set up a routine and it'll surface here once routines link to sessions."
                  : activeFilter === "archived"
                    ? "No archived sessions."
                    : `No ${activeFilter} sessions right now.`}
          </div>
        ) : (
          <div className="pb-6">
            {filteredGroups.map((g) => (
              <ProjectGroup
                key={g.projectId}
                project={g.project}
                projectId={g.projectId}
                sessions={g.sessions}
              />
            ))}
          </div>
        )}
      </section>

      {showNew && (
        <NewSessionSheet
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            navigate(`/session/${id}`);
          }}
        />
      )}
      {showProjects && (
        <ProjectsSheet onClose={() => setShowProjects(false)} />
      )}
      {showImport && (
        <ImportSessionsSheet
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            refreshSessions();
          }}
        />
      )}
      {showWsDiag && (
        <WsDiagPanel diag={wsDiag} onClose={() => setShowWsDiag(false)} />
      )}
    </AppShell>
  );
}

function ProjectGroup({
  project,
  projectId,
  sessions,
}: {
  project: Project | null;
  projectId: string;
  sessions: Session[];
}) {
  // Each group is its own block so its header `sticky top-0` is scoped to
  // the group's vertical run — when you scroll past, the next project's
  // header takes over. The parent `<section>` is the scroll container.
  const displayName = project?.name ?? projectId.slice(0, 8);
  const path = project?.path ?? "";
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 md:px-6 py-2 bg-paper/80 backdrop-blur border-b border-line">
        <span className="display text-[15px] md:text-[16px]">{displayName}</span>
        {path && (
          <span className="mono text-[11px] text-ink-muted truncate hidden sm:inline">
            {path}
          </span>
        )}
        <span className="ml-auto mono text-[11px] text-ink-muted shrink-0">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul>
        {sessions.map((s) => (
          <li key={s.id}>
            <SessionRow session={s} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Status pill text + style mapping. Mirrors the mockup (s-02 lines 523, 537,
// 555, 566, 584). `awaiting` keeps the quoted `#7a4700` color from the mockup.
function statusPillClass(status: string): string {
  switch (status) {
    case "running":
      return "border border-success/30 bg-success-wash text-[#1f5f21]";
    case "awaiting":
      return "border border-warn/30 bg-warn-wash text-[#7a4700]";
    case "error":
      return "border border-danger/30 bg-danger-wash text-danger";
    case "archived":
    case "idle":
    default:
      return "border border-line bg-paper text-ink-muted";
  }
}
function statusPillLabel(status: string): string {
  if (status === "awaiting") return "NEEDS YOU";
  return status.toUpperCase();
}

function SessionRow({ session: s }: { session: Session }) {
  const href = `/session/${s.id}`;
  const archived = s.status === "archived";
  const dotTone = STATUS_DOT[s.status] ?? "bg-ink-faint";
  const dotGlow = DOT_GLOW[s.status] ?? "";
  const rel = formatRel(s.lastMessageAt ?? s.updatedAt);
  const branch = s.branch ?? "main";
  const { linesAdded, linesRemoved, filesChanged, contextPct } = s.stats;
  const hasDiffs = linesAdded > 0 || linesRemoved > 0 || filesChanged > 0;
  // Progress ring geometry: r=9 → circumference ≈ 56.55. Dash offset
  // encodes remaining context. `running` shows an animated dot in place
  // of a ring (mockup s-02 line 533 uses animate-pulse on the dot; here
  // we keep the ring + pulse on the dot for visual consistency).
  const CIRC = 56.55;
  const pct = Math.max(0, Math.min(1, contextPct || 0));
  const dashoffset = CIRC * (1 - pct);
  const showRing = !archived && pct > 0;

  return (
    <Link
      to={href}
      className={cn(
        "block border-b border-line hover:bg-paper/40 cursor-pointer",
        archived && "opacity-75",
      )}
    >
      {/* Mobile stacked layout */}
      <div className="md:hidden px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn("h-2 w-2 rounded-full shrink-0", dotTone, s.status === "running" && "animate-pulse")}
            style={dotGlow ? { boxShadow: dotGlow } : undefined}
          />
          <div className="text-[14px] font-medium truncate flex-1">
            {s.title || "Untitled"}
          </div>
          <span className="text-[11px] text-ink-muted shrink-0">{rel}</span>
        </div>
        {hasDiffs && (
          <div className="mono text-[12px] text-ink-muted truncate mt-0.5">
            <span className="text-success">+{linesAdded}</span>{" "}
            <span className="text-danger">−{linesRemoved}</span>{" "}
            <span>· {filesChanged}f</span>
          </div>
        )}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
          <span className="mono inline-flex items-center gap-1 truncate">
            <GitBranch className="w-3 h-3 shrink-0" />
            {branch}
          </span>
          <span>·</span>
          <span className="mono shrink-0">{shortModel(s.model)}</span>
          <span>·</span>
          <span className="shrink-0">{s.mode}</span>
        </div>
      </div>

      {/* Desktop grid row */}
      <div className="hidden md:block px-6 py-3">
        <div className="grid grid-cols-[22px_minmax(0,1fr)_220px_150px_110px_48px] gap-4 items-center">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              dotTone,
              s.status === "running" && "animate-pulse",
            )}
            style={dotGlow ? { boxShadow: dotGlow } : undefined}
          />
          <div className="min-w-0">
            <div className="text-[15px] font-medium truncate">
              {s.title || "Untitled"}
            </div>
          </div>
          <div className="mono text-[12px] text-ink-soft truncate flex items-center gap-1.5">
            <GitBranch className="w-3 h-3 text-ink-faint shrink-0" />
            <span className="truncate">{branch}</span>
          </div>
          <div className="mono text-[12px] text-ink-muted truncate">
            {hasDiffs ? (
              <>
                <span className="text-success">+{linesAdded}</span>{" "}
                <span className="text-danger">−{linesRemoved}</span>{" "}
                <span>· {filesChanged}f</span>
              </>
            ) : (
              <span className="text-ink-faint">no changes</span>
            )}
          </div>
          <div>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] text-[10px] font-medium uppercase tracking-[0.1em]",
                statusPillClass(s.status),
              )}
            >
              {(s.status === "running" || s.status === "awaiting") && (
                <span className={cn("h-1.5 w-1.5 rounded-full", dotTone)} />
              )}
              {statusPillLabel(s.status)}
            </span>
          </div>
          <div className="flex items-center justify-end">
            {showRing ? (
              <svg width="22" height="22">
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  fill="none"
                  stroke="#e8e4d8"
                  strokeWidth="2.5"
                />
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  fill="none"
                  stroke="#cc785c"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={CIRC.toString()}
                  strokeDashoffset={dashoffset.toString()}
                  transform="rotate(-90 11 11)"
                />
              </svg>
            ) : null}
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-ink-muted">
          <span className="mono">{shortModel(s.model)}</span>
          <span>·</span>
          <span>{s.mode}</span>
          <span>·</span>
          <span>{rel}</span>
        </div>
      </div>
    </Link>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-[12px] border border-dashed border-line-strong p-8 text-center">
      <div className="display text-[1.25rem] mb-2">No sessions yet.</div>
      <p className="text-[14px] text-ink-muted max-w-[42ch] mx-auto mb-5">
        Point claudex at a project folder on this host and start a session.
        The folder will be trusted — claudex asks claude to do things inside it.
      </p>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-1.5 h-10 px-4 rounded-[8px] bg-ink text-canvas text-[14px] font-medium"
      >
        Create your first session
      </button>
    </div>
  );
}

// Horizontal chip rail mirroring mockup s-02 (lines 492–500). Stays above
// the session list; scrolls horizontally on narrow viewports so the last
// chip ("Group by project") stays reachable without wrapping the row.
function FilterChipRail({
  active,
  counts,
  onPick,
}: {
  active: FilterId;
  counts: { all: number; running: number; awaiting: number };
  onPick: (id: FilterId) => void;
}) {
  // Chip set is fixed; we render it fully so the filter's affordance is
  // always visible. `disabled` chips use opacity + pointer-events:none so
  // they look present but don't mislead (Scheduled / Mine).
  const chips: Array<{
    id: FilterId;
    label: string;
    count?: number;
    dot?: "running" | "awaiting";
    disabled?: boolean;
    title?: string;
  }> = [
    { id: "all", label: "All", count: counts.all },
    { id: "running", label: "Running", dot: "running" },
    {
      id: "awaiting",
      label: "Needs approval",
      count: counts.awaiting || undefined,
      dot: "awaiting",
    },
    {
      id: "scheduled",
      label: "Scheduled",
      disabled: true,
      title: "Scheduled sessions surface here once routines link to sessions",
    },
    {
      id: "mine",
      label: "Mine",
      disabled: true,
      title: "Single-user install — every session is yours",
    },
    { id: "archived", label: "Archived" },
  ];

  return (
    <div className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-4 md:px-6 py-2">
      <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap -mx-1 px-1">
        {chips.map((c) => {
          const isActive = active === c.id;
          const base = cn(
            "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[12px] transition-colors shrink-0",
            isActive
              ? "bg-ink text-canvas border-ink"
              : "bg-canvas text-ink-soft border-line hover:bg-paper",
            c.disabled && "opacity-60 pointer-events-none",
          );
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              title={c.title}
              className={base}
              aria-pressed={isActive}
            >
              {c.dot === "running" && (
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    isActive ? "bg-canvas" : "bg-success",
                    !isActive && "animate-pulse",
                  )}
                />
              )}
              {c.dot === "awaiting" && (
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full shrink-0",
                    isActive ? "bg-canvas" : "bg-warn",
                  )}
                />
              )}
              <span>{c.label}</span>
              {typeof c.count === "number" && (
                <span
                  className={cn(
                    "mono text-[11px] -mr-0.5",
                    isActive ? "text-canvas/80" : "text-ink-muted",
                  )}
                >
                  {c.count}
                </span>
              )}
            </button>
          );
        })}
        <span className="ml-auto caps text-ink-muted hidden sm:inline pl-2 shrink-0">
          Group by project
        </span>
      </div>
    </div>
  );
}



function NewSessionSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const NEW_PROJECT = "__new__";
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string>(NEW_PROJECT);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState<ModelId>("claude-opus-4-7");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    api.listProjects().then((r) => {
      setProjects(r.projects);
      if (r.projects.length > 0) setSelected(r.projects[0].id);
    });
  }, []);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      let projectId: string;
      if (selected === NEW_PROJECT) {
        const trimmedPath = projectPath.trim();
        if (!trimmedPath) {
          setErr("Pick an absolute path for the new project.");
          setBusy(false);
          return;
        }
        const trimmedName =
          projectName.trim() ||
          trimmedPath.split("/").filter(Boolean).pop() ||
          "project";
        const p = await api.createProject({
          name: trimmedName,
          path: trimmedPath,
        });
        projectId = p.project.id;
        setProjects((prev) => [p.project, ...prev]);
      } else {
        projectId = selected;
      }
      const res = await api.createSession({
        projectId,
        title: title || "Untitled",
        model,
        mode,
        worktree: false,
      });
      onCreated(res.session.id);
    } catch (e: any) {
      setErr(e?.code ?? e?.message ?? "create failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5">
        <div className="flex items-center mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              New session
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              Tell claude where to work.
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Project
            </div>
            <div className="space-y-1.5">
              {projects.map((p) => (
                <label
                  key={p.id}
                  className={`flex items-center gap-3 px-3 py-2.5 border rounded-[8px] cursor-pointer ${
                    selected === p.id
                      ? "border-klein bg-klein-wash/30"
                      : "border-line"
                  }`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    checked={selected === p.id}
                    onChange={() => setSelected(p.id)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{p.name}</div>
                    <div className="mono text-[11px] text-ink-muted truncate">
                      {p.path}
                    </div>
                  </div>
                </label>
              ))}
              <label
                className={`block border rounded-[8px] cursor-pointer ${
                  selected === NEW_PROJECT
                    ? "border-klein bg-klein-wash/30"
                    : "border-dashed border-line-strong"
                }`}
              >
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <input
                    type="radio"
                    className="sr-only"
                    checked={selected === NEW_PROJECT}
                    onChange={() => setSelected(NEW_PROJECT)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">
                      {projects.length > 0 ? "+ Add a new project" : "Add your first project"}
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      Any directory on this machine you want claude to work in.
                    </div>
                  </div>
                </div>
                {selected === NEW_PROJECT && (
                  <div className="px-3 pb-3 pt-1 space-y-2">
                    <input
                      className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
                      placeholder="Name (e.g. spindle)"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                    <div className="flex items-stretch gap-2">
                      <input
                        className="flex-1 min-w-0 h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px] mono"
                        placeholder="/Users/you/code/spindle"
                        value={projectPath}
                        onChange={(e) => setProjectPath(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        className="h-10 px-3 rounded-[8px] border border-line bg-paper text-[12px] text-ink-soft hover:bg-canvas inline-flex items-center gap-1"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                        Browse
                      </button>
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      Must be an absolute path that already exists on the host.
                      {projectName.trim().length === 0 && projectPath.trim().length > 0 &&
                        " (Name defaults to the folder name.)"}
                    </div>
                  </div>
                )}
              </label>
            </div>
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Title (optional)
            </div>
            <input
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Fix hydration on /pricing"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: "claude-opus-4-7", label: "Opus 4.7" },
                { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
                { id: "claude-haiku-4-5", label: "Haiku 4.5" },
              ] as Array<{ id: ModelId; label: string }>
            ).map((m) => (
              <button
                key={m.id}
                onClick={() => setModel(m.id)}
                className={`h-10 rounded-[8px] text-[13px] font-medium border ${
                  model === m.id
                    ? "border-ink bg-canvas"
                    : "border-line bg-paper text-ink-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Permission mode
            </div>
            <div className="grid grid-cols-4 gap-1 p-1 bg-paper border border-line rounded-[8px]">
              {(
                [
                  ["default", "Ask"],
                  ["acceptEdits", "Accept"],
                  ["plan", "Plan"],
                  ["bypassPermissions", "Bypass"],
                ] as Array<[PermissionMode, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setMode(id)}
                  className={`h-9 rounded-[6px] text-[12px] font-medium ${
                    mode === id
                      ? "bg-canvas shadow-card border border-line text-ink"
                      : "text-ink-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {err && (
          <div className="mt-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}

        <button
          onClick={create}
          disabled={busy}
          className="mt-4 w-full h-12 rounded-[8px] bg-ink text-canvas font-medium disabled:opacity-50"
        >
          {busy ? "Creating…" : "Start session"}
        </button>
      </div>
      {pickerOpen && (
        <FolderPicker
          initialPath={projectPath.trim() || undefined}
          onPick={(abs) => {
            setProjectPath(abs);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function formatRel(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((now - then) / 1000));
  if (diff < 10) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function WsDiagPanel({
  diag,
  onClose,
}: {
  diag: import("@/api/ws").WsDiagnostics;
  onClose: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["phase", diag.phase],
    ["attempts", String(diag.attempts)],
    ["reconnectIn", diag.reconnectIn ? `${diag.reconnectIn}ms` : "—"],
    [
      "lastFrameAt",
      diag.lastFrameAt
        ? `${Math.round((Date.now() - diag.lastFrameAt) / 1000)}s ago`
        : "—",
    ],
    ["lastCloseCode", diag.lastCloseCode ? String(diag.lastCloseCode) : "—"],
    ["lastCloseReason", diag.lastCloseReason || "—"],
    ["lastError", diag.lastError || "—"],
    [
      "url",
      typeof location !== "undefined"
        ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`
        : "?",
    ],
    [
      "userAgent",
      typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 90) : "?",
    ],
  ];
  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-4">
        <div className="flex items-center mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              WebSocket
            </div>
            <div className="display text-[1.1rem] leading-tight">
              Connection diagnostics
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        <dl className="mono text-[12px] divide-y divide-line">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 py-1.5">
              <dt className="text-ink-muted w-32 shrink-0">{k}</dt>
              <dd className="min-w-0 flex-1 break-all text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function ProjectsSheet({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listProjects();
      setProjects(r.projects);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(id: string) {
    setErr(null);
    const name = editingName.trim();
    if (!name) {
      setErr("Name can't be empty.");
      return;
    }
    try {
      await api.updateProject(id, { name });
      setEditingId(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "update failed");
    }
  }

  async function remove(p: Project) {
    setErr(null);
    if (
      !confirm(
        `Delete project "${p.name}"? Sessions under it are not deleted, only the project reference.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteProject(p.id);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "has_sessions") {
        setErr(
          `Can't delete "${p.name}" — it still has sessions. Archive or delete them first.`,
        );
      } else {
        setErr(e instanceof ApiError ? e.code : "delete failed");
      }
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Projects
            </div>
            <h2 className="display text-[1.25rem] leading-tight mt-0.5">
              Manage where claude can work.
            </h2>
          </div>
          <button
            onClick={onClose}
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-[13px] text-ink-muted text-center py-10 mono">
              loading…
            </div>
          ) : projects.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              No projects yet. Add one from the New Session sheet.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {projects.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  {editingId === p.id ? (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") save(p.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
                      />
                      <div className="mono text-[11px] text-ink-muted truncate">
                        {p.path}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => save(p.id)}
                          className="flex-1 h-9 rounded-[8px] bg-ink text-canvas text-[13px] font-medium"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="h-9 px-3 rounded-[8px] border border-line text-[13px]"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium">{p.name}</div>
                        <div className="mono text-[11px] text-ink-muted truncate">
                          {p.path}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setEditingId(p.id);
                          setEditingName(p.name);
                          setErr(null);
                        }}
                        title="Rename"
                        className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center text-ink-soft hover:bg-paper"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => remove(p)}
                        title="Delete"
                        className="h-8 w-8 rounded-[8px] border border-line flex items-center justify-center text-danger hover:bg-danger-wash"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {err && (
          <div
            className={cn(
              "m-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30",
            )}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
