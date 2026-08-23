import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScoreValue, judgeScores, newJudgeDiagnostics, SCORE_STATUS } from "../src/judge.js";

/**
 * The strict score parser.
 *
 * The evaluation this artifact supports was invalidated once by a parser that
 * accepted any finite number and divided it by 100, so a judge answering `0.95`
 * on a 0–1 scale had a confident SAME verdict stored as 0.0095 — a confident
 * DIFF score — for 23.1% of the corpus, while the "judge failed to answer" rate
 * read 0%. These tests pin the contract that replaces it: exactly one accepted
 * form, no silent rescaling, and every rejection counted.
 */

const ok = (raw, expected) => {
  const r = parseScoreValue(raw);
  assert.ok(r.status === SCORE_STATUS.OK || r.status === SCORE_STATUS.OK_PCT_SUFFIX,
    `${JSON.stringify(raw)} should be accepted, got ${r.status}`);
  assert.equal(r.score, expected);
};
const reject = (raw, status) => {
  const r = parseScoreValue(raw);
  assert.equal(r.status, status, `${JSON.stringify(raw)} expected ${status}, got ${r.status}`);
  assert.equal(r.score, null, `${JSON.stringify(raw)} must not yield a score`);
};

test("accepts integer percent as a number", () => {
  ok(95, 0.95);
  ok(0, 0);
  ok(100, 1);
  ok(7, 0.07);
});

test("accepts 95.0 — the same JSON value as 95, not a fraction", () => {
  ok(95.0, 0.95);
  assert.equal(95.0, 95); // the premise: JSON has one number type
});

test("accepts integer percent as a numeric string", () => {
  ok("95", 0.95);
  ok(" 95 ", 0.95);
  ok("95.0", 0.95);
  ok("100", 1);
});

test("accepts an explicit percent suffix, which declares the scale", () => {
  const r = parseScoreValue("95%");
  assert.equal(r.status, SCORE_STATUS.OK_PCT_SUFFIX);
  assert.equal(r.score, 0.95);
});

test("REJECTS 0.95 rather than reinterpreting it — the defect this replaces", () => {
  // On the declared 0–100 scale this is 0.95%; on a 0–1 scale it is 95%.
  // Nothing in the reply distinguishes them, so it is not a score.
  reject(0.95, SCORE_STATUS.NON_INTEGER);
  reject("0.95", SCORE_STATUS.NON_INTEGER);
  reject(0.95, SCORE_STATUS.NON_INTEGER);
  reject(0.0095, SCORE_STATUS.NON_INTEGER);
});

test("REJECTS 0.950 (trailing zeros do not make it an integer)", () => {
  reject(0.950, SCORE_STATUS.NON_INTEGER);
  reject("0.950", SCORE_STATUS.NON_INTEGER);
});

test("rejects non-integer percents", () => {
  reject(95.5, SCORE_STATUS.NON_INTEGER);
  reject("95.5", SCORE_STATUS.NON_INTEGER);
});

test("rejects out-of-range integers instead of clamping", () => {
  // The previous parser clamped 1000 to 100 — a garbage reply became maximal
  // confidence that two actions are the same, which is the suppression side.
  reject(101, SCORE_STATUS.OUT_OF_RANGE);
  reject(1000, SCORE_STATUS.OUT_OF_RANGE);
  reject(-1, SCORE_STATUS.OUT_OF_RANGE);
  reject("-5", SCORE_STATUS.OUT_OF_RANGE);
});

test("rejects invalid and missing values", () => {
  reject("high", SCORE_STATUS.NOT_A_NUMBER);
  reject("", SCORE_STATUS.NOT_A_NUMBER);
  reject("~95", SCORE_STATUS.NOT_A_NUMBER);
  reject("0.95 (same act)", SCORE_STATUS.NOT_A_NUMBER);
  reject({}, SCORE_STATUS.NOT_A_NUMBER);
  reject(true, SCORE_STATUS.NOT_A_NUMBER);
  reject(NaN, SCORE_STATUS.NOT_A_NUMBER);
  reject(Infinity, SCORE_STATUS.NOT_A_NUMBER);
  reject(undefined, SCORE_STATUS.MISSING);
  reject(null, SCORE_STATUS.MISSING);
});

// ─── Batch behaviour: retries, abstention, diagnostics ───────────────────────

/** A fake client returning canned replies, one per call. */
const fakeClient = (replies) => {
  let call = 0;
  return {
    calls: () => call,
    jsonChat: async () => {
      const r = replies[Math.min(call, replies.length - 1)];
      call += 1;
      if (r instanceof Error) throw r;
      return { json: r };
    },
  };
};

const PAIRS = [
  { id: "p0", tool: "charge_card", a: { amount: 1 }, b: { amount: 1 } },
  { id: "p1", tool: "charge_card", a: { amount: 2 }, b: { amount: 3 } },
];

test("a probability-scale batch is retried, not accepted", async () => {
  const client = fakeClient([
    [{ i: 0, p_same_pct: 0.95 }, { i: 1, p_same_pct: 0.02 }], // 0–1 scale: rejected
    [{ i: 0, p_same_pct: 95 }, { i: 1, p_same_pct: 2 }],      // corrected
  ]);
  const diag = newJudgeDiagnostics();
  const scores = await judgeScores(client, PAIRS, { batchSize: 2, diagnostics: diag });
  assert.deepEqual(scores, [0.95, 0.02]);
  assert.equal(client.calls(), 2);
  assert.equal(diag.probabilityScaleBatches, 1);
  assert.equal(diag.batchRetries, 1);
  assert.equal(diag.byStatus[SCORE_STATUS.NON_INTEGER], 2);
  assert.equal(diag.abstentions, 0);
});

test("a judge that never complies yields ABSTENTIONS, not imputed scores", async () => {
  const client = fakeClient([[{ i: 0, p_same_pct: 0.95 }, { i: 1, p_same_pct: 0.02 }]]);
  const diag = newJudgeDiagnostics();
  const scores = await judgeScores(client, PAIRS, { batchSize: 2, diagnostics: diag });
  // null, never 0.5: a defaulted mid-score would enter calibration and move the
  // thresholds while looking like a real judgment.
  assert.deepEqual(scores, [null, null]);
  assert.equal(diag.abstentions, 2);
  assert.equal(client.calls(), 3); // maxAttempts
});

test("a missing pair index is an abstention for that pair only", async () => {
  const client = fakeClient([[{ i: 0, p_same_pct: 95 }]]); // pair 1 never answered
  const diag = newJudgeDiagnostics();
  const scores = await judgeScores(client, PAIRS, { batchSize: 2, diagnostics: diag });
  assert.deepEqual(scores, [0.95, null]);
  assert.equal(diag.abstentions, 1);
  assert.ok(diag.byStatus[SCORE_STATUS.MISSING] >= 1);
});

test("transport failures are counted and retried", async () => {
  const client = fakeClient([
    new Error("HTTP 500"),
    { not: "an array" },
    [{ i: 0, p_same_pct: 10 }, { i: 1, p_same_pct: 20 }],
  ]);
  const diag = newJudgeDiagnostics();
  const scores = await judgeScores(client, PAIRS, { batchSize: 2, diagnostics: diag });
  assert.deepEqual(scores, [0.1, 0.2]);
  assert.equal(diag.transportFailures, 2);
  assert.equal(diag.batchAttempts, 3);
});

test("legacy p_same field is still read, under the same strict rules", async () => {
  const client = fakeClient([[{ i: 0, p_same: 95 }, { i: 1, p_same: 3 }]]);
  const scores = await judgeScores(client, PAIRS, { batchSize: 2 });
  assert.deepEqual(scores, [0.95, 0.03]);
});

test("accepted 0 and 1 are counted as scale-ambiguous exposure", async () => {
  // 0 and 1 are valid percents AND what a probability-scale reply looks like
  // when it is confident. They are accepted (the contract says integers) but
  // counted, so the paper can report how much of the corpus is exposed.
  const client = fakeClient([[{ i: 0, p_same_pct: 1 }, { i: 1, p_same_pct: 0 }]]);
  const diag = newJudgeDiagnostics();
  await judgeScores(client, PAIRS, { batchSize: 2, diagnostics: diag });
  assert.equal(diag.ambiguousAcceptedZeroOne, 2);
});
