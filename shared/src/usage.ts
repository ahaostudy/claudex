import type { ModelId, SessionEvent } from "./models.js";

/**
 * Minimum `lastTurn` input total below which we treat the most recent
 * `turn_end` as "historical" — i.e. persisted before the runner started
 * emitting cache fields, so callers should render `—` on the context ring
 * instead of a misleading 0%.
 *
 * Rationale: any real turn ships at least the system prompt + tool
 * definitions, which are thousands of tokens. `input_tokens` alone (without
 * cache reads) is ~6-30 on a cache-warmed turn, so anything below this
 * threshold is almost certainly a pre-cache-fields row. Using a number
 * instead of an explicit "has cache fields" bit keeps the check honest even
 * if the SDK ever returns `0` for cache reads on a cold turn.
 */
export const HISTORICAL_TURN_THRESHOLD = 500;

/** Raw per-turn totals extracted from a single `turn_end` event's usage payload. */
export interface PerTurnTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Result of a single-pass scan over a session's events. Both the server
 * summary and the web session-usage compute live on top of this shape.
 *
 * `totalInput` is the sum, across every non-empty `turn_end`, of the full
 * context body shipped that turn: `inputTokens + cacheReadInputTokens +
 * cacheCreationInputTokens`. The SDK's `input_tokens` alone would show ~0 on
 * a warm cache — see TurnEndUsage docs for the reasoning.
 *
 * `lastTurn` captures the raw per-turn totals for the most recent non-empty
 * turn. Callers derive any presentation-level fields (e.g. "new tokens
 * billed this turn") from it without re-scanning events.
 */
export interface UsageScan {
  totalInput: number;
  totalOutput: number;
  turnCount: number;
  lastTurn: PerTurnTotals | null;
  /** `true` when `lastTurn`'s context-body total is at least `HISTORICAL_TURN_THRESHOLD`. */
  lastTurnContextKnown: boolean;
  /** Per-model rollup keyed by raw model id. Today every turn is attributed
   * to the caller-provided `sessionModel` (the server doesn't persist a
   * per-turn model) — see `computeSessionUsage` for the simplification
   * note. */
  perModel: Map<
    ModelId | string,
    { inputTokens: number; outputTokens: number; count: number }
  >;
}

/**
 * Canonical single-pass scan over a session's event log.
 *
 * Walks `events` once, filters to `turn_end` rows with a usage payload, and
 * returns the aggregate shape both the server-side `computeUsageSummary` and
 * the web-side `computeSessionUsage` need. Keeps the token math (what counts
 * as "context body", how to handle missing cache fields, when a turn is
 * historical) in exactly one place.
 *
 * Empty / null usage, and turns with total zero tokens, are skipped — they
 * don't contribute to any counter.
 */
export function scanTurnEnds(
  events: SessionEvent[],
  sessionModel: ModelId | string,
): UsageScan {
  const perModel = new Map<
    ModelId | string,
    { inputTokens: number; outputTokens: number; count: number }
  >();
  let turnCount = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let lastTurn: PerTurnTotals | null = null;

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

    const key: ModelId | string = sessionModel;
    const row = perModel.get(key);
    if (row) {
      row.inputTokens += totalInputThisTurn;
      row.outputTokens += out;
      row.count += 1;
    } else {
      perModel.set(key, {
        inputTokens: totalInputThisTurn,
        outputTokens: out,
        count: 1,
      });
    }
    turnCount += 1;
    totalInput += totalInputThisTurn;
    totalOutput += out;
    lastTurn = {
      inputTokens: inp,
      outputTokens: out,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreate,
    };
  }

  const lastTurnTotal = lastTurn
    ? lastTurn.inputTokens +
      lastTurn.cacheReadInputTokens +
      lastTurn.cacheCreationInputTokens
    : 0;

  return {
    totalInput,
    totalOutput,
    turnCount,
    lastTurn,
    lastTurnContextKnown: lastTurnTotal >= HISTORICAL_TURN_THRESHOLD,
    perModel,
  };
}
