/**
 * STAGE 2 — Stream analyzer.
 *
 * Reads EVERY token as it arrives and runs pattern matching in real time over
 * the genuine token stream. Each detected signal carries the exact token index
 * where it fired, so everything downstream (intervention, causal attribution)
 * is anchored to real evidence (Non-Negotiable #2, #8).
 *
 * The detectors are heuristic but operate only on real model output and real
 * tool results — nothing is scripted.
 */
import type { ExtractedIntent, Severity, StreamSignal, StreamSignalType } from "../types.js";

const CERTAINTY = /\b(definitely|certainly|undoubtedly|without a doubt|guarantee[d]?|clearly|obviously|i found|i'?ve found|research shows|studies show|it is well known|the answer is exactly|precisely)\b/i;
const RECHECK = /\b(let me (check|verify|look|try) (again|once more|one more time)|recheck|re-verify|try that again|same thing again)\b/i;
const NUMBERY = /(?<![\w$])(\$?\d[\d,]*(?:\.\d+)?%?)(?![\w])/;
const ASK_BACK = /\b(could you (please )?(provide|clarify|specify|tell me)|what is your|can you clarify|please provide|i need more (info|information)|which (one|account|customer) do you mean)\b/i;
const DRIFT_MARK = /\b(instead,? let me|a related question|on a different note|more generally|as an aside)\b/i;

export interface StreamAnalyzerOptions {
  runId: string;
  intent: ExtractedIntent;
  onSignal: (signal: StreamSignal) => void;
}

interface PriorCall {
  step: number;
  tool: string;
  inputHash: string;
}

export class StreamAnalyzer {
  private readonly runId: string;
  private readonly intent: ExtractedIntent;
  private readonly onSignal: (s: StreamSignal) => void;

  /** Whether any tool has returned usable, non-empty data so far this run. */
  private hasGrounding = false;
  /** Quality (0-100) of the most recent tool result; -1 = none yet. */
  private lastToolQuality = -1;
  private lastToolEmpty = false;
  private priorCalls: PriorCall[] = [];

  // Per-turn state.
  private step = 0;
  private turnBuffer = "";
  private firstTokenIndex = 0;
  private emittedThisTurn = new Set<StreamSignalType>();

  /** Set to the triggering signal when a HIGH-severity abort should happen. */
  abortSignal: StreamSignal | null = null;

  constructor(opts: StreamAnalyzerOptions) {
    this.runId = opts.runId;
    this.intent = opts.intent;
    this.onSignal = opts.onSignal;
  }

  startTurn(step: number, firstTokenIndex: number): void {
    this.step = step;
    this.turnBuffer = "";
    this.firstTokenIndex = firstTokenIndex;
    this.emittedThisTurn.clear();
  }

  /** Called for every single token the model emits. */
  observeToken(text: string, globalIndex: number): void {
    this.turnBuffer += text;
    const buf = this.turnBuffer;

    // HALLUCINATION_FORMING — confident assertions with zero tool grounding.
    // (Bare numbers are only judged on a final answer, in finishTurn, to avoid
    // flagging a step's planning thought that merely mentions a count.)
    if (!this.hasGrounding && !this.emittedThisTurn.has("HALLUCINATION_FORMING")) {
      const m = CERTAINTY.exec(buf);
      if (m) {
        this.emit("HALLUCINATION_FORMING", "HIGH", globalIndex, `confident claim "${snippet(m[0])}" with no grounding tool result yet`, true);
      }
    }

    // SILENT_FAILURE — last tool came back empty/errored but the model is
    // confidently using a value anyway. A bare number inside a tool-call action
    // is an argument, not a claim, so number-detection is gated to non-action
    // turns (certainty language still counts everywhere).
    if (this.lastToolEmpty && !this.emittedThisTurn.has("SILENT_FAILURE")) {
      const isActionTurn = /"action"\s*:\s*"(?!final)/.test(buf);
      if (CERTAINTY.test(buf) || (!isActionTurn && NUMBERY.test(buf))) {
        this.emit("SILENT_FAILURE", "HIGH", globalIndex, `prior tool returned empty/error yet the model states "${snippet(lastMatch(buf))}"`, true);
        // With no grounding at all, asserting a value is also a hallucination
        // forming — the spec panel records both for one incident.
        if (!this.hasGrounding && !this.emittedThisTurn.has("HALLUCINATION_FORMING")) {
          this.emit("HALLUCINATION_FORMING", "HIGH", globalIndex, `ungrounded claim "${snippet(lastMatch(buf))}" after the only tool returned nothing`, false);
        }
      }
    }

    // OVERCONFIDENCE — certainty right after an ambiguous (low-quality) result.
    if (this.lastToolQuality >= 0 && this.lastToolQuality < 40 && !this.lastToolEmpty && !this.emittedThisTurn.has("OVERCONFIDENCE")) {
      if (CERTAINTY.test(buf)) {
        this.emit("OVERCONFIDENCE", "MEDIUM", globalIndex, `definitive language after a low-quality (${this.lastToolQuality}/100) tool result`, false);
      }
    }

    // LOOP_STARTING — explicit "let me check again" style stalling.
    if (!this.emittedThisTurn.has("LOOP_STARTING") && RECHECK.test(buf)) {
      this.emit("LOOP_STARTING", "MEDIUM", globalIndex, `re-check language "${snippet(RECHECK.exec(buf)?.[0] ?? "")}" signals a stalling loop`, false);
    }

    // CONTEXT_COLLAPSE — asking back for something already provided.
    if (!this.emittedThisTurn.has("CONTEXT_COLLAPSE") && ASK_BACK.test(buf)) {
      this.emit("CONTEXT_COLLAPSE", "MEDIUM", globalIndex, `model asks for information already in context: "${snippet(ASK_BACK.exec(buf)?.[0] ?? "")}"`, false);
    }

    // INTENT_DRIFT — explicit pivot away from the question.
    if (!this.emittedThisTurn.has("INTENT_DRIFT") && DRIFT_MARK.test(buf)) {
      this.emit("INTENT_DRIFT", "MEDIUM", globalIndex, `answer pivots away from intent: "${snippet(DRIFT_MARK.exec(buf)?.[0] ?? "")}"`, false);
    }
  }

  /**
   * Called once a turn's full text is known, for checks that need the whole
   * turn (e.g. required-element coverage on a final answer).
   */
  finishTurn(fullText: string, isFinal: boolean): void {
    // A final answer that asserts a specific number with no grounding is a
    // hallucination even if it never used certainty words.
    if (isFinal && !this.hasGrounding && !this.emittedThisTurn.has("HALLUCINATION_FORMING")) {
      const m = NUMBERY.exec(fullText);
      if (m) {
        this.emit(
          "HALLUCINATION_FORMING",
          "HIGH",
          this.firstTokenIndex,
          `final answer states "${snippet(m[0])}" with no grounding tool result in the whole run`,
          false
        );
      }
    }
    if (isFinal && !this.emittedThisTurn.has("INTENT_DRIFT")) {
      const required = this.intent.requiredElements;
      if (required.length >= 3) {
        const lower = fullText.toLowerCase();
        const present = required.filter((e) => lower.includes(e.toLowerCase())).length;
        if (present / required.length < 0.34) {
          this.emit(
            "INTENT_DRIFT",
            "MEDIUM",
            this.firstTokenIndex,
            `final answer covers only ${present}/${required.length} required elements (${required.join(", ")})`,
            false
          );
        }
      }
    }
  }

  /** Feed a tool call so loop detection can compare input hashes across steps. */
  observeToolCall(step: number, tool: string, inputHash: string, tokenIndex: number): void {
    const dup = this.priorCalls.find((c) => c.tool === tool && c.inputHash === inputHash);
    if (dup) {
      const priorSteps = this.priorCalls.filter((c) => c.tool === tool && c.inputHash === inputHash).map((c) => c.step);
      this.emit(
        "LOOP_STARTING",
        "HIGH",
        tokenIndex,
        `tool "${tool}" called with identical input as step(s) ${priorSteps.join(", ")}`,
        true,
        priorSteps
      );
    }
    this.priorCalls.push({ step, tool, inputHash });
  }

  /** Feed a tool result so silent-failure / overconfidence detection has context. */
  observeToolResult(quality: number, empty: boolean, hadData: boolean): void {
    this.lastToolQuality = quality;
    this.lastToolEmpty = empty;
    if (hadData) this.hasGrounding = true;
  }

  private emit(
    type: StreamSignalType,
    severity: Severity,
    tokenIndex: number,
    evidence: string,
    canAbort: boolean,
    priorSteps?: number[]
  ): void {
    this.emittedThisTurn.add(type);
    const signal: StreamSignal = {
      runId: this.runId,
      type,
      tokenIndex,
      detectedAtStep: this.step,
      severity,
      evidence,
      ...(priorSteps ? { priorSteps } : {}),
    };
    if (canAbort && severity === "HIGH") this.abortSignal = signal;
    this.onSignal(signal);
  }
}

function snippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 60);
}

function lastMatch(buf: string): string {
  const c = CERTAINTY.exec(buf);
  if (c) return c[0];
  const n = NUMBERY.exec(buf);
  return n ? n[0] : "a value";
}
