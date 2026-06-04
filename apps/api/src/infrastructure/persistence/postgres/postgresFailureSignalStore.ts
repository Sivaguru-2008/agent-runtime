import type { FailureSignal } from "../../../domain/failure.js";
import type { FailureSignalStore } from "../../../domain/cognitionPorts.js";
import type { PgClient } from "./pgClient.js";

export class PostgresFailureSignalStore implements FailureSignalStore {
  constructor(private readonly client: PgClient) {}

  async record(signal: FailureSignal): Promise<void> {
    await this.client.query(
      // tenant_id (migration 0025) inherited from the owning execution. The
      // text-compare subquery can never raise — an unresolvable execution
      // simply yields 'system' (mirrors 0005's best-effort convention).
      `insert into failure_signals (
         id, cognition_id, execution_id, node_id, kind, severity, score,
         summary, evidence, detected_at, detected_by, tenant_id
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
         coalesce((select tenant_id from executions where id::text = $3::text), 'system')
       )
       on conflict (id) do nothing`,
      [
        signal.id,
        signal.cognitionId ?? null,
        signal.executionId,
        signal.nodeId ?? null,
        signal.kind,
        signal.severity,
        signal.score,
        signal.summary,
        JSON.stringify(signal.evidence),
        signal.detectedAt,
        signal.detectedBy
      ]
    );
  }

  async listByExecution(executionId: string): Promise<FailureSignal[]> {
    const { rows } = await this.client.query<Row>(
      `select id, cognition_id, execution_id, node_id, kind, severity, score,
              summary, evidence, detected_at, detected_by
         from failure_signals
         where execution_id = $1
         order by detected_at asc`,
      [executionId]
    );
    return rows.map(rowToSignal);
  }

  async listByCognition(cognitionId: string): Promise<FailureSignal[]> {
    const { rows } = await this.client.query<Row>(
      `select id, cognition_id, execution_id, node_id, kind, severity, score,
              summary, evidence, detected_at, detected_by
         from failure_signals
         where cognition_id = $1
         order by detected_at asc`,
      [cognitionId]
    );
    return rows.map(rowToSignal);
  }

  async listRecent(limit: number): Promise<FailureSignal[]> {
    const { rows } = await this.client.query<Row>(
      `select id, cognition_id, execution_id, node_id, kind, severity, score,
              summary, evidence, detected_at, detected_by
         from failure_signals
         order by detected_at desc
         limit $1`,
      [limit]
    );
    return rows.map(rowToSignal);
  }
}

interface Row {
  id: string;
  cognition_id: string | null;
  execution_id: string;
  node_id: string | null;
  kind: string;
  severity: string;
  score: number;
  summary: string;
  evidence: FailureSignal["evidence"];
  detected_at: Date | string;
  detected_by: string;
}

function rowToSignal(row: Row): FailureSignal {
  return {
    id: row.id,
    cognitionId: row.cognition_id ?? undefined,
    executionId: row.execution_id,
    nodeId: row.node_id ?? undefined,
    kind: row.kind as FailureSignal["kind"],
    severity: row.severity as FailureSignal["severity"],
    score: row.score,
    summary: row.summary,
    evidence: row.evidence,
    detectedAt: row.detected_at instanceof Date ? row.detected_at.toISOString() : String(row.detected_at),
    detectedBy: row.detected_by
  };
}
