import { test } from "node:test";
import assert from "node:assert/strict";
import {
  suppressionThreshold, escalationFloor, decide, decideOverCandidates,
  maxSuppressionThreshold, maxCertifiableCandidates, requiredCalibrationSize,
  calibrationMaxima, setConformalThreshold,
} from "../src/conformal.js";

const lcg = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

test("suppressionThreshold returns the ⌈(n+1)(1−α)⌉-th order statistic", () => {
  const cal = Array.from({ length: 99 }, (_, i) => (i + 1) / 100); // 0.01..0.99
  // n=99, α=0.05 → k = ⌈100·0.95⌉ = 95 → t = 95th smallest = 0.95
  assert.equal(suppressionThreshold(cal, 0.05), 0.95);
});

test("suppressionThreshold is +∞ when n is too small to certify α", () => {
  // n=9, α=0.05 → k = ⌈10·0.95⌉ = 10 > 9 → cannot certify
  const cal = Array.from({ length: 9 }, (_, i) => (i + 1) / 10);
  assert.equal(suppressionThreshold(cal, 0.05), Infinity);
});

test("empirical wrong-suppression respects the PAIRWISE bound in simulation", () => {
  const rand = lcg(42);
  const draw = () => Math.pow(rand(), 3); // skewed toward 0, occasional high scores
  const alpha = 0.1;
  let violations = 0, trials = 0;
  for (let rep = 0; rep < 200; rep++) {
    const cal = Array.from({ length: 60 }, draw);
    const t = suppressionThreshold(cal, alpha);
    for (let i = 0; i < 50; i++) {
      trials += 1;
      if (draw() > t) violations += 1;
    }
  }
  assert.ok(violations / trials <= alpha + 0.02, `violation rate ${violations / trials} > α=${alpha}`);
});

// ─── The correction: max over m candidates ───────────────────────────────────

test("the UNCORRECTED pairwise threshold FAILS on the max statistic", () => {
  // The defect the correction exists for. Threshold calibrated pairwise at α,
  // then applied to max over m candidates: the violation rate grows with m and
  // blows through α. If this test ever passes at α, the correction is untested.
  const rand = lcg(7);
  const draw = () => Math.pow(rand(), 3);
  const alpha = 0.05;
  const m = 10;
  let violations = 0, trials = 0;
  for (let rep = 0; rep < 300; rep++) {
    const cal = Array.from({ length: 200 }, draw);
    const t = suppressionThreshold(cal, alpha); // WRONG: no multiplicity correction
    for (let i = 0; i < 20; i++) {
      trials += 1;
      const sStar = Math.max(...Array.from({ length: m }, draw));
      if (sStar > t) violations += 1;
    }
  }
  const rateUncorrected = violations / trials;
  assert.ok(rateUncorrected > alpha * 2,
    `expected the uncorrected rule to badly exceed α; got ${rateUncorrected.toFixed(3)}`);
});

test("the Bonferroni-corrected threshold holds on the max statistic", () => {
  const rand = lcg(7);
  const draw = () => Math.pow(rand(), 3);
  const alpha = 0.05;
  for (const m of [1, 2, 5, 10]) {
    let violations = 0, trials = 0;
    for (let rep = 0; rep < 300; rep++) {
      const cal = Array.from({ length: 400 }, draw);
      const t = maxSuppressionThreshold(cal, alpha, m);
      for (let i = 0; i < 20; i++) {
        trials += 1;
        const sStar = Math.max(...Array.from({ length: m }, draw));
        if (sStar > t) violations += 1;
      }
    }
    const r = violations / trials;
    assert.ok(r <= alpha + 0.02, `m=${m}: violation rate ${r.toFixed(3)} > α=${alpha}`);
  }
});

test("the corrected threshold is monotone in m and +∞ past the budget", () => {
  const cal = Array.from({ length: 200 }, (_, i) => i / 200);
  const alpha = 0.05;
  let prev = -Infinity;
  for (const m of [1, 2, 5, 10]) {
    const t = maxSuppressionThreshold(cal, alpha, m);
    assert.ok(t >= prev, `threshold must not decrease as m grows (m=${m})`);
    prev = t;
  }
  // n=200, α=0.05 → m ≤ ⌊0.05·201⌋ = 10 can be certified; 11 cannot.
  assert.equal(maxCertifiableCandidates(200, 0.05), 10);
  assert.ok(Number.isFinite(maxSuppressionThreshold(cal, 0.05, 10)));
  assert.equal(maxSuppressionThreshold(cal, 0.05, 11), Infinity);
  assert.equal(maxSuppressionThreshold(cal, 0.05, 50), Infinity);
});

test("requiredCalibrationSize inverts maxCertifiableCandidates", () => {
  for (const alpha of [0.01, 0.05, 0.1]) {
    for (const m of [1, 5, 25, 50]) {
      const n = requiredCalibrationSize(m, alpha);
      assert.ok(maxCertifiableCandidates(n, alpha) >= m, `n=${n} should certify m=${m} at α=${alpha}`);
    }
  }
});

test("m = 0 never suppresses", () => {
  assert.equal(maxSuppressionThreshold([0.1, 0.2, 0.3], 0.5, 0), Infinity);
  const r = decideOverCandidates([], { distinctCalScores: [0.1], alpha: 0.5, tLo: 0 });
  assert.equal(r.decision, "EXECUTE");
  assert.equal(r.m, 0);
});

test("insufficient calibration data disables semantic suppression", () => {
  const tiny = [0.1, 0.2, 0.3]; // n=3 cannot certify α=0.05 even at m=1
  assert.equal(maxSuppressionThreshold(tiny, 0.05, 1), Infinity);
  const r = decideOverCandidates([0.99], { distinctCalScores: tiny, alpha: 0.05, tLo: 0.5 });
  assert.equal(r.decision, "ESCALATE", "must escalate, never suppress, when α cannot be certified");
});

// ─── Direct set-conformal comparison ─────────────────────────────────────────

test("calibrationMaxima partitions disjointly into ⌊n/m⌋ units", () => {
  const cal = Array.from({ length: 100 }, (_, i) => i / 100);
  assert.equal(calibrationMaxima(cal, 5).length, 20);
  assert.equal(calibrationMaxima(cal, 7).length, 14);
  assert.equal(calibrationMaxima(cal, 200).length, 0); // pool too small for one unit
});

test("direct set-conformal also holds, and is no more conservative", () => {
  const rand = lcg(11);
  const draw = () => Math.pow(rand(), 3);
  const alpha = 0.05, m = 5;
  let violations = 0, trials = 0;
  let tightening = 0, reps = 0;
  for (let rep = 0; rep < 300; rep++) {
    const cal = Array.from({ length: 400 }, draw);
    const tSet = setConformalThreshold(cal, alpha, m, rep + 1);
    const tBonf = maxSuppressionThreshold(cal, alpha, m);
    if (Number.isFinite(tSet) && Number.isFinite(tBonf)) { tightening += tBonf - tSet; reps += 1; }
    for (let i = 0; i < 20; i++) {
      trials += 1;
      if (Math.max(...Array.from({ length: m }, draw)) > tSet) violations += 1;
    }
  }
  assert.ok(violations / trials <= alpha + 0.02, `set-conformal violated α: ${violations / trials}`);
  assert.ok(tightening / reps >= 0, "Bonferroni should sit at or above the direct threshold on average");
});

// ─── Decision rule ───────────────────────────────────────────────────────────

test("decide implements the three-way band", () => {
  assert.equal(decide(0.99, 0.9, 0.4), "SUPPRESS");
  assert.equal(decide(0.7, 0.9, 0.4), "ESCALATE");
  assert.equal(decide(0.1, 0.9, 0.4), "EXECUTE");
  // Ties are conservative: score == tHi does NOT suppress.
  assert.equal(decide(0.9, 0.9, 0.4), "ESCALATE");
});

test("decideOverCandidates takes the max and reports which candidate won", () => {
  const r = decideOverCandidates([0.2, 0.97, 0.5], { tHiOverride: 0.9, tLo: 0.3 });
  assert.equal(r.decision, "SUPPRESS");
  assert.equal(r.index, 1);
  assert.equal(r.score, 0.97);
  assert.equal(r.m, 3);
});

test("abstentions are dropped from the max, never imputed", () => {
  const r = decideOverCandidates([null, 0.95, null], { tHiOverride: 0.9, tLo: 0.3 });
  assert.equal(r.decision, "SUPPRESS");
  assert.equal(r.index, 1);
  // All-abstain is suspected-but-unjudgeable: execute AND flag, never silently.
  const all = decideOverCandidates([null, null], { tHiOverride: 0.9, tLo: 0.3 });
  assert.equal(all.decision, "ESCALATE");
  assert.equal(all.score, null);
});

test("escalationFloor bounds unflagged escapes on same-pair scores", () => {
  const same = Array.from({ length: 49 }, (_, i) => 0.5 + (i + 1) / 100); // 0.51..0.99
  // n=49, γ=0.1 → k=⌊50·0.1⌋=5 → floor = 5th smallest = 0.55
  assert.equal(escalationFloor(same, 0.1), 0.55);
});

test("t_lo needs no multiplicity correction: the max only helps a true duplicate", () => {
  // A true duplicate's candidate set contains its match, so S* ≥ s_match and the
  // unflagged-escape rate can only fall as m grows.
  const rand = lcg(3);
  const gamma = 0.1;
  const same = Array.from({ length: 200 }, () => 1 - Math.pow(rand(), 2));
  const tLo = escalationFloor(same, gamma);
  for (const m of [1, 5, 20]) {
    let below = 0;
    const T = 2000;
    for (let i = 0; i < T; i++) {
      const match = 1 - Math.pow(rand(), 2);
      const others = Array.from({ length: m - 1 }, () => Math.pow(rand(), 3));
      if (Math.max(match, ...others, -1) <= tLo) below += 1;
    }
    assert.ok(below / T <= gamma + 0.03, `m=${m}: unflagged escape ${below / T} > γ`);
  }
});
