import type { ExecutionEvent } from "./types.js";

/**
 * A single parsed Server-Sent Event frame.
 *
 * `data` is the concatenated `data:` lines (newline-joined per the spec).
 * `event`/`id` mirror the SSE fields. Comment-only frames (keepalives) are
 * never emitted by the parser.
 */
export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Incremental SSE parser. Feed it decoded text chunks; it yields complete
 * frames. Handles CRLF/LF, multi-line `data:`, comment lines (`:`), and the
 * `field: value` / `field:value` spacing rules from the WHATWG spec.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventType: string | undefined;
  private lastId: string | undefined;

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let newlineIndex: number;
    // Normalise CRLF to LF so a single split rule works.
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const frame = this.consumeLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private consumeLine(line: string): SseFrame | undefined {
    // Blank line: dispatch the accumulated frame.
    if (line === "") {
      if (this.dataLines.length === 0 && this.eventType === undefined) {
        return undefined; // nothing to dispatch
      }
      const frame: SseFrame = {
        data: this.dataLines.join("\n"),
        ...(this.eventType !== undefined ? { event: this.eventType } : {}),
        ...(this.lastId !== undefined ? { id: this.lastId } : {})
      };
      this.dataLines = [];
      this.eventType = undefined;
      return frame;
    }

    // Comment line (keepalive). Ignore.
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventType = value;
        break;
      case "id":
        this.lastId = value;
        break;
      // `retry` and unknown fields are ignored.
      default:
        break;
    }
    return undefined;
  }
}

/**
 * Convert a `ReadableStream<Uint8Array>` (a fetch `Response.body`) into an
 * async iterator of decoded text chunks. Works whether the runtime exposes
 * `body` as an async-iterable or only via `getReader()`.
 */
async function* readStreamText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse an SSE Response body into typed {@link ExecutionEvent}s.
 *
 * Each frame's `data` is JSON-parsed; if a frame carries an `id`, it is
 * attached as `sequence` when the payload lacks one. The optional `filter`
 * drops events that do not match (used to scope a stream to one execution).
 */
export async function* parseEventStream(
  response: Response,
  filter?: (event: ExecutionEvent) => boolean,
  signal?: AbortSignal
): AsyncGenerator<ExecutionEvent> {
  if (!response.body) return;
  const parser = new SseParser();

  for await (const chunk of readStreamText(response.body)) {
    if (signal?.aborted) return;
    for (const frame of parser.push(chunk)) {
      const event = frameToEvent(frame);
      if (!event) continue;
      if (!filter || filter(event)) yield event;
    }
  }
}

function frameToEvent(frame: SseFrame): ExecutionEvent | undefined {
  if (frame.data === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    // Non-JSON data line — surface it as a raw payload rather than dropping it.
    return {
      type: frame.event ?? "message",
      payload: { raw: frame.data },
      ...(frame.id !== undefined && /^\d+$/.test(frame.id) ? { sequence: Number(frame.id) } : {})
    };
  }
  // A JSON scalar (string/number/bool) is wrapped as a payload value; only an
  // object body is treated as the event envelope itself.
  const base: ExecutionEvent =
    parsed && typeof parsed === "object"
      ? (parsed as ExecutionEvent)
      : { type: frame.event ?? "message", payload: { value: parsed } as Record<string, unknown> };

  // Server tags each frame `event: <type>` and `id: <sequence>`. Backfill the
  // envelope fields from the frame when the JSON body omits them.
  if (frame.event && !base.type) base.type = frame.event;
  if (!base.type) base.type = "message";
  if (base.sequence === undefined && frame.id !== undefined && /^\d+$/.test(frame.id)) {
    base.sequence = Number(frame.id);
  }
  return base;
}

/**
 * Build the default event filter for a single execution. An event matches when
 * its `aggregateId` is the execution, or its payload references the execution
 * id under a common field name.
 */
export function executionFilter(executionId: string): (event: ExecutionEvent) => boolean {
  return (event) => {
    if (event.aggregateId === executionId) return true;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload) {
      if (payload.executionId === executionId) return true;
      if (payload.id === executionId && event.aggregateType === "EXECUTION") return true;
    }
    return false;
  };
}
