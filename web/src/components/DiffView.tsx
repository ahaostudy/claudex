import { useState } from "react";
import { ChevronRight, FilePlus, PencilLine } from "lucide-react";
import { diffForToolCall, type FileDiff } from "@/lib/diff";
import { cn } from "@/lib/cn";

/**
 * Diff card with a collapsible header. Default state is expanded (opens
 * without user input) so reviewers see changes immediately; the chevron
 * just lets them fold noise away mid-thread.
 *
 * Layout notes: the outer div is `w-full` by default so when a parent
 * (permission card, mid-thread Edit tool block) constrains width, the
 * diff fills that column and the hunk grid scrolls horizontally inside.
 *
 * `headerless` strips the outer card + chevron header and emits just the
 * hunk grid at page width. Used by screens (SessionDiff) that already own
 * a per-file row header and don't want the double-header, double-border
 * look. Also implies "always open" since there's no chevron to toggle.
 */
export function DiffView({
  diff,
  defaultOpen = false,
  headerless = false,
}: {
  diff: FileDiff;
  defaultOpen?: boolean;
  headerless?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (headerless) {
    return (
      <div className="w-full overflow-x-auto bg-canvas">
        {diff.hunks.map((h, hi) => (
          <div key={hi} className="w-max min-w-full">
            <div className="mono text-[11px] px-3 py-1 bg-paper/60 text-ink-muted border-t border-b border-line/60 min-w-full">
              {h.header}
            </div>
            <div className="mono text-[12px] min-w-full">
              {h.lines.map((ln, i) => (
                <div
                  key={i}
                  className={cn(
                    "grid grid-cols-[36px_36px_16px_max-content]",
                    ln.kind === "add" && "bg-success-wash/60",
                    ln.kind === "del" && "bg-danger-wash/60",
                  )}
                >
                  <div className="text-right pr-1 text-ink-faint select-none">
                    {ln.oldNum ?? ""}
                  </div>
                  <div className="text-right pr-1 text-ink-faint select-none">
                    {ln.newNum ?? ""}
                  </div>
                  <div className="text-center text-ink-muted select-none">
                    {ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " "}
                  </div>
                  <div className="pr-3 whitespace-pre">
                    {ln.text || " "}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Compact header pattern — matches the look of other tool rows
  // (Read/Bash/Grep/…): [chevron] [kind-icon] LABEL  {file}  +N −N.
  //
  //   - Chevron sits at the FAR LEFT so all tool rows line up visually.
  //   - Icons come from the same set the ToolGroup strip uses
  //     (lib/tool-summary): PencilLine for Edit, FilePlus for Write —
  //     whether the Write creates a new file (kind="create") or
  //     overwrites an existing one (kind="overwrite").
  //   - LABEL is the action verb uppercase; file is the basename only
  //     (full path in the title so mobile hover/tap shows it).
  const label =
    diff.kind === "create"
      ? "CREATE"
      : diff.kind === "overwrite"
        ? "OVERWRITE"
        : "EDIT";
  const KindIcon = diff.kind === "edit" ? PencilLine : FilePlus;
  const slash = diff.path.lastIndexOf("/");
  const basename = slash >= 0 ? diff.path.slice(slash + 1) : diff.path;

  return (
    <div
      className={cn(
        "rounded-[10px] border border-line bg-canvas overflow-clip",
        open ? "w-full" : "w-fit max-w-full",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 bg-paper border-b border-line text-left hover:bg-paper/80 max-w-full min-w-0"
        title={diff.path}
      >
        <ChevronRight
          className={cn(
            "w-3 h-3 text-ink-muted shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <KindIcon className="w-3.5 h-3.5 text-ink-muted shrink-0" />
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-ink-muted shrink-0">
          {label}
        </span>
        <span
          className="mono text-[12px] text-ink-soft truncate min-w-0 flex-1"
        >
          {basename}
        </span>
        <span className="text-[11px] mono text-success shrink-0">
          +{diff.addCount}
        </span>
        <span className="text-[11px] mono text-danger shrink-0">−{diff.delCount}</span>
      </button>
      {open && (
        <div className="w-full overflow-x-auto">
          {diff.hunks.map((h, hi) => (
            <div key={hi} className="w-max min-w-full">
              <div className="mono text-[11px] px-3 py-1 bg-paper/60 text-ink-muted border-b border-line/60 min-w-full">
                {h.header}
              </div>
              <div className="mono text-[12px] min-w-full">
                {h.lines.map((ln, i) => (
                  <div
                    key={i}
                    className={cn(
                      "grid grid-cols-[36px_36px_16px_max-content]",
                      ln.kind === "add" && "bg-success-wash/60",
                      ln.kind === "del" && "bg-danger-wash/60",
                    )}
                  >
                    <div className="text-right pr-1 text-ink-faint select-none">
                      {ln.oldNum ?? ""}
                    </div>
                    <div className="text-right pr-1 text-ink-faint select-none">
                      {ln.newNum ?? ""}
                    </div>
                    <div className="text-center text-ink-muted select-none">
                      {ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : " "}
                    </div>
                    <div className="pr-3 whitespace-pre">
                      {ln.text || " "}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function toolCallToDiff(
  name: string,
  input: Record<string, unknown>,
): FileDiff | null {
  return diffForToolCall(name, input);
}
