export type ReconciliationState =
  | "RECONCILIATION_REQUIRED"
  | "RECONCILING"
  | "RECONCILED_COMMITTED"
  | "RECONCILED_FAILED"
  | "RECONCILED_UNKNOWN";

export interface ReconciliationAuditEntry {
  readonly timestamp: string;
  readonly actor: "system" | "operator";
  readonly action: "INITIATED" | "POLL_ATTEMPT" | "VERDICT_RESOLVED" | "OPERATOR_OVERRIDE" | "ESCALATED";
  readonly details: string;
}

export interface ReconciliationRecord {
  readonly id: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  status: ReconciliationState;
  attemptsCount: number;
  maxAttempts: number;
  readonly auditHistory: ReconciliationAuditEntry[];
  readonly fingerprint: string;
  output?: Record<string, unknown>;
  error?: string;
}
