import { useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  filterSlashCommands,
  type SlashCommand,
} from "@/lib/slash-commands";
import type { SlashClaudexAction } from "@claudex/shared";

/**
 * Slash-command picker. Mobile-first bottom sheet that mirrors the mockup's
 * screen 09 (iPhone · slash sheet): a search input with leading `/`, a list
 * of commands each showing name + description + optional badge, and a hint
 * row at the bottom.
 *
 * Selecting inserts `/<name>` at the composer's cursor — we don't execute
 * anything ourselves. On desktop the same sheet still floats up from the
 * bottom; that keeps the code path single and is close enough to the mockup
 * for MVP.
 *
 * Keyboard navigation is forwarded from the Chat composer textarea via the
 * imperative ref: ↑/↓ moves the selected row, Enter inserts it, Escape
 * closes. This lets the textarea keep native caret behavior while the
 * picker still feels keyboard-driven.
 *
 * "Recent" group: the last 6 picks are persisted in localStorage under
 * `claudex.slash.recents`. Shown as a dedicated section ABOVE the full
 * list, but only when the query is empty — a Recent label next to an
 * already-filtered list would be misleading.
 */

export interface PickerHandle {
  /** Move the highlighted row up or down, wrapping at either end. */
  move: (dir: "up" | "down") => void;
  /** Insert the currently highlighted row, if any. */
  select: () => void;
}

const RECENTS_KEY = "claudex.slash.recents";
const RECENTS_MAX = 6;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function pushRecent(name: string): void {
  try {
    const current = readRecents();
    const next = [name, ...current.filter((v) => v !== name)].slice(0, RECENTS_MAX);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* localStorage quota / private mode — best effort only */
  }
}

/**
 * Wrap the first case-insensitive occurrence of `query` inside `target`
 * in a klein-colored span. Returns a fragment keyed safely for lists.
 * When `query` is empty or not found, returns the plain string.
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

// A single row in the rendered list — either a command or a section header.
// Keeping them in one flat array makes ↑/↓ arithmetic trivial (we just skip
// header rows when moving).
type Row =
  | { kind: "header"; label: string }
  | { kind: "cmd"; cmd: SlashCommand; group: "recent" | "main" };

export const SlashCommandSheet = forwardRef<
  PickerHandle,
  {
    commands: SlashCommand[];
    /** Text typed after the leading `/`, used to pre-filter. */
    initialQuery: string;
    /** Called with the bare command name (no leading slash). */
    onPick: (command: SlashCommand) => void;
    /**
     * Invoked when the user picks a `claudex-action` row. The picker still
     * closes afterward but the token is NOT inserted into the composer —
     * the parent is expected to open the mapped UI (model picker, usage
     * panel, …). When omitted, `claudex-action` rows fall back to `onPick`
     * so the picker stays usable while the parent wires the handler.
     */
    onClaudexAction?: (action: SlashClaudexAction, cmd: SlashCommand) => void;
    onClose: () => void;
  }
>(function SlashCommandSheet(
  { commands, initialQuery, onPick, onClaudexAction, onClose },
  ref,
) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [recentNames, setRecentNames] = useState<string[]>(() => readRecents());
  // One-line hint shown at the bottom of the sheet when the user taps an
  // unsupported row. Cleared when they move the selection or change the
  // query so it doesn't linger past relevance.
  const [hint, setHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // We intentionally don't autofocus the search input. Focus stays in the
  // Chat composer textarea so typing `@foo` after the trigger keeps going
  // to the textarea (and the parent passes `foo` back as `initialQuery`).

  const matches = useMemo(
    () => filterSlashCommands(query, commands),
    [query, commands],
  );

  // Build the flat row list.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const hasQuery = query.trim().length > 0;
    if (!hasQuery && recentNames.length > 0) {
      // Resolve each recent name to the current canonical command entry so
      // kind + description are accurate. Silently drop unknown entries.
      const byName = new Map(commands.map((c) => [c.name, c] as const));
      const recentCmds = recentNames
        .map((n) => byName.get(n))
        .filter((c): c is SlashCommand => !!c);
      if (recentCmds.length > 0) {
        out.push({ kind: "header", label: "Recent" });
        for (const c of recentCmds) out.push({ kind: "cmd", cmd: c, group: "recent" });
      }
      for (const c of matches) out.push({ kind: "cmd", cmd: c, group: "main" });
    } else {
      for (const c of matches) out.push({ kind: "cmd", cmd: c, group: "main" });
    }
    return out;
  }, [matches, recentNames, query, commands]);

  // Indices into `rows` that are selectable commands.
  const cmdIndices = useMemo(
    () => rows.map((r, i) => (r.kind === "cmd" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  // Clamp selection when the underlying list changes.
  useEffect(() => {
    if (selected >= cmdIndices.length) {
      setSelected(Math.max(0, cmdIndices.length - 1));
    }
  }, [cmdIndices.length, selected]);

  function commitPick(cmd: SlashCommand) {
    // Triage by behavior:
    //
    //   - unsupported → never insert, never close. Show a hint at the bottom
    //     so the user knows why nothing happened. Clicking again (or
    //     pressing Enter) is a no-op; they have to dismiss the picker.
    //   - claudex-action → close without inserting; the parent dispatches
    //     the UI action. Fall back to a plain insert if the parent hasn't
    //     wired the handler (keeps the picker usable during rollouts).
    //   - native → insert `/name` into the composer as before.
    //
    // Recents: only record native picks. Recording an unsupported pick
    // would mean the first item a user sees on next open is the one that
    // just silently failed for them, which is awful UX. Claudex-action
    // picks also skip recents — they live in their own affordances
    // (settings sheet, usage panel, …), so promoting them in the slash
    // picker's Recent list is noise.
    const behavior = cmd.behavior;
    if (behavior.kind === "unsupported") {
      setHint(`/${cmd.name} is ${behavior.reason.toLowerCase()}`);
      return;
    }
    if (behavior.kind === "claudex-action") {
      if (onClaudexAction) {
        onClaudexAction(behavior.action, cmd);
        return;
      }
      // Fallback: parent didn't wire the handler — insert like a regular
      // command so nothing is silently lost.
      pushRecent(cmd.name);
      setRecentNames(readRecents());
      onPick(cmd);
      return;
    }
    // native
    pushRecent(cmd.name);
    setRecentNames(readRecents());
    onPick(cmd);
  }

  useImperativeHandle(
    ref,
    () => ({
      move: (dir) => {
        if (cmdIndices.length === 0) return;
        setSelected((i) => {
          if (dir === "down") return (i + 1) % cmdIndices.length;
          return (i - 1 + cmdIndices.length) % cmdIndices.length;
        });
      },
      select: () => {
        const rowIdx = cmdIndices[selected];
        if (rowIdx == null) return;
        const row = rows[rowIdx];
        if (row?.kind === "cmd") commitPick(row.cmd);
      },
    }),
    [cmdIndices, selected, rows],
  );

  // Keep the selected row in view when it changes (keyboard nav).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-picker-row="${selected}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const matchLabel = `${matches.length} ${matches.length === 1 ? "match" : "matches"}`;

  return (
    <div
      className="fixed inset-0 z-30 bg-ink/50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Slash commands"
        className="w-full sm:max-w-xl bg-canvas border-t sm:border border-line rounded-t-[24px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[80vh] sm:max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile affordance) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header / search label + close */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted">
              Slash commands
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

        {/* Search row — mockup s-09 iPhone slash sheet */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 h-10 px-3 rounded-[8px] bg-paper border border-line">
            <span className="mono text-klein text-[15px] leading-none">/</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(0);
                if (hint) setHint(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const rowIdx = cmdIndices[selected];
                  if (rowIdx != null) {
                    const row = rows[rowIdx];
                    if (row?.kind === "cmd") commitPick(row.cmd);
                  }
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  if (cmdIndices.length > 0) {
                    setSelected((i) => (i + 1) % cmdIndices.length);
                  }
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  if (cmdIndices.length > 0) {
                    setSelected(
                      (i) => (i - 1 + cmdIndices.length) % cmdIndices.length,
                    );
                  }
                }
              }}
              placeholder="Filter commands…"
              className="flex-1 bg-transparent outline-none text-[15px]"
            />
            <span className="caps text-ink-muted">{matchLabel}</span>
          </div>
        </div>

        {/* List */}
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 border-t border-line"
        >
          {rows.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              No commands match “{query}”.
            </div>
          ) : (
            rows.map((row, i) => {
              if (row.kind === "header") {
                return (
                  <div
                    key={`h:${row.label}:${i}`}
                    className="px-3 pt-3 pb-1 caps text-ink-muted"
                  >
                    {row.label}
                  </div>
                );
              }
              const cmd = row.cmd;
              const selIdx = cmdIndices.indexOf(i);
              const isSelected = selIdx === selected;
              const isSkill = cmd.kind === "plugin";
              const unsupported = cmd.behavior.kind === "unsupported";
              const isAction = cmd.behavior.kind === "claudex-action";
              // Small trailing badge: REPL-only for unsupported, "ui" for
              // claudex-action. Keep to 10px uppercase to match the kind
              // badge rhythm; colored differently so it reads as metadata,
              // not category.
              const behaviorBadge = unsupported
                ? "REPL only"
                : isAction
                ? "UI"
                : null;
              return (
                <button
                  key={`${cmd.kind}:${cmd.name}:${row.group}`}
                  data-picker-row={selIdx}
                  onClick={() => commitPick(cmd)}
                  onMouseEnter={() => {
                    setSelected(selIdx);
                    if (hint) setHint(null);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-[8px] text-left",
                    isSelected
                      ? "bg-klein-wash/40 border border-klein/30"
                      : "border border-transparent hover:bg-paper/60",
                    unsupported && "opacity-60",
                  )}
                  title={
                    cmd.behavior.kind === "unsupported"
                      ? cmd.behavior.reason
                      : undefined
                  }
                >
                  <span
                    className={cn(
                      "h-7 w-7 rounded-[6px] flex items-center justify-center mono text-[12px] shrink-0",
                      isSelected
                        ? "bg-klein text-canvas"
                        : isSkill
                        ? "bg-paper text-klein-ink"
                        : "bg-paper text-ink-muted",
                    )}
                  >
                    {isSkill ? "sk" : "/"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "text-[14px] mono truncate",
                        isSelected && "font-medium",
                      )}
                    >
                      /{highlightMatch(cmd.name, query)}
                    </div>
                    {cmd.description && (
                      <div className="text-[12px] text-ink-muted truncate">
                        {cmd.description}
                      </div>
                    )}
                  </div>
                  {behaviorBadge && (
                    <span className="mono text-[10px] text-ink-faint uppercase tracking-[0.1em] shrink-0">
                      {behaviorBadge}
                    </span>
                  )}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[10px] uppercase tracking-[0.1em] shrink-0 border",
                      isSkill
                        ? "border-klein/30 bg-klein-wash text-klein-ink"
                        : "border-line bg-paper",
                    )}
                  >
                    {isSkill ? "skill" : cmd.kind}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer hint — mockup: "Tap to insert · long-press for details" + "⏎ select".
            When a user taps an unsupported row, the hint slot shows *why*
            the row didn't insert. The hint replaces the default help text
            so the message reads as the primary signal. */}
        <div className="px-4 py-3 border-t border-line flex items-center text-[11px] text-ink-muted">
          {hint ? (
            <span className="text-danger/80" role="status">
              {hint}
            </span>
          ) : (
            <>
              <span>Tap to insert · ↑↓ navigate</span>
              <span className="ml-auto mono">⏎ select</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
