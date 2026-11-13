import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
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

  // (c) No silent in-memory commit fallback: a committed effect written to a
  // file-backed adapter must still be there after the handle is closed and a
  // fresh adapter reopens the same file. If commits lived only in memory, the
  // reopened store would read null and the effect could fire again.
  describe("durability (no in-memory commit loss)", () => {
    const created: string[] = [];
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

    it("persists committed effects across a close + reopen of the same file", async () => {
      const path = join(tmpdir(), `fence-durability-${randomUUID()}.db`);
      created.push(path);

      const first = new SqliteStorage(path);
      await first.init();
      await first.putCommitted(effect({ operationId: "op-durable" }));
      await first.close(); // simulate the process dying

      const reopened = new SqliteStorage(path);
      await reopened.init();
      const got = await reopened.getCommitted("op-durable");
      expect(got).not.toBeNull();
      expect(JSON.parse(got!.response)).toEqual({ ok: true });
      await reopened.close();
    });
  });
});
