import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { SqliteStorage } from "../src/storage/sqlite";
import type { CommittedEffect } from "../src/storage/base";

function effect(overrides: Partial<CommittedEffect> = {}): CommittedEffect {
  return {
    id: randomUUID(),
    operationId: "op-1",
    toolName: "stripeCharge",
    inputHash: "hash-1",
    response: JSON.stringify({ ok: true }),
    committedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("SqliteStorage", () => {
  it("writes and reads a committed effect", async () => {
    const s = new SqliteStorage(":memory:");
    await s.init();

    expect(await s.getCommitted("op-1")).toBeNull();

    const { inserted } = await s.putCommitted(effect());
    expect(inserted).toBe(true);

    const got = await s.getCommitted("op-1");
    expect(got?.toolName).toBe("stripeCharge");
    expect(JSON.parse(got!.response)).toEqual({ ok: true });

    await s.close();
  });

  it("dedups on (operation_id, tool_name, input_hash)", async () => {
    const s = new SqliteStorage(":memory:");
    await s.init();

    const first = await s.putCommitted(
      effect({ response: JSON.stringify("first") })
    );
    expect(first.inserted).toBe(true);

    const second = await s.putCommitted(
      effect({ response: JSON.stringify("second") })
    );
    expect(second.inserted).toBe(false);
    // The originally-committed row wins; the duplicate is ignored.
    expect(JSON.parse(second.row.response)).toBe("first");

    await s.close();
  });

  it("treats a different input_hash as a separate effect", async () => {
    const s = new SqliteStorage(":memory:");
    await s.init();

    await s.putCommitted(effect({ operationId: "op-a", inputHash: "h-a" }));
    const other = await s.putCommitted(
      effect({ operationId: "op-b", inputHash: "h-b" })
    );
    expect(other.inserted).toBe(true);

    await s.close();
  });

  it("records and updates intent status", async () => {
    const s = new SqliteStorage(":memory:");
    await s.init();

    const id = randomUUID();
    await s.recordIntent({
      id,
      operationId: "op-1",
      toolName: "sendEmail",
      input: "{}",
      intendedAt: new Date().toISOString(),
      status: "PENDING",
    });
    // Should not throw; the row now exists and can transition.
    await expect(s.updateIntentStatus(id, "COMMITTED")).resolves.toBeUndefined();

    await s.close();
  });
});
