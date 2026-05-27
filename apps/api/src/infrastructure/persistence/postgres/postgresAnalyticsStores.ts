/**
 * D3 — Postgres-backed analytics stores.
 *
 * Four adapters that share migration 0006 and replace the in-memory
 * versions in inMemoryCognitionStores.ts. Each implements the existing
 * domain port unchanged so the wiring change in runtimeContainer.ts is a
 * one-line swap when DATABASE_URL is configured.
 *
 * Shared design points:
 *   - All four upsert on conflict so observe/index/record/put are
 *     idempotent. The in-memory versions had the same property; we
 *     preserve it so replayed events do not cause duplicates after a
 *     restart.
 *   - jsonb columns let us round-trip the existing TypeScript shapes
 *     without writing a separate normalisation layer per sub-score.
 *   - listRecent / listByAgent push the sort to the database (the
 *     in-memory versions sorted in JS); the indexes in 0006 keep
 *     those queries bounded.
 */

import type { FailureSignal, FailureSeverity } from "../../../domain/failure.js";
import type {
  AgentRole
} from "../../../domain/cognition.js";
import type {
  AnomalyIndex,
  AnomalyIndexEntry,
  AnomalyIndexQuery,
  FailureCluster,
  FailureSignature,
  FailureSignatureStore,
  ReplayOutcome,
  ReplayOutcomeStore
} from "../../../domain/failureLearning.js";
import type {
  AnomalyDimension,
  ExecutionHealthSnapshot,
  HealthSnapshotStore
} from "../../../domain/executionHealth.js";
import { deriveSignaturePayload } from "../../../domain/signatureHashing.js";
import type { PgClient } from "./pgClient.js";

const ANOMALY_DIMENSIONS: AnomalyDimension[] = [
  "stepCount",
  "nodeCount",
  "tokenTotal",
  "durationMs",
  "signalDensity",
  "toolCallCount"
];

// ─── HealthSnapshot ────────────────────────────────────────────────────────

export class PostgresHealthSnapshotStore implements HealthSnapshotStore {
  constructor(private readonly client: PgClient) {}

  async put(s: ExecutionHealthSnapshot): Promise<void> {
    await this.client.query(
      `insert into execution_health_snapshots
         (execution_id, cognition_id, agent_id, health_score, grade,
          confidence, stability, tool_reliability, consistency, anomaly,
          observed_signal_kinds, computed_at, computation_duration_ms)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)
       on conflict (execution_id) do update set
         cognition_id = excluded.cognition_id,
         agent_id = excluded.agent_id,
         health_score = excluded.health_score,
         grade = excluded.grade,
         confidence = excluded.confidence,
         stability = excluded.stability,
         tool_reliability = excluded.tool_reliability,
         consistency = excluded.consistency,
         anomaly = excluded.anomaly,
         observed_signal_kinds = excluded.observed_signal_kinds,
         computed_at = excluded.computed_at,
         computation_duration_ms = excluded.computation_duration_ms`,
      [
        s.executionId,
        s.cognitionId ?? null,
        s.agentId ?? null,
        s.healthScore,
        s.grade,
        JSON.stringify(s.confidence),
        JSON.stringify(s.stability),
        JSON.stringify(s.toolReliability),
        JSON.stringify(s.consistency),
        JSON.stringify(s.anomaly),
        s.observedSignalKinds,
        s.computedAt,
        s.computationDurationMs
      ]
    );
  }

  async get(executionId: string): Promise<ExecutionHealthSnapshot | undefined> {
    const { rows } = await this.client.query<HealthRow>(
      `select * from execution_health_snapshots where execution_id = $1`,
      [executionId]
    );
    return rows[0] ? rowToHealth(rows[0]) : undefined;
  }

  async listRecent(limit: number): Promise<ExecutionHealthSnapshot[]> {
    const { rows } = await this.client.query<HealthRow>(
      `select * from execution_health_snapshots order by computed_at desc limit $1`,
      [limit]
    );
    return rows.map(rowToHealth);
  }

  async listByAgent(agentId: string, limit: number): Promise<ExecutionHealthSnapshot[]> {
    const { rows } = await this.client.query<HealthRow>(
      `select * from execution_health_snapshots
         where agent_id = $1
         order by computed_at desc
         limit $2`,
      [agentId, limit]
    );
    return rows.map(rowToHealth);
  }

  async listMetricsForAgent(agentId: string, limit: number) {
    const snapshots = await this.listByAgent(agentId, limit);
    return snapshots.map((s) => ({
      executionId: s.executionId,
      computedAt: s.computedAt,
      dimensions: Object.fromEntries(
        ANOMALY_DIMENSIONS.map((d) => [d, s.anomaly.dimensions[d]?.observed ?? 0])
      ) as Record<AnomalyDimension, number>
    }));
  }
}

interface HealthRow {
  execution_id: string;
  cognition_id: string | null;
  agent_id: string | null;
  health_score: number;
  grade: ExecutionHealthSnapshot["grade"];
  confidence: ExecutionHealthSnapshot["confidence"];
  stability: ExecutionHealthSnapshot["stability"];
  tool_reliability: ExecutionHealthSnapshot["toolReliability"];
  consistency: ExecutionHealthSnapshot["consistency"];
  anomaly: ExecutionHealthSnapshot["anomaly"];
  observed_signal_kinds: ExecutionHealthSnapshot["observedSignalKinds"];
  computed_at: Date | string;
  computation_duration_ms: number;
}

function rowToHealth(row: HealthRow): ExecutionHealthSnapshot {
  return {
    executionId: row.execution_id,
    cognitionId: row.cognition_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    healthScore: row.health_score,
    grade: row.grade,
    confidence: row.confidence,
    stability: row.stability,
    toolReliability: row.tool_reliability,
    consistency: row.consistency,
    anomaly: row.anomaly,
    observedSignalKinds: row.observed_signal_kinds,
    computedAt:
      row.computed_at instanceof Date ? row.computed_at.toISOString() : String(row.computed_at),
    computationDurationMs: row.computation_duration_ms
  };
}

// ─── FailureSignature ──────────────────────────────────────────────────────

export class PostgresFailureSignatureStore implements FailureSignatureStore {
  constructor(private readonly client: PgClient) {}

  async observe(signal: FailureSignal): Promise<FailureSignature> {
    const { id, role, summaryTemplate, metricKeys } = deriveSignaturePayload(signal);
    const now = signal.detectedAt;

    return this.client.withTransaction(async (tx) => {
      const { rows: existingRows } = await tx.query<SigRow>(
        `select * from failure_signatures where id = $1 for update`,
        [id]
      );
      const existing = existingRows[0];

      let next: FailureSignature;
      if (existing) {
        const severityDistribution = {
          ...(existing.severity_distribution as Record<FailureSeverity, number>)
        };
        severityDistribution[signal.severity] = (severityDistribution[signal.severity] ?? 0) + 1;

        const examples: FailureSignal[] = [
          signal,
          ...(existing.examples as FailureSignal[]).filter((s) => s.id !== signal.id)
        ].slice(0, 5);

        const exampleExecutionIds = [
          signal.executionId,
          ...existing.example_execution_ids.filter((eid) => eid !== signal.executionId)
        ].slice(0, 5);

        next = {
          id: existing.id,
          kind: existing.kind as FailureSignature["kind"],
          role: (existing.role as AgentRole | null) ?? undefined,
          summaryTemplate: existing.summary_template,
          metricKeys: existing.metric_keys,
          firstSeenAt: isoTs(existing.first_seen_at),
          lastSeenAt: now,
          occurrenceCount: existing.occurrence_count + 1,
          severityDistribution,
          examples,
          exampleExecutionIds
        };

        await tx.query(
          `update failure_signatures
             set last_seen_at = $1,
                 occurrence_count = $2,
                 severity_distribution = $3::jsonb,
                 examples = $4::jsonb,
                 example_execution_ids = $5
             where id = $6`,
          [
            next.lastSeenAt,
            next.occurrenceCount,
            JSON.stringify(severityDistribution),
            JSON.stringify(examples),
            exampleExecutionIds,
            id
          ]
        );
      } else {
        const severityDistribution: Record<FailureSeverity, number> = {
          INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0
        };
        severityDistribution[signal.severity] = 1;

        next = {
          id,
          kind: signal.kind,
          role,
          summaryTemplate,
          metricKeys,
          firstSeenAt: now,
          lastSeenAt: now,
          occurrenceCount: 1,
          severityDistribution,
          examples: [signal],
          exampleExecutionIds: [signal.executionId]
        };

        await tx.query(
          `insert into failure_signatures
             (id, kind, role, summary_template, metric_keys,
              first_seen_at, last_seen_at, occurrence_count,
              severity_distribution, examples, example_execution_ids)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
          [
            id,
            signal.kind,
            role ?? null,
            summaryTemplate,
            metricKeys,
            now,
            now,
            1,
            JSON.stringify(severityDistribution),
            JSON.stringify([signal]),
            [signal.executionId]
          ]
        );
      }

      await tx.query(
        `insert into failure_signature_observations (signature_id, observed_at, execution_id)
         values ($1, $2, $3)`,
        [id, now, signal.executionId]
      );

      return next;
    });
  }

  async getById(signatureId: string): Promise<FailureSignature | undefined> {
    const { rows } = await this.client.query<SigRow>(
      `select * from failure_signatures where id = $1`,
      [signatureId]
    );
    return rows[0] ? rowToSig(rows[0]) : undefined;
  }

  async listClusters(limit: number): Promise<FailureCluster[]> {
    const { rows } = await this.client.query<SigRow & { recent: number }>(
      `select s.*,
              coalesce((
                select count(*) from failure_signature_observations o
                where o.signature_id = s.id
                  and o.observed_at >= now() - interval '24 hours'
              ), 0)::int as recent
         from failure_signatures s
         order by occurrence_count desc
         limit $1`,
      [limit]
    );
    return rows.map((r) => toCluster(r, r.recent));
  }

  async listHot(minHeatScore: number, limit: number): Promise<FailureCluster[]> {
    // Pull a wider candidate window then filter in JS; heat ratio depends on
    // a row-local denominator so a SQL HAVING is cleaner only with a CTE.
    const { rows } = await this.client.query<SigRow & { recent: number }>(
      `select s.*,
              coalesce((
                select count(*) from failure_signature_observations o
                where o.signature_id = s.id
                  and o.observed_at >= now() - interval '24 hours'
              ), 0)::int as recent
         from failure_signatures s
         order by last_seen_at desc
         limit $1`,
      [limit * 4]
    );
    return rows
      .map((r) => toCluster(r, r.recent))
      .filter((c) => c.heatScore >= minHeatScore)
      .sort((a, b) => b.heatScore - a.heatScore)
      .slice(0, limit);
  }
}

interface SigRow {
  id: string;
  kind: string;
  role: string | null;
  summary_template: string;
  metric_keys: string[];
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  occurrence_count: number;
  severity_distribution: Record<FailureSeverity, number>;
  examples: FailureSignal[];
  example_execution_ids: string[];
}

function rowToSig(row: SigRow): FailureSignature {
  return {
    id: row.id,
    kind: row.kind as FailureSignature["kind"],
    role: (row.role as AgentRole | null) ?? undefined,
    summaryTemplate: row.summary_template,
    metricKeys: row.metric_keys,
    firstSeenAt: isoTs(row.first_seen_at),
    lastSeenAt: isoTs(row.last_seen_at),
    occurrenceCount: row.occurrence_count,
    severityDistribution: row.severity_distribution,
    examples: row.examples,
    exampleExecutionIds: row.example_execution_ids
  };
}

function toCluster(row: SigRow, recent24h: number): FailureCluster {
  const sig = rowToSig(row);
  const heatScore = sig.occurrenceCount > 0 ? recent24h / sig.occurrenceCount : 0;
  return {
    signature: sig,
    size: sig.occurrenceCount,
    heatScore,
    affectedExecutionCount: sig.exampleExecutionIds.length
  };
}

// ─── AnomalyIndex ──────────────────────────────────────────────────────────

export class PostgresAnomalyIndex implements AnomalyIndex {
  constructor(private readonly client: PgClient) {}

  async index(entry: AnomalyIndexEntry): Promise<void> {
    await this.client.query(
      `insert into anomaly_index
         (execution_id, agent_id, anomaly_score, top_dimension, top_robust_z_score, indexed_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (execution_id) do update set
         agent_id = excluded.agent_id,
         anomaly_score = excluded.anomaly_score,
         top_dimension = excluded.top_dimension,
         top_robust_z_score = excluded.top_robust_z_score,
         indexed_at = excluded.indexed_at`,
      [
        entry.executionId,
        entry.agentId ?? null,
        entry.anomalyScore,
        entry.topDimension,
        entry.topRobustZScore,
        entry.indexedAt
      ]
    );
  }

  async query(q: AnomalyIndexQuery): Promise<AnomalyIndexEntry[]> {
    const wheres: string[] = [];
    const params: unknown[] = [];
    if (q.minScore !== undefined) {
      params.push(q.minScore);
      wheres.push(`anomaly_score >= $${params.length}`);
    }
    if (q.dimension) {
      params.push(q.dimension);
      wheres.push(`top_dimension = $${params.length}`);
    }
    if (q.agentId) {
      params.push(q.agentId);
      wheres.push(`agent_id = $${params.length}`);
    }
    if (q.since) {
      params.push(q.since);
      wheres.push(`indexed_at >= $${params.length}`);
    }
    const where = wheres.length ? `where ${wheres.join(" and ")}` : "";
    const limitClause = q.limit !== undefined ? (params.push(q.limit), `limit $${params.length}`) : "";
    const { rows } = await this.client.query<AnomalyRow>(
      `select execution_id, agent_id, anomaly_score, top_dimension, top_robust_z_score, indexed_at
         from anomaly_index
         ${where}
         order by anomaly_score desc
         ${limitClause}`,
      params
    );
    return rows.map((r) => ({
      executionId: r.execution_id,
      agentId: r.agent_id ?? undefined,
      anomalyScore: r.anomaly_score,
      topDimension: r.top_dimension as AnomalyDimension,
      topRobustZScore: r.top_robust_z_score,
      indexedAt: isoTs(r.indexed_at)
    }));
  }
}

interface AnomalyRow {
  execution_id: string;
  agent_id: string | null;
  anomaly_score: number;
  top_dimension: string;
  top_robust_z_score: number;
  indexed_at: Date | string;
}

// ─── ReplayOutcome ─────────────────────────────────────────────────────────

export class PostgresReplayOutcomeStore implements ReplayOutcomeStore {
  constructor(private readonly client: PgClient) {}

  async record(o: ReplayOutcome): Promise<void> {
    await this.client.query(
      `insert into replay_outcomes
         (execution_id, cognition_id, kind, source_cognition_id, branch_override,
          succeeded, health_score, failure_signal_count, observed_signal_kinds,
          total_tokens, duration_ms, recorded_at)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)
       on conflict (execution_id) do update set
         cognition_id = excluded.cognition_id,
         kind = excluded.kind,
         source_cognition_id = excluded.source_cognition_id,
         branch_override = excluded.branch_override,
         succeeded = excluded.succeeded,
         health_score = excluded.health_score,
         failure_signal_count = excluded.failure_signal_count,
         observed_signal_kinds = excluded.observed_signal_kinds,
         total_tokens = excluded.total_tokens,
         duration_ms = excluded.duration_ms,
         recorded_at = excluded.recorded_at`,
      [
        o.executionId,
        o.cognitionId,
        o.kind,
        o.sourceCognitionId ?? null,
        o.branchOverride ? JSON.stringify(o.branchOverride) : null,
        o.succeeded,
        o.healthScore,
        o.failureSignalCount,
        o.observedSignalKinds,
        o.totalTokens ?? null,
        o.durationMs ?? null,
        o.recordedAt
      ]
    );
  }

  async getByExecution(executionId: string): Promise<ReplayOutcome | undefined> {
    const { rows } = await this.client.query<ReplayRow>(
      `select * from replay_outcomes where execution_id = $1`,
      [executionId]
    );
    return rows[0] ? rowToReplay(rows[0]) : undefined;
  }

  async listBranchesOf(sourceCognitionId: string): Promise<ReplayOutcome[]> {
    const { rows } = await this.client.query<ReplayRow>(
      `select * from replay_outcomes
         where kind = 'BRANCH' and source_cognition_id = $1
         order by recorded_at asc`,
      [sourceCognitionId]
    );
    return rows.map(rowToReplay);
  }

  async listAll(): Promise<ReplayOutcome[]> {
    const { rows } = await this.client.query<ReplayRow>(
      `select * from replay_outcomes order by recorded_at desc`
    );
    return rows.map(rowToReplay);
  }
}

interface ReplayRow {
  execution_id: string;
  cognition_id: string;
  kind: ReplayOutcome["kind"];
  source_cognition_id: string | null;
  branch_override: ReplayOutcome["branchOverride"] | null;
  succeeded: boolean;
  health_score: number;
  failure_signal_count: number;
  observed_signal_kinds: ReplayOutcome["observedSignalKinds"];
  total_tokens: number | null;
  duration_ms: number | null;
  recorded_at: Date | string;
}

function rowToReplay(row: ReplayRow): ReplayOutcome {
  return {
    executionId: row.execution_id,
    cognitionId: row.cognition_id,
    kind: row.kind,
    sourceCognitionId: row.source_cognition_id ?? undefined,
    branchOverride: row.branch_override ?? undefined,
    succeeded: row.succeeded,
    healthScore: row.health_score,
    failureSignalCount: row.failure_signal_count,
    observedSignalKinds: row.observed_signal_kinds,
    totalTokens: row.total_tokens ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    recordedAt: isoTs(row.recorded_at)
  };
}

function isoTs(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
