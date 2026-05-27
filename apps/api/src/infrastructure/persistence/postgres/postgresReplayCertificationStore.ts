import type { ReplayCertification } from "../../../domain/replay.js";
import type { ReplayCertificationStore } from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";

/**
 * Postgres-backed ReplayCertificationStore.
 *
 * Append-only per execution — matches the InMemoryReplayCertificationStore
 * contract. Each put() inserts a new row; the chain of rows IS the audit
 * trail. `latest` returns the most recent capture (LIMIT 1 over the
 * captured_at desc index); `listForExecution` returns oldest-first
 * (chronological), which is what an operator scanning the timeline expects.
 *
 * The bigserial `id` is internal — callers identify certifications by
 * (executionId, capturedAt), and capturedAt is stamped by the caller (the
 * ReplayDivergenceDetector clock), so two captures in the same millisecond
 * still produce two rows. id is the tie-breaker for the desc index.
 */
export class PostgresReplayCertificationStore implements ReplayCertificationStore {
  constructor(private readonly client: PgClient) {}

  async put(certification: ReplayCertification): Promise<void> {
    await this.client.query(
      `insert into replay_certifications (
         execution_id, workflow_version, event_count, last_event_sequence,
         frame_digests, chain_hash, captured_at
       ) values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        certification.executionId,
        certification.workflowVersion,
        certification.eventCount,
        certification.lastEventSequence,
        JSON.stringify(certification.frameDigests),
        certification.chainHash,
        certification.capturedAt
      ]
    );
  }

  async latest(executionId: string): Promise<ReplayCertification | undefined> {
    const { rows } = await this.client.query<CertificationRow>(
      `select execution_id, workflow_version, event_count, last_event_sequence,
              frame_digests, chain_hash, captured_at, id
         from replay_certifications
         where execution_id = $1
         order by captured_at desc, id desc
         limit 1`,
      [executionId]
    );
    return rows[0] ? rowToCertification(rows[0]) : undefined;
  }

  async listForExecution(executionId: string): Promise<ReplayCertification[]> {
    const { rows } = await this.client.query<CertificationRow>(
      `select execution_id, workflow_version, event_count, last_event_sequence,
              frame_digests, chain_hash, captured_at, id
         from replay_certifications
         where execution_id = $1
         order by captured_at asc, id asc`,
      [executionId]
    );
    return rows.map(rowToCertification);
  }
}

interface CertificationRow {
  execution_id: string;
  workflow_version: string;
  event_count: number;
  last_event_sequence: string | number;
  frame_digests: unknown;
  chain_hash: string;
  captured_at: Date | string;
  id: string | number;
}

function rowToCertification(row: CertificationRow): ReplayCertification {
  return {
    executionId: row.execution_id,
    workflowVersion: row.workflow_version,
    eventCount: Number(row.event_count),
    lastEventSequence: Number(row.last_event_sequence),
    frameDigests: normalizeDigests(row.frame_digests),
    chainHash: row.chain_hash,
    capturedAt:
      row.captured_at instanceof Date
        ? row.captured_at.toISOString()
        : String(row.captured_at)
  };
}

function normalizeDigests(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
