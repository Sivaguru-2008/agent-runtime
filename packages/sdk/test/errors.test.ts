import { describe, it, expect } from "vitest";
import {
  AgentRuntimeError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServiceUnavailableError,
  ServerError,
  ApiError,
  errorFromResponse
} from "../src/errors.js";

describe("errorFromResponse", () => {
  it("maps each status code to the right subclass", () => {
    const cases: Array<[number, typeof AgentRuntimeError]> = [
      [400, ValidationError],
      [401, AuthenticationError],
      [403, AuthorizationError],
      [404, NotFoundError],
      [409, ConflictError],
      [429, RateLimitError],
      [503, ServiceUnavailableError],
      [500, ServerError],
      [502, ServerError],
      [418, ApiError]
    ];
    for (const [status, Ctor] of cases) {
      const err = errorFromResponse(status, { error: "X", message: "boom" });
      expect(err, `status ${status}`).toBeInstanceOf(Ctor);
      expect(err).toBeInstanceOf(AgentRuntimeError);
      expect(err.status).toBe(status);
    }
  });

  it("parses the flat `{ error, message }` envelope", () => {
    const err = errorFromResponse(404, { error: "NOT_FOUND", message: "Execution exec_9 not found" });
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Execution exec_9 not found");
  });

  it("parses the nested `{ success:false, error:{ type, message } }` envelope", () => {
    const err = errorFromResponse(503, {
      success: false,
      error: { type: "PROVIDER_UNAVAILABLE", message: "rate limited", retryable: true }
    });
    expect(err.code).toBe("PROVIDER_UNAVAILABLE");
    expect(err.message).toBe("rate limited");
    expect(err).toBeInstanceOf(ServiceUnavailableError);
  });

  it("captures the server errorId on 500s", () => {
    const err = errorFromResponse(500, { error: "INTERNAL_ERROR", message: "boom", errorId: "err_abc" });
    expect(err.errorId).toBe("err_abc");
  });

  it("marks 429/503/5xx as retryable and 4xx (except 429) as non-retryable", () => {
    expect(errorFromResponse(429, {}).retryable).toBe(true);
    expect(errorFromResponse(503, {}).retryable).toBe(true);
    expect(errorFromResponse(500, {}).retryable).toBe(true);
    expect(errorFromResponse(400, {}).retryable).toBe(false);
    expect(errorFromResponse(404, {}).retryable).toBe(false);
  });

  it("threads retryAfterMs through", () => {
    const err = errorFromResponse(503, {}, 5000);
    expect(err.retryAfterMs).toBe(5000);
  });

  it("falls back to a generic message when the body has none", () => {
    const err = errorFromResponse(500, "plain text body");
    expect(err.message).toContain("500");
  });

  it("supports instanceof across the hierarchy", () => {
    const err = errorFromResponse(404, {});
    expect(err instanceof NotFoundError).toBe(true);
    expect(err instanceof AgentRuntimeError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
