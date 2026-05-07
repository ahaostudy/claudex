import { diffForToolCall, type FileDiff } from "@/lib/diff";
import { cn } from "@/lib/cn";

export function DiffView({ diff }: { diff: FileDiff }) {
  return (
    <div className="rounded-[10px] border border-line bg-canvas overflow-hidden w-fit max-w-full">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-paper border-b border-line">
        <span className="mono text-[12px] text-ink-soft truncate">
          {diff.path}
        </span>
        <span className="text-[11px] mono text-success">
          +{diff.addCount}
        </span>
        <span className="text-[11px] mono text-danger">−{diff.delCount}</span>
        <span className="ml-auto text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          {diff.kind}
        </span>
      </div>
      <div className="overflow-x-auto">
        {diff.hunks.map((h, hi) => (
          <div key={hi}>
            <div className="mono text-[11px] px-3 py-1 bg-paper/60 text-ink-muted border-b border-line/60">
              {h.header}
            </div>
            <div className="mono text-[12px]">
              {h.lines.map((ln, i) => (
                <div
                  key={i}
                  className={cn(
                    "grid grid-cols-[36px_36px_16px_1fr]",
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
                  <div className="pr-3 whitespace-pre-wrap break-words">
                    {ln.text || " "}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function toolCallToDiff(
  name: string,
  input: Record<string, unknown>,
): FileDiff | null {
  return diffForToolCall(name, input);
}
