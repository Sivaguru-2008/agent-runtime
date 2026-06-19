import { describe, it, expect } from "vitest";
import { wrap, createFence } from "../src";
import type {
  StorageAdapter,
  CommittedEffect,
  IntentRecord,
  PutResult,
} from "../src/storage/base";
import type { FenceLogger } from "../src/utils/logger";

const silent = { enabled: false } as const;

/**
 * A storage adapter that records everything written to it, so a test can assert
 * exactly which timestamps / hashes the fence persisted. `seed` pre-loads a
 * committed effect that `getCommitted` will return for any operation id.
 */
function capturingStorage(seed?: CommittedEffect) {
  const committed: CommittedEffect[] = [];
  const intents: IntentRecord[] = [];
  const adapter: StorageAdapter = {
    init: async () => {},
    getCommitted: async () => seed ?? null,
    putCommitted: async (effect: CommittedEffect): Promise<PutResult> => {
      committed.push(effect);
      return { row: effect, inserted: true };
    },
    recordIntent: async (intent: IntentRecord) => {
      intents.push(intent);
    },
    updateIntentStatus: async () => {},
    close: async () => {},
  };
  return { adapter, committed, intents };
}

describe("(b) wall clock is injected, never read directly", () => {
  it("stamps committed + intent records from the injected clock, not Date.now()", async () => {
    const FROZEN = new Date("2000-01-01T00:00:00.000Z");
    const { adapter, committed, intents } = capturingStorage();

    const agent = wrap(async () => ({ chargeId: "ch_1" }), {
      effects: { stripeCharge: "IRREVERSIBLE" },
      storage: adapter,
      runId: "run-1",
      clock: () => FROZEN, // injected — the fence must use this, not the system clock
      logger: silent,
    });

    await agent("stripeCharge", { amount: 100 });
    await agent.close();

    expect(committed).toHaveLength(1);
    expect(committed[0].committedAt).toBe(FROZEN.toISOString());
    // The PENDING intent timestamp also comes from the injected clock.
    expect(intents[0].intendedAt).toBe(FROZEN.toISOString());
  });

  it("advances exactly as the injected clock advances", async () => {
    // One dispatch reads the clock twice: once for the PENDING intent, once for
    // the commit. A monotonically advancing clock must show up in those stamps.
    const times = [
      new Date("2021-06-01T00:00:00.000Z"), // PENDING intent
      new Date("2022-06-01T00:00:00.000Z"), // commit
    ];
    let i = 0;
    const { adapter, committed, intents } = capturingStorage();
    const agent = wrap(async () => "ok", {
      effects: { sendEmail: "IRREVERSIBLE" },
      storage: adapter,
      runId: "run-1",
      clock: () => times[Math.min(i++, times.length - 1)],
      logger: silent,
    });

    await agent("sendEmail", { to: "a@b.com" });
    await agent.close();

    expect(intents[0].intendedAt).toBe("2021-06-01T00:00:00.000Z");
    expect(committed[0].committedAt).toBe("2022-06-01T00:00:00.000Z");
  });
});

describe("(d) input-hash verification is ON by default", () => {
  // A committed row whose operation id will match (getCommitted returns it for
  // any lookup) but whose input hash deliberately does NOT match the live call.
  function staleRow(): CommittedEffect {
    return {
      id: "seed",
      operationId: "whatever",
      toolName: "stripeCharge",
      inputHash: "HASH-OF-A-DIFFERENT-INPUT",
      response: JSON.stringify({ chargeId: "STALE" }),
      committedAt: new Date().toISOString(),
    };
  }

  it("refuses to suppress (and re-executes) when the recorded input hash differs", async () => {
    const { adapter } = capturingStorage(staleRow());
    const warnings: string[] = [];
    const logger: FenceLogger = {
      warn: (m) => warnings.push(m),
      committed: () => {},
      suppressed: () => {},
      debug: () => {},
    };

    let fired = 0;
    const agent = wrap(
      async () => {
        fired++;
        return { chargeId: "FRESH" };
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: adapter,
        runId: "run-1",
        logger, // verifyInputHash defaults to true
      }
    );

    const result = await agent("stripeCharge", { amount: 100 });
    await agent.close();

    expect(fired).toBe(1); // executed instead of returning the stale row
    expect(result).toEqual({ chargeId: "FRESH" });
    expect(warnings.join(" ")).toMatch(/input hash mismatch/i);
  });

  it("can be turned OFF, which then returns the recorded response on an id match", async () => {
    const { adapter } = capturingStorage(staleRow());

    let fired = 0;
    const fence = createFence({
      effects: { stripeCharge: "IRREVERSIBLE" },
      storage: adapter,
      runId: "run-1",
      verifyInputHash: false, // opt out
      logger: silent,
    });

    const result = await fence.dispatch("stripeCharge", { amount: 100 }, () => {
      fired++;
      return { chargeId: "FRESH" };
    });
    await fence.close();

    expect(fired).toBe(0); // suppressed purely on the operation-id match
    expect(result).toEqual({ chargeId: "STALE" });
  });
});
