/**
 * Human session tokens — stateless, HMAC-signed bearer tokens for dashboard
 * login (distinct from machine API keys).
 *
 * Why a signed token (not just a DB session id):
 *   The Next.js edge middleware must decide "is this request authenticated?" on
 *   every navigation WITHOUT a database round-trip (the edge runtime cannot
 *   reach Postgres). A self-describing, signature-verified token lets both the
 *   API (node:crypto) and the web middleware (Web Crypto) validate it with only
 *   a shared secret. A companion `user_sessions` row still exists for audit and
 *   revocation; the token is the fast path, the row is the source of truth for
 *   "is it revoked".
 *
 * Format:  base64url(payloadJson) "." base64url(HMAC_SHA256(payloadJson))
 *   payload = { uid, email, founder, iat, exp }  (exp/iat are unix seconds)
 *
 * Security properties:
 *   • Constant-time signature comparison (timingSafeEqual) — no signature oracle.
 *   • Expiry enforced on verify; a tampered payload changes the signature.
 *   • The secret never leaves the server. The same secret is given to the web
 *     middleware via SESSION_SECRET so it can verify (never mint) tokens.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  /** User id (users.id). */
  uid: string;
  /** Email, denormalized for convenience / display. */
  email: string;
  /** Founder flag, so the web middleware can gate /founder without a DB hit. */
  founder: boolean;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
}

function b64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/**
 * Mint a signed session token valid for `ttlSeconds`. Returns the token plus the
 * claims it encodes (so the caller can persist exp / hash without re-parsing).
 */
export function issueSessionToken(
  claims: Pick<SessionClaims, "uid" | "email" | "founder">,
  secret: string,
  ttlSeconds: number,
  now: number = Math.floor(Date.now() / 1000)
): { token: string; claims: SessionClaims } {
  const full: SessionClaims = {
    uid: claims.uid,
    email: claims.email,
    founder: claims.founder,
    iat: now,
    exp: now + ttlSeconds
  };
  const payloadB64 = b64urlEncode(JSON.stringify(full));
  const sig = sign(payloadB64, secret);
  return { token: `${payloadB64}.${sig}`, claims: full };
}

/**
 * Verify a session token's signature and expiry. Returns the claims on success,
 * or null for any failure (malformed, bad signature, expired). Never throws.
 */
export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): SessionClaims | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  // Length check first so timingSafeEqual never throws on mismatched lengths.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64)) as SessionClaims;
  } catch {
    return null;
  }
  if (
    !claims ||
    typeof claims.uid !== "string" ||
    typeof claims.exp !== "number" ||
    claims.exp <= now
  ) {
    return null;
  }
  return claims;
}

/** SHA-256 of a raw token — the value persisted in user_sessions.token_hash. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
