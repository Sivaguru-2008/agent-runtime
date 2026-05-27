import pg from "pg";
import { isChaosEnabled, wrapPgClientWithChaos } from "../../chaos/index.js";

/**
 * Shared Postgres pool wrapper. Adapters take a `PgClient` instead of a raw
 * `pg.Pool` so callers can substitute a mock or a transaction-scoped wrapper
 * without leaking the driver into orchestration code.
 *
 * Sprint Stabilization additions:
 *   - `acquire()` — exposes a pool client for callers that need session-scoped
 *     transactions across multiple statements (e.g. PostgresEventStore). The
 *     caller MUST call `release()` on the returned token. This replaces the
 *     "each subsystem creates its own pg.Pool" anti-pattern that previously
 *     led to N independent pools per process and made connection exhaustion
 *     impossible to localise.
 *   - `stats()` — pool utilisation snapshot for telemetry exposure.
 *   - Leak detection — `acquire()` records the acquire timestamp and, after
 *     a configurable threshold, emits a warning identifying the call site so
 *     a hung-handler can be diagnosed without taking a heap snapshot.
 */
export interface PgClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  withTransaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T>;
  /**
   * Acquire a dedicated client from the pool. Callers must `release()` the
   * returned token in a `finally` to return it to the pool. Use only when
   * `query()` / `withTransaction()` cannot express the work (e.g. multi-
   * statement transactions inside another adapter).
   */
  acquire(label?: string): Promise<PgConnection>;
  /** Pool utilisation snapshot — see PgPoolStats. */
  stats(): PgPoolStats;
  close(): Promise<void>;
}

export interface PgConnection {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  release(): void;
}

export interface PgPoolStats {
  /** Total client objects in the pool (idle + checked-out). */
  totalCount: number;
  /** Currently idle clients available for immediate acquisition. */
  idleCount: number;
  /** Queries waiting for a client to be returned. Sustained > 0 = exhaustion. */
  waitingCount: number;
  /** Maximum pool size — anchor for utilisation arithmetic. */
  max: number;
  /**
   * Currently outstanding `acquire()` tokens that have NOT been released.
   * Tracked independently of pg.Pool's internal counters so we can name the
   * call sites that hold them.
   */
  outstanding: number;
}

export interface PgClientOptions {
  /** Connection string. Required. */
  connectionString: string;
  /** Max pool clients. Defaults to env PG_POOL_MAX or 10. */
  max?: number;
  /**
   * Threshold (ms) after which a still-held `acquire()` token logs a leak
   * warning. Set high enough (default 30s) that legitimate long transactions
   * do not spam; set low enough that a forgotten release is caught well
   * before pool exhaustion.
   */
  acquireLeakThresholdMs?: number;
  /** Logger sink for leak warnings — defaults to console.warn. */
  onLeak?: (info: { label: string; heldForMs: number; stack: string | undefined }) => void;
  /** Statement timeout for ALL queries. Defaults to env PG_STATEMENT_TIMEOUT_MS or 30s. */
  statementTimeoutMs?: number;
  /** Connection idle timeout. Defaults to 10s. */
  idleTimeoutMillis?: number;
}

class PgPoolClient implements PgClient {
  // The pool is exposed read-only on the prototype so the
  // outer factory can register it with the telemetry sink without
  // re-implementing the wrapper.
  readonly pool: pg.Pool;
  private readonly acquireLeakThresholdMs: number;
  private readonly onLeak: NonNullable<PgClientOptions["onLeak"]>;
  private outstanding = 0;
  private closed = false;
  private readonly leakTimers = new Set<NodeJS.Timeout>();

  constructor(opts: PgClientOptions) {
    const max =
      opts.max ??
      (process.env.PG_POOL_MAX ? Number(process.env.PG_POOL_MAX) : 10);
    const statementTimeoutMs =
      opts.statementTimeoutMs ??
      (process.env.PG_STATEMENT_TIMEOUT_MS
        ? Number(process.env.PG_STATEMENT_TIMEOUT_MS)
        : 30_000);
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max,
      idleTimeoutMillis: opts.idleTimeoutMillis ?? 10_000,
      // statement_timeout protects against runaway queries holding a connection
      // forever — the same root cause as connection-leak exhaustion seen by
      // the previous unbounded pool config.
      statement_timeout: statementTimeoutMs,
      // Bounded connection-acquire timeout. Without this, a saturated pool
      // would queue indefinitely, surfacing as a slow request rather than a
      // 503 the autoscaler can act on.
      connectionTimeoutMillis: 5_000
    });
    this.acquireLeakThresholdMs = opts.acquireLeakThresholdMs ?? 30_000;
    this.onLeak =
      opts.onLeak ??
      ((info) => {
        // eslint-disable-next-line no-console
        console.warn("[pgClient] connection-leak suspect", info);
      });
  }

  async query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    const result = await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }

  async withTransaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const tx: PgClient = {
        async query<U = unknown>(text: string, params?: unknown[]) {
          const r = await client.query(text, params as unknown[]);
          return { rows: r.rows as U[], rowCount: r.rowCount };
        },
        withTransaction: () => {
          throw new Error("nested transactions not supported");
        },
        acquire: () => {
          throw new Error("nested acquire inside a transaction is not supported — reuse the tx handle");
        },
        stats: () => this.stats(),
        close: async () => undefined
      };
      const result = await fn(tx);
      await client.query("commit");
      return result;
    } catch (err) {
      try {
        await client.query("rollback");
      } catch {
        // ignore rollback errors — the original error is more informative
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async acquire(label = "anonymous"): Promise<PgConnection> {
    if (this.closed) {
      throw new Error("[pgClient] acquire() called on a closed pool");
    }
    const client = await this.pool.connect();
    this.outstanding += 1;
    const acquiredAt = Date.now();
    const stack = new Error("acquire").stack;
    let released = false;

    const leakTimer = setTimeout(() => {
      if (released) return;
      this.onLeak({
        label,
        heldForMs: Date.now() - acquiredAt,
        stack
      });
    }, this.acquireLeakThresholdMs);
    leakTimer.unref?.();
    this.leakTimers.add(leakTimer);

    return {
      query: async <T = unknown>(text: string, params?: unknown[]) => {
        const r = await client.query(text, params as unknown[]);
        return { rows: r.rows as T[], rowCount: r.rowCount };
      },
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(leakTimer);
        this.leakTimers.delete(leakTimer);
        this.outstanding = Math.max(0, this.outstanding - 1);
        try {
          client.release();
        } catch {
          // pg already released or errored — defensive only.
        }
      }
    };
  }

  stats(): PgPoolStats {
    const p = this.pool as unknown as {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      options: { max?: number };
    };
    return {
      totalCount: p.totalCount ?? 0,
      idleCount: p.idleCount ?? 0,
      waitingCount: p.waitingCount ?? 0,
      max: p.options?.max ?? 0,
      outstanding: this.outstanding
    };
  }

  async close(): Promise<void> {
    // Sprint Stabilization — graceful drain.
    // Wait for waitingCount to settle before calling pool.end(). Without
    // this, an in-flight query on shutdown would be cancelled mid-statement
    // and leak the partially-applied row state into the next startup. The
    // outer deadline is enforced by the gracefulShutdown timer.
    this.closed = true;
    for (const t of this.leakTimers) clearTimeout(t);
    this.leakTimers.clear();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const s = this.stats();
      if (s.waitingCount === 0 && s.outstanding === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await this.pool.end();
  }
}

export function createPgClient(
  connectionStringOrOptions: string | PgClientOptions
): PgClient {
  const opts: PgClientOptions =
    typeof connectionStringOrOptions === "string"
      ? { connectionString: connectionStringOrOptions }
      : connectionStringOrOptions;
  const raw: PgClient = new PgPoolClient(opts);
  // Chaos: opt-in, dev/test only. wrapPgClientWithChaos is an identity
  // function unless CHAOS_ENABLED=true AND NODE_ENV ∉ {production,staging}.
  // The wrapper preserves the PgClient API exactly — query/withTransaction/
  // acquire/stats/close are all forwarded; only fault injection is added
  // before each query() and before each acquire().
  return isChaosEnabled() ? wrapPgClientWithChaos(raw) : raw;
}
