import { useMemo, useState } from "react";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AskUserQuestionItem } from "@claudex/shared";

export interface AskUserQuestionCardProps {
  askId: string;
  questions: AskUserQuestionItem[];
  // Present when the user has already answered (persisted or just-submitted).
  // The card renders read-only in that case.
  answers?: Record<string, string>;
  onSubmit: (
    answers: Record<string, string>,
    annotations?: Record<string, { notes?: string; preview?: string }>,
  ) => void;
}

// The SDK's AskUserQuestion tool automatically supplies an "Other" option —
// we add it client-side and reveal a free-text input when it's selected.
const OTHER_LABEL = "Other";

/**
 * In-transcript multiple-choice card for the SDK's `AskUserQuestion` tool.
 * Distinct from `PermissionCard` — this isn't a security gate, it's a friendly
 * ask for user input. Uses the klein-wash language instead of warn-wash.
 *
 * Rendering contract:
 *   - one question per block, with a caps "question · claude" header strip
 *   - radios for single-select, checkboxes for multi-select
 *   - each option shows label + muted description; `preview` (if any) is
 *     revealed in a mono <pre> when the option is focused or hovered
 *   - an "Other" option is appended client-side with a free-text input
 *   - submit button is klein-filled, disabled until every question is
 *     answered; after submit the card becomes read-only with the chosen
 *     label highlighted and a muted "Sent" footer
 */
export function AskUserQuestionCard({
  askId,
  questions,
  answers: answersProp,
  onSubmit,
}: AskUserQuestionCardProps) {
  const isAnswered = answersProp != null;

  // Per-question selection state. For multi-select we store a Set of labels;
  // for single-select a plain string. We keep both shapes in one map so the
  // readiness + submit paths are uniform.
  const [selections, setSelections] = useState<
    Record<string, string | string[]>
  >({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  // Readiness: every question has a non-empty answer (for "Other" the
  // free-text box must be filled).
  const ready = useMemo(() => {
    if (isAnswered) return false;
    for (const q of questions) {
      const sel = selections[q.question];
      if (q.multiSelect) {
        const arr = (sel as string[] | undefined) ?? [];
        if (arr.length === 0) return false;
        if (arr.includes(OTHER_LABEL) && !otherText[q.question]?.trim()) {
          return false;
        }
      } else {
        const v = typeof sel === "string" ? sel : "";
        if (!v) return false;
        if (v === OTHER_LABEL && !otherText[q.question]?.trim()) return false;
      }
    }
    return true;
  }, [isAnswered, questions, selections, otherText]);

  function handleSubmit() {
    if (!ready) return;
    const out: Record<string, string> = {};
    for (const q of questions) {
      const sel = selections[q.question];
      if (q.multiSelect) {
        const arr = (sel as string[] | undefined) ?? [];
        const mapped = arr.map((v) =>
          v === OTHER_LABEL ? otherText[q.question]?.trim() || OTHER_LABEL : v,
        );
        // SDK expects comma-separated values for multi-select.
        out[q.question] = mapped.join(", ");
      } else {
        const v = typeof sel === "string" ? sel : "";
        out[q.question] =
          v === OTHER_LABEL
            ? otherText[q.question]?.trim() || OTHER_LABEL
            : v;
      }
    }
    onSubmit(out);
  }

  return (
    <div
      data-ask-id={askId}
      className="rounded-[12px] border border-klein/30 bg-klein-wash/30 p-3 max-w-[72ch] min-w-0"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="h-7 w-7 rounded-[8px] bg-klein-wash border border-klein/40 flex items-center justify-center text-klein">
          <MessageCircle className="w-3.5 h-3.5" />
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[6px] border border-klein/30 bg-klein-wash/60 text-klein-ink text-[10px] font-medium uppercase tracking-[0.1em]">
          question · claude
        </span>
      </div>

      <div className="space-y-4">
        {questions.map((q) => {
          const optionsWithOther = [
            ...q.options,
            { label: OTHER_LABEL, description: "Something else — type below." },
          ];
          const selected = selections[q.question];
          const chosenLabel = answersProp?.[q.question];

          return (
            <div key={q.question} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[15px] leading-snug text-ink display break-words [overflow-wrap:anywhere] min-w-0 flex-1">
                  {q.question}
                </div>
                {q.header ? (
                  <span className="mono text-[10px] text-ink-muted uppercase tracking-[0.08em] shrink-0">
                    {q.header}
                  </span>
                ) : null}
              </div>

              <div className="space-y-1.5">
                {optionsWithOther.map((opt) => {
                  const isChosenByUser = q.multiSelect
                    ? ((selected as string[] | undefined) ?? []).includes(
                        opt.label,
                      )
                    : selected === opt.label;
                  // Read-only: highlight whichever label(s) match `answersProp`.
                  const isChosenAfterSend =
                    isAnswered &&
                    (q.multiSelect
                      ? (chosenLabel ?? "")
                          .split(",")
                          .map((s) => s.trim())
                          .includes(opt.label)
                      : chosenLabel === opt.label ||
                        // Match a free-text "Other" back onto the Other row.
                        (opt.label === OTHER_LABEL &&
                          chosenLabel != null &&
                          !q.options.some((o) => o.label === chosenLabel)));

                  const highlighted = isAnswered
                    ? isChosenAfterSend
                    : isChosenByUser;

                  return (
                    <label
                      key={opt.label}
                      className={cn(
                        "block rounded-[8px] border p-2.5 cursor-pointer transition-colors",
                        highlighted
                          ? "border-klein bg-klein-wash/60 ring-1 ring-klein/40"
                          : "border-line bg-canvas/60 hover:border-klein/30",
                        isAnswered && "cursor-default",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type={q.multiSelect ? "checkbox" : "radio"}
                          name={`ask-${askId}-${q.question}`}
                          value={opt.label}
                          checked={Boolean(highlighted)}
                          disabled={isAnswered}
                          onChange={(e) => {
                            if (isAnswered) return;
                            // Read `checked` synchronously off the event —
                            // never from inside the state updater. React
                            // nulls `e.currentTarget` after the handler
                            // returns, and in concurrent rendering the
                            // updater can be invoked later than the handler
                            // (or twice under StrictMode), which turns
                            // `e.currentTarget.checked` into
                            // `null.checked` → TypeError → the whole
                            // transcript white-screens because this card
                            // isn't behind an error boundary.
                            const checked = e.currentTarget.checked;
                            if (q.multiSelect) {
                              setSelections((prev) => {
                                const prevArr =
                                  (prev[q.question] as string[] | undefined) ??
                                  [];
                                const next = checked
                                  ? [...prevArr, opt.label]
                                  : prevArr.filter((v) => v !== opt.label);
                                return { ...prev, [q.question]: next };
                              });
                            } else {
                              setSelections((prev) => ({
                                ...prev,
                                [q.question]: opt.label,
                              }));
                            }
                          }}
                          className="mt-0.5 accent-klein shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13.5px] font-medium text-ink break-words [overflow-wrap:anywhere]">
                            {opt.label}
                          </div>
                          {opt.description ? (
                            <div className="text-[12px] text-ink-muted leading-snug break-words [overflow-wrap:anywhere]">
                              {opt.description}
                            </div>
                          ) : null}
                          {opt.preview ? (
                            <pre className="mono text-[11px] text-canvas bg-ink rounded-[6px] mt-1.5 px-2 py-1.5 whitespace-pre-wrap break-all overflow-x-auto max-w-full">
                              {opt.preview}
                            </pre>
                          ) : null}
                          {/* Free-text input when Other is selected and not
                              yet submitted. Hidden in the read-only state
                              because the chosen free-text appears in the
                              chip at the top-right of this block below. */}
                          {opt.label === OTHER_LABEL &&
                          !isAnswered &&
                          (q.multiSelect
                            ? (
                                (selections[q.question] as
                                  | string[]
                                  | undefined) ?? []
                              ).includes(OTHER_LABEL)
                            : selected === OTHER_LABEL) ? (
                            <input
                              type="text"
                              value={otherText[q.question] ?? ""}
                              onChange={(e) =>
                                setOtherText((prev) => ({
                                  ...prev,
                                  [q.question]: e.target.value,
                                }))
                              }
                              placeholder="Type your answer…"
                              className="mt-1.5 w-full bg-canvas border border-line rounded-[6px] px-2 py-1 text-[13px] text-ink focus:outline-none focus:border-klein/60"
                            />
                          ) : null}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Read-only footer: when the chosen label was free-text
                  ("Other"), surface the actual answer text the user typed. */}
              {isAnswered && chosenLabel != null &&
                !q.options.some((o) => o.label === chosenLabel) &&
                chosenLabel !== OTHER_LABEL ? (
                <div className="text-[12px] text-ink-muted italic pl-1">
                  Answer: <span className="text-ink">{chosenLabel}</span>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {isAnswered ? (
        <div className="mt-3 text-[11px] mono text-ink-muted flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-klein/70" />
          Sent
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!ready}
            className={cn(
              "h-9 px-4 rounded-[8px] text-[13px] font-medium transition-colors",
              ready
                ? "bg-klein text-canvas hover:bg-klein/90"
                : "bg-klein/30 text-canvas/70 cursor-not-allowed",
            )}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
