import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, FileText, Check, X, FolderOpen } from "lucide-react";
import type { PendingDiffEntry, Session } from "@claudex/shared";
import { api } from "@/api/client";
import { useSessions } from "@/state/sessions";
import { DiffView } from "@/components/DiffView";
import type { FileDiff } from "@/lib/diff";
import { cn } from "@/lib/cn";

/**
 * Full-screen Diff Review page — mockup s-06 (lines 1236-1380).
 *
 * Renders every diff-producing tool call in the session that's currently
 * awaiting user attention, aggregated server-side via
 * `GET /api/sessions/:id/pending-diffs`. Layout:
 *
 *   desktop (md+):  [260px files] [fluid diff] [320px summary]
 *   mobile:         diff only, with a "N files" chip that pops a top sheet
 *
 * The inline chat-thread diff rendering is untouched — this page is a
 * separate surface for cases where the user wants to review everything
 * before answering. Opening the page does NOT auto-approve anything;
 * it's read-only until the user taps Approve.
 *
 * `?approvalId=<id>` in the query string preselects one diff on mount —
 * used when the Chat screen's PermissionCard deep-links into the page.
 */
export function DiffReviewScreen() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const preselectId = search.get("approvalId");
  const [session, setSession] = useState<Session | null>(null);
  const [diffs, setDiffs] = useState<PendingDiffEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedToolUseId, setSelectedToolUseId] = useState<string | null>(
    null,
  );
  const [showFilesSheet, setShowFilesSheet] = useState(false);
  const { resolvePermission } = useSessions();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api
      .getSession(id)
      .then((r) => {
        if (!cancelled) setSession(r.session);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    api
      .listPendingDiffs(id)
      .then((r) => {
        if (cancelled) return;
        setDiffs(r.diffs);
        // Preselect from the query param if it matches; otherwise pick the
        // first diff so the center panel never starts empty.
        const match = preselectId
          ? r.diffs.find((d) => d.approvalId === preselectId)
          : null;
        setSelectedToolUseId(
          match?.toolUseId ?? r.diffs[0]?.toolUseId ?? null,
        );
      })
      .catch((e) => {
        if (!cancelled) setError(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, preselectId]);

  const selected = useMemo(() => {
    if (!diffs || !selectedToolUseId) return null;
    return diffs.find((d) => d.toolUseId === selectedToolUseId) ?? null;
  }, [diffs, selectedToolUseId]);

  // Derived: how many diffs have an outstanding approval pending.
  const pendingApprovals = useMemo(
    () => (diffs ?? []).filter((d) => d.approvalId),
    [diffs],
  );

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const d of diffs ?? []) {
      add += d.addCount;
      del += d.delCount;
    }
    return { add, del };
  }, [diffs]);

  function toFileDiff(entry: PendingDiffEntry): FileDiff {
    // Translate the server-shaped entry into the shape <DiffView> expects.
    // The `kind` field labels differ slightly: the UI's DiffView uses
    // "create" / "edit" / "overwrite", while the server entry uses
    // "edit" / "write" / "multiedit" (matching the UI's bucket labels).
    // We map conservatively — a MultiEdit is rendered as an edit since
    // DiffView already handles multi-hunk layouts.
    const kind: FileDiff["kind"] = entry.kind === "write" ? "overwrite" : "edit";
    return {
      path: entry.filePath,
      kind,
      addCount: entry.addCount,
      delCount: entry.delCount,
      hunks: entry.hunks,
    };
  }

  function handleApprove(entry: PendingDiffEntry) {
    if (!id || !entry.approvalId) return;
    resolvePermission(id, entry.approvalId, "allow_once");
    // Optimistically remove from the local list so the UI doesn't stay
    // stuck on an already-decided diff. A refetch would also work but
    // adds a round-trip; the server is the source of truth on navigation.
    setDiffs((prev) => (prev ?? []).filter((d) => d.toolUseId !== entry.toolUseId));
  }

  function handleReject(entry: PendingDiffEntry) {
    if (!id || !entry.approvalId) return;
    resolvePermission(id, entry.approvalId, "deny");
    setDiffs((prev) => (prev ?? []).filter((d) => d.toolUseId !== entry.toolUseId));
  }

  function handleApproveAll() {
    if (!id) return;
    for (const d of pendingApprovals) {
      resolvePermission(id, d.approvalId!, "allow_once");
    }
    // Clear the local list — the server won't return these anymore either.
    setDiffs([]);
  }

  if (!id) return null;

  return (
    <div className="flex h-[100dvh] bg-canvas">
      {/* Mobile back / title header. Hidden on desktop since the left rail
          provides its own context. */}
      <div className="md:hidden fixed inset-x-0 top-0 z-20 flex items-center gap-2 px-4 py-2.5 border-b border-line bg-canvas">
        <button
          type="button"
          onClick={() => navigate(`/session/${id}`)}
          className="h-8 w-8 rounded-[8px] bg-paper border border-line flex items-center justify-center shrink-0"
          aria-label="Back to chat"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium truncate">
            Diff {diffs ? `· ${diffs.length} file${diffs.length === 1 ? "" : "s"}` : ""}
          </div>
          <div className="mono text-[11px] text-ink-muted truncate">
            <span className="text-success">+{totals.add}</span>{" "}
            <span className="text-danger">−{totals.del}</span>
            {session ? ` · ${session.title}` : ""}
          </div>
        </div>
        {diffs && diffs.length > 0 && (
          <button
            type="button"
            onClick={() => setShowFilesSheet(true)}
            className="h-8 px-2.5 rounded-[8px] bg-paper border border-line text-[12px] flex items-center gap-1.5"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            {diffs.length} files
          </button>
        )}
      </div>

      {/* Desktop + mobile grid. The `md:grid` activation kicks in at the
          desktop breakpoint; on mobile we let the center panel flow full
          width. */}
      <div className="flex-1 min-w-0 flex md:grid md:grid-cols-[260px_minmax(0,1fr)_320px]">
        {/* Left rail — files. Desktop only. */}
        <aside className="hidden md:flex flex-col border-r border-line bg-paper/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex items-center shrink-0">
            <Link
              to={`/session/${id}`}
              className="mr-2 h-7 w-7 rounded-[8px] bg-canvas border border-line flex items-center justify-center shrink-0"
              aria-label="Back to chat"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Link>
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
              Files
            </span>
            <span className="ml-auto mono text-[11px] text-ink-muted">
              {diffs?.length ?? 0} changed
            </span>
          </div>
          <div className="overflow-y-auto flex-1 py-1">
            {diffs && diffs.length === 0 && (
              <div className="px-4 py-3 text-[12.5px] text-ink-muted">
                No pending diffs in this session.
              </div>
            )}
            {(diffs ?? []).map((d) => (
              <FileRow
                key={d.toolUseId}
                entry={d}
                active={d.toolUseId === selectedToolUseId}
                onClick={() => setSelectedToolUseId(d.toolUseId)}
              />
            ))}
          </div>
        </aside>

        {/* Center — selected diff. */}
        <section className="flex flex-col min-w-0 pt-[52px] md:pt-0">
          {/* Sticky header with path / counts / per-file actions. */}
          {selected && (
            <div className="sticky top-0 z-10 bg-canvas border-b border-line px-4 md:px-5 py-3 flex items-center gap-3">
              <div className="min-w-0">
                <div className="display text-[16px] md:text-[18px] leading-tight truncate">
                  {selected.filePath}
                </div>
                <div className="mono text-[11px] text-ink-muted truncate">
                  <span className="text-success">+{selected.addCount}</span>{" "}
                  <span className="text-danger">−{selected.delCount}</span>
                  {" · "}
                  {selected.hunks.length}{" "}
                  {selected.hunks.length === 1 ? "hunk" : "hunks"}
                  {selected.kind ? ` · ${selected.kind}` : ""}
                </div>
              </div>
              {selected.approvalId && (
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleReject(selected)}
                    className="h-8 px-3 rounded-[8px] border border-line bg-canvas text-[12px] text-danger flex items-center gap-1.5"
                  >
                    <X className="w-3.5 h-3.5" />
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApprove(selected)}
                    className="h-8 px-3 rounded-[8px] bg-klein text-canvas text-[12px] font-medium flex items-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" />
                    Approve
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="flex-1 overflow-y-auto bg-canvas">
            {error && (
              <div className="px-5 py-4 text-[13px] text-danger">
                Failed to load diffs: {error}
              </div>
            )}
            {!error && diffs == null && (
              <div className="px-5 py-8 text-[13px] text-ink-muted text-center">
                Loading diffs…
              </div>
            )}
            {!error && diffs && diffs.length === 0 && (
              <EmptyState sessionId={id} />
            )}
            {selected && (
              <div className="p-4 md:p-5">
                <DiffView diff={toFileDiff(selected)} defaultOpen />
              </div>
            )}
          </div>

          {/* Footer — sticky. */}
          <div className="shrink-0 border-t border-line bg-canvas px-4 md:px-5 py-3 flex items-center gap-3">
            <Link
              to={`/session/${id}`}
              className="text-[12.5px] text-ink-muted hover:text-ink-soft hidden md:inline"
            >
              ← Back to chat
            </Link>
            <div className="mono text-[11px] text-ink-muted truncate hidden md:block">
              {session?.title ?? id}
              {session?.branch ? ` · ${session.branch}` : ""}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={handleApproveAll}
                disabled={pendingApprovals.length === 0}
                className="h-9 px-4 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card disabled:opacity-40"
              >
                Approve all
                {pendingApprovals.length > 0
                  ? ` (${pendingApprovals.length})`
                  : ""}
              </button>
            </div>
          </div>
        </section>

        {/* Right rail — summary / checks. Desktop only. */}
        <aside className="hidden md:flex flex-col border-l border-line bg-paper/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-line shrink-0">
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
              What this patch does
            </span>
          </div>
          <div className="overflow-y-auto flex-1 p-4 space-y-4">
            <SummaryPanel selected={selected} diffs={diffs ?? []} />
            <ChecksPanel />
          </div>
        </aside>
      </div>

      {/* Mobile files top-sheet. Only rendered when toggled. */}
      {showFilesSheet && diffs && (
        <MobileFilesSheet
          diffs={diffs}
          selectedId={selectedToolUseId}
          onPick={(toolUseId) => {
            setSelectedToolUseId(toolUseId);
            setShowFilesSheet(false);
          }}
          onClose={() => setShowFilesSheet(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File list row (desktop rail + mobile sheet share the same visuals).
// ---------------------------------------------------------------------------
function FileRow({
  entry,
  active,
  onClick,
}: {
  entry: PendingDiffEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-2 border-b border-line/60 text-left",
        active
          ? "bg-klein-wash/40 border-l-2 border-l-klein"
          : "hover:bg-canvas/60 border-l-2 border-l-transparent",
      )}
    >
      <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
      <span className="mono text-[12px] truncate flex-1">{entry.filePath}</span>
      {entry.approvalId && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-warn shrink-0"
          title="Pending your approval"
        />
      )}
      {entry.addCount > 0 && (
        <span className="mono text-[11px] text-success shrink-0">
          +{entry.addCount}
        </span>
      )}
      {entry.delCount > 0 && (
        <span className="mono text-[11px] text-danger shrink-0">
          −{entry.delCount}
        </span>
      )}
    </button>
  );
}

function SummaryPanel({
  selected,
  diffs,
}: {
  selected: PendingDiffEntry | null;
  diffs: PendingDiffEntry[];
}) {
  if (!selected) {
    return (
      <div className="rounded-[8px] border border-line bg-canvas p-3 text-[12.5px] text-ink-muted">
        No diff selected.
      </div>
    );
  }
  const pendingCount = diffs.filter((d) => d.approvalId).length;
  return (
    <div className="rounded-[8px] border border-line bg-canvas p-3 text-[13px] leading-[1.55] text-ink-soft">
      {selected.title ? (
        <>
          <div className="font-medium text-ink">{selected.title}</div>
          <div className="mt-1 mono text-[11.5px] text-ink-muted">
            {selected.filePath}
          </div>
        </>
      ) : (
        <>
          <div className="font-medium text-ink">In-flight edit</div>
          <div className="mt-1 text-[12.5px] text-ink-muted">
            No permission prompt is attached to this change — the session is
            running in a mode that auto-accepts edits, and this tool call is
            still being executed.
          </div>
        </>
      )}
      <div className="mt-3 text-[12px] text-ink-muted">
        {pendingCount > 0
          ? `${pendingCount} ${pendingCount === 1 ? "file" : "files"} waiting on your decision in this session.`
          : "All changes in this session have been decided."}
      </div>
    </div>
  );
}

function ChecksPanel() {
  // We don't inspect the project for CI config yet — stay honest. When
  // we wire a checks reader this panel grows.
  return (
    <div className="rounded-[8px] border border-line bg-paper/60 p-3 text-[12.5px] text-ink-muted">
      <div className="text-[11px] uppercase tracking-[0.12em] text-ink-muted mb-1">
        Checks
      </div>
      No CI configured for this project.
    </div>
  );
}

function EmptyState({ sessionId }: { sessionId: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-16 px-6 text-center gap-3">
      <div className="text-[13px] text-ink-muted">
        No pending diffs in this session.
      </div>
      <Link
        to={`/session/${sessionId}`}
        className="text-[12.5px] text-klein-ink hover:underline"
      >
        ← Back to chat
      </Link>
    </div>
  );
}

function MobileFilesSheet({
  diffs,
  selectedId,
  onPick,
  onClose,
}: {
  diffs: PendingDiffEntry[];
  selectedId: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 flex items-start justify-center"
      onClick={onClose}
    >
      <div
        className="w-full bg-canvas border-b border-line rounded-b-[16px] shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-line flex items-center">
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
            Files · {diffs.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-7 px-2 rounded-[6px] border border-line text-[12px]"
          >
            Close
          </button>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto">
          {diffs.map((d) => (
            <FileRow
              key={d.toolUseId}
              entry={d}
              active={d.toolUseId === selectedId}
              onClick={() => onPick(d.toolUseId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
