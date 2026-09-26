#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPair, calibrate, decidePair, jurisdictionFilter, DEFAULT_CONFIG } from "../evaluate.js";
import { maxSuppressionThreshold, maxCertifiableCandidates } from "../conformal.js";
import { assessJudge } from "../judgeAdmission.js";
import { TOOLS } from "../tools.js";
import { TOOLS_V2, MISDECLARED_SCHEMA } from "../toolsV2.js";
import { LEVEL_SCHEMAS } from "../corpus/schemaLevels.js";

/**
 * The assertions from repro.config.json, enforced.
 *
 * These are not unit tests — the unit suite checks that the components behave —
 * but integrity checks over the DATA AS SHIPPED. Each one corresponds to a way
 * an evaluation of this shape can be quietly wrong: a leaked split, an imputed
 * abstention, a clamped score, a judge admitted on coverage alone, a pool drawn
 * from the wrong population. Every one of them would leave the reported numbers
 * looking entirely normal.
 *
 * Exit status is non-zero on any failure, so this belongs in the build.
 *
 *   node src/experiments/verify.js
 */

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = JSON.parse(readFileSync(resolve(base, "repro.config.json"), "utf8"));
const readJsonl = (f) => (existsSync(resolve(base, f))
  ? readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : null);

/** How many annotator response files actually exist on disk. */
function countResponses() {
  try { return readdirSync(resolve(base, "annotation")).filter((f) => /^responses-.+\.csv$/i.test(f)).length; }
  catch { return 0; }
}

const failures = [];
const notes = [];
const assert = (ok, name, detail) => { if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`); return ok; };
const skip = (name, why) => notes.push(`SKIP ${name} — ${why}`);

const SCHEMAS = { ...TOOLS, ...TOOLS_V2, ...LEVEL_SCHEMAS, pay_by_account_no: MISDECLARED_SCHEMA };

for (const [corpusName, spec] of Object.entries(cfg.corpora)) {
  const pairs = readJsonl(spec.file);
  if (!pairs) { skip(`corpus ${corpusName}`, `${spec.file} not present`); continue; }
  const scores = readJsonl(spec.scores);
  const scoreById = new Map((scores ?? []).map((r) => [r.id, r]));

  // ── labels ────────────────────────────────────────────────────────────────
  const badLabels = pairs.filter((p) => p.label !== "SAME" && p.label !== "DIFF");
  assert(badLabels.length === 0, `[${corpusName}] labels are exactly SAME or DIFF`, `${badLabels.length} malformed`);

  const dupIds = pairs.length - new Set(pairs.map((p) => p.id)).size;
  assert(dupIds === 0, `[${corpusName}] pair ids are unique`, `${dupIds} duplicates`);

  // ── splits ────────────────────────────────────────────────────────────────
  const cal = pairs.filter((p) => p.split === "cal");
  const test = pairs.filter((p) => p.split === "test");
  const calIds = new Set(cal.map((p) => p.id));
  const leaked = test.filter((p) => calIds.has(p.id));
  assert(leaked.length === 0, `[${corpusName}] calibration and test share no pair id`, `${leaked.length} leaked`);

  const attackInCal = pairs.filter((p) => p.split === "cal" && String(p.category).match(/^(D4|A\d)/));
  assert(attackInCal.length === 0, `[${corpusName}] attack pairs never enter calibration`, `${attackInCal.length} found`);

  if (spec.nPairs !== undefined) {
    assert(pairs.length === spec.nPairs, `[${corpusName}] pair count matches the frozen record`, `config says ${spec.nPairs}, file has ${pairs.length}`);
  }

  if (!scores) { skip(`corpus ${corpusName} score checks`, `${spec.scores} not present`); continue; }

  // ── scores ────────────────────────────────────────────────────────────────
  const judges = [...new Set(scores.flatMap((r) => Object.keys(r.judges ?? {})))];
  for (const j of judges) {
    const vals = pairs.map((p) => scoreById.get(p.id)?.judges?.[j] ?? null);
    const invalid = vals.filter((v) => v !== null && (typeof v !== "number" || !(v >= 0 && v <= 1)));
    assert(invalid.length === 0, `[${corpusName}/${j}] every score is null or in [0,1]`, `${invalid.length} invalid`);

    // A score that is not a multiple of 0.01 cannot have come from an integer
    // percent, which is the only accepted form. Its presence means something
    // rescaled or imputed a value on the way in.
    const nonPercent = vals.filter((v) => v !== null && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9);
    assert(nonPercent.length === 0, `[${corpusName}/${j}] no score was rescaled or imputed`, `${nonPercent.length} non-integer-percent scores`);

    // 0.5 exactly is the value a harness reaches for when it imputes "maximally
    // uncertain" for a judge that did not answer. It is a legal score, so this
    // is a warning rather than a failure — but a suspicious mass at exactly 0.5
    // is worth surfacing.
    const halves = vals.filter((v) => v === 0.5).length;
    if (halves > 0.1 * vals.length) notes.push(`WARN [${corpusName}/${j}] ${halves}/${vals.length} scores are exactly 0.5 — check that abstentions are not being imputed`);
  }

  // ── admission, pools, decisions ───────────────────────────────────────────
  for (const p of pairs) p.facts = classifyPair(p, SCHEMAS, "declared");
  const alpha = cfg.calibration.alphaPrimary;

  for (const j of judges) {
    const scoreOf = (p) => { const v = scoreById.get(p.id)?.judges?.[j]; return v === undefined ? null : v; };
    const admission = assessJudge({ scores: pairs.map(scoreOf), labels: pairs.map((p) => p.label) });
    if (!admission.admitted) { notes.push(`INFO [${corpusName}/${j}] not admitted (${admission.reasons[0]}) — rates for it must not be reported`); continue; }

    const calib = calibrate(cal, scoreOf, DEFAULT_CONFIG, alpha, cfg.calibration.gamma, { m: 1 });

    // The pool must be drawn from this configuration's own jurisdiction.
    const inJur = jurisdictionFilter(DEFAULT_CONFIG);
    const poolPairs = cal.filter((p) => inJur(p.facts) && p.label === "DIFF" && scoreOf(p) !== null);
    assert(poolPairs.length === calib.nCalDiff,
      `[${corpusName}/${j}] calibration pool is drawn from the configuration's own jurisdiction`,
      `jurisdiction gives ${poolPairs.length}, calibrate() reported ${calib.nCalDiff}`);
    const outsideJur = poolPairs.filter((p) => !p.facts.residual);
    assert(outsideJur.length === 0,
      `[${corpusName}/${j}] the hardened pool contains only residual pairs`,
      `${outsideJur.length} pool pairs would have been settled by a decidable layer`);

    // An abstention must never reach the SEMANTIC layer as a suppression.
    //
    // This assertion previously read "no abstention results in a SUPPRESS
    // decision", which is too strong and was never exercised: both GPT-OSS
    // judges abstain on zero pairs, and the only judges that did abstain were
    // excluded on coverage before the loop reached here. Raising Qwen to full
    // coverage ran it for the first time and it failed, on 13 pairs — all of
    // them `by: "certifier"`, all SAME, all S1_mechanical. Those are L0
    // certifications: decidable, taken before the score is consulted, and
    // correct precisely BECAUSE they do not depend on the judge having answered.
    // Forbidding them would forbid the canonical core from working whenever the
    // oracle happens to be down, which is the opposite of the design.
    //
    // What §7.2 actually promises is that an abstention is never treated as
    // evidence of sameness — i.e. it never reaches `decide()`. That is what is
    // checked now, and it is checked more tightly than before: not just that no
    // judge-driven suppression occurs, but that no abstention is settled by the
    // judge at all, in either direction.
    const abstained = pairs.filter((p) => scoreOf(p) === null);
    const abstentionsByJudge = abstained.filter((p) => decidePair(p, scoreOf, DEFAULT_CONFIG, calib).by === "judge");
    assert(abstentionsByJudge.length === 0,
      `[${corpusName}/${j}] no abstention is settled by the judge`,
      `${abstentionsByJudge.length} of ${abstained.length} abstentions reached the semantic layer`);

    const suppressedAbstentions = abstained.filter((p) => {
      const d = decidePair(p, scoreOf, DEFAULT_CONFIG, calib);
      return d.decision === "SUPPRESS" && d.by !== "certifier";
    });
    assert(suppressedAbstentions.length === 0,
      `[${corpusName}/${j}] no abstention is suppressed by anything but the decidable certifier`,
      `${suppressedAbstentions.length} did`);

    // Multiplicity capacity: past the budget the threshold must be +Infinity.
    const budget = maxCertifiableCandidates(calib.nCalDiff, alpha);
    const beyond = maxSuppressionThreshold(poolPairs.map(scoreOf), alpha, budget + 1);
    assert(beyond === Infinity,
      `[${corpusName}/${j}] beyond the certified capacity the threshold is +Infinity`,
      `budget m<=${budget}; t_hi(${budget + 1}) = ${beyond}`);
  }
}

// ── the annotation study must not claim more than it collected ────────────────
// The original assertion here only stopped the file claiming COMPLETE with zero
// responses on disk. That is necessary and much too weak: it would also pass a
// study run on one annotator, on a sheet that had drifted since it was judged,
// or on a MODEL panel while the manuscript called it a human study. Each clause
// below corresponds to one of those, and the last is the one that matters most
// — Channel M is a weaker control than Channel H and the paper must not be able
// to silently promote one to the other.
{
  const p = resolve(base, "results", "human_annotation.json");
  if (existsSync(p)) {
    const ha = JSON.parse(readFileSync(p, "utf8"));
    const responses = countResponses();
    assert(!(ha.status === "COMPLETE" && responses === 0),
      "annotation does not claim COMPLETE while no responses exist",
      `status=${ha.status}, responses=${responses}`);

    if (ha.status === "COMPLETE") {
      assert(Array.isArray(ha.annotators) && ha.annotators.length >= 3,
        "annotation has at least 3 admitted annotators",
        `${ha.annotators?.length ?? 0} admitted`);
      assert(ha.freeze?.ok === true,
        "annotation was collected against a verified frozen sheet",
        `freeze.ok=${ha.freeze?.ok}`);
      assert(ha.channel === "H" || ha.channel === "M" || ha.channel === "H+M",
        "annotation declares its collection channel", `channel=${ha.channel}`);
      assert(ha.catchTrials?.declared?.length >= 3,
        "annotation ran at least 3 catch trials", `${ha.catchTrials?.declared?.length ?? 0} declared`);
      assert(Object.values(ha.catchTrials?.audit ?? {}).every((a) => a.passed),
        "every ADMITTED annotator passed every catch trial");

      // The manuscript must describe the study by the channel that produced it.
      // Checked for the long-form Markdown and for the AIJ submission sources
      // (manuscript, every included section, supplement).
      const docs = resolve(base, "..", "..", "docs", "research");
      const aij = resolve(docs, "aij");
      const manuscripts = [["long-form manuscript", [resolve(docs, "Semantic-Effect-Identity-Paper.md")]]];
      if (existsSync(resolve(aij, "manuscript.tex"))) {
        const sec = existsSync(resolve(aij, "sections")) ? readdirSync(resolve(aij, "sections")).filter((f) => f.endsWith(".tex")).map((f) => resolve(aij, "sections", f)) : [];
        // Recursive: supplement/tables/ holds the generated data tables.
        const walkTex = (dir) => (existsSync(dir)
          ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
            (e.isDirectory() ? walkTex(resolve(dir, e.name)) : e.name.endsWith(".tex") ? [resolve(dir, e.name)] : []))
          : []);
        const supp = walkTex(resolve(aij, "supplement"));
        manuscripts.push(["AIJ manuscript + supplement", [resolve(aij, "manuscript.tex"), resolve(aij, "supplement.tex"), ...sec, ...supp]]);
      }
      for (const [label, files] of manuscripts) {
        const present = files.filter((f) => existsSync(f));
        if (!present.length) continue;
        const text = present.map((f) => readFileSync(f, "utf8")).join("\n");
        if (ha.channel === "M") {
          assert(/model panel/i.test(text),
            `${label} names the model panel as a model panel (channel M)`);
          assert(!/\bhuman (annotation|labelling|validation) study (is )?(complete|completed|run)\b/i.test(text),
            `${label} does not describe the model panel as a completed human study`);
          assert(!/\b(human[- ]validated|validated by (independent )?humans?)\b/i.test(text),
            `${label} does not call the labels human-validated`);
        }
      }
      notes.push(`INFO annotation COMPLETE on channel ${ha.channel} with ${ha.annotators.length} annotators` +
        (ha.catchTrials?.droppedAnnotators?.length ? `, ${ha.catchTrials.droppedAnnotators.length} dropped on catch trials` : ""));
    } else {
      notes.push(`INFO annotation is ${ha.status} — no number from it may appear in the manuscript`);
    }
  } else {
    skip("annotation", "results/human_annotation.json not present");
  }
}


// ── report ────────────────────────────────────────────────────────────────────
for (const n of notes) console.log(n);
if (failures.length === 0) {
  console.log(`\nOK — every assertion in repro.config.json holds (${cfg.assertions.list.length} assertion classes).`);
} else {
  console.error(`\n${failures.length} ASSERTION FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
}
