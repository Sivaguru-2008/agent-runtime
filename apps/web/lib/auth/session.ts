/**
 * Edge-compatible session token verification.
 *
 * Mirrors apps/api/src/infrastructure/security/userSession.ts but uses the Web
 * Crypto API (available in the Next.js middleware / edge runtime, where node:crypto
 * is not). The two MUST stay in lockstep on the token format:
 *
 *   token = base64url(payloadJson) "." base64url(HMAC_SHA256(payloadJson, secret))
 *
 * The web only ever VERIFIES tokens (the API mints them), so there is no signing
 * path here. The shared secret comes from SESSION_SECRET — the same value the API
 * is configured with.
 */

export interface SessionClaims {
  uid: string;
  email: string;
  founder: boolean;
  iat: number;
  exp: number;
}

const SESSION_COOKIE = "session";

export function getSessionSecret(): string {
  return process.env.SESSION_SECRET ?? "dev-insecure-session-secret-change-me-please-32+chars";
}

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8(b64url: string): string {
  const bytes = base64urlToBytes(b64url);
  return new TextDecoder().decode(bytes);
}

/**
 * Verify a session token's signature + expiry, returning the claims or null.
 * Never throws. Used by middleware to gate protected routes.
 */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<SessionClaims | null> {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
    const expectedSig = bytesToBase64url(sigBuf);
    // Constant-ish time compare (length + char loop). Edge has no timingSafeEqual.
    if (expectedSig.length !== providedSig.length) return null;
    let diff = 0;
    for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig.charCodeAt(i) ^ providedSig.charCodeAt(i);
    if (diff !== 0) return null;

    const claims = JSON.parse(utf8(payloadB64)) as SessionClaims;
    if (!claims || typeof claims.uid !== "string" || typeof claims.exp !== "number" || claims.exp <= now) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export { SESSION_COOKIE };
