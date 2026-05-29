import type { ReconciliationEngine } from "./reconciliationEngine.js";
import type { ReconciliationRecord } from "./reconciliationTypes.js";

export class OperatorEscalationService {
  constructor(private readonly engine: ReconciliationEngine) {}

  /**
   * Get all active quarantined executions requiring reconciliation.
   */
  getQuarantinedRecords(): ReconciliationRecord[] {
    return this.engine.listRecords().filter(
      r => r.status === "RECONCILIATION_REQUIRED" || r.status === "RECONCILED_UNKNOWN"
    );
  }

  /**
   * View the complete audit history of a quarantined effect.
   */
  getAuditHistory(idempotencyKey: string): string[] {
    const record = this.engine.getRecord(idempotencyKey);
    if (!record) return [];
    return record.auditHistory.map(
      h => `[${h.timestamp}] [${h.actor.toUpperCase()}] [${h.action}] - ${h.details}`
    );
  }

  /**
   * Operator overrides the resolution for a quarantined effect.
   */
  async resolveManually(
    idempotencyKey: string,
    verdict: "COMMIT" | "ABORT",
    output?: Record<string, unknown>,
    errorMessage?: string
  ): Promise<ReconciliationRecord> {
    return this.engine.operatorOverride(idempotencyKey, verdict, new Date(), output, errorMessage);
  }
}
