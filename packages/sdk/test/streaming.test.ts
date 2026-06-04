import { describe, it, expect } from "vitest";
import { SseParser, parseEventStream, executionFilter } from "../src/streaming.js";
import { sseResponse } from "./helpers.js";
import type { ExecutionEvent } from "../src/types.js";

describe("SseParser", () => {
  it("parses a single complete frame", () => {
    const p = new SseParser();
    const frames = p.push("event: PING\ndata: {\"x\":1}\n\n");
    expect(frames).toEqual([{ event: "PING", data: '{"x":1}' }]);
  });

  it("buffers partial frames across chunks", () => {
    const p = new SseParser();
    expect(p.push("event: PING\nda")).toEqual([]);
    expect(p.push("ta: hello\n\n")).toEqual([{ event: "PING", data: "hello" }]);
  });

  it("joins multi-line data fields with newlines", () => {
    const p = new SseParser();
    const frames = p.push("data: line1\ndata: line2\n\n");
    expect(frames[0]!.data).toBe("line1\nline2");
  });

  it("captures id and handles CRLF line endings", () => {
    const p = new SseParser();
    const frames = p.push("id: 42\r\nevent: TICK\r\ndata: ok\r\n\r\n");
    expect(frames[0]).toEqual({ id: "42", event: "TICK", data: "ok" });
  });

  it("ignores comment (keepalive) lines", () => {
    const p = new SseParser();
    expect(p.push(": keepalive 123\n\n")).toEqual([]);
  });

  it("handles `field:value` with no space after colon", () => {
    const p = new SseParser();
    const frames = p.push("data:tight\n\n");
    expect(frames[0]!.data).toBe("tight");
  });
});

describe("parseEventStream", () => {
  async function collect(gen: AsyncGenerator<ExecutionEvent>): Promise<ExecutionEvent[]> {
    const out: ExecutionEvent[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it("parses JSON frames into typed events", async () => {
    const res = sseResponse([
      'id: 1\nevent: COGNITION_STARTED\ndata: {"type":"COGNITION_STARTED","aggregateId":"exec_1"}\n\n',
      'id: 2\nevent: COGNITION_COMPLETED\ndata: {"type":"COGNITION_COMPLETED","aggregateId":"exec_1"}\n\n'
    ]);
    const events = await collect(parseEventStream(res));
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("COGNITION_STARTED");
    expect(events[0]!.sequence).toBe(1);
    expect(events[1]!.sequence).toBe(2);
  });

  it("backfills type/sequence from frame fields when JSON omits them", async () => {
    const res = sseResponse(['id: 7\nevent: TICK\ndata: {"foo":"bar"}\n\n']);
    const [event] = await collect(parseEventStream(res));
    expect(event!.type).toBe("TICK");
    expect(event!.sequence).toBe(7);
  });

  it("applies the execution filter", async () => {
    const res = sseResponse([
      'data: {"type":"A","aggregateId":"exec_1"}\n\n',
      'data: {"type":"B","aggregateId":"exec_2"}\n\n',
      'data: {"type":"C","payload":{"executionId":"exec_1"}}\n\n'
    ]);
    const events = await collect(parseEventStream(res, executionFilter("exec_1")));
    expect(events.map((e) => e.type)).toEqual(["A", "C"]);
  });

  it("yields nothing for a body-less response", async () => {
    const res = new Response(null, { status: 200 });
    expect(await collect(parseEventStream(res))).toEqual([]);
  });

  it("surfaces non-JSON data as a raw payload instead of dropping it", async () => {
    const res = sseResponse(["data: not-json\n\n"]);
    const [event] = await collect(parseEventStream(res));
    expect(event!.payload).toMatchObject({ raw: "not-json" });
  });
});

describe("executionFilter", () => {
  const match = executionFilter("exec_42");
  it("matches on aggregateId", () => {
    expect(match({ type: "X", aggregateId: "exec_42" })).toBe(true);
  });
  it("matches on payload.executionId", () => {
    expect(match({ type: "X", payload: { executionId: "exec_42" } })).toBe(true);
  });
  it("rejects unrelated events", () => {
    expect(match({ type: "X", aggregateId: "other" })).toBe(false);
  });
});
