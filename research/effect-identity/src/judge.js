import { canonicalize, canonicalString } from "./canonicalize.js";

/**
 * The semantic equivalence judge (L1's scorer) plus a deterministic offline
 * scorer used for tests and the no-network crash/replay demo.
 *
 * The judge returns, per pair, a score s ∈ [0,1]: the judged probability that
 * the two tool calls denote the SAME single intended real-world action (so
 * executing both would be a duplicate), as opposed to two distinct intended
 * actions. The score is a raw signal with unknown error; the calibration layer
 * (conformal.js) is what turns it into a bounded decision rule.
 */

/**
 * Stable column key for a judge model, used in scores.jsonl and in the results
 * tables. Model ids contain `/`, `.` and `-`, none of which survive as clean
 * identifiers.
 */
export const judgeKey = (model) => model.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

export const JUDGE_SYSTEM = `You are an effect-identity judge inside an agent runtime.
You are shown pairs of tool calls (same tool). For each pair decide: do call A and call B denote the SAME single intended real-world action — such that executing both would cause a duplicate effect (double charge, duplicate email, duplicate transfer)? Or are they TWO DISTINCT intended actions that should both execute?

Rules:
- Formatting, key order, whitespace, case of codes, number formats, spelled-out numbers, abbreviations, aliases, and paraphrased free text do NOT make actions different.
- Different amounts, different recipients/accounts/ids, different referenced orders/invoices, or explicit distinguishing tokens ("installment 1 of 2" vs "2 of 2") DO make actions different.
- A retried action after a crash is the same action even if reworded.
Output STRICT JSON only: an array with one object per pair, in order:
[{"i": <pair index>, "p_same_pct": <integer 0-100>}]
p_same_pct is your probability that the pair is the same single action, expressed as a WHOLE-NUMBER PERCENTAGE.
It MUST be an integer between 0 and 100 inclusive. Write 95 for "95% likely the same action".
Do NOT write a decimal fraction: 0.95 is NOT accepted and will be rejected as invalid.`;

function pairPrompt(pairs, { corrective = null } = {}) {
  const lines = ["Judge the following tool-call pairs.\n"];
  pairs.forEach((p, idx) => {
    lines.push(`### Pair ${idx}`);
    lines.push(`tool: ${p.tool}`);
    lines.push(`A: ${JSON.stringify(p.a)}`);
    lines.push(`B: ${JSON.stringify(p.b)}`);
    lines.push("");
  });
  if (corrective) lines.push(corrective);
  lines.push(`Return the JSON array now (${pairs.length} entries, field "p_same_pct", integer 0-100).`);
  return lines.join("\n");
}

// ─── Strict score parsing ────────────────────────────────────────────────────

/**
 * Outcome codes for one declared score. Every reply is classified into exactly
 * one of these and the counts are persisted, because the failure this replaces
 * was invisible precisely as a *count*: the previous parser accepted any finite
 * number and divided by 100, so a judge answering `0.95` (a probability) rather
 * than the instructed `95` (a percent) had a confident SAME verdict recorded as
 * a confident DIFF score — 23.1% of the corpus — while the "failed to answer"
 * rate read 0%. A parser that cannot tell a scale error from an answer cannot
 * report that it is broken.
 */
export const SCORE_STATUS = Object.freeze({
  OK: "ok",                       // integer percent, in range
  OK_PCT_SUFFIX: "ok_pct_suffix", // "95%" — scale declared explicitly by the model
  MISSING: "missing",             // no entry for this pair index
  NOT_A_NUMBER: "not_a_number",   // null, object, empty, "high", NaN
  NON_INTEGER: "non_integer",     // 0.95, 0.950, "0.95", 95.5 — scale is ambiguous
  OUT_OF_RANGE: "out_of_range",   // -1, 101, 1000
});

/**
 * Parse one declared `p_same_pct` value under the strict contract.
 *
 * ACCEPTED (unambiguous): an integer 0–100, as a JSON number (95, 95.0 — the
 * same value in JSON) or as a numeric string ("95", "95.0"), optionally with an
 * explicit percent sign ("95%").
 *
 * REJECTED: everything else, and in particular any non-integer. `0.95` is NOT
 * reinterpreted as 95: on a 0–100 scale it means 0.95%, on a 0–1 scale it means
 * 95%, and nothing in the reply distinguishes them. Guessing is how the defect
 * of §6.2 happened; rejecting is the fix. Rejected values are retried and, if
 * the judge persists, recorded as an abstention (score `null`) — never as a
 * number, and never rescaled.
 *
 * @returns {{status: string, score: number|null, raw: unknown}} score in [0,1]
 */
export function parseScoreValue(raw) {
  const out = (status, score = null) => ({ status, score, raw });
  if (raw === undefined || raw === null) return out(SCORE_STATUS.MISSING);

  let value = raw;
  let pctSuffix = false;
  if (typeof value === "string") {
    let s = value.trim();
    if (s.length === 0) return out(SCORE_STATUS.NOT_A_NUMBER);
    if (s.endsWith("%")) { pctSuffix = true; s = s.slice(0, -1).trim(); }
    // Only a bare numeric literal is a number; "high", "0.95 (same)", "~95" are not.
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return out(SCORE_STATUS.NOT_A_NUMBER);
    value = Number(s);
  }
  if (typeof value === "boolean" || typeof value !== "number" || !Number.isFinite(value)) {
    return out(SCORE_STATUS.NOT_A_NUMBER);
  }
  if (!Number.isInteger(value)) return out(SCORE_STATUS.NON_INTEGER);
  if (value < 0 || value > 100) return out(SCORE_STATUS.OUT_OF_RANGE);
  return out(pctSuffix ? SCORE_STATUS.OK_PCT_SUFFIX : SCORE_STATUS.OK, value / 100);
}

const ACCEPTED = new Set([SCORE_STATUS.OK, SCORE_STATUS.OK_PCT_SUFFIX]);

/**
 * Does this rejected value look like the judge answering on a 0–1 probability
 * scale? A non-integer inside [0,1] is the signature of exactly the defect the
 * strict parser exists to catch, so a batch containing one is retried with an
 * explicit correction rather than merely re-asked.
 */
const looksLikeProbabilityScale = (parsed) =>
  parsed.status === SCORE_STATUS.NON_INTEGER &&
  typeof parsed.raw !== "object" &&
  Number(parsed.raw) >= 0 && Number(parsed.raw) <= 1;

/** A fresh diagnostics accumulator; pass one into judgeScores to collect counts. */
export function newJudgeDiagnostics() {
  return {
    batches: 0,
    batchAttempts: 0,          // total model calls including retries
    batchRetries: 0,           // calls that were retries of a rejected/failed batch
    transportFailures: 0,      // exception or unparseable JSON envelope
    batchesWithViolations: 0,
    probabilityScaleBatches: 0,
    pairsScored: 0,
    abstentions: 0,            // pairs left unscored after all attempts
    byStatus: Object.fromEntries(Object.values(SCORE_STATUS).map((s) => [s, 0])),
    ambiguousAcceptedZeroOne: 0, // accepted 0 or 1: valid percents, but also what
                                 // a probability-scale reply looks like
    samples: [],               // up to 20 rejected raw values, for the audit trail
  };
}

/**
 * Score a batch of pairs with the LLM judge. Batches of `batchSize` pairs per
 * call keep call volume within rate limits; temperature 0 for determinism.
 *
 * Returns an array aligned with `pairs` whose entries are scores in [0,1] or
 * `null` for an ABSTENTION — a pair the judge never returned an admissible
 * value for. `null` is deliberately not 0.5: a defaulted mid-score enters the
 * calibration sample and moves the thresholds, and a fabricated "maximally
 * uncertain" reading of a judge that did not answer is exactly the kind of
 * quiet imputation this harness is being repaired for. Callers must handle
 * `null` explicitly (the fence never suppresses on one; calibration drops it).
 */
export async function judgeScores(client, pairs, { batchSize = 6, onProgress, diagnostics, maxAttempts = 3 } = {}) {
  const diag = diagnostics ?? newJudgeDiagnostics();
  const scores = new Array(pairs.length).fill(null);

  for (let start = 0; start < pairs.length; start += batchSize) {
    const batch = pairs.slice(start, start + batchSize);
    diag.batches += 1;
    let corrective = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      diag.batchAttempts += 1;
      if (attempt > 1) diag.batchRetries += 1;
      let json = null;
      try {
        ({ json } = await client.jsonChat({
          system: JUDGE_SYSTEM,
          prompt: pairPrompt(batch, { corrective }),
          temperature: 0,
          maxTokens: 40 * batch.length + 200,
        }));
      } catch {
        diag.transportFailures += 1;
        corrective = "Your previous reply was not valid JSON. Reply with the JSON array and nothing else.";
        continue;
      }
      if (!Array.isArray(json)) {
        diag.transportFailures += 1;
        corrective = "Your previous reply was not a JSON ARRAY. Reply with the array and nothing else.";
        continue;
      }

      // Index the reply, then classify every pair the batch asked about — a
      // missing index is an outcome, not an absence.
      const byIndex = new Map();
      for (const entry of json) {
        const i = Number(entry?.i);
        if (Number.isInteger(i) && i >= 0 && i < batch.length && !byIndex.has(i)) {
          byIndex.set(i, entry?.p_same_pct !== undefined ? entry.p_same_pct : entry?.p_same);
        }
      }
      let violations = 0, probScale = false;
      for (let j = 0; j < batch.length; j++) {
        if (scores[start + j] !== null) continue; // already settled by an earlier attempt
        const parsed = parseScoreValue(byIndex.has(j) ? byIndex.get(j) : undefined);
        if (ACCEPTED.has(parsed.status)) {
          diag.byStatus[parsed.status] += 1;
          if (parsed.score === 0 || parsed.score === 0.01) diag.ambiguousAcceptedZeroOne += 1;
          scores[start + j] = parsed.score;
          continue;
        }
        violations += 1;
        diag.byStatus[parsed.status] += 1;
        if (looksLikeProbabilityScale(parsed)) probScale = true;
        if (diag.samples.length < 20) {
          diag.samples.push({ pairId: batch[j].id ?? `${start + j}`, status: parsed.status, raw: parsed.raw, attempt });
        }
      }
      if (violations > 0) {
        if (attempt === 1) diag.batchesWithViolations += 1;
        if (probScale) {
          if (attempt === 1) diag.probabilityScaleBatches += 1;
          corrective =
            "Your previous reply used a 0-1 probability scale (e.g. 0.95). That is INVALID. " +
            "Use a WHOLE-NUMBER PERCENTAGE: write 95, not 0.95. Re-answer every pair.";
        } else {
          corrective = "Some values were not integers between 0 and 100. Re-answer every pair with integers 0-100.";
        }
        continue;
      }
      break; // batch fully settled
    }

    for (let j = 0; j < batch.length; j++) if (scores[start + j] === null) diag.abstentions += 1;
    diag.pairsScored += batch.filter((_, j) => scores[start + j] !== null).length;
    onProgress?.(Math.min(start + batch.length, pairs.length), pairs.length);
  }
  return scores;
}

// ─── Deterministic offline scorer ────────────────────────────────────────────

const numberWords = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000,
};

/** Extract the set of numeric magnitudes mentioned in a string ("$1,200.50", "one hundred twenty"). */
export function extractNumbers(text) {
  const out = new Set();
  const s = String(text).toLowerCase();
  for (const m of s.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    out.add(Number(m[0].replace(/,/g, "")));
  }
  // Spelled-out numbers: greedy left-to-right accumulation.
  const words = s.replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  let acc = 0, cur = 0, seen = false;
  for (const w of words) {
    // "and" is a connector INSIDE an English number phrase, not a terminator:
    // "seven hundred and eighty" is 780, not 700 and 80. Flushing here would
    // make the amount look like two numbers, which reads as a changed act —
    // silently rejecting valid paraphrases and breaking numeric agreement.
    if (w === "and" && seen) continue;
    const v = numberWords[w];
    if (v === undefined) {
      if (seen) { out.add(acc + cur); acc = 0; cur = 0; seen = false; }
      continue;
    }
    seen = true;
    if (v === 100) cur = Math.max(1, cur) * 100;
    else if (v >= 1000) { acc += Math.max(1, cur) * v; cur = 0; }
    else cur += v;
  }
  if (seen) out.add(acc + cur);
  out.delete(0);
  return out;
}

const tokenize = (s) => String(s).toLowerCase().normalize("NFC").split(/[^a-z0-9]+/).filter(Boolean);

// Tokens that carry no act-distinguishing content in a numeric expression:
// number words plus currency/unit filler ("$780.00" ≡ "seven hundred eighty dollars").
const NUMERIC_FILLER = new Set([
  ...Object.keys(numberWords),
  "dollars", "dollar", "usd", "us", "cents", "cent", "and",
]);
const nonNumericResidue = (tokens) => tokens.filter((t) => !NUMERIC_FILLER.has(t) && !/^\d+$/.test(t));

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens), b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Offline lexical-numeric scorer: a deterministic stand-in for the LLM judge.
 * Semantic fields (num/id/ci policies) must agree after canonicalization or
 * the score collapses toward 0; free-text fields contribute a token-Jaccard
 * similarity, with mismatched numeric mentions inside text pulling the score
 * down hard (a different order number is a different act).
 */
export function lexicalScore(tool, a, b, schema) {
  const ca = canonicalize(a, schema);
  const cb = canonicalize(b, schema);
  if (canonicalString(ca) === canonicalString(cb)) return 1;

  const fields = schema?.fields ?? {};
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  let textSim = 1;
  let textFields = 0;
  for (const k of keys) {
    const policy = fields[k] ?? "text";
    const va = ca[k], vb = cb[k];
    if (policy === "num" || policy === "id" || policy === "ci") {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return 0.02; // semantic field mismatch → distinct act
      continue;
    }
    // text field
    if (va === vb) continue;
    textFields += 1;
    const na = extractNumbers(va ?? ""), nb = extractNumbers(vb ?? "");
    const numsAgree = na.size > 0 && nb.size === na.size && [...na].every((n) => nb.has(n));
    const numsDisagree =
      (na.size > 0 || nb.size > 0) &&
      (na.size !== nb.size || [...na].some((n) => !nb.has(n)));
    const ta = tokenize(va ?? ""), tb = tokenize(vb ?? "");
    const sim = jaccard(ta, tb);
    // Agreeing numeric mentions (amounts, order/invoice numbers) are strong
    // same-act evidence even under total lexical rewrite ("$780" vs "seven
    // hundred eighty dollars"); disagreeing ones are strong distinct-act
    // evidence (a different order number is a different act). A field that is
    // PURELY a numeric expression (no residue beyond number words/currency
    // filler) is identity-equivalent when its numbers agree.
    const pureNumeric = numsAgree && nonNumericResidue(ta).length === 0 && nonNumericResidue(tb).length === 0;
    const fieldScore = numsDisagree ? 0.25 * sim
      : pureNumeric ? 0.98
      : numsAgree ? 0.75 + 0.2 * sim
      : 0.35 + 0.6 * sim;
    textSim = Math.min(textSim, fieldScore);
  }
  if (textFields === 0) return 1; // only null-vs-absent style differences
  return Math.max(0, Math.min(1, textSim));
}

/** Batch interface matching judgeScores, for offline runs. */
export async function lexicalScores(pairs, schemas) {
  return pairs.map((p) => lexicalScore(p.tool, p.a, p.b, schemas[p.tool]));
}
