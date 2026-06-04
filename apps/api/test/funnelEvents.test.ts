/**
 * Funnel event log — write-side suite.
 *
 * Proves the two hard invariants of the append-only funnel event recorder:
 *   • normalizeSource collapses casing/whitespace/aliases into stable buckets
 *     and never drops an unknown source.
 *   • recordFunnelEvent is FAIL-SAFE (no throw / reject / no-op on null db) and
 *     emits an idempotent `on conflict (dedupe_key) do nothing` insert with the
 *     deterministic dedupe key.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeSource,
  recordFunnelEvent,
  recordRetentionPing,
  funnelDedupe
} from "../src/application/analytics/funnelEvents.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A fake that synchronously captures every query() call. recordFunnelEvent
// invokes db.query synchronously (the promise is fire-and-forget), so the call
// is observable immediately even though the result is never awaited.
function capturingDb(): { db: PgClient; calls: () => { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async () => ({ rows: [], rowCount: 0 })) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return { db, calls: () => calls };
}

describe("normalizeSource", () => {
  const cases: Array<[string | null | undefined, string]> = [
    ["Twitter", "twitter"],
    ["twitter ", "twitter"],
    ["TWITTER", "twitter"],
    ["  ", "direct"],
    ["", "direct"],
    [null, "direct"],
    [undefined, "direct"],
    ["tw", "twitter"],
    ["x", "twitter"],
    ["gh", "github"],
    ["Hacker News", "hackernews"],
    ["product hunt", "producthunt"],
    ["Documentation", "docs"],
    ["docs", "docs"],
    ["landing", "landing"],
    ["newsletter Q2", "newsletter-q2"] // unknown → kept as its own slug, never dropped
  ];
  it.each(cases)("normalizes %o → %s", (input, expected) => {
    expect(normalizeSource(input)).toBe(expected);
  });
});

describe("funnelDedupe", () => {
  it("builds namespaced, deterministic keys", () => {
    expect(funnelDedupe.signup("acme-123")).toBe("signup:acme-123");
    expect(funnelDedupe.activation("acme-123")).toBe("activation:acme-123");
  });
  it("debounces retention to one key per tenant per UTC day", () => {
    expect(funnelDedupe.retention("acme", "2026-06-04")).toBe("retention:acme:2026-06-04");
    // Same tenant + same day → identical key (collapses a burst to one row).
    expect(funnelDedupe.retention("acme", "2026-06-04")).toBe(funnelDedupe.retention("acme", "2026-06-04"));
    // Different day → different key.
    expect(funnelDedupe.retention("acme", "2026-06-05")).not.toBe(funnelDedupe.retention("acme", "2026-06-04"));
  });
});

describe("recordRetentionPing", () => {
  it("emits a retention_ping with today's dedupe key", async () => {
    const { db, calls } = capturingDb();
    recordRetentionPing(db, "t1");
    await flush();
    expect(calls()).toHaveLength(1);
    const { sql, params } = calls()[0];
    expect(sql.toLowerCase()).toContain("insert into funnel_events");
    const today = new Date().toISOString().slice(0, 10);
    expect(params).toContain(`retention:t1:${today}`);
    expect(params).toContain("retention_ping");
  });

  it("is a no-op (never throws) when db is null", () => {
    expect(() => recordRetentionPing(null, "t1")).not.toThrow();
  });
});

describe("recordFunnelEvent — emission", () => {
  it("emits an idempotent insert carrying the dedupe key and attribution", async () => {
    const { db, calls } = capturingDb();
    recordFunnelEvent(db, {
      tenantId: "t1",
      eventType: "signup",
      dedupeKey: funnelDedupe.signup("t1"),
      attribution: { source: "twitter", utmCampaign: "launch" }
    });
    await flush();

    expect(calls()).toHaveLength(1);
    const { sql, params } = calls()[0];
    expect(sql.toLowerCase()).toContain("insert into funnel_events");
    expect(sql.toLowerCase()).toContain("on conflict (dedupe_key) do nothing");
    // dedupe_key is the 13th positional param ($13).
    expect(params).toContain("signup:t1");
    expect(params).toContain("twitter");
    expect(params).toContain("launch");
  });

  it("is a no-op (and never throws) when db is null", () => {
    expect(() => recordFunnelEvent(null, {
      tenantId: "t1", eventType: "activation", dedupeKey: funnelDedupe.activation("t1")
    })).not.toThrow();
  });
});

describe("recordFunnelEvent — fail-safe under a broken db", () => {
  const syncThrowingDb = {
    query() { throw new Error("pool exhausted"); },
    async withTransaction(fn: (c: unknown) => unknown) { return fn(syncThrowingDb); },
    async acquire() { return { query() { throw new Error("boom"); }, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  } as unknown as PgClient;

  const asyncRejectDb = {
    query: async () => { throw new Error("deadlock detected"); },
    async withTransaction(fn: (c: unknown) => unknown) { return fn(asyncRejectDb); },
    async acquire() { return { query: async () => { throw new Error("boom"); }, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  } as unknown as PgClient;

  it("swallows a synchronous throw from db.query", () => {
    expect(() => recordFunnelEvent(syncThrowingDb, {
      tenantId: "t1", eventType: "signup", dedupeKey: "signup:t1"
    })).not.toThrow();
  });

  it("swallows an async rejection (no unhandled rejection)", async () => {
    let unhandled: unknown = null;
    const onUnhandled = (reason: unknown) => { unhandled = reason; };
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() => recordFunnelEvent(asyncRejectDb, {
        tenantId: "t1", eventType: "signup", dedupeKey: "signup:t1"
      })).not.toThrow();
      await flush();
      await flush();
      expect(unhandled).toBeNull();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
