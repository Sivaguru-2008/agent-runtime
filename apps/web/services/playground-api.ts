import type { LiveExecutionState } from "@/events/live-events";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/runtime";

export interface RuntimeMetrics {
  executions: { total: number; active: number; completed: number; failed: number };
  tokens: { total: number };
  latency: { totalMs: number; averageMs: number };
  stream: { totalMs: number; averageMs: number };
  tokensPerSecond: number;
}

export interface ExecutionRecord {
  id: string;
  prompt: string;
  state: LiveExecutionState;
  model: string;
  startedAt: string;
  completedAt?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  streamDurationMs: number;
  tokensPerSecond: number;
  output: string;
  error?: { message: string; code: string };
}

export interface HealthResponse {
  ok: boolean;
  model: string;
  provider: "groq";
  groq: "online" | "offline";
}

/** Groq models surfaced in the playground model selector. */
export const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "deepseek-r1-distill-llama-70b",
  "qwen-qwq-32b"
] as const;

export type GroqModel = (typeof GROQ_MODELS)[number];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
      cache: "no-store"
    });
  } catch (err) {
    throw new Error(
      `Backend is unavailable — ensure the API server is running on port 4000. ` +
        `(${err instanceof Error ? err.message : String(err)})`
    );
  }
  if (!response.ok && response.status !== 202 && response.status !== 502) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`API ${path} failed: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

export const playgroundApi = {
  health: () => request<HealthResponse>("/agent/health"),
  metrics: () => request<RuntimeMetrics>("/agent/metrics"),
  executions: () => request<ExecutionRecord[]>("/agent/executions"),
  execution: (id: string) => request<ExecutionRecord>(`/agent/executions/${id}`),
  run: (prompt: string, opts: { system?: string; temperature?: number; model?: string } = {}) =>
    request<ExecutionRecord>("/agent/run", {
      method: "POST",
      body: JSON.stringify({ prompt, ...opts })
    })
};

export function liveEventStreamUrl(executionId?: string): string {
  const params = new URLSearchParams();
  if (executionId) params.set("executionId", executionId);
  const qs = params.toString();
  return `${API_BASE}/agent/events${qs ? `?${qs}` : ""}`;
}
