import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  priceForModel,
  DEFAULT_MODEL_PRICES,
  FALLBACK_PRICE
} from "../src/providers/cost.js";

describe("estimateCostUsd", () => {
  it("prices a known Groq model from the table", () => {
    // llama-3.3-70b-versatile: $0.59 / $0.79 per 1M
    const est = estimateCostUsd("llama-3.3-70b-versatile", { prompt: 1_000_000, completion: 1_000_000 });
    expect(est.promptCostUsd).toBeCloseTo(0.59, 10);
    expect(est.completionCostUsd).toBeCloseTo(0.79, 10);
    expect(est.totalCostUsd).toBeCloseTo(1.38, 10);
    expect(est.estimated).toBe(false);
  });

  it("is case-insensitive on the model id", () => {
    const lower = estimateCostUsd("llama-3.1-8b-instant", { prompt: 1000, completion: 1000 });
    const upper = estimateCostUsd("LLAMA-3.1-8B-INSTANT", { prompt: 1000, completion: 1000 });
    expect(upper.totalCostUsd).toBeCloseTo(lower.totalCostUsd, 12);
    expect(upper.estimated).toBe(false);
  });

  it("falls back conservatively for an unknown model and flags it", () => {
    const est = estimateCostUsd("some-future-model-xl", { prompt: 1_000_000, completion: 0 });
    expect(est.estimated).toBe(true);
    expect(est.promptCostUsd).toBeCloseTo(FALLBACK_PRICE.inputPerMillion, 10);
  });

  it("treats a missing/empty model as unknown without throwing", () => {
    expect(() => estimateCostUsd(undefined, { prompt: 10, completion: 10 })).not.toThrow();
    expect(estimateCostUsd("", { prompt: 10, completion: 10 }).estimated).toBe(true);
  });

  it("clamps malformed token counts to zero (no negative or NaN charges)", () => {
    const est = estimateCostUsd("llama-3.3-70b-versatile", {
      prompt: -500,
      completion: Number.NaN
    });
    expect(est.totalCostUsd).toBe(0);
  });

  it("scales linearly with token volume", () => {
    const one = estimateCostUsd("qwen-qwq-32b", { prompt: 1000, completion: 2000 });
    const ten = estimateCostUsd("qwen-qwq-32b", { prompt: 10_000, completion: 20_000 });
    expect(ten.totalCostUsd).toBeCloseTo(one.totalCostUsd * 10, 12);
  });

  it("honours an overridden price table (negotiated rate)", () => {
    const custom = { "llama-3.3-70b-versatile": { inputPerMillion: 0, outputPerMillion: 0 } };
    const est = estimateCostUsd("llama-3.3-70b-versatile", { prompt: 1e6, completion: 1e6 }, custom);
    expect(est.totalCostUsd).toBe(0);
    expect(est.estimated).toBe(false);
  });
});

describe("priceForModel", () => {
  it("reports known vs unknown", () => {
    expect(priceForModel("gpt-4o").known).toBe(true);
    expect(priceForModel("nope").known).toBe(false);
    expect(priceForModel("nope").price).toBe(FALLBACK_PRICE);
  });

  it("every advertised Groq model is in the default table", () => {
    for (const id of [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "deepseek-r1-distill-llama-70b",
      "qwen-qwq-32b"
    ]) {
      expect(DEFAULT_MODEL_PRICES[id]).toBeDefined();
    }
  });
});
