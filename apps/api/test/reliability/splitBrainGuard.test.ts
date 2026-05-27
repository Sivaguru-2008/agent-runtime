/**
 * V3 — Split-brain guard tests.
 *
 * Contracts under test:
 *   - acquireFencingToken refuses to issue a token from a passive region.
 *   - assertCanWrite throws StaleFencingTokenError if a failover advanced
 *     the token after acquisition.
 *   - withFencingGuard wraps both steps and rejects mid-flight failovers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetRegionAwarenessForTests,
  getRegionAwareness
} from "../../src/infrastructure/reliability/regionAwareness.js";
import {
  acquireFencingToken,
  assertCanWrite,
  withFencingGuard,
  StaleFencingTokenError,
  NonPrimaryWriteError
} from "../../src/infrastructure/reliability/splitBrainGuard.js";

describe("SplitBrainGuard", () => {
  beforeEach(() => {
    __resetRegionAwarenessForTests({
      regionId: "us-east-1",
      primaryRegionId: "us-east-1"
    });
  });

  it("issues a fencing token when this region is active", () => {
    const t = acquireFencingToken();
    expect(t.regionId).toBe("us-east-1");
    expect(typeof t.token).toBe("number");
    expect(() => assertCanWrite(t)).not.toThrow();
  });

  it("rejects writes from a passive region", () => {
    __resetRegionAwarenessForTests({
      regionId: "us-west-2",
      primaryRegionId: "us-east-1"
    });
    expect(() => acquireFencingToken()).toThrow(NonPrimaryWriteError);
  });

  it("detects mid-flight failover via fencing-token bump", () => {
    const held = acquireFencingToken();
    // Simulate failover — region promotes itself, bumping the token.
    getRegionAwareness().promote("manual-test-failover");
    expect(() => assertCanWrite(held)).toThrow(StaleFencingTokenError);
  });

  it("withFencingGuard surfaces stale tokens", async () => {
    await expect(
      withFencingGuard(async () => {
        getRegionAwareness().promote("mid-op-failover");
        return 42;
      })
    ).rejects.toBeInstanceOf(StaleFencingTokenError);
  });
});
