/**
 * Session-based authorization guards for the human-facing routes.
 *
 * Shared by authRoutes (/auth/me, onboarding) and founderRoutes (/admin/founder)
 * so there is ONE implementation of "validate the signed session cookie/bearer,
 * load the user, optionally require founder". The token is verified statelessly
 * (HMAC, no DB hit); the user is then loaded so a deleted account or a flipped
 * is_founder flag is honoured immediately.
 *
 * On failure the guard sends the response (401/403/503) and returns null — the
 * caller simply `if (!user) return;`. On success it attaches request.sessionUser
 * and returns the user.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { verifySessionToken } from "../../infrastructure/security/userSession.js";
import { getUserById, type UserRecord } from "../../application/users/userStore.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The authenticated human (set by the session guards). */
    sessionUser?: UserRecord;
  }
}

export interface SessionGuardOptions {
  enabled: boolean;
  sessionSecret: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Extract the session token from the `session` cookie or an Authorization Bearer. */
export function readSessionToken(request: FastifyRequest): string | undefined {
  const cookies = parseCookies(request.headers.cookie);
  if (cookies.session) return cookies.session;
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice(7);
    if (t) return t;
  }
  return undefined;
}

/**
 * Build the authenticate() guard bound to a db + options. Returns the user or
 * sends the failure response and returns null.
 */
export function createSessionGuard(db: PgClient | null, options: SessionGuardOptions) {
  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { requireFounder?: boolean } = {}
  ): Promise<UserRecord | null> {
    if (!options.enabled || !db) {
      reply.status(503).send({ error: "AUTH_UNAVAILABLE", message: "User authentication is not configured." });
      return null;
    }
    const token = readSessionToken(request);
    const claims = verifySessionToken(token, options.sessionSecret);
    if (!claims) {
      reply.status(401).send({ error: "UNAUTHORIZED", message: "A valid session is required." });
      return null;
    }
    const user = await getUserById(db, claims.uid);
    if (!user) {
      reply.status(401).send({ error: "UNAUTHORIZED", message: "Session user no longer exists." });
      return null;
    }
    if (opts.requireFounder && !user.is_founder) {
      reply.status(403).send({ error: "FORBIDDEN", message: "Founder access required." });
      return null;
    }
    request.sessionUser = user;
    return user;
  };
}

export type SessionGuard = ReturnType<typeof createSessionGuard>;
