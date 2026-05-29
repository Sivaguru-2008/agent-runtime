import type { Clock } from "../../shared/clock.js";
import { toIso } from "../../shared/clock.js";
import type { EventStore } from "../../domain/ports.js";
import type { ReplayCertificationStore } from "../../domain/cognitionPorts.js";
import type { ReplayCertification, ReplayDivergence } from "../../domain/replay.js";
import { FrameBuilder } from "./frameBuilder.js";
import {
  computeExecutionFingerprint,
  firstDivergentIndex
} from "./executionFingerprint.js";

/**
 * Replay Divergence Detector — Phase B operational hardening.
 *
 * Two distinct operations:
 *
 *   1. `certify(executionId, workflowVersion)`  — read the durable event log,
 *      fold it into a ReplayCertification, persist it, and return it. This is
 *      the "snapshot the truth" operation — it captures what the system
 *      believes the execution looks like right now.
 *
 *   2. `compare(executionId, workflowVersion)`  — recompute the certification
 *      from the current event log and compare it against the LATEST persisted
 *      certification for the same execution. Returns a ReplayDivergence
 *      diagnosing whether they match, and if not, *where* they first diverged.
 *
 * Why both: certify alone proves nothing. compare alone has nothing to
 * compare against. Operators call certify once during the canonical replay
 * (which is treated as ground truth), then call compare on every subsequent
 * replay attempt or determinism audit. A divergence between two replays of
 * the SAME workflow version + SAME event log is unconditionally a bug —
 * either a non-determinism leak in the engine (wallclock, random, retrieval
 * order) or out-of-band tampering with the event log.
 *
 * Implementation notes:
 *   • The fingerprint is computed exclusively from the durable EventStore —
 *     never from runtime memory — so a divergence reading is independent of
 *     in-process state. This is what makes it a *replay* certification rather
 *     than a runtime snapshot.
 *   • `workflowVersion` is supplied by the caller, not derived. Two
 *     certifications with different workflowVersion are reported as divergent
 *     with reason="WORKFLOW_VERSION" — replays across versions are a category
 *     error, not a determinism bug.
 *   • The detector is intentionally storage-agnostic: any
 *     ReplayCertificationStore (in-memory, Postgres, etc.) satisfies the
 *     contract. Production wires the Postgres store; unit tests use memory.
 */
export class ReplayDivergenceDetector {
  private readonly frameBuilder = new FrameBuilder();

  constructor(
    private readonly events: EventStore,
    private readonly certifications: ReplayCertificationStore,
    private readonly clock: Clock
  ) {}

  /**
   * Capture a certification from the current event log and persist it.
   * Idempotent in spirit — the chain hash for a stable event log is the
   * same on every call — but each call writes a fresh row so operators can
   * audit a timeline of certifications per execution.
   */
  async certify(
    executionId: string,
    workflowVersion: string
  ): Promise<ReplayCertification> {
    const certification = await this.computeCertification(executionId, workflowVersion);
    await this.certifications.put(certification);
    return certification;
  }

  /**
   * Recompute the certification and compare it against the most recent
   * persisted one. The narrative is human-readable and dashboard-ready.
   *
   * Edge cases:
   *   • No prior certification: actual == expected; `divergent=false`,
   *     `reason="NONE"`, narrative explains it's a first-time capture.
   *     The actual certification is NOT auto-persisted — call certify() to
   *     persist it. compare() is read-only.
   *   • Same chainHash, different frameCount: cannot happen by construction
   *     (the chain hash folds the count via the digest sequence), but
   *     defended via EVENT_COUNT divergence reason — silent skip would mask
   *     a chain-hash collision.
   */
  async compare(executionId: string, workflowVersion: string): Promise<ReplayDivergence> {
    const actual = await this.computeCertification(executionId, workflowVersion);
    const expected = (await this.certifications.latest(executionId)) ?? actual;

    if (expected === actual) {
      // First time the execution has been certified — nothing to diverge
      // FROM. Return a benign result so the caller's dashboard renders a
      // clean state, not an "unknown" sentinel.
      return {
        executionId,
        expected,
        actual,
        divergent: false,
        firstDivergentFrame: null,
        reason: "NONE",
        classification: "EQUIVALENT",
        narrative: "First certification — no prior baseline to compare against",
        detectedAt: toIso(this.clock.now())
      };
    }

    if (expected.workflowVersion !== actual.workflowVersion) {
      return {
        executionId,
        expected,
        actual,
        divergent: true,
        firstDivergentFrame: null,
        reason: "WORKFLOW_VERSION",
        classification: "NON_RECONSTRUCTABLE",
        narrative: `Workflow version changed: ${expected.workflowVersion} → ${actual.workflowVersion} (replays across versions are not comparable)`,
        detectedAt: toIso(this.clock.now())
      };
    }

    if (expected.chainHash === actual.chainHash) {
      return {
        executionId,
        expected,
        actual,
        divergent: false,
        firstDivergentFrame: null,
        reason: "NONE",
        classification: "EQUIVALENT",
        narrative: `Replay matches baseline across ${actual.frameDigests.length} frame(s)`,
        detectedAt: toIso(this.clock.now())
      };
    }

    if (expected.eventCount !== actual.eventCount) {
      return {
        executionId,
        expected,
        actual,
        divergent: true,
        firstDivergentFrame: firstDivergentIndex(expected.frameDigests, actual.frameDigests),
        reason: "EVENT_COUNT",
        classification: "DIVERGED",
        narrative: `Event log size changed: ${expected.eventCount} → ${actual.eventCount} event(s) — either appended out-of-band or trimmed`,
        detectedAt: toIso(this.clock.now())
      };
    }

    const idx = firstDivergentIndex(expected.frameDigests, actual.frameDigests);
    return {
      executionId,
      expected,
      actual,
      divergent: true,
      firstDivergentFrame: idx,
      reason: "FRAME_DIGEST",
      classification: "DIVERGED",
      narrative:
        idx === null
          ? "Chain hash diverged but no per-frame divergence found — likely a digest implementation drift"
          : `Replay diverged from baseline at frame ${idx} (out of ${actual.frameDigests.length}); first ${idx} frames matched, frames ${idx}..${actual.frameDigests.length - 1} differ`,
      detectedAt: toIso(this.clock.now())
    };
  }

  private async computeCertification(
    executionId: string,
    workflowVersion: string
  ): Promise<ReplayCertification> {
    const events = await this.events.listByExecution(executionId);
    const frames = await this.frameBuilder.build(events);
    const fp = computeExecutionFingerprint(frames);
    return {
      executionId,
      workflowVersion,
      eventCount: events.length,
      lastEventSequence: fp.lastEventSequence,
      frameDigests: fp.frameDigests,
      chainHash: fp.chainHash,
      capturedAt: toIso(this.clock.now())
    };
  }
}
