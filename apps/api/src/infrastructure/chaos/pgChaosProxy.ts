/**
 * pgChaosProxy — wraps a PgClient to inject controlled database faults.
 *
 * Faults injected:
 *   - pg.disconnect         Transiently rejects a query with an error mimicking
 *                           a connection drop (code "57P01" — admin shutdown,
 *                           the shape pg surfaces on connection termination).
 *   - pg.statementTimeout   Rejects with "57014" (query_canceled) after the
 *                           payload `afterMs`, simulating a statement_timeout
 *                           trip on a real query that the server cut off.
 *   - pg.poolStarvation     Holds a pool connection for `holdMs` before
 *                           returning it. Drives concurrent callers into
 *                           waitingCount > 0 territory so the load test can
 *                           verify connection-acquire timeout behaviour.
 *
 * The proxy preserves the PgClient API exactly. withTransaction and acquire
 * pass through; only query() (and acquired-connection query()) are
 * fault-injectable. That matches reality: a real network blip terminates an
 * in-flight statement on the server side and the client surfaces it via the
 * query call, not via the pool itself.
 */

import type { PgClient, PgConnection, PgPoolStats } from "../persistence/postgres/pgClient.js";
import { chaosController } from "./chaosController.js";
import { assertChaosSafeEnvironment, isChaosEnabled } from "./chaosConfig.js";

class FaultyDisconnectError extends Error {
  readonly code = "57P01";
  constructor() {
    super("[chaos] simulated admin_shutdown: connection terminated");
    this.name = "FaultyDisconnectError";
  }
}

class FaultyStatementTimeoutError extends Error {
  readonly code = "57014";
  constructor(afterMs: number) {
    super(`[chaos] simulated statement_timeout fired after ${afterMs}ms`);
    this.name = "FaultyStatementTimeoutError";
  }
}

export function wrapPgClientWithChaos(client: PgClient): PgClient {
  if (!isChaosEnabled()) return client;
  assertChaosSafeEnvironment();

  const controller = chaosController();

  async function maybeInjectQueryFault(text: string): Promise<void> {
    if (controller.maybeFire("pg.disconnect", { sqlHead: text.slice(0, 64) })) {
      throw new FaultyDisconnectError();
    }
    const stPayload = controller.maybeFire("pg.statementTimeout", {
      sqlHead: text.slice(0, 64)
    });
    if (stPayload) {
      const afterMs = Number((stPayload as { afterMs?: number }).afterMs ?? 100);
      await new Promise((resolve) => setTimeout(resolve, afterMs));
      throw new FaultyStatementTimeoutError(afterMs);
    }
  }

  async function maybeStarvePool(label: string): Promise<void> {
    const payload = controller.maybeFire("pg.poolStarvation", { label });
    if (!payload) return;
    const holdMs = Number((payload as { holdMs?: number }).holdMs ?? 250);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }

  const wrapped: PgClient = {
    async query(text, params) {
      await maybeInjectQueryFault(text);
      return client.query(text, params);
    },

    async withTransaction(fn) {
      // Apply pool starvation BEFORE acquiring the underlying tx client so
      // the wait surfaces as a real pool delay. The faults inside the
      // transaction body are layered on the tx handle below.
      await maybeStarvePool("withTransaction");
      return client.withTransaction(async (rawTx) => {
        const faultyTx: PgClient = {
          query: async (text, params) => {
            await maybeInjectQueryFault(text);
            return rawTx.query(text, params);
          },
          withTransaction: () => {
            throw new Error("nested transactions not supported");
          },
          acquire: () => {
            throw new Error("nested acquire inside a transaction is not supported");
          },
          stats: () => rawTx.stats(),
          close: async () => undefined
        };
        return fn(faultyTx);
      });
    },

    async acquire(label?: string): Promise<PgConnection> {
      await maybeStarvePool(label ?? "anonymous");
      const conn = await client.acquire(label);
      return {
        query: async (text, params) => {
          await maybeInjectQueryFault(text);
          return conn.query(text, params);
        },
        release: () => conn.release()
      };
    },

    stats(): PgPoolStats {
      return client.stats();
    },

    close: () => client.close()
  };

  return wrapped;
}
