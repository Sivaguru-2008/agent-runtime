import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalize, canonicalString, operationId, semanticProjection, sha256 } from "./canonicalize.js";
import { decideOverCandidates, maxSuppressionThreshold } from "./conformal.js";

/**
 * The layered semantic fence — Algorithm 1 of the paper.
 *
 * L0 (canonical core): exact match on the canonical operation id. Provably
 *     safe under A5; zero judge cost.
 * Witness: candidates whose declared effect-determining fields differ from the
 *     dispatch are provably distinct acts (A5′) and are removed BEFORE any
 *     judge is consulted, so no judge output — however manipulated — can
 *     suppress across a declared difference.
 * L1 (calibrated semantic layer): the judge scores the dispatch against every
 *     surviving candidate and the fence thresholds the MAXIMUM. The threshold
 *     is a function of the candidate-set size m (Bonferroni, conformal.js):
 *     thresholding a max of m scores with a pairwise-calibrated threshold does
 *     not control the max, and the error grows with m.
 * L2 (auditable escalation): scores inside the band (t_lo, t_hi] execute but
 *     are durably flagged DUPLICATE_SUSPECT — a duplicate that escapes the
 *     semantic layer is loud, not silent.
 *
 * What the fence does NOT do is close the window between the external effect
 * succeeding and its commit row landing. `windowGuard` makes that window
 * *observable* by comparing a dispatch against PENDING intents with no commit,
 * but it can only ever ESCALATE on a match: a pending intent means the effect
 * may or may not have fired, and suppressing on "may have" is how a legitimate
 * action silently never happens. Closing the window requires the provider's
 * idempotency contract (Theorem T5), not a better local decision.
 *
 * The durable log is a JSON file (research apparatus; the production analogue
 * is agent-fence's SQLite/Postgres stores with a UNIQUE constraint).
 */

class EffectLog {
  constructor(path) {
    this.path = path;
    this.data = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : { committed: {}, intents: [], flags: [] };
  }
  #save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }
  getCommitted(opId) {
    return this.data.committed[opId] ?? null;
  }
  putCommitted(record) {
    if (this.data.committed[record.operationId]) return false; // UNIQUE(operationId)
    this.data.committed[record.operationId] = record;
    this.#save();
    return true;
  }
  listCommitted(runId, tool) {
    return Object.values(this.data.committed).filter((r) => r.runId === runId && r.tool === tool);
  }
  /**
   * Dispatches that recorded an intent to execute and never recorded an
   * outcome: the durable trace of a crash between `exec()` and `putCommitted`.
   * Whether the external effect happened is exactly what is unknown here.
   */
  listPendingOrphans(runId, tool) {
    const settled = new Set(
      this.data.intents.filter((i) => i.status !== "PENDING").map((i) => i.operationId)
    );
    return this.data.intents.filter(
      (i) => i.status === "PENDING" && i.runId === runId && i.tool === tool &&
        !settled.has(i.operationId) && !this.data.committed[i.operationId]
    );
  }
  recordIntent(intent) {
    this.data.intents.push({ ...intent, at: new Date().toISOString() });
    this.#save();
  }
  recordFlag(flag) {
    this.data.flags.push({ ...flag, at: new Date().toISOString() });
    this.#save();
  }
}

export class SemanticFence {
  /**
   * @param {object} opts
   * @param {Record<string, {effect: string, fields: object}>} opts.schemas tool schemas
   * @param {string} opts.runId stable across retries/replays of the logical run
   * @param {string} opts.logPath durable committed-effects log
   * @param {(pairs: Array<{tool,a,b}>) => Promise<Array<number|null>>} opts.scorer
   *   judge; scores in [0,1], or null for an abstention (never suppresses).
   * @param {{distinctScores: number[], alpha: number}} [opts.calibration]
   *   calibration pool + level, from which the threshold for THIS dispatch's
   *   candidate-set size is derived. Preferred over a fixed `tHi`.
   * @param {number} [opts.tHi] fixed suppression threshold. Uncorrected for
   *   candidate-set size — valid only where m ≤ 1 — and used by the ablation
   *   that measures what the correction is worth.
   * @param {number} [opts.tLo] escalation floor
   * @param {boolean} [opts.semantic=true] disable to get the pure L0 (syntactic) fence
   * @param {boolean} [opts.witness=true] distinctness-witness veto
   * @param {(input: object, schema: object) => string} [opts.projection]
   *   the witness projection σ. Defaults to the declared non-text fields
   *   (`semanticProjection`). A deployment that has tightened its schema
   *   supplies a wider projection here; the fence's logic is unchanged, which
   *   is the point — T6 says the residual moves with the declaration, not with
   *   the mechanism, so a schema change must be expressible as a σ swap.
   * @param {boolean} [opts.windowGuard=false] compare against PENDING orphans
   *   and flag (never suppress) a suspected re-fire inside the commit window
   * @param {(e: object) => void} [opts.onEvent]
   * @param {object} [opts.hooks] fault-injection seam used by the crash/replay
   *   experiment: afterL0, afterWitness, afterJudge, beforeExec, duringExec,
   *   afterExec, afterCommit. Each marks a structurally different point at
   *   which a process can die. Nothing in production sets them.
   */
  constructor({
    schemas, runId, logPath, scorer, calibration = null, tHi = Infinity, tLo = 0,
    semantic = true, witness = true, windowGuard = false, onEvent, hooks,
    projection = semanticProjection,
  }) {
    this.hooks = hooks ?? {};
    this.projection = projection;
    this.schemas = schemas;
    this.runId = runId;
    this.log = new EffectLog(logPath);
    this.scorer = scorer;
    this.calibration = calibration;
    this.tHi = tHi;
    this.tLo = tLo;
    this.semantic = semantic;
    this.witness = witness;
    this.windowGuard = windowGuard;
    this.onEvent = onEvent ?? (() => {});
    // Cost accounting for the friction analysis: how much judging a deployment
    // actually pays for, as opposed to how much the design implies.
    this.stats = { dispatches: 0, judgeCalls: 0, comparisons: 0, l0Hits: 0, witnessFiltered: 0 };
  }

  /** The suppression threshold for a candidate set of size m. */
  thresholdFor(m) {
    if (this.calibration) {
      return maxSuppressionThreshold(this.calibration.distinctScores, this.calibration.alpha, m);
    }
    return m > 0 ? this.tHi : Infinity;
  }

  async dispatch(tool, input, exec) {
    const schema = this.schemas[tool];
    if (!schema || schema.effect !== "IRREVERSIBLE") return exec(); // idempotent: pass through
    this.stats.dispatches += 1;

    // ── L0: canonical core ────────────────────────────────────────────────
    const { operationId: opId, inputHash } = operationId(this.runId, tool, input, schema);
    const existing = this.log.getCommitted(opId);
    if (existing && existing.inputHash === inputHash) {
      this.stats.l0Hits += 1;
      this.log.recordIntent({ tool, runId: this.runId, operationId: opId, status: "SUPPRESSED", layer: "L0" });
      this.onEvent({ type: "SUPPRESSED", layer: "L0", tool, operationId: opId, pid: process.pid });
      return existing.response;
    }
    this.hooks.afterL0?.({ tool, operationId: opId });

    const semProj = this.projection(input, schema);

    // ── L1: calibrated semantic layer ────────────────────────────────────
    if (this.semantic) {
      // Distinctness witness (hardening): a committed effect whose canonical
      // SEMANTIC projection differs from this call's is provably a different
      // act under A5′ — excluded from judging entirely, so no judge opinion
      // (or judge-directed injection) can suppress across a declared
      // amount/id/recipient difference. Filtering here also SHRINKS m, which
      // tightens nothing and loosens the multiplicity correction: the witness
      // buys threshold budget as well as adversarial soundness.
      const all = this.log.listCommitted(this.runId, tool);
      const candidates = this.witness ? all.filter((c) => c.semProjection === semProj) : all;
      this.stats.witnessFiltered += all.length - candidates.length;
      this.hooks.afterWitness?.({ tool, operationId: opId, m: candidates.length });

      if (candidates.length > 0) {
        const scores = await this.scorer(candidates.map((c) => ({ tool, a: c.input, b: input })));
        this.stats.judgeCalls += 1;
        this.stats.comparisons += candidates.length;
        this.hooks.afterJudge?.({ tool, operationId: opId, scores });

        const verdict = decideOverCandidates(scores, {
          distinctCalScores: this.calibration?.distinctScores,
          alpha: this.calibration?.alpha,
          tLo: this.tLo,
          tHiOverride: this.calibration ? undefined : this.tHi,
        });

        if (verdict.decision === "SUPPRESS") {
          const winner = candidates[verdict.index];
          this.log.recordIntent({
            tool, runId: this.runId, operationId: opId, status: "SUPPRESSED", layer: "L1",
            matchedOperationId: winner.operationId, score: verdict.score, m: verdict.m, tHi: verdict.tHi,
          });
          this.onEvent({
            type: "SUPPRESSED", layer: "L1", tool, operationId: opId,
            matchedOperationId: winner.operationId, score: verdict.score,
            m: verdict.m, tHi: verdict.tHi, pid: process.pid,
          });
          return winner.response;
        }
        if (verdict.decision === "ESCALATE") {
          // Execute below, but durably flag the suspicion first (L2).
          this.log.recordFlag({
            type: "DUPLICATE_SUSPECT", tool, operationId: opId,
            suspectOperationId: candidates[verdict.index]?.operationId ?? null,
            score: verdict.score, m: verdict.m, tHi: verdict.tHi,
          });
          this.onEvent({
            type: "ESCALATED", tool, operationId: opId,
            suspectOperationId: candidates[verdict.index]?.operationId ?? null,
            score: verdict.score, m: verdict.m, pid: process.pid,
          });
        }
      }

      // ── Window guard: PENDING intents with no outcome ──────────────────
      // A match here means a previous attempt may have fired this effect and
      // died before recording it. The decision is ALWAYS to execute — the
      // effect may never have happened, and suppressing on a maybe is the
      // catastrophic direction — but the re-fire is flagged rather than
      // silent. This detects the window; it does not close it (T5 does).
      if (this.windowGuard) {
        const orphansAll = this.log.listPendingOrphans(this.runId, tool);
        const orphans = this.witness
          ? orphansAll.filter((o) => o.semProjection === semProj)
          : orphansAll;
        if (orphans.length > 0) {
          const scores = await this.scorer(orphans.map((o) => ({ tool, a: o.input, b: input })));
          this.stats.judgeCalls += 1;
          this.stats.comparisons += orphans.length;
          const v = decideOverCandidates(scores, {
            distinctCalScores: this.calibration?.distinctScores,
            alpha: this.calibration?.alpha,
            tLo: this.tLo,
            tHiOverride: this.calibration ? undefined : this.tHi,
          });
          if (v.decision !== "EXECUTE") {
            this.log.recordFlag({
              type: "UNCERTAIN_COMMIT_WINDOW", tool, operationId: opId,
              suspectOperationId: orphans[v.index]?.operationId ?? null, score: v.score,
            });
            this.onEvent({
              type: "WINDOW_SUSPECT", tool, operationId: opId,
              suspectOperationId: orphans[v.index]?.operationId ?? null,
              score: v.score, pid: process.pid,
            });
          }
        }
      }
    }

    // ── Execute as a new effect ───────────────────────────────────────────
    // The intent carries the input and its projection so a LATER process can
    // compare against it semantically. An intent recording only an opaque hash
    // is unreadable to the very mechanism that would use it: after a paraphrase
    // the hash of the retry does not match, which is the whole problem.
    this.log.recordIntent({
      tool, runId: this.runId, operationId: opId, status: "PENDING",
      input, semProjection: semProj,
    });
    this.hooks.beforeExec?.({ tool, operationId: opId });
    const response = await exec({ duringExec: () => this.hooks.duringExec?.({ tool, operationId: opId }) });
    // ── irreducible commit window (Theorem T1, remark) ────────────────────
    // The external effect has happened; the commit row has not been written.
    // A crash here leaves a PENDING intent with no commit — observable, but
    // not preventable locally.
    this.hooks.afterExec?.({ tool, operationId: opId, response });
    const canonical = canonicalize(input, schema);
    const inserted = this.log.putCommitted({
      operationId: opId,
      runId: this.runId,
      tool,
      input,
      canonical: canonicalString(canonical),
      semProjection: semProj,
      inputHash,
      response,
      pid: process.pid,
      committedAt: new Date().toISOString(),
    });
    this.log.recordIntent({ tool, runId: this.runId, operationId: opId, status: inserted ? "COMMITTED" : "COMMIT_CONFLICT" });
    this.onEvent({ type: "COMMITTED", tool, operationId: opId, pid: process.pid });
    this.hooks.afterCommit?.({ tool, operationId: opId, response });
    return response;
  }
}

export { sha256 };
