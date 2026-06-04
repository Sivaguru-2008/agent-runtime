/**
 * Google OAuth / Sign-In token verification.
 *
 * Flow (server-verified ID token — the recommended, no-secret pattern):
 *   1. The browser renders the Google Identity Services "Continue with Google"
 *      button. Google handles the email/password (or passkey) challenge.
 *   2. On success Google hands the browser a signed JWT *ID token*.
 *   3. The browser POSTs that ID token to our API (via POST /auth/google).
 *   4. THIS module verifies the token's signature against Google's public keys
 *      and checks the audience == our GOOGLE_CLIENT_ID. Only then do we trust
 *      the email/name/picture/sub it carries.
 *
 * We never see or store the user's password — Google verifies it. We persist
 * only the durable Google account id (`sub`) and profile fields.
 *
 * The verifier is injectable (GoogleTokenVerifier) so tests can exercise the
 * full signup/login path with a deterministic fake — no network, no real
 * Google keys — exactly as the rest of the suite fakes Postgres.
 */

import { OAuth2Client } from "google-auth-library";

/** The trusted identity fields lifted from a verified Google ID token. */
export interface GoogleIdentity {
  /** Stable Google account id (the JWT `sub`). The login key. */
  googleId: string;
  email: string;
  /** Google asserts the email is verified. We require this to be true. */
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

/** Verifies a Google ID token, returning the identity or throwing on failure. */
export interface GoogleTokenVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

export class GoogleVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleVerificationError";
  }
}

/**
 * Production verifier backed by google-auth-library. Validates signature,
 * issuer, expiry, and audience (clientId) against Google's published certs
 * (the library caches them). Throws GoogleVerificationError on any problem.
 */
export class LiveGoogleTokenVerifier implements GoogleTokenVerifier {
  private readonly client: OAuth2Client;
  constructor(private readonly clientId: string) {
    this.client = new OAuth2Client(clientId);
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId
      });
      payload = ticket.getPayload();
    } catch (err) {
      throw new GoogleVerificationError(
        `Google token verification failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!payload) throw new GoogleVerificationError("Google token had no payload");
    if (!payload.sub) throw new GoogleVerificationError("Google token missing subject (sub)");
    if (!payload.email) throw new GoogleVerificationError("Google token missing email");
    // google-auth-library types email_verified as `true | undefined`. Treat any
    // non-true value as unverified and refuse it.
    const emailVerified = payload.email_verified === true;
    if (!emailVerified) {
      throw new GoogleVerificationError("Google account email is not verified");
    }
    return {
      googleId: payload.sub,
      email: payload.email,
      emailVerified,
      name: payload.name ?? null,
      picture: payload.picture ?? null
    };
  }
}
