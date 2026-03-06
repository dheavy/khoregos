/**
 * Token cost estimation.
 *
 * Default pricing for Claude models (USD per token).
 * Users can override via k6s.yaml pricing config.
 */

import type { TranscriptUsage } from "./transcript.js";

interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheCreationPerToken: number;
  cacheReadPerToken: number;
}

// Pricing as of early 2026. These are defaults — users can override in config.
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    inputPerToken: 15 / 1_000_000,
    outputPerToken: 75 / 1_000_000,
    cacheCreationPerToken: 18.75 / 1_000_000,
    cacheReadPerToken: 1.5 / 1_000_000,
  },
  "claude-sonnet-4-6": {
    inputPerToken: 3 / 1_000_000,
    outputPerToken: 15 / 1_000_000,
    cacheCreationPerToken: 3.75 / 1_000_000,
    cacheReadPerToken: 0.3 / 1_000_000,
  },
  "claude-haiku-4-5-20251001": {
    inputPerToken: 0.8 / 1_000_000,
    outputPerToken: 4 / 1_000_000,
    cacheCreationPerToken: 1 / 1_000_000,
    cacheReadPerToken: 0.08 / 1_000_000,
  },
};

// Fallback for unknown models — use sonnet pricing as a reasonable middle ground.
const FALLBACK_PRICING: ModelPricing = DEFAULT_PRICING["claude-sonnet-4-6"];

function resolvePricing(
  model: string,
  overrides?: Record<string, Partial<ModelPricing>>,
): ModelPricing {
  if (overrides?.[model]) {
    return { ...FALLBACK_PRICING, ...overrides[model] };
  }
  // Try exact match first, then prefix match (e.g. "claude-opus-4-6" matches "claude-opus-4-6-20260301").
  if (DEFAULT_PRICING[model]) return DEFAULT_PRICING[model];
  for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return FALLBACK_PRICING;
}

export function estimateCost(
  usage: TranscriptUsage,
  pricingOverrides?: Record<string, Partial<ModelPricing>>,
): number {
  const pricing = resolvePricing(usage.model, pricingOverrides);
  return (
    usage.inputTokens * pricing.inputPerToken +
    usage.outputTokens * pricing.outputPerToken +
    usage.cacheCreationInputTokens * pricing.cacheCreationPerToken +
    usage.cacheReadInputTokens * pricing.cacheReadPerToken
  );
}
