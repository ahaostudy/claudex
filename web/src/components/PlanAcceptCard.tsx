import { useState } from "react";
import { ChevronDown, ChevronRight, MessageCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { Markdown } from "@/components/Markdown";

export interface PlanAcceptCardProps {
  planId: string;
  plan: string;
  // Set once the user (or a persisted decision event on refetch) has made a
  // choice. When present the card renders read-only with an accepted /
  // rejected pill.
  decision?: "accept" | "reject";
  onDecide: (decision: "accept" | "reject") => void;
}

// Collapsed preview caps. Whichever clips more aggressively wins — we want
// the card to stay out of the way of the rest of the transcript until the
// user asks to see the whole plan.
const PREVIEW_CHAR_LIMIT = 400;
const PREVIEW_LINE_LIMIT = 10;

/**
 * In-transcript card for the SDK's `ExitPlanMode` tool. NOT a warn-wash
 * permission gate — the model is declaring "I've planned enough, ready to
 * start doing" and asking for a go-ahead. Rendered klein-wash to match the
 * friendly "question · claude" language used by `AskUserQuestionCard`.
 *
 * Rendering contract:
 *   - klein-wash card with a "plan · ready to execute" caps header strip
 *   - a display-type "Commit to this plan?" header
 *   - the plan text itself rendered as markdown (SDK ships markdown),
 *     collapsed by default to a short preview with an expand affordance so
 *     a long plan doesn't push the rest of the transcript off-screen
 *   - two buttons: klein-filled "Accept & execute" + outline "Send back
 *     for revisions"
 *   - after decision the card becomes read-only with either a klein-filled
 *     "✓ accepted" pill or an outline "✗ rejected" pill in place of the
 *     buttons (expand/collapse still works so the user can re-read)
 */
export function PlanAcceptCard({
  planId,
  plan,
  decision,
  onDecide,
}: PlanAcceptCardProps) {
  const decided = decision != null;
  const [expanded, setExpanded] = useState(false);

  const lines = plan.split("\n");
  const totalLines = lines.length;
  const byLines = lines.slice(0, PREVIEW_LINE_LIMIT).join("\n");
  // Pick whichever rule clips more aggressively (i.e. fewer chars kept).
  const truncatedBody =
    byLines.length <= PREVIEW_CHAR_LIMIT
      ? byLines
      : plan.slice(0, PREVIEW_CHAR_LIMIT);
  const isTruncated = truncatedBody.length < plan.length;
  const preview = isTruncated ? `${truncatedBody}…` : truncatedBody;
  const body = expanded || !isTruncated ? plan : preview;

  return (
    <div
      data-plan-id={planId}
      className="rounded-[12px] border border-klein/30 bg-klein-wash/30 p-3 max-w-[72ch] min-w-0"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="h-7 w-7 rounded-[8px] bg-klein-wash border border-klein/40 flex items-center justify-center text-klein">
          <MessageCircle className="w-3.5 h-3.5" />
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-klein/30 bg-klein-wash/60 text-klein-ink text-[10px] font-medium uppercase tracking-[0.1em]">
          plan · ready to execute
        </span>
      </div>

      <div className="text-[15px] leading-snug text-ink display mb-2">
        Commit to this plan?
      </div>

      <div className="rounded-[8px] border border-line bg-canvas/60 p-3">
        {plan.trim().length > 0 ? (
          <>
            <div className="md:[&_.markdown]:text-[14px] md:[&_.markdown]:leading-[1.6]">
              <Markdown source={body} />
            </div>
            {isTruncated ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 inline-flex items-center gap-1 text-[12px] mono text-klein-ink underline underline-offset-2 hover:opacity-80"
              >
                {expanded ? (
                  <>
                    <ChevronDown className="w-3 h-3" />
                    Collapse
                  </>
                ) : (
                  <>
                    <ChevronRight className="w-3 h-3" />
                    Expand ({totalLines} lines)
                  </>
                )}
              </button>
            ) : null}
          </>
        ) : (
          <div className="mono text-[12px] text-ink-muted italic">
            (no plan text provided by the model)
          </div>
        )}
      </div>

      {decided ? (
        <div className="mt-3 flex justify-end">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] text-[12px] font-medium",
              decision === "accept"
                ? "bg-klein text-canvas"
                : "border border-line text-ink-muted",
            )}
          >
            {decision === "accept" ? "✓ accepted" : "✗ rejected"}
          </span>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => onDecide("reject")}
            className="h-9 px-3 rounded-[8px] border border-line bg-canvas text-[13px] text-ink hover:border-klein/40"
          >
            Send back for revisions
          </button>
          <button
            type="button"
            onClick={() => onDecide("accept")}
            className="h-9 px-4 rounded-[8px] bg-klein text-canvas text-[13px] font-medium hover:bg-klein/90"
          >
            Accept & execute
          </button>
        </div>
      )}
    </div>
  );
}
