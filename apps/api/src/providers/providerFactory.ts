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
import { ClaudeProvider } from "./claudeProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { OllamaModelProvider } from "./ollamaModelProvider.js";
import { OllamaProvider } from "./ollama.js";
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
    case "ollama":
      return new OllamaModelProvider(
        new OllamaProvider({
          baseUrl: config.OLLAMA_URL,
          model: config.OLLAMA_MODEL,
          requestTimeoutMs: config.OLLAMA_REQUEST_TIMEOUT_MS
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

    case "ollama":
      return buildNamed("ollama", config)!;

    case "failover": {
      // D2 — build the chain from MODEL_FAILOVER_CHAIN, dropping providers
      // whose credentials are missing. Order is preserved so primary →
      // secondary → tertiary failover semantics are obvious from config.
      const order = (config.MODEL_FAILOVER_CHAIN ?? "claude,openai,ollama")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const links: FailoverLink[] = [];
      for (const name of order) {
        const provider = buildNamed(name, config);
        if (provider) links.push({ name, provider });
      }
      if (!links.length) {
        throw new Error(
          "MODEL_PROVIDER=failover but no providers in MODEL_FAILOVER_CHAIN have valid credentials — " +
            "set ANTHROPIC_API_KEY / OPENAI_API_KEY and/or include 'ollama' in the chain."
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
