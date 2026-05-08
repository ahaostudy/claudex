import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  ListOrdered,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type {
  ModelId,
  PermissionMode,
  Project,
  QueuedPrompt,
  QueueStatus,
} from "@claudex/shared";
import { api, ApiError } from "@/api/client";
import { AppShell } from "@/components/AppShell";

/**
 * Queue screen — the user composes several prompts and the server dispatches
 * them one at a time as fresh sessions. Independent of Routines because the
 * scheduling model is different ("run these now, in order" vs. "fire on a
 * cron").
 *
 * Live updates:
 *   - The server broadcasts a `queue_update` WS frame on every mutation of
 *     the queued_prompts table (create, patch, delete, move, runner status
 *     transitions). The Sessions WS client forwards those to a
 *     `claudex:queue_update` window event (see web/src/state/sessions.ts)
 *     and we refetch on receipt. No polling — a stale browser tab left on
 *     this screen stays honest for days.
 *   - On any local mutation (create / delete / reorder / patch) we still
 *     refetch immediately so the UI reflects the change before the server
 *     broadcast round-trips back.
 *
 * Drag-and-drop reorder (desktop md+): each queued row is draggable. The
 * onDragOver handler computes whether the cursor is in the top or bottom
 * half of the target row and paints a thin klein indicator line. onDrop
 * computes an absolute target index from the drop position and calls
 * `POST /api/queue/:id/move {seq}` — the server clamps the seq so
 * dropping past the end is a no-op rather than a 400. Mobile keeps the
 * up/down chevron buttons untouched.
 */
export function QueueScreen() {
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<QueuedPrompt | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Drag state. draggingId is the row being carried; dropTarget captures the
  // row we're hovering over + "above" / "below" so we can paint the indicator
  // in the right place. Nullable so the SSR / initial-render path renders
  // without flicker.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    { id: string; position: "above" | "below" } | null
  >(null);
  // Desktop keyboard reorder: when the user presses Space/Enter on a queued
  // row, we arm "reorder mode" for that row. While armed, Arrow Up/Down
  // call the same move API the chevron buttons use; Escape or Space/Enter
  // toggles back out. Mouse drag is unaffected.
  const [kbdReorderId, setKbdReorderId] = useState<string | null>(null);
  // Two-step cancel confirm state keyed by row id. First click swaps the
  // button label to "Click again to cancel" and arms a 3s reset; second
  // click within the window fires the actual cancel. Matches the
  // Session Settings Delete / Trust-revoke pattern so the vocabulary is
  // consistent across the app.
  const [cancelConfirmingId, setCancelConfirmingId] = useState<string | null>(
    null,
  );
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh() {
    try {
      const [q, p] = await Promise.all([api.listQueue(), api.listProjects()]);
      setQueue(q.queue);
      setProjects(p.projects);
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "load failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // Subscribe to the global queue-update bus. Replaces the 5s setInterval
    // poll — the server guarantees a broadcast on every state change that
    // matters here (see QueueStore.onChange in server/src/queue/store.ts).
    const handler = () => {
      void refresh();
    };
    window.addEventListener("claudex:queue_update", handler);
    return () => {
      window.removeEventListener("claudex:queue_update", handler);
    };
  }, []);

  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  // Clean up the dangling cancel-confirm timer on unmount.
  useEffect(() => {
    return () => {
      if (cancelTimerRef.current) {
        clearTimeout(cancelTimerRef.current);
        cancelTimerRef.current = null;
      }
    };
  }, []);

  async function cancel(row: QueuedPrompt) {
    // Two-step confirm inline (replaces the native window.confirm() which
    // broke focus on mobile + was un-styleable). First press arms, second
    // press within 3s fires. Any other row's press or a 3s tick resets.
    if (cancelConfirmingId !== row.id) {
      setCancelConfirmingId(row.id);
      if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = setTimeout(() => {
        setCancelConfirmingId(null);
        cancelTimerRef.current = null;
      }, 3000);
      return;
    }
    if (cancelTimerRef.current) {
      clearTimeout(cancelTimerRef.current);
      cancelTimerRef.current = null;
    }
    setCancelConfirmingId(null);
    setErr(null);
    try {
      await api.deleteQueued(row.id);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "cancel failed");
    }
  }

  async function reorder(row: QueuedPrompt, direction: "up" | "down") {
    setErr(null);
    try {
      await api.reorderQueued(row.id, direction);
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "reorder failed");
    }
  }

  // Escape at the screen level: exit keyboard reorder mode (if armed) or
  // dismiss the cancel-confirm pulse. Editor modal owns its own Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (kbdReorderId) {
        setKbdReorderId(null);
      } else if (cancelConfirmingId) {
        if (cancelTimerRef.current) {
          clearTimeout(cancelTimerRef.current);
          cancelTimerRef.current = null;
        }
        setCancelConfirmingId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbdReorderId, cancelConfirmingId]);

  /**
   * Move `sourceId` to the position of `targetId` in the queued sub-list.
   * `position` says whether to land above or below the target. We compute
   * the absolute index within the current queued-only slice and POST it to
   * `/api/queue/:id/move`. Optimistically applies the same splice locally
   * so the UI doesn't flicker while the server round-trips.
   */
  async function moveByDrop(
    sourceId: string,
    targetId: string,
    position: "above" | "below",
  ) {
    if (sourceId === targetId) return;
    const queuedOnly = queue.filter((r) => r.status === "queued");
    const srcIdx = queuedOnly.findIndex((r) => r.id === sourceId);
    const tgtIdx = queuedOnly.findIndex((r) => r.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1) return;
    // "Above target" lands the row at the target's index; "below target"
    // lands it at target.index + 1. When moving downward, splicing out the
    // source first shifts everything after it up by one, so the target's
    // effective index is one lower than its pre-splice index. Account for
    // that here so the final index matches the user's visual drop.
    let finalIdx = position === "above" ? tgtIdx : tgtIdx + 1;
    if (srcIdx < finalIdx) finalIdx -= 1;
    if (finalIdx === srcIdx) return;

    // Optimistic local reorder: rebuild the queued sub-list with the moved
    // item in its new position, then re-weave it with the non-queued rows
    // (running / done / failed / cancelled) at their original indices. The
    // drag only affects queued rows — finished rows' visual position is
    // whatever it was before the drop.
    const queuedIds = queuedOnly.map((r) => r.id);
    const [movedId] = queuedIds.splice(srcIdx, 1);
    queuedIds.splice(finalIdx, 0, movedId);
    const queuedById = new Map(queuedOnly.map((r) => [r.id, r]));
    const reorderedQueued = queuedIds.map((id) => queuedById.get(id)!);
    const nextFull: QueuedPrompt[] = [];
    let qCursor = 0;
    for (const row of queue) {
      if (row.status === "queued") {
        nextFull.push(reorderedQueued[qCursor++]);
      } else {
        nextFull.push(row);
      }
    }
    setQueue(nextFull);

    setErr(null);
    try {
      await api.moveQueued(sourceId, finalIdx);
      // No refresh() here — the server broadcasts a queue_update which will
      // refetch us. Keeps the success path single-fetch. If the server
      // rejects we refetch to resync.
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "reorder failed");
      await refresh();
    }
  }

  return (
    <AppShell tab="queue">
      <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-line px-5 py-3 flex items-center gap-3">
        <div>
          <div className="caps text-ink-muted">Queue</div>
          <h1 className="display text-[1.25rem] leading-tight mt-0.5">Batch</h1>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-[8px] bg-klein text-canvas text-[13px] font-medium shadow-card"
        >
          <Plus className="w-4 h-4" />
          New item
        </button>
      </header>

      <section className="flex-1 min-h-0 overflow-y-auto pb-20 md:pb-6">
        {loading ? (
          <div className="text-[13px] text-ink-muted text-center py-10 mono">
            loading…
          </div>
        ) : queue.length === 0 ? (
          <div className="max-w-[900px] mx-auto w-full px-4 md:px-6 py-6">
            <div className="rounded-[12px] border border-dashed border-line-strong p-8 text-center">
              <ListOrdered className="w-6 h-6 mx-auto text-ink-muted mb-2" />
              <div className="display text-[1.1rem] mb-1">
                No prompts queued.
              </div>
              <div className="text-[13px] text-ink-muted max-w-[40ch] mx-auto">
                Line up several prompts and claudex will run them sequentially,
                each in its own fresh session. Useful for "go fix these four
                issues while I'm away".
              </div>
            </div>
          </div>
        ) : (
          <ul>
            {(() => {
              const queuedTotal = queue.filter(
                (r) => r.status === "queued",
              ).length;
              let queuedIdx = 0;
              return queue.map((row, idx) => {
                const project = projectsById.get(row.projectId);
                const queuedPos =
                  row.status === "queued" ? ++queuedIdx : null;
                return (
                  <QueueRow
                    key={row.id}
                    row={row}
                    project={project}
                    queuedPos={queuedPos}
                    queuedTotal={queuedTotal}
                    canMoveUp={
                      row.status === "queued" &&
                      queue
                        .slice(0, idx)
                        .some((r) => r.status === "queued")
                    }
                    canMoveDown={
                      row.status === "queued" &&
                      queue
                        .slice(idx + 1)
                        .some((r) => r.status === "queued")
                    }
                    draggingId={draggingId}
                    dropTarget={dropTarget}
                    kbdReorderActive={kbdReorderId === row.id}
                    cancelConfirming={cancelConfirmingId === row.id}
                    onToggleKbdReorder={() => {
                      if (row.status !== "queued") return;
                      setKbdReorderId((prev) =>
                        prev === row.id ? null : row.id,
                      );
                    }}
                    onExitKbdReorder={() => setKbdReorderId(null)}
                    onDragStart={(e) => {
                      if (row.status !== "queued") return;
                      setDraggingId(row.id);
                      e.dataTransfer.effectAllowed = "move";
                      try {
                        e.dataTransfer.setData("text/plain", row.id);
                      } catch {
                        // Firefox requires a setData call; some browsers throw
                        // if the dataTransfer is in a protected state. Ignore.
                      }
                    }}
                    onDragOver={(e) => {
                      if (!draggingId || row.status !== "queued") return;
                      if (draggingId === row.id) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      const rect = (
                        e.currentTarget as HTMLLIElement
                      ).getBoundingClientRect();
                      const above =
                        e.clientY - rect.top < rect.height / 2;
                      setDropTarget({
                        id: row.id,
                        position: above ? "above" : "below",
                      });
                    }}
                    onDragLeave={() => {
                      // Only clear if the current target matches — otherwise a
                      // sibling's onDragOver has already set the new target.
                      setDropTarget((prev) =>
                        prev && prev.id === row.id ? null : prev,
                      );
                    }}
                    onDrop={(e) => {
                      if (!draggingId) return;
                      e.preventDefault();
                      const position =
                        dropTarget && dropTarget.id === row.id
                          ? dropTarget.position
                          : "above";
                      void moveByDrop(draggingId, row.id, position);
                      setDraggingId(null);
                      setDropTarget(null);
                    }}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDropTarget(null);
                    }}
                    onEdit={() => setEditing(row)}
                    onCancel={() => cancel(row)}
                    onReorder={async (dir) => {
                      await reorder(row, dir);
                    }}
                  />
                );
              });
            })()}
          </ul>
        )}
        {err && (
          <div className="mx-4 md:mx-6 my-3 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
      </section>

      {(creating || editing) && (
        <QueueEditor
          initial={editing}
          projects={projects}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </AppShell>
  );
}

function QueueRow({
  row,
  project,
  queuedPos,
  queuedTotal,
  canMoveUp,
  canMoveDown,
  draggingId,
  dropTarget,
  kbdReorderActive,
  cancelConfirming,
  onToggleKbdReorder,
  onExitKbdReorder,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onEdit,
  onCancel,
  onReorder,
}: {
  row: QueuedPrompt;
  project: Project | undefined;
  queuedPos: number | null;
  queuedTotal: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  draggingId: string | null;
  dropTarget: { id: string; position: "above" | "below" } | null;
  kbdReorderActive: boolean;
  cancelConfirming: boolean;
  onToggleKbdReorder: () => void;
  onExitKbdReorder: () => void;
  onDragStart: (e: React.DragEvent<HTMLLIElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLLIElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLLIElement>) => void;
  onDrop: (e: React.DragEvent<HTMLLIElement>) => void;
  onDragEnd: (e: React.DragEvent<HTMLLIElement>) => void;
  onEdit: () => void;
  onCancel: () => void;
  onReorder: (direction: "up" | "down") => void | Promise<void>;
}) {
  const navigate = useNavigate();
  const liRef = useRef<HTMLLIElement | null>(null);
  const title =
    row.title && row.title.trim().length > 0
      ? row.title
      : row.prompt.split(/\r?\n/, 1)[0]?.slice(0, 60) ?? "(empty prompt)";

  const isDraggable = row.status === "queued";
  const isBeingDragged = draggingId === row.id;
  const indicatorAbove =
    dropTarget?.id === row.id && dropTarget.position === "above";
  const indicatorBelow =
    dropTarget?.id === row.id && dropTarget.position === "below";

  // Keep focus on the moved row across reorders. The parent refetches the
  // queue and the row re-mounts under the same id, so we re-focus on every
  // render where reorder mode is armed and the element isn't already the
  // active element. Cheap and avoids the usual "list moved, focus fell back
  // to body" papercut that makes keyboard reorder unusable.
  useEffect(() => {
    if (!kbdReorderActive) return;
    const el = liRef.current;
    if (!el) return;
    if (document.activeElement !== el) el.focus();
  });

  async function handleKbdReorder(direction: "up" | "down") {
    if (!isDraggable) return;
    if (direction === "up" && !canMoveUp) return;
    if (direction === "down" && !canMoveDown) return;
    await onReorder(direction);
    // Re-assert focus after the list reshuffles. React reuses the li via
    // the stable key, but blurs on some browsers during the reorder API
    // round-trip — pull focus back.
    requestAnimationFrame(() => {
      liRef.current?.focus();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLLIElement>) {
    // Only the row itself — not bubbled keystrokes from inner buttons.
    if (e.target !== e.currentTarget) return;
    if (!isDraggable) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      onToggleKbdReorder();
      return;
    }
    if (e.key === "Escape" && kbdReorderActive) {
      e.preventDefault();
      onExitKbdReorder();
      return;
    }
    if (kbdReorderActive && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      void handleKbdReorder(e.key === "ArrowUp" ? "up" : "down");
    }
  }

  // Desktop uses native HTML5 drag for mouse users and Space/Arrow-key
  // reorder for keyboard users. Mobile keeps the up/down chevron buttons
  // as the accessible alternative for thumb reach. `role="button"` +
  // `tabIndex={0}` on queued rows makes the row itself a reorder handle
  // when focused; inner buttons still keep their own tab stops.

  return (
    <li
      ref={liRef}
      draggable={isDraggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onKeyDown={isDraggable ? onKeyDown : undefined}
      tabIndex={isDraggable ? 0 : undefined}
      role={isDraggable ? "button" : undefined}
      aria-grabbed={isDraggable ? kbdReorderActive : undefined}
      aria-label={
        isDraggable && queuedPos != null
          ? `Queue item ${queuedPos} of ${queuedTotal} — press space then arrow keys to reorder`
          : undefined
      }
      className={`relative px-4 md:px-6 py-3 border-b border-line hover:bg-paper/40 focus:outline-none ${
        kbdReorderActive
          ? "ring-2 ring-klein ring-inset bg-klein/5"
          : "focus-visible:ring-2 focus-visible:ring-klein/60 focus-visible:ring-inset"
      } ${isBeingDragged ? "opacity-40" : ""}`}
    >
      {indicatorAbove && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 -top-[1px] h-[2px] bg-klein"
        />
      )}
      {indicatorBelow && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 -bottom-[1px] h-[2px] bg-klein"
        />
      )}
      <div className="flex items-center gap-3">
        {isDraggable && (
          <GripVertical
            className="hidden md:block w-4 h-4 text-ink-faint shrink-0 cursor-grab active:cursor-grabbing"
            aria-hidden
          />
        )}
        <StatusDot status={row.status} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium truncate">{title}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-muted flex-wrap">
            {project ? (
              <span className="mono truncate">{project.name}</span>
            ) : (
              <span className="mono text-danger truncate">
                (project gone)
              </span>
            )}
            <span>·</span>
            <span className="mono">{row.model ?? "opus-4-7"}</span>
            <span>·</span>
            <span className="mono">{row.mode ?? "default"}</span>
            {row.worktree && (
              <>
                <span>·</span>
                <span className="mono">worktree</span>
              </>
            )}
            {kbdReorderActive && (
              <>
                <span>·</span>
                <span className="mono text-klein">
                  reorder mode — ↑/↓ to move, Esc to exit
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {row.status === "queued" ? (
            <>
              <button
                onClick={() => onReorder("up")}
                disabled={!canMoveUp}
                className="md:hidden h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas disabled:opacity-40"
                title="Move up"
                aria-label="Move up"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onReorder("down")}
                disabled={!canMoveDown}
                className="md:hidden h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas disabled:opacity-40"
                title="Move down"
                aria-label="Move down"
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onEdit}
                className="h-8 w-8 rounded-[6px] border border-line flex items-center justify-center text-ink-soft hover:bg-canvas"
                title="Edit"
                aria-label="Edit queued item"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onCancel}
                title={cancelConfirming ? "Click again to cancel" : "Remove"}
                aria-label={
                  cancelConfirming
                    ? "Click again to cancel"
                    : "Remove queued item"
                }
                className={`h-8 rounded-[6px] flex items-center justify-center text-[12px] ${
                  cancelConfirming
                    ? "px-2.5 bg-danger text-canvas border border-danger"
                    : "w-8 border border-line text-danger hover:bg-danger-wash"
                }`}
              >
                {cancelConfirming ? (
                  "Click again"
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
              </button>
            </>
          ) : row.status === "running" ? (
            <>
              {row.sessionId && (
                <button
                  onClick={() => navigate(`/session/${row.sessionId}`)}
                  className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] hover:bg-canvas"
                >
                  Open session →
                </button>
              )}
              <button
                onClick={onCancel}
                aria-label={
                  cancelConfirming
                    ? "Click again to cancel"
                    : "Stop running prompt"
                }
                className={`h-8 px-2.5 rounded-[6px] text-[12px] ${
                  cancelConfirming
                    ? "bg-danger text-canvas border border-danger"
                    : "border border-line text-danger hover:bg-danger-wash"
                }`}
              >
                {cancelConfirming ? "Click again to cancel" : "Stop"}
              </button>
            </>
          ) : (
            row.sessionId && (
              <button
                onClick={() => navigate(`/session/${row.sessionId}`)}
                className="h-8 px-2.5 rounded-[6px] border border-line text-[12px] hover:bg-canvas"
              >
                Open session →
              </button>
            )
          )}
        </div>
      </div>
    </li>
  );
}

function StatusDot({ status }: { status: QueueStatus }) {
  const cls =
    status === "queued"
      ? "bg-ink-faint"
      : status === "running"
        ? "bg-success animate-pulse"
        : status === "done"
          ? "bg-ink-faint"
          : status === "cancelled"
            ? "bg-line-strong"
            : "bg-danger";
  return (
    <span
      className={`h-2 w-2 rounded-full shrink-0 ${cls}`}
      title={status}
      aria-label={status}
    />
  );
}

function QueueEditor({
  initial,
  projects,
  onCancel,
  onSaved,
}: {
  initial: QueuedPrompt | null;
  projects: Project[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(
    initial?.projectId ?? projects[0]?.id ?? "",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [model, setModel] = useState<ModelId>(
    initial?.model ?? "claude-opus-4-7",
  );
  const [mode, setMode] = useState<PermissionMode>(initial?.mode ?? "default");
  const [worktree, setWorktree] = useState<boolean>(initial?.worktree ?? false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Autofocus target: the first editable input on mount. On new items that's
  // the project select (or the title field if there's only one project).
  // On edit that's the title input — the project select is frozen and the
  // prompt is the primary action but a screen-reader user lands on the
  // title so they can orient via "Edit queued item: <title>".
  const cardRef = useRef<HTMLDivElement | null>(null);
  const firstInputRef = useRef<
    HTMLSelectElement | HTMLInputElement | null
  >(null);

  // Autofocus the first input once on mount. Running in an effect (rather
  // than `autoFocus`) so it also works when the modal is re-used across
  // create → edit transitions without an unmount.
  useEffect(() => {
    const t = setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  // Escape closes. Focus trap: Tab cycles within the modal card so the
  // user can't accidentally land on a background control (which is also
  // inert visually under the z-40 scrim but still in the tab order).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card) return;
      const focusables = card.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function save() {
    setErr(null);
    if (!initial && !projectId) return setErr("Pick a project first.");
    if (!prompt.trim()) return setErr("Prompt can't be empty.");
    setBusy(true);
    try {
      if (initial) {
        await api.updateQueued(initial.id, {
          prompt: prompt.trim(),
          title: title.trim() || undefined,
          model,
          mode,
          worktree,
        });
      } else {
        await api.createQueued({
          projectId,
          prompt: prompt.trim(),
          title: title.trim() || undefined,
          model,
          mode,
          worktree,
        });
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.code : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 flex items-end sm:items-center justify-center"
      onMouseDown={(e) => {
        // Click-outside-to-close: only when the mousedown originated on the
        // scrim itself, not on a child (prevents a drag that ends outside
        // the card from dismissing the editor).
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="queue-editor-title"
        className="w-full sm:max-w-lg bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[90vh]"
      >
        <div className="flex items-center p-4 border-b border-line">
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              {initial ? "Edit queued item" : "New queued item"}
            </div>
            <h2
              id="queue-editor-title"
              className="display text-[1.25rem] leading-tight mt-0.5"
            >
              {initial ? "Tweak before it runs." : "Compose a batch item."}
            </h2>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close editor"
            className="ml-auto h-8 w-8 rounded-[8px] border border-line flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Project
            </div>
            {initial ? (
              <div className="px-3 py-2.5 border border-line rounded-[8px] text-[13px] text-ink-muted">
                {projects.find((p) => p.id === initial.projectId)?.name ??
                  initial.projectId}
                <span className="mono text-[11px] ml-2">
                  (can't change after queue)
                </span>
              </div>
            ) : projects.length === 0 ? (
              <div className="px-3 py-2.5 border border-dashed border-line-strong rounded-[8px] text-[13px] text-ink-muted">
                No projects yet. Add one from the New Session sheet first.
              </div>
            ) : (
              <select
                ref={(el) => {
                  // Autofocus target on the create flow (no `initial`). On
                  // edit, the project select isn't rendered so the ref
                  // falls through to the title input below.
                  if (!initial) firstInputRef.current = el;
                }}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.path}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Title (optional)
            </div>
            <input
              ref={(el) => {
                // On the edit flow the project select is frozen, so the
                // title input becomes the autofocus target.
                if (initial) firstInputRef.current = el;
              }}
              className="w-full h-10 px-3 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Fix failing CI test"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Prompt
            </div>
            <textarea
              rows={5}
              className="w-full px-3 py-2 bg-canvas border border-line rounded-[8px] text-[14px]"
              placeholder="Describe what claude should do…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div>
            <div className="text-[12px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              Model
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
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            <span>Use git worktree (if the project is a repo)</span>
          </label>
        </div>
        {err && (
          <div className="mx-4 mb-2 text-[13px] text-danger bg-danger-wash rounded-[8px] px-3 py-2 border border-danger/30">
            {err}
          </div>
        )}
        <div className="p-4 border-t border-line flex gap-2">
          <button
            onClick={onCancel}
            className="h-11 px-4 rounded-[8px] border border-line text-[13px]"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy}
            className="flex-1 h-11 rounded-[8px] bg-ink text-canvas text-[13px] font-medium disabled:opacity-50"
          >
            {busy ? "Saving…" : initial ? "Save changes" : "Add to queue"}
          </button>
        </div>
      </div>
    </div>
  );
}
