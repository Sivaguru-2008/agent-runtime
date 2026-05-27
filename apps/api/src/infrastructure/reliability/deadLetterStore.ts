/**
 * Dead-Letter Queue implementations.
 *
 * Corruption risk prevented:
 *   Without a DLQ, poison-pill executions re-enter the queue indefinitely,
 *   consuming worker capacity, triggering repeated alert noise, and masking
 *   the root cause in a flood of failure events.
 *
 * Operational impact:
 *   Poisoned executions are persisted here for operator inspection. An
 *   operator can replay from the DLQ once the underlying bug is fixed,
 *   or discard entries they know are irrecoverable.
 *
 * Distributed implications:
 *   The DLQ is a write-once (upsert on executionId), read-many store.
 *   Multiple workers can safely push the same executionId — the latest
 *   entry wins (last-write-wins on movedAt).
 *
 * Replay safety:
 *   Every DLQ entry captures a `taskSnapshot` so replay diagnostics can
 *   reconstruct the exact inputs that caused repeated failure.
 */

import type { DeadLetterEntry } from "../../domain/cluster.js";
import type { DeadLetterQueue } from "../../domain/clusterPorts.js";

/**
 * In-memory DLQ for development and single-process deployments.
 *
 * WARNING: state is lost on process restart. Use PostgresDeadLetterStore
 * (or equivalent) in any environment where replay safety is required.
 */
export class InMemoryDeadLetterStore implements DeadLetterQueue {
  private readonly entries = new Map<string, DeadLetterEntry>();

  async push(entry: DeadLetterEntry): Promise<void> {
    // Upsert by executionId — last write wins, which captures the most recent error.
    this.entries.set(entry.executionId, entry);
  }

  async list(): Promise<DeadLetterEntry[]> {
    return Array.from(this.entries.values()).sort(
      (a, b) => new Date(b.movedAt).getTime() - new Date(a.movedAt).getTime()
    );
  }

  async getByExecution(executionId: string): Promise<DeadLetterEntry | undefined> {
    return this.entries.get(executionId);
  }
}
