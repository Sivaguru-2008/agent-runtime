import type {
  BranchRegistry,
  CognitionRepository,
  FailureSignalStore,
  LineageStore,
  ReplayCertificationStore,
  ReplaySessionStore,
  SnapshotStore
} from "../../domain/cognitionPorts.js";
import type {
  CheckpointStore,
  LeaseStore,
  WorkerRegistry
} from "../../domain/clusterPorts.js";
import type {
  AgentRepository,
  EventStore,
  ExecutionRepository,
  MemoryRepository
} from "../../domain/ports.js";

import {
  InMemoryAgentRepository,
  InMemoryEventStore,
  InMemoryExecutionRepository,
  InMemoryMemoryRepository
} from "./inMemoryStores.js";
import { PostgresEventStore } from "./postgresEventStore.js";
import { PostgresAgentRepository } from "./postgres/postgresAgentRepository.js";
import { PostgresExecutionRepository } from "./postgres/postgresExecutionRepository.js";
import { PostgresMemoryRepository } from "./postgres/postgresMemoryRepository.js";
import {
  InMemoryBranchRegistry,
  InMemoryCognitionRepository,
  InMemoryFailureSignalStore,
  InMemoryLineageStore,
  InMemoryReplayCertificationStore,
  InMemoryReplaySessionStore,
  InMemorySnapshotStore
} from "./inMemoryCognitionStores.js";
import { PostgresCognitionRepository } from "./postgres/postgresCognitionRepository.js";
import { PostgresLineageStore } from "./postgres/postgresLineageStore.js";
import { PostgresSnapshotStore } from "./postgres/postgresSnapshotStore.js";
import { PostgresReplaySessionStore } from "./postgres/postgresReplaySessionStore.js";
import { PostgresReplayCertificationStore } from "./postgres/postgresReplayCertificationStore.js";
import { PostgresBranchRegistry } from "./postgres/postgresBranchRegistry.js";
import { PostgresFailureSignalStore } from "./postgres/postgresFailureSignalStore.js";
import {
  InMemoryCheckpointStore,
  InMemoryLeaseStore,
  InMemoryWorkerRegistry
} from "../cluster/inMemoryClusterStores.js";
import { PostgresWorkerRegistry } from "../cluster/postgres/postgresWorkerRegistry.js";
import { PostgresLeaseStore } from "../cluster/postgres/postgresLeaseStore.js";
import { PostgresCheckpointStore } from "../cluster/postgres/postgresCheckpointStore.js";
import { createPgClient, type PgClient } from "./postgres/pgClient.js";

/**
 * PersistenceLayer — the full set of durable stores wired together so the
 * runtime container can DI a single bundle instead of instantiating each
 * adapter individually.
 *
 * `eventStore` is included alongside the Sprint Next stores because in
 * Postgres mode they all share the same connection pool — pulling them into
 * one factory keeps that fact discoverable.
 */
export interface PersistenceLayer {
  driver: "memory" | "postgres";
  eventStore: EventStore;
  /**
   * Durable agent repository. In Postgres mode, agent rows survive restart;
   * in memory mode, this is the legacy in-memory implementation preserved
   * for unit tests and local dev. Exposed on the layer so the runtime
   * container can use the same wiring path for both drivers.
   */
  agents: AgentRepository;
  /** Durable execution repository — see agents. */
  executions: ExecutionRepository;
  /** Durable memory repository — see agents. */
  memory: MemoryRepository;
  cognitions: CognitionRepository;
  lineage: LineageStore;
  snapshots: SnapshotStore;
  replaySessions: ReplaySessionStore;
  branches: BranchRegistry;
  failureSignals: FailureSignalStore;
  workers: WorkerRegistry;
  leases: LeaseStore;
  checkpoints: CheckpointStore;
  /**
   * Phase B (Operational Hardening) — durable record of execution replay
   * fingerprints. Postgres-backed under the postgres driver (migration
   * 0009_replay_certifications); in-memory under the memory driver. The
   * runtime container reads from this port for divergence detection; swapping
   * the implementation requires no engine changes.
   */
  replayCertifications: ReplayCertificationStore;
  /** Postgres pool — undefined for the memory driver. */
  pg?: PgClient;
  close(): Promise<void>;
}

export interface PersistenceFactoryConfig {
  driver: "memory" | "postgres";
  databaseUrl?: string;
  /**
   * If true, the EventStore is built from the SAME Postgres pool as the
   * cognition/cluster stores. If false, the EventStore is independent (used
   * when EVENT_STORE_DRIVER=memory but PERSISTENCE_DRIVER=postgres, which is
   * an unusual but supported configuration for tests).
   */
  sharePoolWithEventStore?: boolean;
  /** Pre-built event store, used when the caller wants different driver mixes. */
  eventStore?: EventStore;
  /**
   * Sprint Stabilization — optional leak handler forwarded to the shared
   * pg pool. When acquire() is held past the leak threshold, the handler is
   * invoked with the call-site label. The runtime container wires this to
   * the `agent_pg_pool_leak_suspect_total` counter so operators get a
   * Prometheus-visible signal in addition to the warn log.
   */
  onPoolLeak?: (info: { label: string; heldForMs: number; stack: string | undefined }) => void;
}

export function createPersistenceLayer(config: PersistenceFactoryConfig): PersistenceLayer {
  if (config.driver === "memory") {
    // Sprint Hardening — fencing: the in-memory execution / memory repos accept
    // a LeaseStore reference so saveFenced/addFenced can validate fencing
    // tokens against the same lease state the workers see. The Postgres
    // adapter does this atomically in SQL; for parity, we share the in-memory
    // lease store here so unit tests exercise the same invariant.
    //
    // Event-write fencing (audit Task 1): InMemoryEventStore.appendFenced
    // must consult the same lease substrate so that engine-level tests reject
    // stale-worker step/memory/model events with the same contract the
    // Postgres adapter enforces in SQL. We wire the lease store onto the
    // store via setter so existing `new InMemoryEventStore()` call sites in
    // unit tests remain backwards-compatible.
    const leases = new InMemoryLeaseStore();
    const eventStore = config.eventStore ?? new InMemoryEventStore();
    if (eventStore instanceof InMemoryEventStore) {
      eventStore.setLeaseStore(leases);
    }
    const memory = new InMemoryMemoryRepository(leases);
    const executions = new InMemoryExecutionRepository(leases, memory, eventStore);
    return {
      driver: "memory",
      eventStore,
      agents: new InMemoryAgentRepository(),
      executions,
      memory,
      cognitions: new InMemoryCognitionRepository(),
      lineage: new InMemoryLineageStore(),
      snapshots: new InMemorySnapshotStore(),
      replaySessions: new InMemoryReplaySessionStore(),
      branches: new InMemoryBranchRegistry(),
      failureSignals: new InMemoryFailureSignalStore(),
      workers: new InMemoryWorkerRegistry(),
      leases,
      // Phase A: checkpoint writes must be fence-guarded for parity with the
      // Postgres adapter. Wire the lease store so writeFenced() rejects stale
      // workers at the in-memory layer the same way Postgres rejects them at
      // the SQL layer. Unfenced write() remains available for unleased
      // operator paths (pause/resume routes) and unit-test contexts.
      checkpoints: new InMemoryCheckpointStore(leases),
      replayCertifications: new InMemoryReplayCertificationStore(),
      async close() {
        // no-op for in-memory
      }
    };
  }

  if (!config.databaseUrl) {
    throw new Error("createPersistenceLayer({driver:'postgres'}) requires databaseUrl");
  }
  // Sprint Stabilization — ONE Postgres pool per persistence layer.
  // Previously the layer constructed its own pgClient AND passed the same
  // databaseUrl to PostgresEventStore which spun up a SECOND pool. Two
  // long-lived pools per container against the same Postgres meant:
  //   • Steady-state connection count was ~2x what the operator configured.
  //   • A connection leak in either pool was invisible from the other's
  //     stats, so an "exhausted persistence pool" looked like a randomly
  //     timing-out event-store query.
  //   • Pool sizing and statement_timeout were impossible to govern from
  //     a single env var.
  // The shared pool below threads through both — and PostgresEventStore now
  // accepts a PgClient, so it uses the same connection pool as the rest of
  // the durable repositories.
  const pg = createPgClient({
    connectionString: config.databaseUrl,
    onLeak: config.onPoolLeak
  });
  const eventStore =
    config.eventStore ??
    (config.sharePoolWithEventStore === false
      ? new InMemoryEventStore()
      : new PostgresEventStore(pg));

  return {
    driver: "postgres",
    eventStore,
    // Sprint Hardening: agent/execution/memory repos are durable in Postgres
    // mode. Previously these defaulted to in-memory inside runtimeContainer,
    // which meant a production deployment lost every agent and execution on
    // restart even though PERSISTENCE_DRIVER=postgres was set.
    agents: new PostgresAgentRepository(pg),
    executions: new PostgresExecutionRepository(pg),
    memory: new PostgresMemoryRepository(pg),
    cognitions: new PostgresCognitionRepository(pg),
    lineage: new PostgresLineageStore(pg),
    snapshots: new PostgresSnapshotStore(pg),
    replaySessions: new PostgresReplaySessionStore(pg),
    branches: new PostgresBranchRegistry(pg),
    failureSignals: new PostgresFailureSignalStore(pg),
    workers: new PostgresWorkerRegistry(pg),
    leases: new PostgresLeaseStore(pg),
    checkpoints: new PostgresCheckpointStore(pg),
    // Phase B carry-over (closed): durable certifications now ride the
    // shared pool. Memory driver continues to use the in-memory adapter.
    replayCertifications: new PostgresReplayCertificationStore(pg),
    pg,
    async close() {
      await pg.close();
      if ("close" in eventStore && typeof (eventStore as { close?: () => Promise<void> }).close === "function") {
        await (eventStore as { close: () => Promise<void> }).close();
      }
    }
  };
}
