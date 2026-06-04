/**
 * Docker-free unit coverage for the OutboxDlqRecoveryService bounded-retry
 * contract. The DB-driven claim/redeliver/quarantine path is covered by
 * test/integration/postgres/outboxDlqRecovery.audit.integration.test.ts; here
 * we pin the pure backoff + quarantine decision functions so the bounded-retry
 * invariant has regression coverage independent of the integration harness.
 */
import { describe, it, expect } from "vitest";
import {
  dlqRecoveryBackoffMs,
  shouldQuarantineDlqRow,
  DLQ_RECOVERY_MAX_ATTEMPTS,
  DLQ_RECOVERY_BASE_BACKOFF_MS,
  DLQ_RECOVERY_MAX_BACKOFF_MS
} from "../src/infrastructure/events/outboxDlqRecoveryService.js";

describe("OutboxDlqRecoveryService — backoff schedule", () => {
  it("first failure backs off by the base interval (2^0)", () => {
    expect(dlqRecoveryBackoffMs(1, 1000, 10 * 60_000)).toBe(1000);
  });

  it("doubles per attempt (2^(n-1))", () => {
    expect(dlqRecoveryBackoffMs(2, 1000, 10 * 60_000)).toBe(2000);
    expect(dlqRecoveryBackoffMs(3, 1000, 10 * 60_000)).toBe(4000);
    expect(dlqRecoveryBackoffMs(4, 1000, 10 * 60_000)).toBe(8000);
  });

  it("is capped at maxBackoffMs", () => {
    expect(dlqRecoveryBackoffMs(50, 1000, 5000)).toBe(5000);
  });

  it("never returns a negative or sub-base delay for the first attempt edge", () => {
    // attemptsAfterFailure of 0 (defensive) collapses exp to 0 → base.
    expect(dlqRecoveryBackoffMs(0, 1000, 10_000)).toBe(1000);
  });

  it("uses production defaults when none supplied", () => {
    expect(dlqRecoveryBackoffMs(1)).toBe(DLQ_RECOVERY_BASE_BACKOFF_MS);
    // 2^4 * 30s = 480s = 480_000ms, under the 30m ceiling.
    expect(dlqRecoveryBackoffMs(5)).toBe(DLQ_RECOVERY_BASE_BACKOFF_MS * 16);
    // A large attempt count saturates at the ceiling.
    expect(dlqRecoveryBackoffMs(100)).toBe(DLQ_RECOVERY_MAX_BACKOFF_MS);
  });
});

describe("OutboxDlqRecoveryService — quarantine boundary", () => {
  it("does not quarantine below the ceiling", () => {
    expect(shouldQuarantineDlqRow(1, 5)).toBe(false);
    expect(shouldQuarantineDlqRow(4, 5)).toBe(false);
  });

  it("quarantines at and above the ceiling", () => {
    expect(shouldQuarantineDlqRow(5, 5)).toBe(true);
    expect(shouldQuarantineDlqRow(6, 5)).toBe(true);
  });

  it("uses the production default ceiling", () => {
    expect(shouldQuarantineDlqRow(DLQ_RECOVERY_MAX_ATTEMPTS - 1)).toBe(false);
    expect(shouldQuarantineDlqRow(DLQ_RECOVERY_MAX_ATTEMPTS)).toBe(true);
  });
});
