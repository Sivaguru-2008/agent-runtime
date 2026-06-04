import { ConfigurationError } from "./errors.js";
import type { RetryOptions } from "./retry.js";

/** A fetch-compatible function. Defaults to the global `fetch`. */
export type FetchLike = typeof fetch;

/** How the API key is presented to the server. */
export type AuthScheme = "x-api-key" | "bearer";

export interface ClientConfig {
  /**
   * Base URL of the API, e.g. `https://api.example.com` or
   * `http://localhost:4000`. Trailing slashes are trimmed.
   */
  baseUrl: string;
  /**
   * API key. Sent as `X-Api-Key` by default, or `Authorization: Bearer <key>`
   * when `authScheme` is `"bearer"`. Can be omitted only when the target
   * server runs with auth disabled (local/dev).
   *
   * Typed `string | undefined` so you can pass `process.env.AGENT_API_KEY`
   * directly without a non-null assertion.
   */
  apiKey?: string | undefined;
  /** Auth header style. Defaults to `"x-api-key"`. */
  authScheme?: AuthScheme;
  /** Per-request timeout in milliseconds. Defaults to 30_000. 0 disables. */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Retry behaviour. See {@link RetryOptions}. */
  retry?: RetryOptions;
  /** Override the fetch implementation (tests, proxies, custom agents). */
  fetch?: FetchLike;
  /** User-Agent suffix appended to the SDK's default UA. */
  userAgent?: string;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKey?: string;
  authScheme: AuthScheme;
  timeoutMs: number;
  headers: Record<string, string>;
  retry: RetryOptions;
  fetch: FetchLike;
  userAgent: string;
}

const SDK_VERSION = "0.1.0";

export function resolveConfig(config: ClientConfig): ResolvedConfig {
  if (!config || typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
    throw new ConfigurationError("`baseUrl` is required and must be a non-empty string.");
  }

  let baseUrl: string;
  try {
    // Validate eagerly so misconfiguration fails at construction, not first call.
    baseUrl = new URL(config.baseUrl).toString().replace(/\/+$/, "");
  } catch {
    throw new ConfigurationError(`\`baseUrl\` is not a valid URL: ${config.baseUrl}`);
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ConfigurationError(
      "No global `fetch` available. Pass `fetch` in the client config or run on Node >= 20."
    );
  }

  return {
    baseUrl,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    authScheme: config.authScheme ?? "x-api-key",
    timeoutMs: config.timeoutMs ?? 30_000,
    headers: { ...config.headers },
    retry: config.retry ?? {},
    fetch: fetchImpl,
    userAgent: `agent-platform-sdk/${SDK_VERSION}${config.userAgent ? ` ${config.userAgent}` : ""}`
  };
}

/** Build the auth headers for the resolved config. */
export function authHeaders(config: ResolvedConfig): Record<string, string> {
  if (!config.apiKey) return {};
  if (config.authScheme === "bearer") {
    return { authorization: `Bearer ${config.apiKey}` };
  }
  return { "x-api-key": config.apiKey };
}
