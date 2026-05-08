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

  return { totalInput, totalOutput, costUsd, perModel, turnCount };
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
