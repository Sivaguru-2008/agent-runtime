import type {
  Agent,
  AgentDetails,
  ClusterSnapshot,
  Execution,
  ExecutionDetails,
  FailureClusterReport,
  Overview,
  Topology
} from "@/types/observability";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/runtime";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  baseUrl: API_BASE,
  overview: () => request<Overview>("/observability/overview"),
  topology: () => request<Topology>("/observability/topology"),
  agents: () => request<Agent[]>("/agents"),
  agent: (agentId: string) => request<AgentDetails>(`/agents/${agentId}`),
  execution: (executionId: string) => request<ExecutionDetails>(`/executions/${executionId}`),
  createAgent: () =>
    request<Agent>("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "runloop-self-healing-agent",
        goal: "Process travel order cancellations, issue Stripe refunds, and update database ledgers.",
        tools: [
          { name: "sandbox.payment_refund", enabled: true },
          { name: "sandbox.db_write", enabled: true }
        ]
      })
    }),
  addMemory: (agentId: string, content: string) =>
    request(`/agents/${agentId}/memory`, {
      method: "POST",
      body: JSON.stringify({
        type: "EPISODIC",
        content,
        metadata: { source: "observability-dashboard" }
      })
    }),
  runTask: (agentId: string, prompt: string) =>
    request<Execution>(`/agents/${agentId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ prompt })
    }),
  replay: (executionId: string) =>
    request<Execution>(`/executions/${executionId}/replay`, {
      method: "POST"
    }),
  failureClusters: () => request<FailureClusterReport>("/observability/failure-clusters"),
  snapshot: (executionId: string) => request<Record<string, unknown>>(`/executions/${executionId}/snapshot`),
  clusterSnapshot: () => request<ClusterSnapshot>("/cluster/snapshot"),
  drainWorker: (workerId: string) =>
    request(`/cluster/workers/${workerId}/drain`, { method: "POST" }),
  recoverCluster: () => request<{ recovered: number }>("/cluster/recover", { method: "POST" })
};

export function snapshotUrl(executionId: string) {
  return `${API_BASE}/executions/${executionId}/snapshot`;
}

export function eventStreamUrl() {
  return `${API_BASE}/events/stream`;
}
