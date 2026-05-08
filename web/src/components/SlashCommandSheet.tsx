import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  filterSlashCommands,
  type SlashCommand,
} from "@/lib/slash-commands";

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
 * The `commands` list is provided by the parent: today it comes from
 * `GET /api/slash-commands`, which merges the CLI built-ins, the user's
 * `~/.claude/commands/*.md`, and the project's `.claude/commands/*.md`.
 */
export function SlashCommandSheet({
  commands,
  initialQuery,
  onPick,
  onClose,
}: {
  commands: SlashCommand[];
  /** Text typed after the leading `/`, used to pre-filter. */
  initialQuery: string;
  /** Called with the bare command name (no leading slash). */
  onPick: (command: SlashCommand) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // We intentionally don't autofocus the search input. Focus stays in the
  // Chat composer textarea so typing `@foo` after the trigger keeps going
  // to the textarea (and the parent passes `foo` back as `initialQuery`).
  // Users who want to refine the query via this sheet can tap the search
  // pill. That keeps delete / backspace / ESC behavior intuitive — the
  // textarea stays responsive whether the picker is open or not.

  const matches = filterSlashCommands(query, commands);

  return (
    <div
      className="fixed inset-0 z-30 bg-ink/50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-xl bg-canvas border-t sm:border border-line rounded-t-[20px] sm:rounded-[14px] shadow-lift flex flex-col max-h-[80vh] sm:max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag handle (mobile affordance) */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-12 bg-line-strong rounded-full" />
        </div>

        {/* Header / search */}
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
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 h-10 px-3 rounded-[8px] bg-paper border border-line">
            <span className="mono text-klein text-[15px] leading-none">/</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (matches[0]) onPick(matches[0]);
                }
              }}
              placeholder="Filter commands…"
              className="flex-1 bg-transparent outline-none text-[15px]"
            />
            <span className="caps text-ink-muted">
              {matches.length} {matches.length === 1 ? "match" : "matches"}
            </span>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 border-t border-line">
          {matches.length === 0 ? (
            <div className="text-[13px] text-ink-muted text-center py-10">
              No commands match “{query}”.
            </div>
          ) : (
            matches.map((cmd, i) => (
              <button
                key={`${cmd.kind}:${cmd.name}`}
                onClick={() => onPick(cmd)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-[8px] text-left",
                  i === 0
                    ? "bg-klein-wash/40 border border-klein/30"
                    : "hover:bg-paper/60 border border-transparent",
                )}
              >
                <span
                  className={cn(
                    "h-7 w-7 rounded-[6px] flex items-center justify-center mono text-[12px] shrink-0",
                    i === 0
                      ? "bg-klein text-canvas"
                      : "bg-paper text-ink-muted",
                  )}
                >
                  /
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium mono">
                    <span className={i === 0 ? "text-klein" : "text-ink"}>
                      /{cmd.name}
                    </span>
                  </div>
                  {cmd.description && (
                    <div className="text-[12px] text-ink-muted truncate">
                      {cmd.description}
                    </div>
                  )}
                </div>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] border border-line bg-paper text-[10px] uppercase tracking-[0.1em] shrink-0">
                  {cmd.kind}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer hint — mirrors mockup's "Tap to insert · ⏎ select" */}
        <div className="px-4 py-3 border-t border-line flex items-center text-[11px] text-ink-muted">
          <span>Tap to insert</span>
          <span className="ml-auto mono">⏎ select first</span>
        </div>
      </div>
    </div>
  );
}
