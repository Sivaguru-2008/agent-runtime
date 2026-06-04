/**
 * providerFactory.test.ts — failover chain composition.
 *
 * Decisive guarantee: outside strict (production/staging) mode the failover
 * chain ALWAYS ends with an always-available `deterministic` link. Without it a
 * chain that collapses to a single real provider (e.g. [groq]) hard-fails on the
 * first transient upstream error, which OPENs the wrapping "model-provider"
 * circuit breaker and cascades into a wave of dead-lettered runs. In strict mode
 * a genuine outage must instead fail loudly, so the fallback is NOT appended.
 */

import { describe, it, expect } from "vitest";
import type { AppConfig } from "../src/shared/config.js";
import { createModelProvider } from "../src/providers/providerFactory.js";
import { FailoverModelProvider } from "../src/providers/failoverModelProvider.js";

function makeConfig(overrides: Partial<AppConfig>): AppConfig {
  return {
    NODE_ENV: "development",
    MODEL_PROVIDER: "failover",
    PROVIDER_TIMEOUT_MS: 120_000,
    PROVIDER_MAX_RETRIES: 3,
    ...overrides
  } as unknown as AppConfig;
}

function linkNamesOf(provider: unknown): readonly string[] {
  expect(provider).toBeInstanceOf(FailoverModelProvider);
  return (provider as FailoverModelProvider).linkNames;
}

describe("createModelProvider — failover chain", () => {
  it("appends a terminal deterministic fallback in development when a real provider is present", () => {
    const provider = createModelProvider(
      makeConfig({ MODEL_FAILOVER_CHAIN: "groq", GROQ_API_KEY: "test-key" })
    );
    expect(linkNamesOf(provider)).toEqual(["groq", "deterministic"]);
  });

  it("does NOT append deterministic in strict (production) mode — a real outage must fail loudly", () => {
    const provider = createModelProvider(
      makeConfig({ NODE_ENV: "production", MODEL_FAILOVER_CHAIN: "groq", GROQ_API_KEY: "test-key" })
    );
    expect(linkNamesOf(provider)).toEqual(["groq"]);
  });

  it("does NOT append deterministic when STRICT_PROD is forced on", () => {
    const provider = createModelProvider(
      makeConfig({ STRICT_PROD: true, MODEL_FAILOVER_CHAIN: "groq", GROQ_API_KEY: "test-key" })
    );
    expect(linkNamesOf(provider)).toEqual(["groq"]);
  });

  it("falls back to deterministic-only (no throw) in development when no provider has credentials", () => {
    const provider = createModelProvider(
      makeConfig({ MODEL_FAILOVER_CHAIN: "claude,openai,groq" })
    );
    expect(linkNamesOf(provider)).toEqual(["deterministic"]);
  });

  it("throws in strict mode when no provider in the chain has credentials", () => {
    expect(() =>
      createModelProvider(
        makeConfig({ NODE_ENV: "production", MODEL_FAILOVER_CHAIN: "claude,openai,groq" })
      )
    ).toThrow(/no providers in MODEL_FAILOVER_CHAIN have valid credentials/);
  });

  it("is idempotent — does not double-append when the operator already ended the chain with deterministic", () => {
    const provider = createModelProvider(
      makeConfig({ MODEL_FAILOVER_CHAIN: "groq,deterministic", GROQ_API_KEY: "test-key" })
    );
    expect(linkNamesOf(provider)).toEqual(["groq", "deterministic"]);
  });
});
