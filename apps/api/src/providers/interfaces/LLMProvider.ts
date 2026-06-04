/**
 * LLMProvider — the canonical provider abstraction layer.
 *
 * All application code depends on THIS interface, never on a concrete vendor
 * SDK or endpoint. A provider exposes exactly three capabilities:
 *
 *   chat()       — run a chat completion (optionally streaming via onToken).
 *   health()     — lightweight reachability + latency probe.
 *   listModels() — enumerate the models the provider can serve.
 *
 * Operational impact  : a single seam means swapping the backing vendor (Groq,
 *   and any future provider) touches only the provider directory — routes,
 *   runtime tracing, cognition tracking and observability are untouched.
 * Replay implications : chat() returns a deterministic { text, usage } shape so
 *   the token accounting persisted in the cognition graph is provider-agnostic.
 * Failure modes       : every failure is normalised to the typed ProviderError
 *   hierarchy (see ../errors.ts) so the shared retry policy and the
 *   /api/health/llm envelope behave identically across providers.
 */

/** A single chat message in the provider-neutral request envelope. */
export interface LLMChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMChatRequest {
  /** Ordered conversation. The first system message (if any) is the system prompt. */
  messages: LLMChatMessage[];
  /** Override the provider's default model for this call. */
  model?: string;
  /** Sampling temperature. 0 = deterministic. */
  temperature?: number;
  /** Maximum completion tokens. */
  maxTokens?: number;
  /** Abort signal so callers can cancel mid-stream. */
  signal?: AbortSignal;
  /**
   * Optional streaming sink. Invoked once per token as it arrives so the live
   * SSE bridge can forward tokens to the UI in real time. Resolution of the
   * returned promise still yields the full aggregated text.
   */
  onToken?: (token: string, confidence: number) => void;
}

export interface LLMTokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface LLMChatResponse {
  /** The full assistant message text. */
  text: string;
  /** The model id that actually served the request. */
  model: string;
  usage: LLMTokenUsage;
}

/**
 * Health probe result. Shape mirrors the GET /api/health/llm contract so the
 * route can return it (plus a timestamp) without remapping fields.
 */
export interface LLMHealth {
  provider: string;
  online: boolean;
  /** Round-trip latency of the probe in milliseconds. */
  latency: number;
  /** The currently selected default model. */
  selectedModel: string;
  /** Present only when online === false. */
  error?: string;
}

export interface LLMProvider {
  /** Stable provider identifier, e.g. "groq". Used for structured logs/metrics. */
  readonly provider: string;
  /** The default model this provider serves when a request omits `model`. */
  readonly selectedModel: string;
  /** Run a chat completion. Streams via request.onToken when supplied. */
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  /** Probe reachability + latency without running inference. */
  health(): Promise<LLMHealth>;
  /** Enumerate the models the provider can serve. */
  listModels(): Promise<string[]>;
}
