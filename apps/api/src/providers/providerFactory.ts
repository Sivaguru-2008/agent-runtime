/**
 * Selects and constructs the appropriate ModelProvider implementation based
 * on the resolved application configuration.
 *
 * Operational impact  : single construction point ensures all provider-level
 *   configuration (API keys, timeouts, retry budgets) flows from AppConfig.
 * Replay implications : the provider name is stored on Agent.model, so the
 *   event store already records which provider served a given execution.
 * Failure modes       : missing API keys throw at construction time (fail
 *   fast), not at first inference call.
 * Observability       : returns a named provider so loggers can tag events
 *   with a consistent `provider` field.
 */

import type { ModelProvider } from "../domain/ports.js";
import type { AppConfig } from "../shared/config.js";
import { isStrictInfrastructureMode } from "../shared/config.js";
import { ClaudeProvider } from "./claudeProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { GroqModelProvider } from "./groqModelProvider.js";
import { GroqProvider } from "./GroqProvider.js";
import { DeterministicModelProvider } from "../runtime/mockModelProvider.js";
import { FailoverModelProvider, type FailoverLink } from "./failoverModelProvider.js";
import type { AgentMetrics } from "../infrastructure/metrics/prometheusMetrics.js";

/**
 * Construct a single configured provider by name. Used both by the legacy
 * top-level switch and by the failover chain builder below. Returns
 * undefined when the named provider lacks its required credentials so the
 * failover builder can transparently skip it rather than failing boot.
 */
function buildNamed(name: string, config: AppConfig): ModelProvider | undefined {
  switch (name.trim().toLowerCase()) {
    case "claude":
    case "anthropic":
      if (!config.ANTHROPIC_API_KEY) return undefined;
      return new ClaudeProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.MODEL_NAME,
        timeoutMs: config.PROVIDER_TIMEOUT_MS,
        retry: { maxAttempts: config.PROVIDER_MAX_RETRIES }
      });
    case "openai":
      if (!config.OPENAI_API_KEY) return undefined;
      return new OpenAIProvider({
        apiKey: config.OPENAI_API_KEY,
        model: config.MODEL_NAME,
        timeoutMs: config.PROVIDER_TIMEOUT_MS,
        retry: { maxAttempts: config.PROVIDER_MAX_RETRIES }
      });
    case "groq":
      if (!config.GROQ_API_KEY) return undefined;
      return new GroqModelProvider(
        new GroqProvider({
          apiKey: config.GROQ_API_KEY,
          baseUrl: config.GROQ_BASE_URL,
          model: config.MODEL_NAME ?? config.GROQ_MODEL,
          requestTimeoutMs: config.GROQ_REQUEST_TIMEOUT_MS
        }),
        { retry: { maxAttempts: config.PROVIDER_MAX_RETRIES } }
      );
    case "deterministic":
      return new DeterministicModelProvider();
    default:
      return undefined;
  }
}

export function createModelProvider(config: AppConfig, metrics?: AgentMetrics): ModelProvider {
  switch (config.MODEL_PROVIDER) {
    case "claude":
      if (!config.ANTHROPIC_API_KEY) {
        throw new Error("MODEL_PROVIDER=claude requires ANTHROPIC_API_KEY to be set");
      }
      return buildNamed("claude", config)!;

    case "openai":
      if (!config.OPENAI_API_KEY) {
        throw new Error("MODEL_PROVIDER=openai requires OPENAI_API_KEY to be set");
      }
      return buildNamed("openai", config)!;

    case "groq":
      if (!config.GROQ_API_KEY) {
        throw new Error("MODEL_PROVIDER=groq requires GROQ_API_KEY to be set");
      }
      return buildNamed("groq", config)!;

    case "failover": {
      // D2 — build the chain from MODEL_FAILOVER_CHAIN, dropping providers
      // whose credentials are missing. Order is preserved so primary →
      // secondary → tertiary failover semantics are obvious from config.
      const order = (config.MODEL_FAILOVER_CHAIN ?? "claude,openai,groq")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const links: FailoverLink[] = [];
      for (const name of order) {
        const provider = buildNamed(name, config);
        if (provider) links.push({ name, provider });
      }

      // Resilience — terminal deterministic fallback (non-strict environments).
      // With a chain that collapses to e.g. [groq] (the only provider with
      // credentials), a single transient upstream failure ("groq: rate limit
      // exceeded", a network blip) exhausts the chain and throws. The wrapping
      // "model-provider" circuit breaker then OPENs and fast-fails EVERY
      // subsequent execution ("Circuit breaker 'model-provider' is OPEN"), so one
      // rate-limit cascades into a wave of dead-lettered runs (observed: 11 such
      // failures). Appending the always-available DeterministicModelProvider as
      // the LAST link means the failover chain always succeeds, so the breaker
      // never opens and a run degrades to a deterministic response instead of
      // failing. Skipped in strict (production/staging) mode — there a genuine
      // provider outage must fail loudly rather than silently serve canned
      // output — and skipped if the operator already placed it in the chain.
      const strict = isStrictInfrastructureMode(config.NODE_ENV) || config.STRICT_PROD === true;
      const hasDeterministic = links.some((l) => l.name.trim().toLowerCase() === "deterministic");
      if (!strict && !hasDeterministic) {
        links.push({ name: "deterministic", provider: new DeterministicModelProvider() });
      }

      if (!links.length) {
        // Reachable only in strict mode (non-strict always has the deterministic
        // terminal link above): production must be configured with real keys.
        throw new Error(
          "MODEL_PROVIDER=failover but no providers in MODEL_FAILOVER_CHAIN have valid credentials — " +
            "set ANTHROPIC_API_KEY / OPENAI_API_KEY / GROQ_API_KEY for the providers in the chain."
        );
      }
      return new FailoverModelProvider({
        links,
        perCallTimeoutMs: config.PROVIDER_TIMEOUT_MS,
        metrics
      });
    }

    default:
      // "deterministic" — safe fallback for tests and local dev without keys.
      return new DeterministicModelProvider();
  }
}
