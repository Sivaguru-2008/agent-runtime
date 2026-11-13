import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { wrap } from "../src";

const created: string[] = [];
function tempDb(): string {
  const p = join(tmpdir(), `fence-${randomUUID()}.db`);
  created.push(p);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

// The function that dispatches tool calls. It logs every *real* execution so
// the test can assert which effects actually fired.
function makeAgent(log: string[]) {
  return async (tool: string, input: any) => {
    log.push(`${tool}:${JSON.stringify(input)}`);
    if (tool === "stripeCharge") return { id: "ch_123", amount: input.amount };
    if (tool === "sendEmail") return { delivered: true };
    if (tool === "readDatabase") return { rows: 3 };
    return null;
  };
}

const effects = {
  stripeCharge: "IRREVERSIBLE",
  sendEmail: "IRREVERSIBLE",
  readDatabase: "IDEMPOTENT",
} as const;

describe("crash + restart", () => {
  it("fires IRREVERSIBLE effects once across a restart, re-runs IDEMPOTENT ones", async () => {
    const dbPath = tempDb();
    const RUN = "order-4242";

    // ---- first run: charge + email succeed, then the process "crashes" ----
    const log1: string[] = [];
    const agent1 = wrap(makeAgent(log1), {
      effects,
      storage: "sqlite",
      connectionString: dbPath,
      runId: RUN,
      logger: { enabled: false },
    });
    const charge1 = await agent1("stripeCharge", { amount: 4242 });
    await agent1("sendEmail", { to: "buyer@acme.com" });
    await agent1.close(); // process dies here

    expect(log1).toEqual([
      'stripeCharge:{"amount":4242}',
      'sendEmail:{"to":"buyer@acme.com"}',
    ]);

    // ---- restart: same run id, same db, the orchestrator replays steps ----
    const log2: string[] = [];
    const agent2 = wrap(makeAgent(log2), {
      effects,
      storage: "sqlite",
      connectionString: dbPath,
      runId: RUN,
      logger: { enabled: false },
    });
    const charge2 = await agent2("stripeCharge", { amount: 4242 }); // suppressed
    await agent2("sendEmail", { to: "buyer@acme.com" }); // suppressed
    await agent2("readDatabase", { table: "orders" }); // idempotent -> runs
    await agent2.close();

    // IRREVERSIBLE effects did NOT re-execute on the second run.
    expect(log2).not.toContain('stripeCharge:{"amount":4242}');
    expect(log2).not.toContain('sendEmail:{"to":"buyer@acme.com"}');
    // The IDEMPOTENT read DID execute on the second run.
    expect(log2).toContain('readDatabase:{"table":"orders"}');
    // A suppressed call returns the originally-recorded response.
    expect(charge2).toEqual(charge1);
    expect(charge2).toEqual({ id: "ch_123", amount: 4242 });
  });

  it("keeps separate runs independent", async () => {
    const dbPath = tempDb();
    let fires = 0;
    const agent = wrap(
      async () => {
        fires++;
        return "charged";
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: "sqlite",
        connectionString: dbPath,
        logger: { enabled: false },
      }
    );

    await agent("stripeCharge", { amount: 10 }, { runId: "run-A" });
    await agent("stripeCharge", { amount: 10 }, { runId: "run-B" });
    await agent("stripeCharge", { amount: 10 }, { runId: "run-A" }); // suppressed

    expect(fires).toBe(2); // run-A and run-B each fired once
    await agent.close();
  });
});
