/**
 * Human auth + onboarding suite — drives the real registerAuthRoutes via
 * app.inject against a stateful fake PgClient and a fake Google verifier. Proves
 * signup-vs-login, login_count increment, session issuance, /auth/me gating,
 * logout revocation, developer-key provisioning (and its idempotency), and the
 * onboarding step machine.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes, type AuthRouteOptions } from "../src/interfaces/http/authRoutes.js";
import { registerFounderRoutes } from "../src/interfaces/http/founderRoutes.js";
import type { PgClient } from "../src/infrastructure/persistence/postgres/pgClient.js";
import type { GoogleIdentity, GoogleTokenVerifier } from "../src/infrastructure/security/googleAuth.js";
import { GoogleVerificationError } from "../src/infrastructure/security/googleAuth.js";

// ── Fake Postgres ─────────────────────────────────────────────────────────────
// In-memory model of the users / user_sessions / user_onboarding tables plus the
// minimal tenant/api_key/signup writes provisionDeveloperKey performs. Pattern-
// matches on SQL text, mirroring the established signupRoutes.test.ts fake.
interface FakeState {
  usersById: Map<string, any>;
  usersByGoogle: Map<string, any>;
  sessions: any[];
  onboarding: Map<string, any>;
  events: any[];
}

function fakeDb(state: FakeState): PgClient {
  const now = () => new Date().toISOString();
  const run = async (sql: string, params: unknown[] = []) => {
    const t = sql.toLowerCase();

    if (t.includes("insert into users") && t.includes("on conflict (google_id)")) {
      const [id, googleId, email, name, picture, isFounder] = params as any[];
      const existing = state.usersByGoogle.get(googleId);
      if (existing) {
        existing.email = email;
        existing.name = name ?? existing.name;
        existing.profile_picture = picture ?? existing.profile_picture;
        existing.is_founder = isFounder;
        existing.last_login_at = now();
        existing.login_count += 1;
        return { rows: [{ ...existing, inserted: false }], rowCount: 1 };
      }
      const row = {
        id, google_id: googleId, email, name: name ?? null, profile_picture: picture ?? null,
        tenant_id: null, is_founder: isFounder, created_at: now(), last_login_at: now(), login_count: 1
      };
      state.usersById.set(id, row);
      state.usersByGoogle.set(googleId, row);
      return { rows: [{ ...row, inserted: true }], rowCount: 1 };
    }

    if (t.startsWith("select * from users where id")) {
      const row = state.usersById.get(params[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (t.includes("update users set tenant_id")) {
      const [tenantId, userId] = params as any[];
      const row = state.usersById.get(userId);
      if (row) row.tenant_id = tenantId;
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (t.includes("insert into user_sessions")) {
      const [id, userId, hash, exp] = params as any[];
      state.sessions.push({ id, user_id: userId, token_hash: hash, exp, revoked_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (t.includes("update user_sessions set revoked_at")) {
      const hash = params[0] as string;
      const s = state.sessions.find((x) => x.token_hash === hash && !x.revoked_at);
      if (s) s.revoked_at = now();
      return { rows: [], rowCount: s ? 1 : 0 };
    }

    if (t.includes("insert into user_events")) {
      state.events.push({ user_id: params[1], event_type: params[2], dedupe_key: params[4] });
      return { rows: [], rowCount: 1 };
    }

    if (t.includes("insert into user_onboarding")) {
      const userId = params[0] as string;
      let row = state.onboarding.get(userId);
      if (!row) {
        row = {
          user_id: userId, onboarding_started: now(), onboarding_completed: null,
          developer_key_created: null, first_agent_created: null,
          first_task_executed: null, first_replay_viewed: null, updated_at: now()
        };
        state.onboarding.set(userId, row);
      }
      return { rows: [row], rowCount: 1 };
    }
    if (t.includes("update user_onboarding")) {
      const [userId, step] = params as any[];
      const row = state.onboarding.get(userId);
      if (row) {
        if (!row[step]) row[step] = now();
        const allDone = ["developer_key_created", "first_agent_created", "first_task_executed", "first_replay_viewed"]
          .every((c) => row[c]);
        if (allDone && !row.onboarding_completed) row.onboarding_completed = now();
        row.updated_at = now();
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    // provisionDeveloperKey writes — accept silently.
    if (t.includes("insert into tenants") || t.includes("insert into tenant_quotas") ||
        t.includes("insert into api_keys") || t.includes("insert into signups")) {
      return { rows: [], rowCount: 1 };
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

// ── Fake Google verifier ──────────────────────────────────────────────────────
function fakeVerifier(identityByToken: Record<string, GoogleIdentity>): GoogleTokenVerifier {
  return {
    async verify(idToken: string): Promise<GoogleIdentity> {
      const id = identityByToken[idToken];
      if (!id) throw new GoogleVerificationError("bad token");
      return id;
    }
  };
}

const ADA: GoogleIdentity = {
  googleId: "google-ada-123",
  email: "ada@founders.com",
  emailVerified: true,
  name: "Ada Lovelace",
  picture: "https://pic/ada.png"
};
const BOB: GoogleIdentity = {
  googleId: "google-bob-456",
  email: "bob@user.com",
  emailVerified: true,
  name: "Bob",
  picture: null
};

const SECRET = "test-secret-at-least-32-characters-long!!";

let app: FastifyInstance | undefined;
let state: FakeState;

beforeEach(() => {
  state = {
    usersById: new Map(),
    usersByGoogle: new Map(),
    sessions: [],
    onboarding: new Map(),
    events: []
  };
});
afterEach(async () => {
  if (app) await app.close();
  app = undefined;
});

async function build(overrides: Partial<AuthRouteOptions> = {}, db: PgClient | null = fakeDb(state)) {
  const a = Fastify({ logger: false });
  const opts: AuthRouteOptions = {
    enabled: true,
    verifier: fakeVerifier({ "ada-token": ADA, "bob-token": BOB }),
    sessionSecret: SECRET,
    sessionTtlSeconds: 3600,
    founderEmails: new Set(["ada@founders.com"]),
    defaultPlan: "starter",
    defaultRpm: 120,
    ...overrides
  };
  await registerAuthRoutes(a, db, opts);
  await registerFounderRoutes(a, db, { enabled: opts.enabled, sessionSecret: opts.sessionSecret });
  await a.ready();
  app = a;
  return a;
}

describe("POST /auth/google", () => {
  it("creates a new user on first sign-in (201, isNewUser=true) and marks founder", async () => {
    const a = await build();
    const res = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "ada-token" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.isNewUser).toBe(true);
    expect(body.user.email).toBe("ada@founders.com");
    expect(body.user.isFounder).toBe(true);
    expect(body.user.loginCount).toBe(1);
    expect(typeof body.sessionToken).toBe("string");
  });

  it("logs an existing user in (200, isNewUser=false) and increments login_count", async () => {
    const a = await build();
    await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "ada-token" } });
    const second = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "ada-token" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().isNewUser).toBe(false);
    expect(second.json().user.loginCount).toBe(2);
  });

  it("rejects an invalid Google token with 401", async () => {
    const a = await build();
    const res = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "garbage" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("INVALID_GOOGLE_TOKEN");
  });

  it("returns 503 when no verifier is configured", async () => {
    const a = await build({ verifier: null });
    const res = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "ada-token" } });
    expect(res.statusCode).toBe(503);
  });

  it("returns 403 when auth is disabled", async () => {
    const a = await build({ enabled: false });
    const res = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "ada-token" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /auth/me", () => {
  it("returns the user + onboarding for a valid session", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const me = await a.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("bob@user.com");
    expect(me.json().onboarding.totalSteps).toBe(4);
  });

  it("401s without a session", async () => {
    const a = await build();
    const me = await a.inject({ method: "GET", url: "/auth/me" });
    expect(me.statusCode).toBe(401);
  });

  it("reads the session from the cookie too", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const me = await a.inject({ method: "GET", url: "/auth/me", headers: { cookie: `session=${token}` } });
    expect(me.statusCode).toBe(200);
  });
});

describe("onboarding", () => {
  it("provisions a developer key once, then 409s on a second attempt", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const auth = { authorization: `Bearer ${token}` };

    const first = await a.inject({ method: "POST", url: "/auth/onboarding/developer-key", headers: auth });
    expect(first.statusCode).toBe(201);
    expect(first.json().apiKey).toMatch(/^sk_live_/);
    expect(first.json().onboarding.developerKeyCreated).not.toBeNull();

    const second = await a.inject({ method: "POST", url: "/auth/onboarding/developer-key", headers: auth });
    expect(second.statusCode).toBe(409);
  });

  it("advances the step machine and completes onboarding after all four steps", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const auth = { authorization: `Bearer ${token}` };

    await a.inject({ method: "POST", url: "/auth/onboarding/developer-key", headers: auth });
    await a.inject({ method: "POST", url: "/auth/onboarding/step", headers: auth, payload: { step: "first_agent_created" } });
    await a.inject({ method: "POST", url: "/auth/onboarding/step", headers: auth, payload: { step: "first_task_executed" } });
    const last = await a.inject({ method: "POST", url: "/auth/onboarding/step", headers: auth, payload: { step: "first_replay_viewed" } });

    expect(last.statusCode).toBe(200);
    const ob = last.json();
    expect(ob.completedSteps).toBe(4);
    expect(ob.onboardingCompleted).not.toBeNull();
  });

  it("rejects an unknown onboarding step with 400", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const res = await a.inject({
      method: "POST", url: "/auth/onboarding/step",
      headers: { authorization: `Bearer ${token}` }, payload: { step: "not_a_step" }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session row and returns ok", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const res = await a.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(state.sessions.find((s) => s.revoked_at)).toBeTruthy();
  });
});

describe("founder route gating", () => {
  it("401s with no session", async () => {
    const a = await build();
    const res = await a.inject({ method: "GET", url: "/admin/founder/overview" });
    expect(res.statusCode).toBe(401);
  });

  it("403s for a non-founder session", async () => {
    const a = await build();
    const login = await a.inject({ method: "POST", url: "/auth/google", payload: { idToken: "bob-token" } });
    const token = login.json().sessionToken as string;
    const res = await a.inject({ method: "GET", url: "/admin/founder/overview", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });
});
