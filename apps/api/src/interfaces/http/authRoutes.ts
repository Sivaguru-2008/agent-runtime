/**
 * Human authentication + onboarding routes (Google Sign-In).
 *
 * These run UNAUTHENTICATED with respect to the API-key plugin — the human has
 * a session cookie, not a machine key — so app.ts adds "/auth" to the auth
 * skip-paths. Authorization for the protected routes here is enforced by the
 * `requireSession` / `requireFounder` preHandlers below, which validate the
 * HMAC-signed session token (cookie or Bearer) and load the user.
 *
 * Endpoints:
 *   POST /auth/google                      — verify a Google ID token, upsert the
 *                                            user, record signup/login, issue a
 *                                            session. Handles BOTH signup & login.
 *   POST /auth/logout                      — revoke the session, record logout.
 *   GET  /auth/me                          — current user + onboarding state.
 *   GET  /auth/onboarding                  — onboarding state (creates it, stamps
 *                                            onboarding_started).
 *   POST /auth/onboarding/developer-key    — mint the developer key (step 2).
 *   POST /auth/onboarding/step             — mark an onboarding milestone.
 *
 * The session token is signed/verified by userSession.ts so the Next.js edge
 * middleware can verify it with the same SESSION_SECRET (no DB round-trip).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import type { GoogleTokenVerifier } from "../../infrastructure/security/googleAuth.js";
import { GoogleVerificationError } from "../../infrastructure/security/googleAuth.js";
import {
  issueSessionToken,
  verifySessionToken,
  hashSessionToken
} from "../../infrastructure/security/userSession.js";
import {
  upsertUserFromGoogle,
  ensureOnboarding,
  markOnboardingStep,
  type UserRecord,
  type OnboardingState,
  type OnboardingStep
} from "../../application/users/userStore.js";
import { provisionDeveloperKey } from "../../application/users/provisionDeveloperKey.js";
import { createId } from "../../shared/id.js";
import {
  recordUserEvent,
  userEventDedupe,
  type UserEventType
} from "../../application/analytics/userEvents.js";
import { createSessionGuard, readSessionToken } from "./sessionAuth.js";

export interface AuthRouteOptions {
  /** Master switch. When false every /auth route is a clean 404-equivalent 403. */
  enabled: boolean;
  /** Verifier for Google ID tokens. null → /auth/google returns 503. */
  verifier: GoogleTokenVerifier | null;
  /** Secret used to sign/verify session tokens. Shared with the web middleware. */
  sessionSecret: string;
  /** Session lifetime in seconds. */
  sessionTtlSeconds: number;
  /** Lowercased emails granted founder access. */
  founderEmails: Set<string>;
  /** Plan + rpm for developer keys minted during onboarding. */
  defaultPlan: "starter" | "growth" | "enterprise";
  defaultRpm: number;
}

function clientIp(request: FastifyRequest): string | null {
  const fwd = request.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]!.trim();
  return request.ip ?? null;
}

function publicUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    profilePicture: u.profile_picture,
    tenantId: u.tenant_id,
    isFounder: u.is_founder,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    loginCount: u.login_count
  };
}

function publicOnboarding(o: OnboardingState) {
  const completedSteps = [
    o.developer_key_created,
    o.first_agent_created,
    o.first_task_executed,
    o.first_replay_viewed
  ].filter(Boolean).length;
  return {
    onboardingStarted: o.onboarding_started,
    onboardingCompleted: o.onboarding_completed,
    developerKeyCreated: o.developer_key_created,
    firstAgentCreated: o.first_agent_created,
    firstTaskExecuted: o.first_task_executed,
    firstReplayViewed: o.first_replay_viewed,
    completedSteps,
    totalSteps: 4
  };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  db: PgClient | null,
  options: AuthRouteOptions
): Promise<void> {
  // The shared session guard (also used by founderRoutes) — one implementation
  // of "validate the signed token, load the user".
  const authenticate = createSessionGuard(db, {
    enabled: options.enabled,
    sessionSecret: options.sessionSecret
  });

  // ── POST /auth/visit — anonymous top-of-funnel tracking ──────────────────────
  // Public (no session): records a 'visit' event so the activation funnel has a
  // real "Visitors" number. Fail-safe and fire-and-forget; user_id is null.
  const visitSchema = z.object({
    path: z.string().max(1024).optional(),
    referrer: z.string().max(1024).optional()
  });
  app.post("/auth/visit", async (request, reply) => {
    if (!options.enabled || !db) return reply.status(204).send();
    let body: z.infer<typeof visitSchema> = {};
    try {
      body = visitSchema.parse(request.body ?? {});
    } catch {
      // Ignore malformed bodies — a visit ping must never error.
    }
    recordUserEvent(db, {
      userId: null,
      eventType: "visit",
      properties: { path: body.path ?? null, referrer: body.referrer ?? null }
    });
    return reply.status(204).send();
  });

  // ── POST /auth/google — signup + login ────────────────────────────────────
  const googleSchema = z.object({
    idToken: z.string().min(1).max(8192),
    source: z.string().max(64).optional()
  });

  app.post("/auth/google", async (request, reply) => {
    if (!options.enabled) {
      return reply.status(403).send({ error: "AUTH_DISABLED", message: "Google sign-in is not enabled." });
    }
    if (!db || !options.verifier) {
      return reply.status(503).send({
        error: "AUTH_UNAVAILABLE",
        message: "Sign-in requires a configured Google client and database."
      });
    }

    let body: z.infer<typeof googleSchema>;
    try {
      body = googleSchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: "INVALID_REQUEST", message: "An idToken is required." });
    }

    let identity;
    try {
      identity = await options.verifier.verify(body.idToken);
    } catch (err) {
      const message = err instanceof GoogleVerificationError ? err.message : "Token verification failed.";
      request.log.warn({ err }, "[auth] google token verification failed");
      return reply.status(401).send({ error: "INVALID_GOOGLE_TOKEN", message });
    }

    const isFounder = options.founderEmails.has(identity.email.toLowerCase());

    let user: UserRecord;
    let isNewUser: boolean;
    try {
      const result = await upsertUserFromGoogle(db, identity, isFounder);
      user = result.user;
      isNewUser = result.isNewUser;
    } catch (err) {
      request.log.error({ err }, "[auth] failed to upsert user");
      return reply.status(500).send({ error: "AUTH_FAILED", message: "Could not complete sign-in." });
    }

    // Issue + persist the session (the row makes it revocable + auditable).
    const { token, claims } = issueSessionToken(
      { uid: user.id, email: user.email, founder: user.is_founder },
      options.sessionSecret,
      options.sessionTtlSeconds
    );
    try {
      await db.query(
        `insert into user_sessions (id, user_id, token_hash, expires_at, ip, user_agent)
         values ($1, $2, $3, to_timestamp($4), $5, $6)`,
        [
          createId(),
          user.id,
          hashSessionToken(token),
          claims.exp,
          clientIp(request),
          typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null
        ]
      );
    } catch (err) {
      // Non-fatal: the token is valid statelessly even if we failed to persist
      // the audit/revocation row. Log and continue.
      request.log.warn({ err }, "[auth] failed to persist session row");
    }

    // Analytics: a brand-new user is a signup (idempotent); everyone is a login.
    if (isNewUser) {
      recordUserEvent(db, {
        userId: user.id,
        eventType: "signup",
        dedupeKey: userEventDedupe.signup(user.id),
        properties: { source: body.source ?? "google" }
      });
      // Seed the onboarding row so onboarding_started is stamped at signup.
      void ensureOnboarding(db, user.id).catch(() => undefined);
      recordUserEvent(db, {
        userId: user.id,
        eventType: "onboarding_started",
        dedupeKey: userEventDedupe.onboardingStarted(user.id)
      });
    }
    recordUserEvent(db, { userId: user.id, eventType: "login" });

    return reply.status(isNewUser ? 201 : 200).send({
      user: publicUser(user),
      isNewUser,
      sessionToken: token,
      expiresAt: new Date(claims.exp * 1000).toISOString()
    });
  });

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  app.post("/auth/logout", async (request, reply) => {
    const token = readSessionToken(request);
    if (token && db) {
      const claims = verifySessionToken(token, options.sessionSecret);
      try {
        await db.query(
          "update user_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null",
          [hashSessionToken(token)]
        );
      } catch (err) {
        request.log.warn({ err }, "[auth] failed to revoke session");
      }
      if (claims) recordUserEvent(db, { userId: claims.uid, eventType: "logout" });
    }
    return reply.status(200).send({ ok: true });
  });

  // ── GET /auth/me ─────────────────────────────────────────────────────────────
  app.get("/auth/me", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const onboarding = await ensureOnboarding(db!, user.id);
    return reply.send({ user: publicUser(user), onboarding: publicOnboarding(onboarding) });
  });

  // ── GET /auth/onboarding ─────────────────────────────────────────────────────
  app.get("/auth/onboarding", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;
    const onboarding = await ensureOnboarding(db!, user.id);
    return reply.send(publicOnboarding(onboarding));
  });

  // ── POST /auth/onboarding/developer-key (step 2) ─────────────────────────────
  app.post("/auth/onboarding/developer-key", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;

    // Idempotent: if the user already has a tenant/key, do not mint a second.
    if (user.tenant_id) {
      return reply.status(409).send({
        error: "KEY_ALREADY_PROVISIONED",
        message: "A developer key already exists for this account. Keys are shown only once at creation."
      });
    }

    let provisioned;
    try {
      provisioned = await provisionDeveloperKey(db!, {
        userId: user.id,
        email: user.email,
        plan: options.defaultPlan,
        rpm: options.defaultRpm
      });
    } catch (err) {
      request.log.error({ err }, "[auth] failed to provision developer key");
      return reply.status(500).send({ error: "PROVISION_FAILED", message: "Could not create a developer key." });
    }

    const onboarding = await markOnboardingStep(db!, user.id, "developer_key_created");
    recordUserEvent(db!, {
      userId: user.id,
      eventType: "developer_key_created",
      dedupeKey: userEventDedupe.developerKeyCreated(user.id),
      properties: { tenantId: provisioned.tenantId }
    });

    return reply.status(201).send({
      tenantId: provisioned.tenantId,
      apiKey: provisioned.rawKey,
      keyPrefix: provisioned.keyPrefix,
      plan: provisioned.plan,
      rateLimitRpm: provisioned.rateLimitRpm,
      onboarding: publicOnboarding(onboarding)
    });
  });

  // ── POST /auth/onboarding/step ───────────────────────────────────────────────
  const stepSchema = z.object({
    step: z.enum(["first_agent_created", "first_task_executed", "first_replay_viewed"])
  });
  // Map each onboarding milestone to its analytics event + dedupe key.
  const stepEvent: Record<string, { type: UserEventType; dedupe: (u: string) => string }> = {
    first_agent_created: { type: "agent_created", dedupe: userEventDedupe.firstAgent },
    first_task_executed: { type: "task_completed", dedupe: userEventDedupe.firstTask },
    first_replay_viewed: { type: "replay_viewed", dedupe: userEventDedupe.firstReplay }
  };

  app.post("/auth/onboarding/step", async (request, reply) => {
    const user = await authenticate(request, reply);
    if (!user) return;

    let body: z.infer<typeof stepSchema>;
    try {
      body = stepSchema.parse(request.body);
    } catch {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        message: "step must be one of first_agent_created, first_task_executed, first_replay_viewed."
      });
    }

    const before = await ensureOnboarding(db!, user.id);
    const onboarding = await markOnboardingStep(db!, user.id, body.step as OnboardingStep);

    const ev = stepEvent[body.step]!;
    recordUserEvent(db!, { userId: user.id, eventType: ev.type, dedupeKey: ev.dedupe(user.id) });

    // Fire onboarding_completed exactly once — when this step flipped it.
    if (!before.onboarding_completed && onboarding.onboarding_completed) {
      recordUserEvent(db!, {
        userId: user.id,
        eventType: "onboarding_completed",
        dedupeKey: userEventDedupe.onboardingCompleted(user.id)
      });
    }

    return reply.send(publicOnboarding(onboarding));
  });
}
