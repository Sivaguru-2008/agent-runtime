import { describe, it, expect } from "vitest";
import { AgentRuntimeClient } from "../src/client.js";
import { ConfigurationError, NotFoundError } from "../src/errors.js";
import { jsonResponse, mockFetch, sseResponse, makeExecution } from "./helpers.js";
import type { ExecutionEvent } from "../src/types.js";

function makeClient(responses: Parameters<typeof mockFetch>[0]) {
  const { fetch, calls } = mockFetch(responses);
  const client = new AgentRuntimeClient({
    baseUrl: "https://api.test",
    apiKey: "sk_test",
    fetch,
    retry: { maxRetries: 1, baseDelayMs: 0, jitter: 0 }
  });
  return { client, calls };
}

describe("constructor", () => {
  it("rejects a missing baseUrl", () => {
    expect(() => new AgentRuntimeClient({ baseUrl: "" })).toThrow(ConfigurationError);
  });
  it("rejects an invalid baseUrl", () => {
    expect(() => new AgentRuntimeClient({ baseUrl: "not a url" })).toThrow(ConfigurationError);
  });
});

describe("createAgent", () => {
  it("POSTs to /agents with name + goal", async () => {
    const { client, calls } = makeClient([jsonResponse({ id: "agent_1", name: "a", goal: "g" }, { status: 201 })]);
    const agent = await client.createAgent({ name: "a", goal: "g" });
    expect(agent.id).toBe("agent_1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/agents");
    expect(calls[0]!.body).toEqual({ name: "a", goal: "g" });
  });

  it("forwards optional model/tools/memoryPolicy when provided", async () => {
    const { client, calls } = makeClient([jsonResponse({ id: "agent_2", name: "a", goal: "g" }, { status: 201 })]);
    await client.createAgent({ name: "a", goal: "g", model: { provider: "groq" }, tools: [{ name: "search" }] });
    expect(calls[0]!.body).toEqual({ name: "a", goal: "g", model: { provider: "groq" }, tools: [{ name: "search" }] });
  });

  it("requires name and goal", async () => {
    const { client } = makeClient([]);
    await expect(client.createAgent({ name: "", goal: "g" })).rejects.toBeInstanceOf(ConfigurationError);
    await expect(client.createAgent({ name: "a", goal: "" })).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe("createExecution", () => {
  it("POSTs to /agents/:id/tasks with the body", async () => {
    const exec = makeExecution({ status: "QUEUED" });
    const { client, calls } = makeClient([jsonResponse(exec, { status: 202 })]);
    const result = await client.createExecution({ agentId: "agent_1", prompt: "hi" });
    expect(result.id).toBe("exec_1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/agents/agent_1/tasks");
    expect(calls[0]!.body).toEqual({ prompt: "hi" });
  });

  it("requires agentId", async () => {
    const { client } = makeClient([]);
    await expect(client.createExecution({ agentId: "", prompt: "x" })).rejects.toBeInstanceOf(
      ConfigurationError
    );
  });

  it("requires at least one of prompt/goal/input", async () => {
    const { client } = makeClient([]);
    await expect(client.createExecution({ agentId: "a" })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("sends an Idempotency-Key header and enables retry when provided", async () => {
    const { client, calls } = makeClient([
      jsonResponse({ error: "QUEUE_SATURATED" }, { status: 503, headers: { "retry-after": "0" } }),
      jsonResponse(makeExecution(), { status: 202 })
    ]);
    await client.createExecution({ agentId: "a", prompt: "x", idempotencyKey: "key-123" });
    expect(calls[0]!.headers["idempotency-key"]).toBe("key-123");
    expect(calls).toHaveLength(2); // retried
  });

  it("url-encodes the agent id", async () => {
    const { client, calls } = makeClient([jsonResponse(makeExecution(), { status: 202 })]);
    await client.createExecution({ agentId: "a/b c", prompt: "x" });
    expect(calls[0]!.url).toBe("https://api.test/agents/a%2Fb%20c/tasks");
  });
});

describe("getExecution", () => {
  it("GETs the execution envelope", async () => {
    const envelope = { execution: makeExecution({ status: "COMPLETED" }), traceId: "t1", runtimeId: "r1" };
    const { client, calls } = makeClient([jsonResponse(envelope)]);
    const result = await client.getExecution("exec_1");
    expect(result.execution.status).toBe("COMPLETED");
    expect(result.traceId).toBe("t1");
    expect(calls[0]!.url).toBe("https://api.test/executions/exec_1");
  });

  it("throws NotFoundError on 404", async () => {
    const { client } = makeClient([
      jsonResponse({ error: "NOT_FOUND", message: "Execution exec_x not found" }, { status: 404 })
    ]);
    await expect(client.getExecution("exec_x")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("replayExecution", () => {
  it("POSTs to the replay endpoint", async () => {
    const replay = makeExecution({ id: "exec_2", parentExecutionId: "exec_1", status: "REPLAYING" });
    const { client, calls } = makeClient([jsonResponse(replay, { status: 202 })]);
    const result = await client.replayExecution("exec_1");
    expect(result.id).toBe("exec_2");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/executions/exec_1/replay");
  });
});

describe("listExecutions", () => {
  const envelope = {
    executions: [
      makeExecution({ id: "e1", status: "COMPLETED" }),
      makeExecution({ id: "e2", status: "FAILED" })
    ],
    count: 2
  };

  it("GETs /executions and returns the executions array", async () => {
    const { client, calls } = makeClient([jsonResponse(envelope)]);
    const result = await client.listExecutions();
    expect(result.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(calls[0]!.url).toBe("https://api.test/executions");
  });

  it("passes agentId, status, and limit as server-side query params", async () => {
    const { client, calls } = makeClient([jsonResponse(envelope)]);
    await client.listExecutions({ agentId: "agent_1", status: ["COMPLETED", "FAILED"], limit: 2 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/executions");
    expect(url.searchParams.get("agentId")).toBe("agent_1");
    expect(url.searchParams.get("status")).toBe("COMPLETED,FAILED");
    expect(url.searchParams.get("limit")).toBe("2");
  });

  it("joins a single status into the query", async () => {
    const { client, calls } = makeClient([jsonResponse(envelope)]);
    await client.listExecutions({ status: "COMPLETED" });
    expect(new URL(calls[0]!.url).searchParams.get("status")).toBe("COMPLETED");
  });

  it("tolerates a missing executions field", async () => {
    const { client } = makeClient([jsonResponse({ count: 0 })]);
    expect(await client.listExecutions()).toEqual([]);
  });
});

describe("streamExecution", () => {
  it("yields filtered events for an execution", async () => {
    const { client } = makeClient([
      sseResponse([
        'id: 1\nevent: COGNITION_STARTED\ndata: {"type":"COGNITION_STARTED","aggregateId":"exec_1"}\n\n',
        'id: 2\nevent: OTHER\ndata: {"type":"OTHER","aggregateId":"exec_999"}\n\n',
        'id: 3\nevent: COGNITION_COMPLETED\ndata: {"type":"COGNITION_COMPLETED","aggregateId":"exec_1"}\n\n'
      ])
    ]);
    const events: ExecutionEvent[] = [];
    for await (const e of client.streamExecution({ executionId: "exec_1" })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(["COGNITION_STARTED", "COGNITION_COMPLETED"]);
  });

  it("passes afterSequence as a query param and sets the SSE accept header", async () => {
    const { client, calls } = makeClient([sseResponse([])]);
    // drain the (empty) generator
    for await (const _ of client.streamExecution({ afterSequence: 10 })) void _;
    expect(calls[0]!.url).toBe("https://api.test/events/stream?afterSequence=10");
    expect(calls[0]!.headers["accept"]).toBe("text/event-stream");
  });

  it("can be stopped with an AbortController", async () => {
    const ac = new AbortController();
    const { client } = makeClient([
      sseResponse([
        'id: 1\ndata: {"type":"A","aggregateId":"exec_1"}\n\n',
        'id: 2\ndata: {"type":"B","aggregateId":"exec_1"}\n\n'
      ])
    ]);
    const seen: string[] = [];
    for await (const e of client.streamExecution({ executionId: "exec_1", signal: ac.signal })) {
      seen.push(e.type);
      ac.abort();
    }
    expect(seen).toEqual(["A"]);
  });
});

describe("waitForExecution", () => {
  it("polls until a terminal state", async () => {
    const { client } = makeClient([
      jsonResponse({ execution: makeExecution({ status: "RUNNING" }) }),
      jsonResponse({ execution: makeExecution({ status: "RUNNING" }) }),
      jsonResponse({ execution: makeExecution({ status: "COMPLETED" }) })
    ]);
    const result = await client.waitForExecution("exec_1", { pollIntervalMs: 0 });
    expect(result.status).toBe("COMPLETED");
  });

  it("throws when the deadline passes before terminal", async () => {
    const { client } = makeClient([jsonResponse({ execution: makeExecution({ status: "RUNNING" }) })]);
    await expect(
      client.waitForExecution("exec_1", { timeoutMs: 0, pollIntervalMs: 0 })
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
