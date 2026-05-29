/**
 * In-memory TimelineStore — single-process, no durability.
 *
 * Suitable for unit/integration tests and single-node dev mode. Production
 * deployments wire a Postgres-backed store with the same contract and the
 * same `(executionId, seq) UNIQUE` invariant. Switching adapters is a
 * one-line change in the persistence factory — the runtime never depends on
 * an adapter detail.
 *
 * Concurrency:
 *   Per-execution sequencing uses an in-process counter. JavaScript's
 *   single-threaded model means appends within a process serialise
 *   automatically; the per-execution Map writes are atomic. Cross-process
 *   coordination is delegated to the durable adapter.
 */

import type { TimelineEvent, TimelineStore } from "../../domain/executionTimeline.js";

export class InMemoryTimelineStore implements TimelineStore {
  private readonly nextSeq = new Map<string, number>();
  private readonly byExecution = new Map<string, TimelineEvent[]>();
  private readonly recent: TimelineEvent[] = [];
  private readonly recentCap = 4096;

  async append(draft: Omit<TimelineEvent, "seq">): Promise<TimelineEvent> {
    const seq = this.nextSeq.get(draft.executionId) ?? 0;
    this.nextSeq.set(draft.executionId, seq + 1);
    const record: TimelineEvent = { ...draft, seq };

    const arr = this.byExecution.get(draft.executionId) ?? [];
    arr.push(record);
    this.byExecution.set(draft.executionId, arr);

    this.recent.push(record);
    if (this.recent.length > this.recentCap) {
      this.recent.splice(0, this.recent.length - this.recentCap);
    }
    return record;
  }

  async listByExecution(executionId: string): Promise<TimelineEvent[]> {
    return [...(this.byExecution.get(executionId) ?? [])];
  }

  async listRecent(limit: number): Promise<TimelineEvent[]> {
    const n = Math.max(0, Math.min(limit, this.recent.length));
    if (n === 0) return [];
    return this.recent.slice(this.recent.length - n).reverse();
  }

  async listAfter(executionId: string, afterSeq: number, limit: number): Promise<TimelineEvent[]> {
    const arr = this.byExecution.get(executionId) ?? [];
    const filtered = arr.filter((e) => e.seq > afterSeq);
    if (limit <= 0) return filtered;
    return filtered.slice(0, limit);
  }
}
