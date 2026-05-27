/**
 * Minimal ExecutionJob fixtures for chaos suites. We don't import the model
 * factories from the integration tree because chaos doesn't exercise the
 * cognition graph — only the queue contract.
 */

import type { ExecutionJob } from "../../../src/domain/jobQueue.js";

export function makeJob(jobId: string, overrides: Partial<ExecutionJob> = {}): ExecutionJob {
  const now = new Date().toISOString();
  return {
    jobId,
    agentId: `agent-${jobId}`,
    executionId: `exec-${jobId}`,
    agentSnapshot: {
      id: `agent-${jobId}`,
      name: `chaos-agent`,
      status: "active",
      createdAt: now,
      updatedAt: now,
      tenantId: "chaos-tenant"
    } as unknown as ExecutionJob["agentSnapshot"],
    executionSnapshot: {
      id: `exec-${jobId}`,
      agentId: `agent-${jobId}`,
      status: "QUEUED",
      createdAt: now,
      updatedAt: now
    } as unknown as ExecutionJob["executionSnapshot"],
    task: { goal: "chaos-probe" },
    enqueuedAt: now,
    attempt: 0,
    priorFailures: 0,
    ...overrides
  };
}
