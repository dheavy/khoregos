/**
 * Tests for token cost estimation.
 */

import { describe, it, expect } from "vitest";
import { estimateCost } from "../../src/engine/cost.js";
import type { TranscriptUsage } from "../../src/engine/transcript.js";

function usage(overrides: Partial<TranscriptUsage> = {}): TranscriptUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

describe("estimateCost", () => {
  it("returns 0 for zero tokens", () => {
    expect(estimateCost(usage())).toBe(0);
  });

  it("calculates cost for input and output tokens", () => {
    const cost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-sonnet-4-6" }),
    );
    // sonnet: $3/M input, $15/M output
    const expected = (1000 * 3) / 1_000_000 + (500 * 15) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("includes cache creation and cache read costs", () => {
    const cost = estimateCost(
      usage({
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 500,
        cacheReadInputTokens: 200,
        model: "claude-sonnet-4-6",
      }),
    );
    // Should be greater than just input + output
    const baseOnly = estimateCost(
      usage({ inputTokens: 100, outputTokens: 50, model: "claude-sonnet-4-6" }),
    );
    expect(cost).toBeGreaterThan(baseOnly);
  });

  it("uses opus pricing for opus model", () => {
    const opusCost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-opus-4-6" }),
    );
    const sonnetCost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-sonnet-4-6" }),
    );
    // Opus should be more expensive than sonnet
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  it("uses haiku pricing for haiku model", () => {
    const haikuCost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-haiku-4-5-20251001" }),
    );
    const sonnetCost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-sonnet-4-6" }),
    );
    // Haiku should be cheaper than sonnet
    expect(haikuCost).toBeLessThan(sonnetCost);
  });

  it("matches prefix for versioned model IDs", () => {
    const cost1 = estimateCost(
      usage({ inputTokens: 1000, model: "claude-opus-4-6" }),
    );
    const cost2 = estimateCost(
      usage({ inputTokens: 1000, model: "claude-opus-4-6-20260301" }),
    );
    expect(cost1).toBe(cost2);
  });

  it("falls back to sonnet pricing for unknown models", () => {
    const unknownCost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-unknown-99" }),
    );
    const sonnetCost = estimateCost(
      usage({ inputTokens: 1000, outputTokens: 500, model: "claude-sonnet-4-6" }),
    );
    expect(unknownCost).toBe(sonnetCost);
  });

  it("accepts pricing overrides", () => {
    const customCost = estimateCost(
      usage({ inputTokens: 1_000_000, model: "custom-model" }),
      { "custom-model": { inputPerToken: 0.001 } },
    );
    expect(customCost).toBeCloseTo(1000, 2);
  });
});
