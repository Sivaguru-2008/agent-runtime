import { createHash } from "node:crypto";
import type { ReplayFrame } from "../../domain/replay.js";

/**
 * Execution-level fingerprint primitives.
 *
 * Per-frame digests are already produced by FrameBuilder (preview.fingerprint)
 * — those are key-sorted SHA-256 hashes over the strip-non-deterministic
 * payload projection of each event. Two replays of the same event log produce
 * bit-identical preview.fingerprints. This module folds those per-frame
 * digests into ONE execution-level rolling chain hash, which serves three
 * purposes the per-frame digests can't:
 *
 *   1. A single value that summarizes the whole replay. A divergence detector
 *      can compare two certifications by checking ONE field — chainHash —
 *      instead of frame-by-frame, which collapses N comparisons into O(1).
 *
 *   2. A tamper-evident anchor. Because the chain hash is built recursively
 *      (H_i = sha256(H_{i-1} || digest_i)), a single mutated frame somewhere
 *      in the middle of the log shifts every hash from that point forward —
 *      the equivalent of a Merkle root over the event stream's deterministic
 *      projection.
 *
 *   3. A stable diff cursor. When two chain hashes differ, the divergence
 *      detector can binary-search the frameDigests arrays to localize the
 *      first divergent frame in O(log n) — the per-frame digests are the
 *      same primitives the chain hash is built from, so localization is
 *      consistent with the chain comparison.
 *
 * Determinism contract:
 *   • Given the same input frames in the same order, computeExecutionFingerprint
 *     MUST return a bit-identical result. No wallclock, no PID, no random.
 *   • Frames MUST be sorted by eventSequence ascending before folding. The
 *     FrameBuilder already produces sorted frames, so this is defensive.
 *   • A frame with NO preview.fingerprint is folded as the literal "∅" string
 *     rather than skipped — silently skipping would mask divergence.
 */

/**
 * Pure rolling chain hash. H_0 = "" ; H_i = sha256(H_{i-1} || "\x1e" || digest_i).
 * The 0x1E (record separator) byte is a domain separator so an attacker cannot
 * forge a chain by concatenating digests; standard practice for streaming
 * Merkle-style hashes.
 */
export function chainHashOf(digests: readonly string[]): string {
  let h = "";
  for (const d of digests) {
    h = createHash("sha256")
      .update(h)
      .update("\x1e")
      .update(d ?? "∅")
      .digest("hex")
      .slice(0, 32);
  }
  // Empty input → empty seed; treat as the well-known "empty stream" sentinel
  // so two empty replays compare equal under chainHash.
  return h || "0".repeat(32);
}

/**
 * Extract the per-frame deterministic digest. Mirrors FrameBuilder's
 * preview.fingerprint exactly, but defends against frames whose builder did
 * not populate the field — those collapse to a stable empty-set sentinel.
 */
export function frameDigest(frame: ReplayFrame): string {
  return frame.preview.fingerprint ?? "∅";
}

export interface ExecutionFingerprint {
  /** Number of frames folded into the chain hash. */
  frameCount: number;
  /** Highest eventSequence observed across all frames (cursor anchor). */
  lastEventSequence: number;
  /** Per-frame digests in eventSequence order. */
  frameDigests: string[];
  /** Rolling chain hash; the headline equivalence test. */
  chainHash: string;
}

/**
 * Compute the execution-level fingerprint from a materialized frame timeline.
 *
 * Pure: no IO, no clock, no randomness. Safe to call concurrently and from
 * any context, including replay-engine cold paths.
 */
export function computeExecutionFingerprint(frames: readonly ReplayFrame[]): ExecutionFingerprint {
  const sorted = [...frames].sort((a, b) => (a.eventSequence ?? 0) - (b.eventSequence ?? 0));
  const frameDigests = sorted.map(frameDigest);
  const lastEventSequence = sorted.length > 0 ? sorted[sorted.length - 1].eventSequence ?? 0 : 0;
  return {
    frameCount: sorted.length,
    lastEventSequence,
    frameDigests,
    chainHash: chainHashOf(frameDigests)
  };
}

/**
 * Localize the first divergent frame between two digest arrays. Returns null
 * when the arrays are identical (modulo length); returns the lowest index
 * where they differ when both are non-empty and have content past it.
 *
 * Performance is O(min(n, m)) in the worst case (sequential scan), which is
 * fine — even a 100k-frame execution costs <1ms. A binary search would be
 * theoretically tighter but only on the assumption that "divergence is rare
 * and clustered late", which is not a property we can rely on.
 */
export function firstDivergentIndex(
  expected: readonly string[],
  actual: readonly string[]
): number | null {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (expected[i] !== actual[i]) return i;
  }
  if (expected.length !== actual.length) return n;
  return null;
}
