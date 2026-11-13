import { describe, it, expect } from "vitest";
import { RuntimeDB } from "../src/db/database.js";
import { FenceEnforcer } from "../src/stages/fenceEnforcement.js";
import type { FenceEvent } from "../src/types.js";

describe("Stage 4: fence enforcement (real agent-fence over the shared DB)", () => {
  it("suppresses an identical IRREVERSIBLE call and replays the recorded response", async () => {
    const db = new RuntimeDB(":memory:");
    const events: FenceEvent[] = [];
    const fence = new FenceEnforcer({
      db: db.handle,
      runId: "run-1",
      effects: { charge_card: "IRREVERSIBLE" },
      onEvent: (e) => events.push(e),
    });

    let fires = 0;
    const exec = () => {
      fires++;
      return { ok: true, data: { chargeId: "ch_1", charged: 5 } };
    };

    const a = await fence.dispatch(1, "charge_card", { customer: "c", amountUsd: 5 }, exec);
    const b = await fence.dispatch(2, "charge_card", { customer: "c", amountUsd: 5 }, exec);

    expect(fires).toBe(1); // the side effect fired exactly once
    expect(a.decision).toBe("COMMITTED");
    expect(b.decision).toBe("SUPPRESSED");
    expect(b.result).toEqual(a.result); // recorded response replayed
    expect(events.map((e) => e.decision)).toEqual(["COMMITTED", "SUPPRESSED"]);
    await fence.close();
    db.close();
  });

  it("passes IDEMPOTENT tools straight through with no fence event", async () => {
    const db = new RuntimeDB(":memory:");
    const events: FenceEvent[] = [];
    const fence = new FenceEnforcer({
      db: db.handle,
      runId: "run-2",
      effects: { search_web: "IDEMPOTENT" },
      onEvent: (e) => events.push(e),
    });
    let fires = 0;
    const r1 = await fence.dispatch(1, "search_web", { q: 1 }, () => (++fires, { ok: true, data: [1] }));
    const r2 = await fence.dispatch(2, "search_web", { q: 1 }, () => (++fires, { ok: true, data: [1] }));
    expect(fires).toBe(2); // idempotent: re-runs every time
    expect(r1.decision).toBe("PASSTHROUGH");
    expect(r2.decision).toBe("PASSTHROUGH");
    expect(events.length).toBe(0);
    await fence.close();
    db.close();
  });

  it("records an intervention HOLD as a SUPPRESSED fence event", async () => {
    const db = new RuntimeDB(":memory:");
    const events: FenceEvent[] = [];
    const fence = new FenceEnforcer({ db: db.handle, runId: "run-3", effects: {}, onEvent: (e) => events.push(e) });
    const ev = fence.hold(4, "send_email", "upstream quality 12/100");
    expect(ev.decision).toBe("SUPPRESSED");
    expect(events[0]?.tool).toBe("send_email");
    await fence.close();
    db.close();
  });
});
