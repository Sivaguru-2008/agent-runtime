/** A side effect that already fired and was recorded. */
export interface CommittedEffect {
  id: string;
  operationId: string;
  toolName: string;
  inputHash: string;
  /** JSON-encoded tool response. */
  response: string;
  /** ISO-8601 timestamp. */
  committedAt: string;
}

export type IntentStatus = "PENDING" | "COMMITTED" | "SUPPRESSED";

/** An audit record of an intended IRREVERSIBLE effect. */
export interface IntentRecord {
  id: string;
  operationId: string;
  toolName: string;
  /** JSON-encoded tool input. */
  input: string;
  /** ISO-8601 timestamp. */
  intendedAt: string;
  status: IntentStatus;
}

export interface PutResult {
  row: CommittedEffect;
  /** false when an equivalent effect was already committed (unique conflict). */
  inserted: boolean;
}

/**
 * Pluggable persistence for the committed-effects log and the intent log.
 * Implementations must be safe to call concurrently and must enforce the
 * UNIQUE(operation_id, tool_name, input_hash) constraint on commits.
 */
export interface StorageAdapter {
  init(): Promise<void>;
  getCommitted(operationId: string): Promise<CommittedEffect | null>;
  /** Insert a committed effect, ignoring (not overwriting) an existing one. */
  putCommitted(effect: CommittedEffect): Promise<PutResult>;
  recordIntent(intent: IntentRecord): Promise<void>;
  updateIntentStatus(id: string, status: IntentStatus): Promise<void>;
  close(): Promise<void>;
}

/** Normalize a driver timestamp (Date or string) to an ISO-8601 string. */
export function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
