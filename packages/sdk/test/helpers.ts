import type { FetchLike } from "../src/config.js";
import type { Execution } from "../src/types.js";

/** Build a JSON Response with optional status and headers. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

/** Build an SSE Response that emits the given raw text chunks then closes. */
export function sseResponse(chunks: string[], init: { status?: number } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(stream, {
    status: init.status ?? 200,
    headers: { "content-type": "text/event-stream" }
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A scripted fetch mock. Provide a queue of responses (or response factories);
 * each call shifts one. Records every request for assertions.
 */
export function mockFetch(
  responses: Array<Response | ((call: RecordedCall) => Response | Promise<Response>) | Error>
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...responses];

  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined
    };
    calls.push(call);

    const next = queue.shift();
    if (next === undefined) throw new Error(`mockFetch: no scripted response for ${call.method} ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  };

  return { fetch, calls };
}

export function makeExecution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: "exec_1",
    agentId: "agent_1",
    status: "RUNNING",
    input: {},
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
