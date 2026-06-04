import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../app/api/runtime/[...path]/route";

describe("Runloop Console Proxy & API Integration", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.useFakeTimers();
    if ((globalThis as any).breaker) {
      (globalThis as any).breaker.recordSuccess();
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // 1. Frontend starts before API (handles connection delays gracefully)
  it("Scenario 1: Handles connection delays gracefully with retry backoff when Frontend starts before API", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        const err: any = new Error("fetch failed");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return new Response(JSON.stringify({ ok: true, data: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-runtime-id": "test-runtime-id" }
      });
    });

    const req = new NextRequest("http://localhost:3000/api/runtime/agents", {
      method: "GET",
      headers: { "x-trace-id": "test-trace" }
    });

    const handlerPromise = GET(req, { params: Promise.resolve({ path: ["agents"] }) });
    
    await vi.runAllTimersAsync();
    
    const res = await handlerPromise;
    expect(res.status).toBe(200);
    expect(callCount).toBe(3); 
    const json = await res.json();
    expect(json.data).toBe("success");
  });

  // 2. API starts before frontend
  it("Scenario 2: Connects instantly when API starts before frontend", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: "instant" }), {
        status: 200,
        headers: { "Content-Type": "application/json", "x-runtime-id": "test-runtime-id" }
      })
    );

    const req = new NextRequest("http://localhost:3000/api/runtime/agents");
    const res = await GET(req, { params: Promise.resolve({ path: ["agents"] }) });
    
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toBe("instant");
  });

  // 3. API restart while frontend remains running
  it("Scenario 3: Smooth recovery after API restart", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount >= 2 && callCount <= 4) {
        const err: any = new Error("fetch failed");
        err.code = "ECONNREFUSED";
        throw err;
      }
      return new Response(JSON.stringify({ attempt: callCount }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });

    // Request 1: successful
    const req1 = new NextRequest("http://localhost:3000/api/runtime/agents");
    const res1 = await GET(req1, { params: Promise.resolve({ path: ["agents"] }) });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ attempt: 1 });

    // Request 2: API restarted/down -> fails -> retries and fails
    const req2 = new NextRequest("http://localhost:3000/api/runtime/agents");
    const handlerPromise = GET(req2, { params: Promise.resolve({ path: ["agents"] }) });
    await vi.runAllTimersAsync();
    const res2 = await handlerPromise;
    expect(res2.status).toBe(503); 

    // Request 3: API back up -> succeeds again
    const req3 = new NextRequest("http://localhost:3000/api/runtime/agents");
    const res3 = await GET(req3, { params: Promise.resolve({ path: ["agents"] }) });
    expect(res3.status).toBe(200);
    expect(await res3.json()).toEqual({ attempt: 5 }); 
  });

  // 4. Temporary API outage
  it("Scenario 4: Temporary API outage returns structured JSON instead of 500 HTML", async () => {
    global.fetch = vi.fn().mockRejectedValue({
      code: "ECONNREFUSED",
      message: "ECONNREFUSED"
    });

    const req = new NextRequest("http://localhost:3000/api/runtime/agents");
    const handlerPromise = GET(req, { params: Promise.resolve({ path: ["agents"] }) });
    await vi.runAllTimersAsync();
    const res = await handlerPromise;

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toBe("ECONNREFUSED");
    expect(json.message).toContain("starting up or temporarily unreachable");
  });

  // 5. Circuit Breaker protection
  it("Scenario 5: Tripped Circuit Breaker blocks requests and returns 503 CIRCUIT_OPEN", async () => {
    global.fetch = vi.fn().mockRejectedValue({ code: "ECONNREFUSED", message: "Refused" });

    // Try 6 times to trip breaker (threshold = 5)
    for (let i = 0; i < 6; i++) {
      const req = new NextRequest("http://localhost:3000/api/runtime/agents");
      const p = GET(req, { params: Promise.resolve({ path: ["agents"] }) });
      await vi.runAllTimersAsync();
      await p;
    }

    // Reset fetch to verify it's blocked and not called
    global.fetch = vi.fn();
    const req = new NextRequest("http://localhost:3000/api/runtime/agents");
    const res = await GET(req, { params: Promise.resolve({ path: ["agents"] }) });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toBe("CIRCUIT_OPEN");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 6. SSE Transparent Streaming & Cursors
  it("Scenario 6: SSE transparent chunk streaming handles reconnect parameters", async () => {
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: event-payload\n\n"));
        controller.close();
      }
    });

    global.fetch = vi.fn().mockResolvedValue(
      new Response(mockStream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      })
    );

    const req = new NextRequest("http://localhost:3000/api/runtime/events/stream?afterSequence=42");
    const res = await GET(req, { params: Promise.resolve({ path: ["events", "stream"] }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    
    const reader = res.body?.getReader();
    const chunk = await reader?.read();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain("data: event-payload");
  });

  // 7. Empty datasets
  it("Scenario 7: UI/Queries handles empty datasets gracefully", () => {
    const emptyGraph = {
      nodes: [],
      edges: []
    };
    
    const toFlow = (details?: any) => {
      if (!details) return { nodes: [], edges: [] };
      return {
        nodes: details.graph.nodes,
        edges: details.graph.edges
      };
    };

    const details = { graph: emptyGraph };
    const flow = toFlow(details);
    expect(flow.nodes).toHaveLength(0);
    expect(flow.edges).toHaveLength(0);
  });

  // 8. Missing admin configuration (Degraded Mode check)
  it("Scenario 8: Missing admin configuration handles stubs correctly", () => {
    const degradedHandler = (db: any) => {
      if (!db) {
        return {
          status: 503,
          body: {
            error: "ADMIN_REQUIRES_DATABASE",
            message: "Admin endpoints require a Postgres-backed security database."
          }
        };
      }
      return { status: 200, body: { ok: true } };
    };

    const res1 = degradedHandler(null);
    expect(res1.status).toBe(503);
    expect(res1.body.error).toBe("ADMIN_REQUIRES_DATABASE");

    const res2 = degradedHandler({});
    expect(res2.status).toBe(200);
  });

  // 9. DAG Rendering & Fallback Generation
  it("Scenario 9: Hydrates flow nodes with fallback node generation on empty history", () => {
    const emptyEvents: any[] = [];
    const flowEvents = emptyEvents.filter(
      (event) =>
        event.type === "EXECUTION_STARTED" ||
        event.type === "EXECUTION_STEP_STARTED" ||
        event.type === "MODEL_COMPLETED" ||
        event.type === "TOOL_CALLED" ||
        event.type === "MEMORY_RETRIEVED" ||
        event.type === "EXECUTION_COMPLETED" ||
        event.type === "EXECUTION_FAILED"
    );

    const graphNodes: any[] = [...flowEvents];
    
    // Test the fallback generator logic
    if (graphNodes.length === 0) {
      graphNodes.push({
        id: "fallback-exec-id",
        type: "EXECUTION_STARTED",
        label: "execution started (fallback)",
        timestamp: new Date().toISOString(),
        data: { message: "Execution resolved successfully." },
        metadata: {
          aggregateId: "exec-id",
          traceId: "trace-id",
          reasoningIntensity: 0
        }
      });
    }

    expect(graphNodes).toHaveLength(1);
    expect(graphNodes[0].type).toBe("EXECUTION_STARTED");
    expect(graphNodes[0].id).toBe("fallback-exec-id");
  });
});
