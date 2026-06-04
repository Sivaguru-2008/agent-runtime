/**
 * Observability metadata — runtimeId identity.
 *
 * The operator console's "Runtime ID" field must identify the running backend
 * INSTANCE, not the individual request. Before this fix `runtimeIdFor` returned
 * `request.id`, so the value changed on every request — the console showed a
 * different Runtime ID on the metadata panel vs. the error card, and it rolled
 * over constantly. It must instead be stable for the life of the process and
 * only change across a restart.
 */

import { describe, expect, it } from "vitest";
import { runtimeIdFor, RUNTIME_INSTANCE_ID } from "../src/interfaces/http/observabilityMetadata.js";

describe("runtimeIdFor — stable per-process runtime instance id", () => {
  it("returns the same value across different requests (not the per-request id)", () => {
    const reqA = { id: "req-aaaaaaaa" } as never;
    const reqB = { id: "req-bbbbbbbb" } as never;
    expect(runtimeIdFor(reqA)).toBe(runtimeIdFor(reqB));
  });

  it("returns the module-level RUNTIME_INSTANCE_ID, ignoring request.id", () => {
    const req = { id: "some-other-request-id" } as never;
    expect(runtimeIdFor(req)).toBe(RUNTIME_INSTANCE_ID);
    expect(runtimeIdFor(req)).not.toBe("some-other-request-id");
  });

  it("RUNTIME_INSTANCE_ID is a non-empty string", () => {
    expect(typeof RUNTIME_INSTANCE_ID).toBe("string");
    expect(RUNTIME_INSTANCE_ID.length).toBeGreaterThan(0);
  });
});
