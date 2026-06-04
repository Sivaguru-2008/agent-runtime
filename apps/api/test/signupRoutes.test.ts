/**
 * Self-serve signup suite — drives the real registerSignupRoutes via
 * app.inject against a stateful fake PgClient. Proves the activation gate:
 * disabled → 403, invite enforcement, key minting, and duplicate-email
 * idempotency.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSignupRoutes, type SignupRouteOptions } from "../src/interfaces/http/signupRoutes.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";

// Stateful fake: tracks signup emails so the dup-check select and the unique
// constraint both behave like Postgres. Every other insert is a no-op success.
function fakeDb(): PgClient {
  const emails = new Set<string>();
  const run = async (sql: string, params: unknown[] = []) => {
    const text = sql.toLowerCase();
    if (text.includes("from signups") && text.includes("lower(email)")) {
      const email = String(params[0] ?? "").toLowerCase();
      return { rows: emails.has(email) ? [{ id: "existing" }] : [], rowCount: emails.has(email) ? 1 : 0 };
    }
    if (text.includes("insert into signups")) {
      const email = String(params[1] ?? "").toLowerCase();
      if (emails.has(email)) {
        const e = new Error("duplicate key") as Error & { code: string };
        e.code = "23505";
        throw e;
      }
      emails.add(email);
    }
    return { rows: [], rowCount: 0 };
  };
  const db: PgClient = {
    query: (async (sql: string, params: unknown[] = []) => run(sql, params)) as PgClient["query"],
    async withTransaction(fn) { return fn(db); },
    async acquire() { return { query: (async (s: string, p: unknown[] = []) => run(s, p)) as never, release() {} }; },
    stats() { return { totalCount: 0, idleCount: 0, waitingCount: 0, max: 0, outstanding: 0 }; },
    async close() {}
  };
  return db;
}

const OPTS: SignupRouteOptions = {
  enabled: true,
  open: false,
  inviteCodes: ["LETMEIN"],
  defaultPlan: "starter",
  defaultRpm: 120
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function build(opts: Partial<SignupRouteOptions> = {}, db: PgClient | null = fakeDb()): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await registerSignupRoutes(a, db, { ...OPTS, ...opts });
  await a.ready();
  app = a;
  return a;
}

describe("POST /signup", () => {
  it("returns 403 SIGNUP_DISABLED when the feature is off", async () => {
    const a = await build({ enabled: false });
    const res = await a.inject({ method: "POST", url: "/signup", payload: { email: "a@x.com" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("SIGNUP_DISABLED");
  });

  it("returns 503 when no security database is configured", async () => {
    const a = await build({}, null);
    const res = await a.inject({ method: "POST", url: "/signup", payload: { email: "a@x.com", inviteCode: "LETMEIN" } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("SIGNUP_REQUIRES_DATABASE");
  });

  it("rejects an invalid email with 400", async () => {
    const a = await build();
    const res = await a.inject({ method: "POST", url: "/signup", payload: { email: "not-an-email", inviteCode: "LETMEIN" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_REQUEST");
  });

  it("rejects a missing/wrong invite code with 403 when not open", async () => {
    const a = await build();
    const noCode = await a.inject({ method: "POST", url: "/signup", payload: { email: "a@x.com" } });
    expect(noCode.statusCode).toBe(403);
    expect(noCode.json().error).toBe("INVALID_INVITE");

    const wrong = await a.inject({ method: "POST", url: "/signup", payload: { email: "a@x.com", inviteCode: "nope" } });
    expect(wrong.statusCode).toBe(403);
  });

  it("mints a developer key with a valid invite", async () => {
    const a = await build();
    const res = await a.inject({ method: "POST", url: "/signup", payload: { email: "ada@x.com", inviteCode: "LETMEIN", organization: "Ada Labs" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.role).toBe("developer");
    expect(body.plan).toBe("starter");
    expect(body.apiKey).toMatch(/^sk_live_/);
    expect(body.tenantId).toMatch(/^ada-labs-[0-9a-f]{8}$/);
    expect(body.rateLimitRpm).toBe(120);
  });

  it("allows signup without an invite when open=true", async () => {
    const a = await build({ open: true });
    const res = await a.inject({ method: "POST", url: "/signup", payload: { email: "open@x.com" } });
    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^sk_live_/);
  });

  it("returns 409 for a duplicate email (case-insensitive)", async () => {
    const a = await build({ open: true });
    const first = await a.inject({ method: "POST", url: "/signup", payload: { email: "dup@x.com" } });
    expect(first.statusCode).toBe(201);
    const second = await a.inject({ method: "POST", url: "/signup", payload: { email: "DUP@x.com" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("EMAIL_ALREADY_REGISTERED");
  });
});
