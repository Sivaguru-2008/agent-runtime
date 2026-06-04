/**
 * Session token suite — proves the HMAC sign/verify contract the whole human
 * auth layer (and the web edge middleware) depends on: round-trip, expiry,
 * tamper rejection, wrong-secret rejection, and malformed-input safety.
 */

import { describe, expect, it } from "vitest";
import {
  issueSessionToken,
  verifySessionToken,
  hashSessionToken
} from "../src/infrastructure/security/userSession.js";

const SECRET = "test-secret-at-least-32-characters-long!!";

describe("userSession", () => {
  it("round-trips claims through issue → verify", () => {
    const { token, claims } = issueSessionToken(
      { uid: "u1", email: "a@x.com", founder: true },
      SECRET,
      3600
    );
    const verified = verifySessionToken(token, SECRET);
    expect(verified).not.toBeNull();
    expect(verified!.uid).toBe("u1");
    expect(verified!.email).toBe("a@x.com");
    expect(verified!.founder).toBe(true);
    expect(verified!.exp).toBe(claims.exp);
  });

  it("rejects an expired token", () => {
    // Issue as if it was minted an hour ago with a 1s ttl.
    const past = Math.floor(Date.now() / 1000) - 3600;
    const { token } = issueSessionToken({ uid: "u1", email: "a@x.com", founder: false }, SECRET, 1, past);
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = issueSessionToken({ uid: "u1", email: "a@x.com", founder: false }, SECRET, 3600);
    expect(verifySessionToken(token, "a-totally-different-secret-value-32chars")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const { token } = issueSessionToken({ uid: "u1", email: "a@x.com", founder: false }, SECRET, 3600);
    const [, sig] = token.split(".");
    // Swap in a payload claiming founder:true, keep the old signature.
    const forgedPayload = Buffer.from(
      JSON.stringify({ uid: "u1", email: "a@x.com", founder: true, iat: 1, exp: 9999999999 }),
      "utf8"
    ).toString("base64url");
    expect(verifySessionToken(`${forgedPayload}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects malformed / empty input without throwing", () => {
    expect(verifySessionToken(undefined, SECRET)).toBeNull();
    expect(verifySessionToken("", SECRET)).toBeNull();
    expect(verifySessionToken("no-dot", SECRET)).toBeNull();
    expect(verifySessionToken(".", SECRET)).toBeNull();
    expect(verifySessionToken("a.", SECRET)).toBeNull();
    expect(verifySessionToken(".b", SECRET)).toBeNull();
  });

  it("hashSessionToken is deterministic and hex", () => {
    const { token } = issueSessionToken({ uid: "u1", email: "a@x.com", founder: false }, SECRET, 3600);
    const h1 = hashSessionToken(token);
    const h2 = hashSessionToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
