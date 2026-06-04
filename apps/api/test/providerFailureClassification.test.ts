import { describe, expect, it } from "vitest";
import { classifyTransientProviderFailure } from "../src/interfaces/http/routes.js";
import {
  ProviderRateLimitError,
  ProviderNetworkError,
  ProviderServerError,
  ProviderTimeoutError,
  ProviderAuthError
} from "../src/providers/errors.js";
import { AllProvidersFailedError } from "../src/providers/failoverModelProvider.js";
import { RuntimeExecutionError } from "../src/shared/errors.js";
import { CircuitOpenError } from "../src/infrastructure/reliability/circuitBreaker.js";

/**
 * The HTTP error handler maps a *transient* provider outage to 503 + Retry-After
 * rather than an opaque 500. This is the regression guard for the symptom where
 * Groq going offline mid-runloop surfaced as "500 Internal Server Error" in the
 * Run Studio. The classifier must recognise the outage both as a typed error
 * AND by message — the cognition orchestrator flattens a failed role to a plain
 * Error whose message is the only thing that survives.
 */
describe("classifyTransientProviderFailure", () => {
  it("classifies a direct rate-limit as transient with the provider's back-off hint", () => {
    expect(classifyTransientProviderFailure(new ProviderRateLimitError("groq", 8000))).toEqual({
      retryAfterSec: 8
    });
  });

  it("classifies an OPEN circuit breaker as transient", () => {
    expect(classifyTransientProviderFailure(new CircuitOpenError("groq"))).toEqual({
      retryAfterSec: 10
    });
  });

  it("classifies an unreachable provider (typed ProviderNetworkError) as transient", () => {
    expect(
      classifyTransientProviderFailure(new ProviderNetworkError("groq", new Error("ECONNREFUSED")))
    ).toEqual({ retryAfterSec: 5 });
  });

  it("classifies a provider timeout and upstream 5xx as transient", () => {
    expect(classifyTransientProviderFailure(new ProviderTimeoutError("groq", 2000))).toEqual({
      retryAfterSec: 5
    });
    expect(classifyTransientProviderFailure(new ProviderServerError("groq", 503))).toEqual({
      retryAfterSec: 5
    });
  });

  it("classifies an exhausted failover chain as transient", () => {
    const err = new AllProvidersFailedError(["groq"], [{ provider: "groq", error: "network error" }]);
    expect(classifyTransientProviderFailure(err)).toEqual({ retryAfterSec: 10 });
  });

  it("walks the wrapped cause chain (orchestrator wraps the provider error)", () => {
    // Mirrors the real path: RuntimeExecutionError(originalError = ProviderNetworkError).
    const wrapped = new RuntimeExecutionError(
      "Cognition execution encountered fatal error",
      "cog-1",
      true,
      true,
      new ProviderNetworkError("groq", new Error("getaddrinfo ENOTFOUND"))
    );
    expect(classifyTransientProviderFailure(wrapped)).toEqual({ retryAfterSec: 5 });
  });

  it("matches by message when the type has been flattened to a plain Error", () => {
    // The orchestrator surfaces a failed role as node.output.error (a string) and
    // re-wraps it as a generic Error, so only the message survives the round-trip.
    const flattened = new Error(
      "Execution failed at stage EXECUTE: All providers in failover chain [groq] failed: " +
        "groq=groq: network error — is the service reachable?"
    );
    expect(classifyTransientProviderFailure(flattened)).toEqual({ retryAfterSec: 10 });

    expect(
      classifyTransientProviderFailure(new Error("groq: network error — is the service reachable?"))
    ).toEqual({ retryAfterSec: 5 });
  });

  it("does NOT classify a genuine bug or a non-transient provider error as transient", () => {
    expect(classifyTransientProviderFailure(new Error("Cannot read properties of undefined"))).toBeNull();
    // Auth failure is a misconfiguration, not a transient outage — must stay a hard error.
    expect(classifyTransientProviderFailure(new ProviderAuthError("groq"))).toBeNull();
    expect(classifyTransientProviderFailure(undefined)).toBeNull();
  });
});
