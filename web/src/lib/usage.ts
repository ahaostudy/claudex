import type { ModelId, SessionEvent } from "@claudex/shared";
import { estimateCostUsd } from "./pricing";

/**
 * Per-model usage breakdown. Tokens are cumulative across every `turn_end`
 * attributed to that model.
 */
export interface PerModelUsage {
  model: ModelId | string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SessionUsage {
  totalInput: number;
  totalOutput: number;
  costUsd: number;
  /** Present when the session spanned more than one model; otherwise a single row. */
  perModel: PerModelUsage[];
  /** Count of turn_end events that contributed usage (debug + sanity check). */
  turnCount: number;
  /**
   * Input tokens reported on the most recent `turn_end` event. Unlike
   * `totalInput` (which sums every turn and over-counts because prior turns'
   * input overlaps), this is a reasonable proxy for "current context size":
   * each turn resends the full conversation to the model, so the latest
   * turn's `inputTokens` ≈ how much context is live right now. Zero when no
   * `turn_end` with usage has been seen.
   */
  lastTurnInput: number;
}

/**
 * Known context window sizes (in tokens) per model id. Used by the Usage
 * panel to render the "context %" ring as `lastTurnInput / contextWindow`.
 *
 * These numbers come from Anthropic's published model specs. If you add a
 * new model here, double-check the window size rather than guessing — a
 * wrong value will silently mislead the ring. When the shipped model list
 * changes, update `shared/src/models.ts` first, then mirror it here.
 */
const CONTEXT_WINDOW_TOKENS: Record<ModelId, number> = {
  "claude-opus-4-7": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};

/** Default window used when the model id is unknown to this table. */
const CONTEXT_WINDOW_FALLBACK = 200_000;

/**
 * Context window size (tokens) for a given model id. Returns
 * `CONTEXT_WINDOW_FALLBACK` (200k) for unknown models — every currently
 * shipping Claude 4.x model is a 200k window, so this is a safe default
 * rather than a guess. Revisit if Anthropic ships a non-200k model.
 */
export function contextWindowTokens(model: ModelId | string): number {
  return (
    (CONTEXT_WINDOW_TOKENS as Record<string, number>)[String(model)] ??
    CONTEXT_WINDOW_FALLBACK
  );
}

/**
 * Aggregate token usage + cost from a list of persisted `SessionEvent`s.
 *
 * Pure: no network, no state. The caller passes raw events (e.g. the
 * response of `/api/sessions/:id/events`) plus the session's current
 * `ModelId`. Every `turn_end` event whose payload has
 * `usage.inputTokens` / `usage.outputTokens` contributes.
 *
 * Model attribution: the server does not persist a per-turn model on
 * `turn_end` today, so we attribute every turn to the session's current
 * model. This means a session that swapped models mid-stream will look like
 * a single-model session in the breakdown — a known simplification. Future
 * work: have the server stamp `model` on each `turn_end` payload, then this
 * function can partition correctly.
 */
export function computeSessionUsage(
  events: SessionEvent[],
  sessionModel: ModelId | string,
): SessionUsage {
  const perModelMap = new Map<
    string,
    { model: ModelId | string; inputTokens: number; outputTokens: number }
  >();
  let turnCount = 0;
  let lastTurnInput = 0;

  for (const ev of events) {
    if (ev.kind !== "turn_end") continue;
    const usage = (ev.payload as Record<string, unknown>).usage as
      | { inputTokens?: number; outputTokens?: number }
      | null
      | undefined;
    if (!usage) continue;
    const inp = Number(usage.inputTokens ?? 0) | 0;
    const out = Number(usage.outputTokens ?? 0) | 0;
    if (inp === 0 && out === 0) continue;
    // No per-event model today; attribute to the session's current model.
    const model = sessionModel;
    const key = String(model);
    const row = perModelMap.get(key);
    if (row) {
      row.inputTokens += inp;
      row.outputTokens += out;
    } else {
      perModelMap.set(key, { model, inputTokens: inp, outputTokens: out });
    }
    turnCount += 1;
    // Events are assumed to be in insertion order (server returns them
    // ordered by id asc); the final turn_end's inputTokens wins.
    lastTurnInput = inp;
  }

  const perModel: PerModelUsage[] = Array.from(perModelMap.values())
    .map((r) => ({
      ...r,
      costUsd: estimateCostUsd(r.model, r.inputTokens, r.outputTokens),
    }))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));

  const totalInput = perModel.reduce((n, r) => n + r.inputTokens, 0);
  const totalOutput = perModel.reduce((n, r) => n + r.outputTokens, 0);
  const costUsd = perModel.reduce((n, r) => n + r.costUsd, 0);

  return { totalInput, totalOutput, costUsd, perModel, turnCount, lastTurnInput };
}

/** Format a token count as "12.3M", "612k", or "1,234". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n >= 1_000) return (n / 1_000).toFixed(2).replace(/\.00$/, "") + "k";
  return n.toLocaleString();
}

/** Format a USD amount with up to 4 decimals for small values. */
export function formatUsd(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
