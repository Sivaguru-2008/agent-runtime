/**
 * Model cost estimation.
 *
 * Token counts are already captured on every completion (see ModelProvider's
 * `tokenUsage`). This module turns those counts into an estimated USD cost so
 * cost dashboards, per-tenant quotas and the operator UI can reason about spend
 * without re-deriving prices at every call site.
 *
 * Operational impact  : a single price table means a Groq price change is a
 *   one-line edit, not a grep across the codebase.
 * Replay implications : cost is a pure function of (model, tokenUsage); it is
 *   never persisted as authoritative truth — token counts are. Cost can always
 *   be recomputed from the durable token accounting if prices are revised.
 * Failure modes       : an unknown model never throws — it falls back to a
 *   conservative default rate and flags `estimated: true` so callers can
 *   surface "price unknown" rather than silently reporting $0.
 *
 * Prices are USD per 1,000,000 tokens, sourced from public provider pricing.
 * They are intentionally overridable via the optional `prices` argument so an
 * operator on a negotiated/enterprise rate is never stuck with list price.
 */

import type { LLMTokenUsage } from "./interfaces/LLMProvider.js";

/** USD per 1,000,000 tokens, split by direction. */
export interface ModelPrice {
  /** Price per 1M prompt (input) tokens. */
  inputPerMillion: number;
  /** Price per 1M completion (output) tokens. */
  outputPerMillion: number;
}

/**
 * Public list prices per 1M tokens. Groq models are the primary surface; the
 * failover chain can also route to Claude / OpenAI, so a few common ids are
 * included. Keys are matched case-insensitively against the resolved model id.
 */
export const DEFAULT_MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // ── Groq ──────────────────────────────────────────────────────────────────
  "llama-3.3-70b-versatile": { inputPerMillion: 0.59, outputPerMillion: 0.79 },
  "llama-3.1-8b-instant": { inputPerMillion: 0.05, outputPerMillion: 0.08 },
  "deepseek-r1-distill-llama-70b": { inputPerMillion: 0.75, outputPerMillion: 0.99 },
  "qwen-qwq-32b": { inputPerMillion: 0.29, outputPerMillion: 0.39 },
  // ── Anthropic (failover) ────────────────────────────────────────────────
  "claude-sonnet-4-6": { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  // ── OpenAI (failover) ───────────────────────────────────────────────────
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 }
};

/**
 * Conservative fallback when a model id is not in the table. Chosen to be at
 * least as expensive as the priciest Groq model so cost is never *under*
 * reported for an unknown Groq variant. Surfaced with `estimated: true`.
 */
export const FALLBACK_PRICE: ModelPrice = { inputPerMillion: 0.79, outputPerMillion: 0.99 };

export interface CostEstimate {
  /** Estimated USD cost of the prompt (input) tokens. */
  promptCostUsd: number;
  /** Estimated USD cost of the completion (output) tokens. */
  completionCostUsd: number;
  /** Total estimated USD cost. */
  totalCostUsd: number;
  /** True when the model id was unknown and FALLBACK_PRICE was used. */
  estimated: boolean;
  /** The model id the estimate was computed for (lower-cased, trimmed). */
  model: string;
}

/** Look up the price for a model id, falling back when unknown. */
export function priceForModel(
  model: string | undefined,
  prices: Readonly<Record<string, ModelPrice>> = DEFAULT_MODEL_PRICES
): { price: ModelPrice; known: boolean } {
  const key = (model ?? "").trim().toLowerCase();
  const price = key ? prices[key] : undefined;
  return price ? { price, known: true } : { price: FALLBACK_PRICE, known: false };
}

/**
 * Estimate the USD cost of a completion from its model id and token usage.
 *
 * Pure and total: never throws, never negative. Negative or NaN token counts
 * are clamped to 0 so a malformed usage object can't produce a bogus charge.
 */
export function estimateCostUsd(
  model: string | undefined,
  usage: Pick<LLMTokenUsage, "prompt" | "completion">,
  prices: Readonly<Record<string, ModelPrice>> = DEFAULT_MODEL_PRICES
): CostEstimate {
  const { price, known } = priceForModel(model, prices);
  const prompt = clampTokens(usage.prompt);
  const completion = clampTokens(usage.completion);

  const promptCostUsd = (prompt / 1_000_000) * price.inputPerMillion;
  const completionCostUsd = (completion / 1_000_000) * price.outputPerMillion;

  return {
    promptCostUsd,
    completionCostUsd,
    totalCostUsd: promptCostUsd + completionCostUsd,
    estimated: !known,
    model: (model ?? "").trim().toLowerCase()
  };
}

function clampTokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}
