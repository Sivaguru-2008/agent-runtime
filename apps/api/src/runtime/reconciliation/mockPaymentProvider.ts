import type {
  ProviderReconciliationContract,
  ProviderVerificationResult
} from "./providerContract.js";

export class MockPaymentProvider implements ProviderReconciliationContract {
  readonly providerName = "stripe-refund-reconciler";
  
  // Simulates the remote Stripe state store
  public readonly remoteStore = new Map<string, { args: Record<string, unknown>; status: "COMMITTED" | "NOT_COMMITTED" | "UNKNOWN" }>();
  
  // Controls behavior of the mock provider for testing failure scenarios
  public behavior: {
    timeoutOnLookup: boolean;
    partitionOnLookup: boolean;
    forceStatus?: "COMMITTED" | "NOT_COMMITTED" | "UNKNOWN";
  } = {
    timeoutOnLookup: false,
    partitionOnLookup: false
  };

  /**
   * Record a remote side-effect (simulating a successful request that reached the provider).
   */
  recordRemoteEffect(idempotencyKey: string, args: Record<string, unknown>, status: "COMMITTED" | "NOT_COMMITTED" | "UNKNOWN" = "COMMITTED"): void {
    this.remoteStore.set(idempotencyKey, { args, status });
  }

  async lookupStatus(
    idempotencyKey: string,
    args: Record<string, unknown>
  ): Promise<ProviderVerificationResult> {
    if (this.behavior.timeoutOnLookup) {
      throw new Error("Stripe API Timeout: Connection timed out.");
    }
    if (this.behavior.partitionOnLookup) {
      throw new Error("Network Partition: Stripe API is currently unreachable.");
    }
    if (this.behavior.forceStatus) {
      return { status: this.behavior.forceStatus };
    }

    const recorded = this.remoteStore.get(idempotencyKey);
    if (!recorded) {
      return { status: "NOT_COMMITTED", error: "No charge/refund found for this idempotency key on Stripe." };
    }

    return {
      status: recorded.status,
      output: recorded.status === "COMMITTED" ? { success: true, stripeId: `ch_${idempotencyKey}` } : undefined
    };
  }

  async verifyIdempotency(
    idempotencyKey: string,
    args: Record<string, unknown>
  ): Promise<boolean> {
    const recorded = this.remoteStore.get(idempotencyKey);
    if (!recorded) {
      return true; // No record yet, so no conflict is possible
    }

    // Check if arguments have drifted from original remote dispatch
    const recordedFingerprint = this.fingerprintEffect(recorded.args);
    const incomingFingerprint = this.fingerprintEffect(args);
    return recordedFingerprint === incomingFingerprint;
  }

  fingerprintEffect(args: Record<string, unknown>): string {
    const crypto = require("crypto");
    const sorted = Object.keys(args)
      .sort()
      .reduce((acc, key) => {
        acc[key] = args[key];
        return acc;
      }, {} as Record<string, unknown>);

    return crypto
      .createHash("sha256")
      .update(JSON.stringify(sorted))
      .digest("hex");
  }

  isReplaySafe(): boolean {
    return false; // Payments/refunds are NOT replay safe!
  }
}
