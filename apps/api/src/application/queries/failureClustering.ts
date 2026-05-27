import type { DomainEvent } from "../../domain/events.js";
import type { ObservabilityWarning, WarningKind } from "./failureAnalysisEngine.js";

export interface FailureCluster {
  id: string;
  fingerprint: string;
  kind: WarningKind | "EXECUTION_FAILURE" | "HALLUCINATION_PATTERN" | "UNSTABLE_TOOL_CHAIN";
  signature: string;
  description: string;
  occurrences: number;
  severity: "info" | "warning" | "critical";
  firstSeen: string;
  lastSeen: string;
  executionIds: string[];
  sampleWarningIds: string[];
}

export interface FailureClusterReport {
  clusters: FailureCluster[];
  totals: { warnings: number; executions: number };
}

export interface ExecutionWarningBundle {
  executionId: string;
  warnings: ObservabilityWarning[];
  events: DomainEvent[];
  failure?: { message?: string; code?: string };
  toolChain: string[];
}

export function clusterFailures(bundles: ExecutionWarningBundle[]): FailureClusterReport {
  const clusters = new Map<string, FailureCluster>();
  let totalWarnings = 0;

  for (const bundle of bundles) {
    totalWarnings += bundle.warnings.length;
    for (const warning of bundle.warnings) {
      const fingerprint = warningFingerprint(warning);
      mergeCluster(clusters, {
        fingerprint,
        kind: warning.kind,
        signature: warning.title,
        description: warning.description,
        severity: warning.severity,
        timestamp: warning.timestamp,
        executionId: bundle.executionId,
        warningId: warning.id
      });
    }

    if (bundle.failure?.message) {
      const fingerprint = `execution-failure:${normalize(bundle.failure.message)}`;
      mergeCluster(clusters, {
        fingerprint,
        kind: "EXECUTION_FAILURE",
        signature: bundle.failure.message,
        description: `Repeated execution failure: ${bundle.failure.message}`,
        severity: "critical",
        timestamp: bundle.events.at(-1)?.timestamp ?? new Date().toISOString(),
        executionId: bundle.executionId,
        warningId: `failure-${bundle.executionId}`
      });
    }

    const hallucinations = bundle.warnings.filter((warning) => warning.kind === "HALLUCINATION_INDICATOR");
    if (hallucinations.length >= 2) {
      const fingerprint = `hallucination-pattern:${bundle.executionId.slice(0, 8)}`;
      mergeCluster(clusters, {
        fingerprint,
        kind: "HALLUCINATION_PATTERN",
        signature: "Recurring hallucination indicators",
        description: `Execution emitted ${hallucinations.length} hallucination warnings.`,
        severity: "warning",
        timestamp: hallucinations.at(-1)?.timestamp ?? new Date().toISOString(),
        executionId: bundle.executionId,
        warningId: hallucinations[0]?.id ?? `hallucination-${bundle.executionId}`
      });
    }

    const toolSignature = bundle.toolChain.join(">");
    if (bundle.toolChain.length >= 3 && bundle.warnings.some((warning) => warning.kind === "UNSAFE_TOOL_EXECUTION")) {
      const fingerprint = `unstable-tool-chain:${toolSignature}`;
      mergeCluster(clusters, {
        fingerprint,
        kind: "UNSTABLE_TOOL_CHAIN",
        signature: toolSignature,
        description: `Tool chain ${toolSignature} repeated alongside unsafe-tool warnings.`,
        severity: "warning",
        timestamp: bundle.events.at(-1)?.timestamp ?? new Date().toISOString(),
        executionId: bundle.executionId,
        warningId: `tool-chain-${bundle.executionId}`
      });
    }
  }

  const clustered = [...clusters.values()].sort((a, b) => b.occurrences - a.occurrences || severityRank(b.severity) - severityRank(a.severity));

  return {
    clusters: clustered,
    totals: { warnings: totalWarnings, executions: bundles.length }
  };
}

function warningFingerprint(warning: ObservabilityWarning): string {
  return `${warning.kind}:${normalize(warning.title)}`;
}

function mergeCluster(
  store: Map<string, FailureCluster>,
  input: {
    fingerprint: string;
    kind: FailureCluster["kind"];
    signature: string;
    description: string;
    severity: FailureCluster["severity"];
    timestamp: string;
    executionId: string;
    warningId: string;
  }
) {
  const existing = store.get(input.fingerprint);
  if (!existing) {
    store.set(input.fingerprint, {
      id: `cluster-${input.fingerprint}`,
      fingerprint: input.fingerprint,
      kind: input.kind,
      signature: input.signature,
      description: input.description,
      occurrences: 1,
      severity: input.severity,
      firstSeen: input.timestamp,
      lastSeen: input.timestamp,
      executionIds: [input.executionId],
      sampleWarningIds: [input.warningId]
    });
    return;
  }

  existing.occurrences += 1;
  if (input.timestamp < existing.firstSeen) existing.firstSeen = input.timestamp;
  if (input.timestamp > existing.lastSeen) existing.lastSeen = input.timestamp;
  if (!existing.executionIds.includes(input.executionId)) existing.executionIds.push(input.executionId);
  if (existing.sampleWarningIds.length < 5) existing.sampleWarningIds.push(input.warningId);
  if (severityRank(input.severity) > severityRank(existing.severity)) existing.severity = input.severity;
}

function severityRank(severity: FailureCluster["severity"]): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
