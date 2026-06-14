import { describe, it, expect } from "vitest";
import { wrap } from "../src";
import { SqliteStorage } from "../src/storage/sqlite";
import type { StorageAdapter } from "../src/storage/base";
import type { FenceLogger } from "../src/utils/logger";

const silent = { enabled: false } as const;

describe("fence core", () => {
  it("suppresses an IRREVERSIBLE effect on the second identical call", async () => {
    let fires = 0;
    const agent = wrap(
      async (tool: string, input: any) => {
        fires++;
        return { tool, charged: input.amount };
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: new SqliteStorage(":memory:"),
        runId: "run-1",
        logger: silent,
      }
    );

    const a = await agent("stripeCharge", { amount: 100 });
    const b = await agent("stripeCharge", { amount: 100 });

    expect(fires).toBe(1);
    expect(b).toEqual(a);
    await agent.close();
  });

  it("ignores object key order when hashing input", async () => {
    let fires = 0;
    const agent = wrap(
      async () => {
        fires++;
        return "ok";
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: new SqliteStorage(":memory:"),
        runId: "run-1",
        logger: silent,
      }
    );

    await agent("stripeCharge", { amount: 100, currency: "usd" });
    await agent("stripeCharge", { currency: "usd", amount: 100 });

    expect(fires).toBe(1);
    await agent.close();
  });

  it("re-executes IDEMPOTENT effects every time", async () => {
    let reads = 0;
    const agent = wrap(
      async () => {
        reads++;
        return reads;
      },
      {
        effects: { readDatabase: "IDEMPOTENT" },
        storage: new SqliteStorage(":memory:"),
        runId: "run-1",
        logger: silent,
      }
    );

    await agent("readDatabase", { q: 1 });
    await agent("readDatabase", { q: 1 });

    expect(reads).toBe(2);
    await agent.close();
  });

  it("treats changed input as a new operation", async () => {
    let fires = 0;
    const agent = wrap(
      async (_tool: string, input: any) => {
        fires++;
        return input.amount;
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: new SqliteStorage(":memory:"),
        runId: "run-1",
        logger: silent,
      }
    );

    await agent("stripeCharge", { amount: 100 }); // fires
    await agent("stripeCharge", { amount: 250 }); // different input -> fires
    await agent("stripeCharge", { amount: 100 }); // repeat -> suppressed

    expect(fires).toBe(2);
    await agent.close();
  });

  it("suppresses a second agent that shares storage + operation", async () => {
    const store = new SqliteStorage(":memory:");
    let firesA = 0;
    let firesB = 0;

    const agentA = wrap(
      async () => {
        firesA++;
        return "sent-A";
      },
      {
        effects: { sendEmail: "IRREVERSIBLE" },
        storage: store,
        runId: "shared-run",
        logger: silent,
      }
    );
    const agentB = wrap(
      async () => {
        firesB++;
        return "sent-B";
      },
      {
        effects: { sendEmail: "IRREVERSIBLE" },
        storage: store,
        runId: "shared-run",
        logger: silent,
      }
    );

    const ra = await agentA("sendEmail", { to: "x@y.com" });
    const rb = await agentB("sendEmail", { to: "x@y.com" });

    expect(firesA).toBe(1);
    expect(firesB).toBe(0); // second agent is suppressed
    expect(rb).toBe(ra); // and returns the recorded response
    await store.close();
  });

  it("does NOT commit when the tool throws", async () => {
    let attempts = 0;
    const agent = wrap(
      async () => {
        attempts++;
        throw new Error("stripe 500");
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: new SqliteStorage(":memory:"),
        runId: "run-1",
        logger: silent,
      }
    );

    await expect(agent("stripeCharge", { amount: 5 })).rejects.toThrow(
      "stripe 500"
    );
    // Nothing was committed, so a retry runs the tool again (it never succeeded).
    await expect(agent("stripeCharge", { amount: 5 })).rejects.toThrow(
      "stripe 500"
    );
    expect(attempts).toBe(2);
    await agent.close();
  });

  it("fails open and warns when storage reads throw", async () => {
    const broken: StorageAdapter = {
      init: async () => {},
      getCommitted: async () => {
        throw new Error("db down");
      },
      putCommitted: async () => {
        throw new Error("db down");
      },
      recordIntent: async () => {},
      updateIntentStatus: async () => {},
      close: async () => {},
    };

    let fires = 0;
    const warnings: string[] = [];
    const capture: FenceLogger = {
      warn: (m) => warnings.push(m),
      committed: () => {},
      suppressed: () => {},
      debug: () => {},
    };

    const agent = wrap(
      async () => {
        fires++;
        return "ok";
      },
      {
        effects: { stripeCharge: "IRREVERSIBLE" },
        storage: broken,
        runId: "run-1",
        logger: capture,
      }
    );

    const r = await agent("stripeCharge", { amount: 1 });
    expect(r).toBe("ok");
    expect(fires).toBe(1);
    expect(warnings.join(" ")).toMatch(/failing open/);
    await agent.close();
  });
});
