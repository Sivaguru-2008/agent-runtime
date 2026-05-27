import type { DomainEvent } from "../../domain/events.js";
import type { ReplayFrame, ReplayFramePreview } from "../../domain/replay.js";
import { fingerprint } from "../../shared/determinism.js";

/**
 * Frame Builder — converts an append-only event stream into a contiguous
 * replay timeline. Deterministic: given the same input events, output frames
 * are bit-identical including `preview.fingerprint`.
 *
 * Determinism notes (Phase 3):
 *   • `preview.fingerprint` deliberately *excludes* every wallclock and
 *     duration field on the payload, because two replays of the same event
 *     log can record different wall times (one ran on 2024-01-01, the other
 *     during a 2026-replay). If we hashed those, replay diffs would falsely
 *     flag every frame as DIVERGED.
 *   • `preview.label` is a human string — never compared in diffs, only
 *     rendered in the scrubber. Free to vary.
 *   • Sort is by `event.sequence` (monotonic per-aggregate). The event log is
 *     already ordered, so this is a defensive O(n log n) safety net.
 */
export class FrameBuilder {
  async build(events: DomainEvent[]): Promise<ReplayFrame[]> {
    const sorted = [...events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    const frames: ReplayFrame[] = [];
    for (let i = 0; i < sorted.length; i++) {
      frames.push(await this.toFrame(sorted[i], i));
    }
    return frames;
  }

  async toFrame(event: DomainEvent, index: number): Promise<ReplayFrame> {
    return {
      index,
      kind: this.kindForType(event.type),
      timestamp: event.timestamp,
      eventSequence: event.sequence ?? index,
      eventType: event.type,
      preview: await this.preview(event)
    };
  }

  private kindForType(type: string): ReplayFrame["kind"] {
    if (type === "REPLAY_SNAPSHOT_WRITTEN") return "SNAPSHOT";
    if (type === "REPLAY_BRANCH_CREATED") return "BRANCH_POINT";
    if (
      type === "EXECUTION_COMPLETED" ||
      type === "EXECUTION_FAILED" ||
      type === "COGNITION_COMPLETED" ||
      type === "COGNITION_FAILED"
    ) {
      return "TERMINATION";
    }
    return "EVENT";
  }

  private async preview(event: DomainEvent): Promise<ReplayFramePreview> {
    const tone = this.toneForType(event.type);
    const label = this.labelForEvent(event);
    return {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      label,
      tone,
      fingerprint: await fingerprint({
        type: event.type,
        // Hash a *normalized* projection of the payload — strip non-deterministic
        // fields (wallclock timestamps, durations, worker assignment) so two
        // replays of the same event log produce identical fingerprints.
        payload: stripNondeterministic(event.payload)
      })
    };
  }

  private toneForType(type: string): ReplayFramePreview["tone"] {
    if (type.endsWith("_FAILED") || type.includes("FAILURE") || type === "HALLUCINATION_DETECTED") {
      return "error";
    }
    if (type.endsWith("_COMPLETED") || type === "COGNITION_COMPLETED") return "success";
    if (type.startsWith("REPLAY_") || type === "MEMORY_INFLUENCE_RECORDED") return "info";
    if (type.includes("WARNING") || type === "UNCERTAINTY_SPIKE") return "warning";
    return "neutral";
  }

  private labelForEvent(event: DomainEvent): string {
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "COGNITION_NODE_STARTED":
      case "COGNITION_NODE_COMPLETED":
      case "COGNITION_NODE_FAILED": {
        const node = payload.node as { role?: string; sequence?: number } | undefined;
        return `${event.type.replace("COGNITION_NODE_", "")} · ${node?.role ?? "?"} #${node?.sequence ?? "?"}`;
      }
      case "COGNITION_HANDOFF": {
        const handoff = payload.handoff as { fromNodeId?: string } | undefined;
        const to = payload.toRole as string | undefined;
        return `HANDOFF → ${to ?? "?"} (from ${handoff?.fromNodeId?.slice(0, 6) ?? "?"})`;
      }
      case "MEMORY_INFLUENCE_RECORDED": {
        const influence = payload.influence as { length?: number } | undefined;
        return `MEMORY INFLUENCE × ${(influence as unknown[] | undefined)?.length ?? 0}`;
      }
      case "FAILURE_SIGNAL_RAISED": {
        const signal = payload.signal as { kind?: string; severity?: string } | undefined;
        return `FAILURE · ${signal?.kind ?? "?"} (${signal?.severity ?? "?"})`;
      }
      default:
        return event.type;
    }
  }
}

/**
 * Strip fields that vary across runs even when the underlying cognition is
 * identical. Pure function — does not mutate the input.
 *
 * Removes any of these keys at any depth:
 *   • startedAt / completedAt / capturedAt / detectedAt / emittedAt / acquiredAt
 *   • renewedAt / expiresAt / lastHeartbeatAt / createdAt / updatedAt
 *   • durationMs / workerId / ownerWorkerId
 *
 * The whitelist is by *key name*, not type, so payload-shape changes don't
 * need to update the algorithm.
 */
const NONDETERMINISTIC_KEYS = new Set([
  "startedAt",
  "completedAt",
  "capturedAt",
  "detectedAt",
  "emittedAt",
  "acquiredAt",
  "renewedAt",
  "expiresAt",
  "lastHeartbeatAt",
  "createdAt",
  "updatedAt",
  "timestamp",
  "durationMs",
  "workerId",
  "ownerWorkerId",
  "host"
]);

function stripNondeterministic(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripNondeterministic);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (NONDETERMINISTIC_KEYS.has(key)) continue;
    out[key] = stripNondeterministic(val);
  }
  return out;
}
