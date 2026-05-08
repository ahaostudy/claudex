import { describe, it, expect } from "vitest";
import type { SessionEvent } from "@claudex/shared";
import { computeUsageSummary } from "../src/sessions/usage-summary.js";

function makeTurnEnd(
  seq: number,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  } | null,
): SessionEvent {
  return {
    id: `ev-${seq}`,
    sessionId: "s1",
    kind: "turn_end",
    seq,
    createdAt: new Date().toISOString(),
    payload: { stopReason: "end_turn", usage },
  };
}

describe("computeUsageSummary", () => {
  it("returns zeros on an empty event list", () => {
    const out = computeUsageSummary([], "claude-opus-4-7");
    expect(out.totalInput).toBe(0);
    expect(out.totalOutput).toBe(0);
    expect(out.lastTurnInput).toBe(0);
    expect(out.lastTurnContextKnown).toBe(false);
    expect(out.turnCount).toBe(0);
    expect(out.perModel).toEqual([]);
  });

  it("sums a single turn's input + cacheRead + cacheCreation as the context body", () => {
    const events: SessionEvent[] = [
      makeTurnEnd(0, {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 5000,
      }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-7");
    expect(out.turnCount).toBe(1);
    // 100 + 20000 + 5000 = 25100 — above HISTORICAL_TURN_THRESHOLD (500)
    expect(out.lastTurnInput).toBe(25100);
    expect(out.lastTurnContextKnown).toBe(true);
    expect(out.totalInput).toBe(25100);
    expect(out.totalOutput).toBe(50);
    expect(out.perModel).toHaveLength(1);
    expect(out.perModel[0]).toEqual({
      model: "claude-opus-4-7",
      inputTokens: 25100,
      outputTokens: 50,
    });
  });

  it("aggregates totals across multiple turns and records the last turn's input", () => {
    const events: SessionEvent[] = [
      makeTurnEnd(0, {
        inputTokens: 50,
        outputTokens: 100,
        cacheReadInputTokens: 10000,
      }),
      makeTurnEnd(1, {
        inputTokens: 70,
        outputTokens: 200,
        cacheReadInputTokens: 20000,
        cacheCreationInputTokens: 1000,
      }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-7");
    expect(out.turnCount).toBe(2);
    // Last turn: 70 + 20000 + 1000 = 21070
    expect(out.lastTurnInput).toBe(21070);
    expect(out.lastTurnContextKnown).toBe(true);
    // Totals: (50+10000) + (70+20000+1000) = 31120 input, 300 output
    expect(out.totalInput).toBe(31120);
    expect(out.totalOutput).toBe(300);
  });

  it("flips lastTurnContextKnown=false for historical rows below threshold", () => {
    // Only input_tokens present — pre-cache-fields row. Sum is 20 tokens,
    // well under the 500 threshold, so the ring should render `—`.
    const events: SessionEvent[] = [
      makeTurnEnd(0, { inputTokens: 20, outputTokens: 40 }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-7");
    expect(out.turnCount).toBe(1);
    expect(out.lastTurnInput).toBe(20);
    expect(out.lastTurnContextKnown).toBe(false);
  });

  it("ignores turn_end events with null/missing usage", () => {
    const events: SessionEvent[] = [
      makeTurnEnd(0, null),
      makeTurnEnd(1, { inputTokens: 50, cacheReadInputTokens: 1000 }),
    ];
    const out = computeUsageSummary(events, "claude-opus-4-7");
    expect(out.turnCount).toBe(1);
    expect(out.lastTurnInput).toBe(1050);
  });
});
