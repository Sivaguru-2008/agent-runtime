/**
 * STAGE 4 — Fence enforcement.
 *
 * Every IRREVERSIBLE tool call goes through the REAL agent-fence engine, backed
 * by the shared unified database. We capture the fence's COMMITTED / SUPPRESSED
 * decisions through a custom FenceLogger and surface them as FenceEvents.
 *
 * Two ways a call can be SUPPRESSED:
 *   1. agent-fence's committed-effects log (an identical effect already fired) —
 *      the fence replays the recorded response, the side effect never re-runs.
 *   2. An intervention HOLD (Stage 6 blocked the call because upstream data
 *      quality was too low) — recorded here for one consistent fence ledger.
 */
import type { DatabaseSync } from "node:sqlite";
import { Fence } from "../../../agent-fence/dist/index.js";
import type { FenceLogger } from "../../../agent-fence/dist/utils/logger.js";
import { SharedSqliteFenceStorage } from "../db/fenceStore.js";
import type { FenceEvent } from "../types.js";

interface FenceDecision {
  decision: "COMMITTED" | "SUPPRESSED";
  tool: string;
  operationId: string;
}

export interface FenceDispatchResult {
  result: unknown;
  decision: "COMMITTED" | "SUPPRESSED" | "PASSTHROUGH";
  event: FenceEvent | null;
}

export class FenceEnforcer {
  private readonly fence: Fence;
  private readonly runId: string;
  private readonly onEvent: (e: FenceEvent) => void;
  /** The fence logger writes its decision here during dispatch. */
  private captured: FenceDecision | null = null;

  /** Read-and-clear. The declared return type is authoritative at the call
   *  site, sidestepping TS's property-narrowing limitation across the await. */
  private takeCaptured(): FenceDecision | null {
    const c = this.captured;
    this.captured = null;
    return c;
  }

  constructor(opts: {
    db: DatabaseSync;
    runId: string;
    effects: Record<string, "IRREVERSIBLE" | "IDEMPOTENT">;
    onEvent: (e: FenceEvent) => void;
  }) {
    this.runId = opts.runId;
    this.onEvent = opts.onEvent;
    const logger: FenceLogger = {
      committed: (e) => {
        this.captured = { decision: "COMMITTED", tool: e.tool, operationId: e.operationId };
      },
      suppressed: (e) => {
        this.captured = { decision: "SUPPRESSED", tool: e.tool, operationId: e.operationId };
      },
      warn: () => {},
      debug: () => {},
    };
    this.fence = new Fence({
      effects: opts.effects,
      storage: new SharedSqliteFenceStorage(opts.db),
      runId: opts.runId,
      logger,
    });
  }

  /** Run a tool through the fence. IDEMPOTENT tools pass straight through. */
  async dispatch(
    step: number,
    tool: string,
    input: unknown,
    exec: () => unknown | Promise<unknown>
  ): Promise<FenceDispatchResult> {
    // The fence's logger fires synchronously during dispatch and writes into
    // this.captured; read it back through takeCaptured().
    this.captured = null;
    const result = await this.fence.dispatch(tool, input, exec, { runId: this.runId });
    const pending = this.takeCaptured();
    if (!pending) {
      return { result, decision: "PASSTHROUGH", event: null };
    }
    const decision = pending.decision;
    const event: FenceEvent = {
      runId: this.runId,
      step,
      tool: pending.tool,
      decision,
      operationId: pending.operationId,
      ...(decision === "SUPPRESSED" ? { recordedResponse: safeStringify(result) } : {}),
      reason:
        decision === "SUPPRESSED"
          ? "identical irreversible effect already committed — replayed recorded response, side effect did not re-run"
          : "irreversible effect executed once and recorded in the committed-effects log",
    };
    this.onEvent(event);
    return { result, decision, event };
  }

  /** Record an intervention-driven HOLD as a SUPPRESSED fence event. */
  hold(step: number, tool: string, reason: string): FenceEvent {
    const event: FenceEvent = {
      runId: this.runId,
      step,
      tool,
      decision: "SUPPRESSED",
      operationId: `hold:${tool}:${step}`,
      reason,
    };
    this.onEvent(event);
    return event;
  }

  async close(): Promise<void> {
    await this.fence.close();
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v);
  }
}
