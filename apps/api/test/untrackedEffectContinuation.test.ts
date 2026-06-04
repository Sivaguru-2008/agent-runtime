import { describe, expect, it } from "vitest";
import {
  deterministicStorage,
  runWithUntrackedAllowedAsync,
  type DeterministicExecutionContext
} from "../src/runtime/executionEngine.js";

/**
 * Regression: the undici fetch-continuation guard trip (S_UNSAFE_REPLAY).
 *
 * The determinism guard patches global Date.now() to throw inside an execution
 * step (deterministicStorage context, allowUntracked=false). The MODEL_GENERATION
 * provider fetch runs via runWithUntrackedAllowedAsync. undici schedules an
 * INTERNAL continuation (node:internal/deps/undici processResponseEndOfBody)
 * DURING the fetch that calls Date.now() while finalizing the response body — and
 * that continuation can fire on a LATER tick, AFTER the awaited effect already
 * returned.
 *
 * The original impl flipped `store.allowUntracked = true` then restored it in a
 * `finally`, keeping the SAME store active in the ALS context. The trailing
 * undici continuation captured that store and fired after `allowUntracked` was
 * reset to false → the guard threw on trusted infra I/O, spamming a fatal-level
 * uncaughtException on every model run.
 *
 * The fix runs the effect via `deterministicStorage.exit()`, so every
 * continuation the effect spawns inherits "no store" and never arms the guard —
 * regardless of when it fires. The guard stays armed for step-body code.
 *
 * This test reproduces the exact shape: an effect that returns quickly but
 * leaves a deferred Date.now() continuation scheduled inside its own context.
 * It FAILS against the boolean-flip impl and PASSES with exit().
 */

function stepCtx(): DeterministicExecutionContext {
  return {
    executionId: "exec-undici-continuation",
    stepType: "MODEL_GENERATION",
    clock: { now: () => 0 } as never,
    random: () => 0,
    allowUntracked: false
  };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("determinism guard vs. trusted-effect trailing continuations", () => {
  it("does NOT trip the guard when a recorded effect leaves a deferred Date.now() continuation (undici processResponseEndOfBody)", async () => {
    await deterministicStorage.run(stepCtx(), async () => {
      let trailing: { ok: boolean; err?: unknown } | undefined;

      // The effect (stand-in for modelProvider.complete's fetch) returns quickly
      // but schedules a continuation that calls Date.now() on a LATER tick —
      // exactly like undici finalizing the response body after fetch() resolves.
      await runWithUntrackedAllowedAsync(async () => {
        setTimeout(() => {
          try {
            Date.now();
            trailing = { ok: true };
          } catch (err) {
            trailing = { ok: false, err };
          }
        }, 0);
        return "provider-response";
      });

      // The helper's window has closed (allowUntracked restored), but the step's
      // deterministicStorage context is still active. Let the deferred
      // continuation fire — this is when the original impl threw.
      await tick(20);

      expect(trailing, "trailing continuation should have run").toBeDefined();
      expect(
        trailing!.ok,
        `guard tripped on trusted infra continuation: ${String((trailing as { err?: unknown } | undefined)?.err)}`
      ).toBe(true);
    });
  });

  it("STILL throws for bare Date.now() in step-body code (guard not weakened)", async () => {
    await deterministicStorage.run(stepCtx(), async () => {
      expect(() => Date.now()).toThrow(/S_UNSAFE_REPLAY|Untracked Nondeterminism/);
    });
  });

  it("STILL throws for bare Math.random() in step-body code (guard not weakened)", async () => {
    await deterministicStorage.run(stepCtx(), async () => {
      expect(() => Math.random()).toThrow(/S_UNSAFE_REPLAY|Untracked Nondeterminism/);
    });
  });
});
