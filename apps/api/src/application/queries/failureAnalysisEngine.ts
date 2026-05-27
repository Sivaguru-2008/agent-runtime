import type { DomainEvent } from "../../domain/events.js";
import type { MemoryRecord } from "../../domain/model.js";

export type WarningSeverity = "info" | "warning" | "critical";
export type WarningKind =
  | "INFINITE_LOOP_RISK"
  | "REPEATED_RETRY"
  | "HALLUCINATION_INDICATOR"
  | "UNSAFE_TOOL_EXECUTION"
  | "CORRUPTED_MEMORY"
  | "CONFLICTING_MEMORY"
  | "LATENCY_SPIKE"
  | "MEMORY_DRIFT"
  | "STALE_LEASE_DETECTED"
  | "FENCING_REJECTION"
  | "EXECUTION_TIMEOUT"
  | "CANCELLATION_ABORTED"
  | "DEPENDENCY_FAILURE";

export interface ObservabilityWarning {
  id: string;
  kind: WarningKind;
  severity: WarningSeverity;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  timestamp: string;
}

export class FailureAnalysisEngine {
  analyze(events: DomainEvent[]): ObservabilityWarning[] {
    return [
      ...this.detectRepeatedRetries(events),
      ...this.detectLoopRisk(events),
      ...this.detectUnsafeTools(events),
      ...this.detectHallucinationIndicators(events),
      ...this.detectMemoryRisks(events),
      ...this.detectLatencySpikes(events),
      ...this.detectStaleLeases(events),
      ...this.detectCancellations(events),
      ...this.detectDependencyFailures(events)
    ];
  }

  private detectRepeatedRetries(events: DomainEvent[]): ObservabilityWarning[] {
    const retries = events.filter((event) => event.type === "RETRY_TRIGGERED");
    if (retries.length < 3) return [];

    return [{
      id: "warning-repeated-retry",
      kind: "REPEATED_RETRY",
      severity: "critical",
      title: "Repeated retry loop",
      description: "Execution emitted three or more retry events, indicating unstable planning or tool recovery.",
      evidence: { retryCount: retries.length, eventIds: retries.map((event) => event.id) },
      timestamp: retries.at(-1)?.timestamp ?? new Date().toISOString()
    }];
  }

  private detectLoopRisk(events: DomainEvent[]): ObservabilityWarning[] {
    const stepTypes = events
      .filter((event) => event.type === "EXECUTION_STEP_STARTED")
      .map((event) => String(readPath(event.payload, ["step", "type"]) ?? "UNKNOWN"));

    const repeatedStep = stepTypes.find((stepType) => stepTypes.filter((item) => item === stepType).length >= 4);
    if (!repeatedStep) return [];

    return [{
      id: `warning-loop-${repeatedStep.toLowerCase()}`,
      kind: "INFINITE_LOOP_RISK",
      severity: "warning",
      title: "Possible execution loop",
      description: `The ${repeatedStep.toLowerCase()} step repeated four or more times in one execution.`,
      evidence: { repeatedStep, sequence: stepTypes },
      timestamp: events.at(-1)?.timestamp ?? new Date().toISOString()
    }];
  }

  private detectUnsafeTools(events: DomainEvent[]): ObservabilityWarning[] {
    const unsafePatterns = ["shell", "exec", "docker", "filesystem", "fs.", "network", "browser"];
    return events
      .filter((event) => event.type === "TOOL_CALLED")
      .map((event) => ({
        event,
        toolName: String(readPath(event.payload, ["toolCall", "toolName"]) ?? "")
      }))
      .filter(({ toolName }) => unsafePatterns.some((pattern) => toolName.toLowerCase().includes(pattern)))
      .map(({ event, toolName }) => ({
        id: `warning-unsafe-tool-${event.id}`,
        kind: "UNSAFE_TOOL_EXECUTION" as const,
        severity: "warning" as const,
        title: "Sensitive tool execution",
        description: `Tool ${toolName} may require sandboxing, approval, or output redaction.`,
        evidence: { eventId: event.id, toolName },
        timestamp: event.timestamp
      }));
  }

  private detectHallucinationIndicators(events: DomainEvent[]): ObservabilityWarning[] {
    const indicators = ["i think", "probably", "cannot verify", "no evidence", "assume", "guess"];
    return events
      .filter((event) => event.type === "MODEL_COMPLETED")
      .filter((event) => indicators.some((indicator) => JSON.stringify(event.payload).toLowerCase().includes(indicator)))
      .map((event) => ({
        id: `warning-hallucination-${event.id}`,
        kind: "HALLUCINATION_INDICATOR" as const,
        severity: "warning" as const,
        title: "Possible hallucination indicator",
        description: "Model output contains uncertainty language that should be inspected against memory and tool evidence.",
        evidence: { eventId: event.id, indicators },
        timestamp: event.timestamp
      }));
  }

  private detectMemoryRisks(events: DomainEvent[]): ObservabilityWarning[] {
    const memoryEvents = events.filter((event) => event.type === "MEMORY_RETRIEVED");
    return memoryEvents.flatMap((event) => {
      const records = readPath(event.payload, ["records"]) as MemoryRecord[] | undefined;
      return (records ?? []).flatMap((record) => {
        const content = record.content.toLowerCase();
        const warnings: ObservabilityWarning[] = [];

        if (content.includes("corrupt") || content.includes("invalid") || content.includes("poisoned")) {
          warnings.push({
            id: `warning-corrupted-memory-${record.id}`,
            kind: "CORRUPTED_MEMORY",
            severity: "critical",
            title: "Potentially corrupted memory",
            description: "Retrieved memory contains markers associated with invalid or poisoned context.",
            evidence: { memoryId: record.id, content: record.content.slice(0, 240) },
            timestamp: event.timestamp
          });
        }

        if (content.includes("conflict") || content.includes("contradict")) {
          warnings.push({
            id: `warning-conflicting-memory-${record.id}`,
            kind: "CONFLICTING_MEMORY",
            severity: "warning",
            title: "Conflicting memory influence",
            description: "Retrieved memory may contradict other execution context.",
            evidence: { memoryId: record.id, content: record.content.slice(0, 240) },
            timestamp: event.timestamp
          });
        }

        return warnings;
      });
    });
  }

  private detectLatencySpikes(events: DomainEvent[]): ObservabilityWarning[] {
    return events
      .filter((event) => event.type === "EXECUTION_STEP_COMPLETED")
      .filter((event) => Number(readPath(event.payload, ["step", "durationMs"]) ?? 0) > 5000)
      .map((event) => ({
        id: `warning-latency-${event.id}`,
        kind: "LATENCY_SPIKE" as const,
        severity: "info" as const,
        title: "Execution latency spike",
        description: "A reasoning step exceeded the MVP latency threshold.",
        evidence: {
          eventId: event.id,
          stepType: readPath(event.payload, ["step", "type"]),
          durationMs: readPath(event.payload, ["step", "durationMs"])
        },
        timestamp: event.timestamp
      }));
  }

  private detectStaleLeases(events: DomainEvent[]): ObservabilityWarning[] {
    const rejections = events.filter((e) => e.type === "EXECUTION_FENCE_REJECTED" || e.type === "EXECUTION_FENCE_VIOLATED");
    return rejections.map((event) => ({
      id: `warning-stale-lease-${event.id}`,
      kind: event.type === "EXECUTION_FENCE_REJECTED" ? "FENCING_REJECTION" as const : "STALE_LEASE_DETECTED" as const,
      severity: "critical" as const,
      title: event.type === "EXECUTION_FENCE_REJECTED" ? "Fencing Rejection" : "Stale Lease Write Attempt",
      description: event.type === "EXECUTION_FENCE_REJECTED"
        ? `Advisory fencing conditional write was rejected for phase: ${readPath(event.payload, ["phase"]) ?? "unknown"}.`
        : `Durable SQL write rejected: fencing violation occurred for worker ${readPath(event.payload, ["workerId"]) ?? "unknown"}.`,
      evidence: { eventId: event.id, payload: event.payload },
      timestamp: event.timestamp
    }));
  }

  private detectCancellations(events: DomainEvent[]): ObservabilityWarning[] {
    const aborts = events.filter((e) => e.type === "EXECUTION_ABORTED");
    return aborts.map((event) => ({
      id: `warning-cancellation-${event.id}`,
      kind: "CANCELLATION_ABORTED" as const,
      severity: "info" as const,
      title: "Execution Cancelled",
      description: `Execution was gracefully aborted mid-flight. Reason: ${readPath(event.payload, ["reason"]) ?? "manual"}.`,
      evidence: { eventId: event.id, payload: event.payload },
      timestamp: event.timestamp
    }));
  }

  private detectDependencyFailures(events: DomainEvent[]): ObservabilityWarning[] {
    const circuitOpen = events.filter((e) => e.type === "CIRCUIT_BREAKER_OPENED");
    const circuitWarnings = circuitOpen.map((event) => ({
      id: `warning-circuit-${event.id}`,
      kind: "DEPENDENCY_FAILURE" as const,
      severity: "critical" as const,
      title: `Circuit Breaker Opened: ${readPath(event.payload, ["circuit"]) ?? "unknown"}`,
      description: `Dependency is failing and circuit has opened to prevent compounding exhaustion. Consecutive failures: ${readPath(event.payload, ["consecutiveFailures"]) ?? "unknown"}.`,
      evidence: { eventId: event.id, payload: event.payload },
      timestamp: event.timestamp
    }));

    const systemErrors = events.filter((e) => e.type === "SYSTEM_ERROR_RAISED");
    const errorWarnings = systemErrors.map((event) => ({
      id: `warning-sys-error-${event.id}`,
      kind: "DEPENDENCY_FAILURE" as const,
      severity: "warning" as const,
      title: "Subsystem Error Raised",
      description: `A critical warning was reported by subsystem: ${readPath(event.payload, ["subsystem"]) ?? "unknown"}.`,
      evidence: { eventId: event.id, payload: event.payload },
      timestamp: event.timestamp
    }));

    return [...circuitWarnings, ...errorWarnings];
  }
}

function readPath(source: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}
