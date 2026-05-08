import type { ModelId, SessionEvent, UsageSummaryResponse } from "@claudex/shared";

/**
 * Minimum `lastTurnInput` below which we treat the most recent `turn_end` as
 * "historical" — i.e. persisted before the runner started emitting cache
 * fields, so the client should render `—` on the context ring instead of a
 * misleading 0%. Kept in sync with `web/src/lib/usage.ts` HISTORICAL_TURN_THRESHOLD.
 */
export const HISTORICAL_TURN_THRESHOLD = 500;

/**
 * Server-side equivalent of `computeSessionUsage` (web/src/lib/usage.ts) —
 * scans `turn_end` events and returns the subset of fields the UsagePanel,
 * ChatTasksRail, and Chat header ring actually consume. Deliberately does
 * NOT include cost — cost computation lives client-side where the pricing
 * table is, and we want to keep server-side logic narrow.
 */
export function computeUsageSummary(
  events: SessionEvent[],
  sessionModel: ModelId | string,
): UsageSummaryResponse {
  const perModelMap = new Map<
    string,
    { model: string; inputTokens: number; outputTokens: number }
  >();
  let turnCount = 0;
  let lastTurnInput = 0;

  for (const ev of events) {
    if (ev.kind !== "turn_end") continue;
    const usage = (ev.payload as Record<string, unknown>).usage as
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
        }
      | null
      | undefined;
    if (!usage) continue;
    const inp = Number(usage.inputTokens ?? 0) | 0;
    const out = Number(usage.outputTokens ?? 0) | 0;
    const cacheRead = Number(usage.cacheReadInputTokens ?? 0) | 0;
    const cacheCreate = Number(usage.cacheCreationInputTokens ?? 0) | 0;
    const totalInputThisTurn = inp + cacheRead + cacheCreate;
    if (totalInputThisTurn === 0 && out === 0) continue;
    const key = String(sessionModel);
    const row = perModelMap.get(key);
    if (row) {
      row.inputTokens += totalInputThisTurn;
      row.outputTokens += out;
    } else {
      perModelMap.set(key, {
        model: key,
        inputTokens: totalInputThisTurn,
        outputTokens: out,
      });
    }
    turnCount += 1;
    lastTurnInput = totalInputThisTurn;
  }

  const perModel = Array.from(perModelMap.values()).sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
  const totalInput = perModel.reduce((n, r) => n + r.inputTokens, 0);
  const totalOutput = perModel.reduce((n, r) => n + r.outputTokens, 0);

  return {
    totalInput,
    totalOutput,
    lastTurnInput,
    lastTurnContextKnown: lastTurnInput >= HISTORICAL_TURN_THRESHOLD,
    turnCount,
    perModel,
  };
}
