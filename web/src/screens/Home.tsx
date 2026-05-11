import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, GitBranch, Pencil, Pin, Trash2, FolderOpen, Settings2, X, Download, Search, BarChart3, MoreHorizontal, ChevronDown, ChevronUp } from "lucide-react";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { api, ApiError } from "@/api/client";
import type { Project, Session, ModelId, PermissionMode } from "@claudex/shared";
import { FolderPicker } from "@/components/FolderPicker";
import { AppShell } from "@/components/AppShell";
import { ImportSessionsSheet } from "@/components/ImportSessionsSheet";
import { GlobalSearchSheet } from "@/components/GlobalSearchSheet";
import { StatsSheet } from "@/components/StatsSheet";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";
import { useFocusReturn } from "@/hooks/useFocusReturn";

// Status dot colors for the flat row layout. `running` and `awaiting` get a
// soft glow ring (box-shadow) to match the mockup (s-02 lines 513, 533).
// `cli_running` uses the klein tone so it's visually distinct from `running`
// (SDK-driven) — signals "external `claude` CLI process is alive against
// this session" without implying claudex's composer is busy.
const STATUS_DOT: Record<string, string> = {
  running: "bg-success",
  cli_running: "bg-klein",
  awaiting: "bg-warn",
  idle: "bg-ink-faint",
  archived: "bg-line-strong",
  error: "bg-danger",
};
const DOT_GLOW: Record<string, string> = {
  running: "0 0 0 4px rgba(63,145,66,0.18)",
  cli_running: "0 0 0 4px rgba(204,120,92,0.22)",
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
  // Optional tag filter sourced from `?tag=<name>`. Stored in the URL so the
  // filter is shareable + survives back/forward. Only one tag active at a
  // time for now; multi-tag intersection can come later if the UI asks.
  const activeTag = searchParams.get("tag");
  const [showNew, setShowNew] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showWsDiag, setShowWsDiag] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSearchSheet, setShowSearchSheet] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  // Data-fetch failures from the two direct API calls on this screen:
  // `listSessions({archived:true})` (only fetched when the archived chip is
  // active) and `listProjects()`. Previously swallowed with `/* best-effort */`
  // comments — which meant a broken API looked identical to "no rows". Surface
  // them as a thin dismissible banner so the user can tell the difference.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Per-group expand/collapse state. Groups collapsed by default — each
  // group shows "all non-idle + up to 3 most-recent idle" rows so long
  // lists don't dominate the screen, while rows that need the user's
  // attention (awaiting / running / error) are always in view. The set
  // holds the projectIds that the user has explicitly expanded.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const toggleGroup = (projectId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // Cmd+K / Ctrl+K opens the global search sheet (full-text across session
  // titles AND message bodies) from anywhere on the page. preventDefault so
  // the browser's own "search bookmarks" binding doesn't fight us. Works
  // even when another input is focused — users expect to jump into search
  // without first clicking out of the composer.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearchSheet(true);
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
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(
          e instanceof ApiError
            ? `archived sessions: ${e.code}`
            : "Failed to load archived sessions",
        );
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
      .catch((e) => {
        if (cancelled) return;
        setLoadErr(
          e instanceof ApiError
            ? `projects: ${e.code}`
            : "Failed to load projects",
        );
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
    for (const s of sourceSessions) {
      // Hide side-chat children from the Home list. They appear inline in
      // their parent chat's side drawer, not as top-level rows.
      if (s.parentSessionId) continue;
      if (!chipMatches(s, activeFilter)) continue;
      if (activeTag) {
        const tags = s.tags ?? [];
        if (!tags.includes(activeTag)) continue;
      }
      const list = byProject.get(s.projectId);
      if (list) list.push(s);
      else byProject.set(s.projectId, [s]);
    }
    // Sort strictly by `updatedAt` (ISO 8601) descending. We previously
    // keyed on `lastMessageAt ?? updatedAt`, but that ignored non-message
    // updates (status flips, tag edits, title renames) — a session whose
    // status transitioned to `awaiting` but had no fresh user message
    // wouldn't float to the top even though its state just changed. The
    // user wants strict "most-recently-updated first" semantics.
    const sortKey = (s: Session) => Date.parse(s.updatedAt) || 0;
    // Session-level ordering is pinned-first, then activity-desc. Within
    // each project group the pinned rows float; at the group level we bucket
    // groups by whether they contain any pinned session so projects with
    // pinned work surface above the rest, then break ties on the newest
    // session's activity.
    const sessionSort = (a: Session, b: Session) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return sortKey(b) - sortKey(a);
    };
    const out: Array<{ project: Project | null; projectId: string; sessions: Session[] }> = [];
    for (const [projectId, list] of byProject) {
      list.sort(sessionSort);
      out.push({
        project: projectLookup.get(projectId) ?? null,
        projectId,
        sessions: list,
      });
    }
    out.sort((a, b) => {
      const ap = a.sessions.some((s) => s.pinned) ? 1 : 0;
      const bp = b.sessions.some((s) => s.pinned) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return sortKey(b.sessions[0]) - sortKey(a.sessions[0]);
    });
    return out;
  }, [sourceSessions, projects, activeFilter, activeTag]);

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

  // Set or clear the tag filter. When called with the currently-active tag
  // we clear; otherwise we swap. Used by both the rail chip's X and the
  // per-row tag chips. The URL stays the source of truth for the filter.
  const setTag = (name: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (!name) next.delete("tag");
    else next.set("tag", name);
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
      <header className="shrink-0 relative z-40 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        {/* Title = single-line breadcrumb. "Sessions" alone when nothing
            is filtered; "Sessions · <project>" when a project filter is
            on, with an inline × to clear. Beats the old caps-above-display
            stack where "Sessions / All projects" read like two titles
            fighting for the same slot. */}
        <h1 className="display text-[18px] md:text-[22px] leading-tight flex items-baseline gap-1.5 min-w-0">
          <span className="shrink-0">Sessions</span>
          {activeProject && (
            <>
              <span
                className="text-ink-faint shrink-0 font-sans text-[14px] md:text-[16px]"
                aria-hidden
              >
                ·
              </span>
              <span
                className="font-sans text-[14px] md:text-[15px] font-medium text-ink-soft truncate min-w-0"
                title={activeProject.name}
              >
                {activeProject.name}
              </span>
              <button
                type="button"
                onClick={clearFilter}
                aria-label={`Clear project filter ${activeProject.name}`}
                title="Clear project filter"
                className="shrink-0 h-5 w-5 rounded-full border border-line bg-paper flex items-center justify-center hover:bg-canvas"
              >
                <X className="w-2.5 h-2.5 text-ink-muted" aria-hidden />
              </button>
            </>
          )}
        </h1>
        <button
          type="button"
          onClick={() => setShowWsDiag((v) => !v)}
          title="WebSocket diagnostics"
          aria-label="WebSocket diagnostics"
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
        {/* Desktop-only search trigger (mockup s-02 lines 480-490). Mobile
            header is too narrow to fit this so the magnifier icon on the
            right serves as the mobile entry point. Click (or ⌘K) opens the
            GlobalSearchSheet for full-text search across titles + messages. */}
        <button
          type="button"
          onClick={() => setShowSearchSheet(true)}
          title="Search (⌘K)"
          className="hidden md:flex flex-1 max-w-md mx-auto w-full text-left items-center gap-2 h-9 px-3 bg-paper border border-line rounded-[8px] hover:bg-paper/80"
        >
          <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
          <span className="flex-1 min-w-0 text-[13px] text-ink-muted truncate">
            Search sessions and messages
          </span>
          <span className="ml-auto text-[11px] text-ink-faint mono shrink-0">
            ⌘K
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2 min-w-0">
          {/* Mobile-only full-text search trigger. Desktop uses the inline
              input above (which also carries the ⌘K hint); on touch there's
              no keyboard shortcut, so an explicit tappable icon is the only
              affordance to reach GlobalSearchSheet. */}
          <button
            type="button"
            onClick={() => setShowSearchSheet(true)}
            aria-label="Search"
            title="Search"
            className="md:hidden h-9 w-9 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper shrink-0"
          >
            <Search className="w-4 h-4 text-ink-soft" />
          </button>
          {/* Desktop keeps all three utilities visible. Mobile collapses
              Import / Stats / Projects into the overflow menu below so the
              New-session primary action is never clipped off-screen. */}
          <button
            onClick={() => setShowImport(true)}
            title="Import existing CLI sessions"
            aria-label="Import CLI sessions"
            className="hidden md:flex h-9 w-9 rounded-[8px] border border-line bg-canvas items-center justify-center hover:bg-paper shrink-0"
          >
            <Download className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowStats(true)}
            title="Statistics"
            aria-label="Statistics"
            className="hidden md:flex h-9 w-9 rounded-[8px] border border-line bg-canvas items-center justify-center hover:bg-paper shrink-0"
          >
            <BarChart3 className="w-4 h-4 text-ink-soft" />
          </button>
          <button
            onClick={() => setShowProjects(true)}
            title="Manage projects"
            className="hidden md:flex h-9 w-9 rounded-[8px] border border-line bg-canvas items-center justify-center hover:bg-paper shrink-0"
          >
            <Settings2 className="w-4 h-4 text-ink-soft" />
          </button>
          {/* Mobile overflow menu — Import / Stats / Projects live here so
              the header fits on a 390px viewport without pushing the
              primary "New" button off-screen. */}
          <HeaderOverflowMenu
            onImport={() => setShowImport(true)}
            onStats={() => setShowStats(true)}
            onProjects={() => setShowProjects(true)}
          />
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card shrink-0"
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
        {activeTag && (
          <div className="px-4 md:px-6 pt-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-klein text-canvas text-[12px]">
              #{activeTag}
              <button
                type="button"
                onClick={() => setTag(null)}
                aria-label={`Clear tag filter ${activeTag}`}
                className="hover:opacity-80"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
            <span className="text-[11px] text-ink-muted">
              Filtering by tag
            </span>
          </div>
        )}
        <div className="px-4 md:px-6 py-3 flex items-center gap-3">
          <span className="mono text-[11px] text-ink-muted">
            {loadingSessions
              ? "loading…"
              : activeProjectId
                ? `${visibleSessionCount} in this project · ${sessions.length} total`
                : `${sessions.length} total`}
          </span>
          {/* Previously had a "clear filter" button here — redundant now
              that the header title carries the project chip with its own
              inline × next to it. */}
        </div>

        {loadErr && (
          <div className="mx-4 md:mx-6 mb-3 flex items-center gap-2 rounded-[8px] border border-danger/30 bg-danger-wash px-3 py-2 text-[12.5px] text-danger">
            <span className="min-w-0 flex-1 truncate">{loadErr}</span>
            <button
              type="button"
              onClick={() => setLoadErr(null)}
              aria-label="Dismiss"
              className="shrink-0 h-5 w-5 rounded-full flex items-center justify-center hover:bg-danger/10"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        {loadingSessions && sessions.length === 0 ? (
          // Skeleton list on first paint — 3 greyed rows. Using the empty-state
          // card here would look identical to a genuine "no sessions" account
          // and confuse every freshly-loaded page.
          <div className="px-4 md:px-6 pb-6 space-y-2">
            <div className="h-[68px] rounded-[8px] bg-paper animate-pulse" />
            <div className="h-[68px] rounded-[8px] bg-paper animate-pulse" />
            <div className="h-[68px] rounded-[8px] bg-paper animate-pulse" />
          </div>
        ) : sessions.length === 0 && !loadingSessions ? (
          <div className="px-4 md:px-6 pb-6">
            <EmptyState onNew={() => setShowNew(true)} />
          </div>
        ) : filteredGroups.length === 0 ? (
          <div className="px-4 md:px-6 pb-6 text-[13px] text-ink-muted">
            {activeFilter === "all"
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
                expanded={expandedGroups.has(g.projectId)}
                onToggleExpanded={() => toggleGroup(g.projectId)}
                onPickTag={(name) => setTag(name)}
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
      {showSearchSheet && (
        <GlobalSearchSheet
          onClose={() => {
            setShowSearchSheet(false);
          }}
        />
      )}
      {showStats && <StatsSheet onClose={() => setShowStats(false)} />}
    </AppShell>
  );
}

// Mobile overflow menu used by the Home header — collapses Import / Stats /
// Projects into a single `⋯` button so the New-session primary action
// always fits on a 390px viewport. Hidden on desktop (md:hidden).
function HeaderOverflowMenu({
  onImport,
  onStats,
  onProjects,
}: {
  onImport: () => void;
  onStats: () => void;
  onProjects: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative md:hidden shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More"
        className="h-9 w-9 rounded-[8px] border border-line bg-canvas flex items-center justify-center hover:bg-paper"
      >
        <MoreHorizontal className="w-4 h-4 text-ink-soft" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-30 w-[180px] rounded-[10px] border border-line bg-canvas shadow-lift p-1"
        >
          <button
            role="menuitem"
            onClick={() => pick(onImport)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[6px] text-left text-[13px] text-ink-soft hover:bg-paper/60"
          >
            <Download className="w-3.5 h-3.5 text-ink-soft" />
            Import sessions
          </button>
          <button
            role="menuitem"
            onClick={() => pick(onStats)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[6px] text-left text-[13px] text-ink-soft hover:bg-paper/60"
          >
            <BarChart3 className="w-3.5 h-3.5 text-ink-soft" />
            Statistics
          </button>
          <button
            role="menuitem"
            onClick={() => pick(onProjects)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[6px] text-left text-[13px] text-ink-soft hover:bg-paper/60"
          >
            <Settings2 className="w-3.5 h-3.5 text-ink-soft" />
            Manage projects
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectGroup({
  project,
  projectId,
  sessions,
  expanded,
  onToggleExpanded,
  onPickTag,
}: {
  project: Project | null;
  projectId: string;
  sessions: Session[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPickTag: (name: string) => void;
}) {
  // Each group is its own block so its header `sticky top-0` is scoped to
  // the group's vertical run — when you scroll past, the next project's
  // header takes over. The parent `<section>` is the scroll container.
  const displayName = project?.name ?? projectId.slice(0, 8);
  const path = project?.path ?? "";

  // Default-collapsed view: every non-idle session (awaiting / running /
  // error / cli_running) is always rendered regardless of count. Beyond
  // that, the visible list is padded with idle sessions up to a total
  // budget of 3 rows — so a group with 1 non-idle + 20 idle shows 1
  // non-idle + 2 idle (3 total), and a group with 5 non-idle + 20 idle
  // shows all 5 non-idle + 0 idle. Iterates in sort order (already
  // pinned-first + updatedAt desc) so display order is preserved.
  const { visibleSessions, hiddenCount } = useMemo(() => {
    if (expanded) {
      return { visibleSessions: sessions, hiddenCount: 0 };
    }
    const TOTAL_BUDGET = 3;
    const nonIdleCount = sessions.reduce(
      (n, s) => (s.status !== "idle" ? n + 1 : n),
      0,
    );
    const idleBudget = Math.max(0, TOTAL_BUDGET - nonIdleCount);
    const visible: Session[] = [];
    let idleShown = 0;
    for (const s of sessions) {
      if (s.status !== "idle") {
        visible.push(s);
      } else if (idleShown < idleBudget) {
        visible.push(s);
        idleShown++;
      }
    }
    return {
      visibleSessions: visible,
      hiddenCount: sessions.length - visible.length,
    };
  }, [sessions, expanded]);

  return (
    <div>
      {/* Chip rail is the first sticky at top-0 z-20 (see FilterChipRail).
          This group header sticks BELOW it: its top offset equals the
          rail's rendered height. Mobile rail is py-2 (16 + 28 h-7 + 1 border
          ≈ 45px); desktop rail is py-3 (24 + 28 + 1 ≈ 53px). z-10 keeps it
          under the rail so it slides beneath as you scroll past. */}
      <div className="sticky top-[45px] md:top-[53px] z-10 flex items-center gap-3 px-4 md:px-6 py-2 bg-paper/80 backdrop-blur border-b border-line">
        <span className="display text-[15px] md:text-[16px]">{displayName}</span>
        {path && (
          <span className="mono text-[11px] text-ink-muted truncate hidden md:inline">
            {path}
          </span>
        )}
        <span className="ml-auto mono text-[11px] text-ink-muted shrink-0">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul>
        {visibleSessions.map((s) => (
          <li key={s.id}>
            <SessionRow session={s} onPickTag={onPickTag} />
          </li>
        ))}
      </ul>
      {(hiddenCount > 0 || (expanded && sessions.length > 3)) && (
        <div className="px-4 md:px-6 py-2 border-b border-line bg-paper/40">
          <button
            type="button"
            onClick={onToggleExpanded}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line bg-canvas text-[12px] text-ink-soft hover:bg-paper"
            aria-expanded={expanded}
            aria-controls={`project-group-${projectId}`}
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Show less</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>
                  Show {hiddenCount} more idle session
                  {hiddenCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// Status pill text + style mapping. Mirrors the mockup (s-02 lines 523, 537,
// 555, 566, 584). `awaiting` keeps the quoted `#7a4700` color from the mockup.
function statusPillClass(status: string): string {
  switch (status) {
    case "running":
      return "border border-success/30 bg-success-wash text-[#1f5f21]";
    case "cli_running":
      return "border border-klein/30 bg-klein-wash text-klein-ink";
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
  if (status === "cli_running") return "CLI · RUNNING";
  return status.toUpperCase();
}

function SessionRow({
  session: s,
  onPickTag,
}: {
  session: Session;
  onPickTag: (name: string) => void;
}) {
  const href = `/session/${s.id}`;
  const archived = s.status === "archived";
  const dotTone = STATUS_DOT[s.status] ?? "bg-ink-faint";
  const dotGlow = DOT_GLOW[s.status] ?? "";
  const rel = formatRel(s.lastMessageAt ?? s.updatedAt);
  const branch = s.branch ?? "main";
  const { linesAdded, linesRemoved, filesChanged, contextPct } = s.stats;
  // Inline delete confirm. Opened by the trailing trash button on the row;
  // anchored to the row itself (NOT a modal) so the user stays oriented in
  // the list. Escape closes. The Delete button is NOT autofocused — we don't
  // want a stray Enter to nuke a session on mobile keyboards.
  const forgetSession = useSessions((st) => st.forgetSession);
  const refreshSessions = useSessions((st) => st.refreshSessions);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirmOpen) return;
    const onDoc = (ev: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(ev.target as Node)) {
        setConfirmOpen(false);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        setConfirmOpen(false);
      }
    };
    // mousedown so click on the row's <Link> still navigates after close —
    // but deletion via trash icon stops propagation so we don't race.
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [confirmOpen]);

  const openConfirm = (e: React.MouseEvent) => {
    // Critical: the row is a <Link> — without these two the trash click
    // would navigate to /session/:id before the popover can open.
    e.preventDefault();
    e.stopPropagation();
    setConfirmOpen(true);
  };

  const onDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (deleting) return;
    setDeleting(true);
    try {
      await api.deleteSession(s.id);
      forgetSession(s.id);
      toast("Session deleted");
      // Also refresh so grouped counts stay accurate.
      refreshSessions();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "delete_failed";
      toast(`Delete failed: ${code}`);
      setDeleting(false);
      setConfirmOpen(false);
      return;
    }
    // Component will unmount on successful delete — no need to reset state.
  };
  // "Looks stuck" — session reports `running` but its last activity timestamp
  // is > 5 min old. Normally the server watchdog catches this; on a recent
  // restart the in-memory timer can be missing until on-boot sweep fires, so
  // we surface a subtle `?` badge next to the status dot so the user knows
  // the row might be lying. The SessionSettingsSheet exposes a "Reset to
  // idle" link that calls POST /api/sessions/:id/force-idle.
  const anchorIso = s.lastMessageAt ?? s.updatedAt;
  const anchorMs = anchorIso ? Date.parse(anchorIso) : Number.NaN;
  const ageMs = Number.isFinite(anchorMs) ? Date.now() - anchorMs : 0;
  const looksStuck = s.status === "running" && ageMs > 5 * 60 * 1000;
  // Up to 3 tag chips are rendered next to the title on desktop; mobile has
  // no room. Clicking a chip activates the `?tag=` filter on Home. The
  // chip intercepts the row's <Link> navigation via stopPropagation +
  // preventDefault so tapping a tag doesn't also open the session.
  const visibleTags = (s.tags ?? []).slice(0, 3);
  const extraTags = Math.max(0, (s.tags ?? []).length - visibleTags.length);
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
    <div className="relative group/row">
      <Link
        to={href}
        className={cn(
          "block border-b border-line hover:bg-paper/40 cursor-pointer",
          archived && "opacity-75",
        )}
      >
      {/* Mobile stacked layout — mirrors mockup s-02 rows (lines 370-403):
          CAPS status line (dot + label + relative time) on top, title with
          context ring aligned to its right, optional subtitle, meta row. */}
      <div className="md:hidden px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn("h-2 w-2 rounded-full shrink-0", dotTone, (s.status === "running" || s.status === "cli_running") && "animate-pulse")}
            style={dotGlow ? { boxShadow: dotGlow } : undefined}
          />
          <span className="text-[11px] caps text-ink-muted">
            {statusPillLabel(s.status)}
          </span>
          {looksStuck && (
            <span
              className="text-[11px] text-ink-faint"
              aria-label="Running with no activity — session may be stuck"
              title="Running with no activity — session may be stuck. Open Settings to reset."
            >
              ?
            </span>
          )}
          <span className="ml-auto text-[11px] text-ink-faint">{rel}</span>
          {/* Mobile-only in-flow delete trigger. Lives inside the status
              line (not absolute) so it never overlaps title / context ring
              / tags. Small target with an accessible label; confirm popover
              anchors from the row itself. */}
          <button
            type="button"
            onClick={openConfirm}
            aria-label="Delete session"
            title="Delete session"
            className="md:hidden shrink-0 h-7 w-7 -my-1 -mr-1 flex items-center justify-center text-ink-faint active:text-danger"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {s.pinned && (
            <Pin
              className="w-3.5 h-3.5 text-klein-ink shrink-0"
              aria-label="Pinned"
            />
          )}
          <div className="text-[15px] font-medium leading-snug truncate flex-1 min-w-0">
            {s.title || "Untitled"}
          </div>
          <span className="shrink-0">
            {showRing ? (
              <svg width="20" height="20">
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="#e8e4d8"
                  strokeWidth="2.5"
                />
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="#cc785c"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray="50.26"
                  strokeDashoffset={(50.26 * (1 - pct)).toString()}
                  transform="rotate(-90 10 10)"
                />
              </svg>
            ) : (
              <svg width="20" height="20">
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  fill="none"
                  stroke="#e8e4d8"
                  strokeWidth="2.5"
                />
              </svg>
            )}
          </span>
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
              (s.status === "running" || s.status === "cli_running") && "animate-pulse",
            )}
            style={dotGlow ? { boxShadow: dotGlow } : undefined}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {s.pinned && (
                <Pin
                  className="w-3.5 h-3.5 text-klein-ink shrink-0"
                  aria-label="Pinned"
                />
              )}
              <span className="text-[14px] font-medium truncate">
                {s.title || "Untitled"}
              </span>
              {s.worktreePath && (
                <span className="text-[11px] caps text-ink-muted shrink-0">
                  worktree
                </span>
              )}
              {visibleTags.length > 0 && (
                <span className="hidden lg:flex items-center gap-1 shrink-0">
                  {visibleTags.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onPickTag(t);
                      }}
                      className="inline-flex items-center px-1.5 h-5 rounded-full border border-line bg-paper text-[10px] text-ink-soft hover:bg-klein-wash hover:text-klein-ink hover:border-klein/30"
                    >
                      #{t}
                    </button>
                  ))}
                  {extraTags > 0 && (
                    <span className="mono text-[10px] text-ink-faint">
                      +{extraTags}
                    </span>
                  )}
                </span>
              )}
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
              {(s.status === "running" || s.status === "awaiting" || s.status === "cli_running") && (
                <span className={cn("h-1.5 w-1.5 rounded-full", dotTone)} />
              )}
              {statusPillLabel(s.status)}
              {looksStuck && (
                <span
                  className="text-ink-faint"
                  aria-label="Running with no activity — session may be stuck"
                  title="Running with no activity — session may be stuck. Open Settings to reset."
                >
                  ?
                </span>
              )}
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
      {/* Trailing quick-delete icon. Absolutely positioned so it overlays
          the row without breaking the Link's tap target. preventDefault +
          stopPropagation on click are critical — otherwise the row's
          <Link> navigates to /session/:id before the popover opens. */}
      <button
        type="button"
        onClick={openConfirm}
        aria-label="Delete session"
        title="Delete session"
        className={cn(
          // Desktop-only: absolutely positioned, hover-revealed. On mobile
          // the in-row trash button (below) is the affordance — an always-
          // visible absolute overlay covers the relative-time + context
          // ring and felt heavy.
          "hidden md:flex absolute top-3 right-3 h-8 w-8 rounded-[8px] border border-line bg-canvas/95 shadow-card",
          "items-center justify-center text-ink-muted hover:text-danger hover:bg-danger-wash hover:border-danger/30",
          "md:opacity-0 md:group-hover/row:opacity-100 md:focus-visible:opacity-100",
          confirmOpen && "md:opacity-100",
        )}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
      {confirmOpen && (
        <div
          ref={confirmRef}
          role="dialog"
          aria-label="Confirm delete session"
          // Anchored below the trash button. Uses max-w so a long warning
          // still fits on a 390px viewport; z-30 to clear the sticky group
          // header (z-10) + filter rail (z-20) without going modal-tier.
          className="absolute right-2 md:right-3 top-11 md:top-12 z-30 w-[260px] rounded-[10px] border border-line bg-canvas shadow-lift p-3"
          onClick={(e) => {
            // Keep clicks inside the popover from bubbling up to the row's
            // <Link> (which would navigate and lose the confirm state).
            e.stopPropagation();
          }}
        >
          <div className="text-[13px] font-medium mb-1">Delete session?</div>
          <p className="text-[12px] text-ink-muted leading-snug">
            This removes the transcript and tool runs. Can't be undone.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirmOpen(false);
              }}
              disabled={deleting}
              className="h-8 px-3 rounded-[6px] border border-line bg-paper text-[12px] text-ink-soft hover:bg-canvas disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              className="ml-auto h-8 px-3 rounded-[6px] bg-danger text-canvas text-[12px] font-medium hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
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
    <div className="sticky top-0 z-20 bg-canvas/95 backdrop-blur border-b border-line px-4 md:px-6 py-2 md:py-3">
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
  useFocusReturn();
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
  // When the target project is untrusted we pause here instead of creating
  // the session. The card below captures the user's explicit confirmation
  // before we flip the trust bit and proceed. Null = no pending trust step.
  const [trustPending, setTrustPending] = useState<Project | null>(null);

  useEffect(() => {
    api.listProjects().then((r) => {
      setProjects(r.projects);
      if (r.projects.length > 0) setSelected(r.projects[0].id);
    });
  }, []);

  /**
   * Resolve the project the user wants to spawn under — creating a new row
   * if the NEW_PROJECT radio is selected, or looking up the existing one.
   * Returns null on validation failure (err already set). Keeping this
   * separate from the trust step lets us funnel both "brand new project"
   * and "already-added but untrusted project" through the same confirm card.
   */
  async function resolveTargetProject(): Promise<Project | null> {
    if (selected === NEW_PROJECT) {
      const trimmedPath = projectPath.trim();
      if (!trimmedPath) {
        setErr("Pick an absolute path for the new project.");
        return null;
      }
      const trimmedName =
        projectName.trim() ||
        trimmedPath.split("/").filter(Boolean).pop() ||
        "project";
      const p = await api.createProject({
        name: trimmedName,
        path: trimmedPath,
      });
      // Surface the new project in the in-memory list so subsequent renders
      // of this sheet (if the user re-opens after cancel) show it.
      setProjects((prev) => [p.project, ...prev]);
      return p.project;
    }
    return projects.find((p) => p.id === selected) ?? null;
  }

  async function spawnSession(projectId: string) {
    const res = await api.createSession({
      projectId,
      title: title || "Untitled",
      model,
      mode,
      worktree: false,
    });
    onCreated(res.session.id);
  }

  async function onPrimary() {
    setBusy(true);
    setErr(null);
    try {
      const project = await resolveTargetProject();
      if (!project) {
        setBusy(false);
        return;
      }
      if (!project.trusted) {
        // Pause on the trust card — don't spawn until the user confirms.
        setTrustPending(project);
        setBusy(false);
        return;
      }
      await spawnSession(project.id);
    } catch (e: any) {
      setErr(e?.code ?? e?.message ?? "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTrustAndCreate() {
    if (!trustPending) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.trustProject(trustPending.id, true);
      // Propagate the new trust state into the in-memory list so the card
      // doesn't reappear if the user creates a second session in this
      // sheet's lifetime.
      setProjects((prev) =>
        prev.map((p) => (p.id === res.project.id ? res.project : p)),
      );
      setTrustPending(null);
      await spawnSession(res.project.id);
    } catch (e: any) {
      setErr(e?.code ?? e?.message ?? "trust failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="new-session-sheet-title" className="w-full max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5">
        <div className="flex items-center mb-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              New session
            </div>
            <h2 id="new-session-sheet-title" className="display text-[1.25rem] leading-tight mt-0.5">
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
          onClick={onPrimary}
          disabled={busy}
          className="mt-4 w-full h-12 rounded-[8px] bg-ink text-canvas font-medium disabled:opacity-50"
        >
          {busy ? "Creating…" : "Start session"}
        </button>
      </div>
      {trustPending && (
        <TrustConfirmCard
          project={trustPending}
          busy={busy}
          err={err}
          onCancel={() => {
            // Dismiss the trust card without creating the session. The
            // project stays in the list (we don't roll back `createProject`
            // on cancel — having an untrusted row lying around is fine; the
            // user can either confirm next time or delete it from
            // Settings → Security).
            setTrustPending(null);
            setErr(null);
          }}
          onConfirm={confirmTrustAndCreate}
        />
      )}
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

// Confirm card shown when the selected project is untrusted. claudex's rule:
// no session spawns under a project until the user has explicitly okayed
// claude touching files in that folder. The card is nested inside the
// NewSessionSheet overlay (z-50 on top of z-40) so dismissing it returns
// the user to the sheet with their model/mode selection intact.
function TrustConfirmCard({
  project,
  busy,
  err,
  onCancel,
  onConfirm,
}: {
  project: Project;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useFocusReturn();
  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="trust-folder-modal-title" className="w-full max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-5">
        <div className="caps text-ink-muted">Security</div>
        <h2 id="trust-folder-modal-title" className="display text-[1.25rem] leading-tight mt-0.5">
          Trust this folder?
        </h2>
        <div className="mt-3 rounded-[8px] border border-line bg-paper px-3 py-2">
          <div className="text-[13px] font-medium truncate">{project.name}</div>
          <div className="mono text-[11px] text-ink-muted break-all">
            {project.path}
          </div>
        </div>
        <p className="mt-3 text-[13px] text-ink-muted leading-relaxed">
          claudex will ask claude to run shell commands and edit files inside
          this folder. Only trust folders you own.
        </p>
        {err && (
          <div className="mt-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-11 px-4 rounded-[8px] border border-line bg-paper text-[14px] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 h-11 rounded-[8px] bg-ink text-canvas text-[14px] font-medium disabled:opacity-50"
          >
            {busy ? "Trusting…" : "Trust and continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRel(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Math.round((now - then) / 1000));
  // Sub-minute precision — sessions that flipped to idle seconds ago
  // shouldn't read identical to sessions idle for almost a minute.
  if (diff < 3) return "just now";
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
  useFocusReturn();
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
      <div role="dialog" aria-modal="true" aria-labelledby="ws-diag-title" className="w-full sm:max-w-md bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift p-4">
        <div className="flex items-center mb-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              WebSocket
            </div>
            <div id="ws-diag-title" className="display text-[1.1rem] leading-tight">
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
  useFocusReturn();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [shakeId, setShakeId] = useState<string | null>(null);
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
      // Empty name → shake the input + toast. We don't use the top-level err
      // banner for this so the visual feedback lives right next to the input.
      setShakeId(id);
      window.setTimeout(() => setShakeId(null), 340);
      toast("Name can't be empty");
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
      <div role="dialog" aria-modal="true" aria-labelledby="projects-sheet-title" className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]">
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Projects
            </div>
            <h2 id="projects-sheet-title" className="display text-[1.25rem] leading-tight mt-0.5">
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
                        className={cn(
                          "w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]",
                          shakeId === p.id && "animate-shake",
                        )}
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
