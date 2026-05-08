import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bell,
  Calendar,
  MessageSquare,
  Settings as SettingsIcon,
} from "lucide-react";
import { useAuth } from "@/state/auth";
import { useSessions } from "@/state/sessions";
import { api } from "@/api/client";
import type { Project } from "@claudex/shared";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// AppShell — the global navigation frame for all non-chat, non-login screens.
//
// Mobile: fixed bottom tab bar (h-58px). Four tabs: Sessions / Routines /
//         Alerts / Settings, mirroring mockup lines 431-436.
// Desktop: left sidebar (w-260px) with logo, nav list, divider, Projects
//         list, and a pinned user profile card. Mirrors mockup lines 449-477.
//
// Chat and Login do NOT use AppShell — they're full-viewport screens. The
// Chat screen in particular needs every vertical pixel for its transcript
// and the composer stuck to the bottom.
// ---------------------------------------------------------------------------

export type ShellTab = "sessions" | "routines" | "alerts" | "settings";

interface NavItem {
  id: ShellTab;
  label: string;
  icon: typeof MessageSquare;
  href: string;
}

const NAV: NavItem[] = [
  { id: "sessions", label: "Sessions", icon: MessageSquare, href: "/sessions" },
  { id: "routines", label: "Routines", icon: Calendar, href: "/routines" },
  { id: "alerts", label: "Alerts", icon: Bell, href: "/alerts" },
  { id: "settings", label: "Settings", icon: SettingsIcon, href: "/settings" },
];

export function AppShell({
  tab,
  children,
}: {
  tab: ShellTab;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] bg-canvas flex md:flex-row flex-col">
      {/* Desktop sidebar — hidden below md; Chat never renders this because
          Chat bypasses AppShell entirely. */}
      <DesktopSidebar tab={tab} />

      {/* Main column. The bottom padding on mobile is to keep the tab bar
          from covering the tail of the content. */}
      <main className="flex-1 min-w-0 flex flex-col pb-[58px] md:pb-0">
        {children}
      </main>

      {/* Mobile bottom tab bar. Fixed so it stays visible while the content
          scrolls; `pb-[env(safe-area-inset-bottom)]` keeps clear of the iOS
          home indicator. */}
      <MobileTabBar tab={tab} />
    </div>
  );
}

function DesktopSidebar({ tab }: { tab: ShellTab }) {
  const { user, logout } = useAuth();
  const { sessions } = useSessions();
  const [projects, setProjects] = useState<Project[]>([]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeProjectId = searchParams.get("project");

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects);
      })
      .catch(() => {
        /* best-effort — sidebar without projects still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Per-project session counts so the sidebar rows show a live number.
  const countsByProject = new Map<string, number>();
  for (const s of sessions) {
    countsByProject.set(s.projectId, (countsByProject.get(s.projectId) ?? 0) + 1);
  }

  // Clicking a project row filters the Sessions screen to that project via a
  // `?project=<id>` query param. "All projects" clears the filter. We stay on
  // whatever route we're already on if the user is on Sessions; otherwise
  // jump to Sessions. Keeping the nav simple — no drill-in page for projects
  // yet.
  const goToProject = (projectId: string | null) => {
    const target =
      projectId === null ? "/sessions" : `/sessions?project=${projectId}`;
    navigate(target);
  };

  return (
    <aside className="hidden md:flex border-r border-line bg-paper/40 w-[260px] flex-col shrink-0">
      <div className="p-4 flex items-center gap-2">
        <svg viewBox="0 0 32 32" className="w-5 h-5">
          <path d="M9 22 L16 8 L23 22 Z" fill="#cc785c" />
          <circle cx="16" cy="18" r="2.2" fill="#faf9f5" />
        </svg>
        <span className="mono text-[13px]">claudex</span>
      </div>

      <div className="px-3 space-y-1">
        {NAV.map(({ id, label, icon: Icon, href }) => {
          const active = tab === id;
          const count =
            id === "sessions"
              ? sessions.length
              : undefined;
          return (
            <Link
              key={id}
              to={href}
              className={cn(
                "w-full flex items-center gap-2 px-2.5 h-8 rounded-[6px] text-[13px]",
                active
                  ? "bg-canvas shadow-card border border-line text-ink"
                  : "text-ink-soft hover:bg-canvas/60 border border-transparent",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {typeof count === "number" && (
                <span className="ml-auto mono text-[11px] text-ink-muted">
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      <div className="mx-3 my-4 h-px bg-line" />

      <div className="px-4 caps text-ink-muted mb-2">Projects</div>
      <div className="px-3 space-y-0.5 overflow-y-auto flex-1 min-h-0">
        <button
          type="button"
          onClick={() => goToProject(null)}
          className={cn(
            "w-full flex items-center gap-2 px-2.5 h-7 rounded-[6px] text-left",
            tab === "sessions" && !activeProjectId
              ? "bg-canvas shadow-card border border-line text-ink"
              : "hover:bg-canvas/60 border border-transparent",
          )}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-ink-faint shrink-0" />
          <span className="mono text-[13px] text-ink-soft truncate">
            All projects
          </span>
          <span className="ml-auto text-[11px] text-ink-muted mono">
            {sessions.length}
          </span>
        </button>
        {projects.length === 0 ? (
          <div className="px-2.5 text-[12px] text-ink-muted">
            No projects yet.
          </div>
        ) : (
          projects.map((p) => {
            const active = tab === "sessions" && activeProjectId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => goToProject(p.id)}
                className={cn(
                  "w-full flex items-center gap-2 px-2.5 h-7 rounded-[6px] text-left",
                  active
                    ? "bg-canvas shadow-card border border-line text-ink"
                    : "hover:bg-canvas/60 border border-transparent",
                )}
                title={p.path}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-klein shrink-0" />
                <span className="mono text-[13px] text-ink-soft truncate">
                  {p.name}
                </span>
                <span className="ml-auto text-[11px] text-ink-muted mono">
                  {countsByProject.get(p.id) ?? 0}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="mt-auto p-4 border-t border-line flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-ink text-canvas flex items-center justify-center text-[13px] font-medium">
          {user?.username?.[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate">
            {user?.username ?? "—"}
          </div>
          <div className="text-[11px] text-ink-muted truncate">2FA on</div>
        </div>
        <button
          onClick={() => logout()}
          title="Sign out"
          className="text-[11px] text-ink-muted hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function MobileTabBar({ tab }: { tab: ShellTab }) {
  const navigate = useNavigate();
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-canvas/95 backdrop-blur flex items-center justify-around h-[58px] px-2"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {NAV.map(({ id, label, icon: Icon, href }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => navigate(href)}
            className={cn(
              "flex flex-col items-center gap-0.5 px-3 py-1 relative",
              active ? "text-ink" : "text-ink-muted",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="w-4 h-4" />
            <span className="text-[10px] font-medium">{label}</span>
            {active && (
              <span className="absolute -bottom-1 h-[3px] w-8 bg-klein rounded-full" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
