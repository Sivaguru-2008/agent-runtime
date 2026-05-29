import type { SideEffectCapability } from "../canonicalSemantics.js";

export type ProviderVerificationStatus = "COMMITTED" | "NOT_COMMITTED" | "UNKNOWN";

export interface ProviderVerificationResult {
  readonly status: ProviderVerificationStatus;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
}

export interface ProviderReconciliationContract {
  readonly providerName: string;

  /**
   * Look up the remote status of a side effect using the idempotency key and arguments.
   */
  lookupStatus(
    idempotencyKey: string,
    args: Record<string, unknown>
  ): Promise<ProviderVerificationResult>;

  /**
   * Verify if the idempotency key corresponds to a matching payload / arguments.
   */
  verifyIdempotency(
    idempotencyKey: string,
    args: Record<string, unknown>
  ): Promise<boolean>;

  /**
   * Compute a deterministic fingerprint hash of the side effect arguments to detect drift.
   */
  fingerprintEffect(args: Record<string, unknown>): string;

  /**
   * Whether this provider's operations are replay-safe / read-only.
   */
  isReplaySafe(): boolean;

  /**
   * Return the declared side-effect capability class of this provider.
   */
  getCapability?(): SideEffectCapability;
}
