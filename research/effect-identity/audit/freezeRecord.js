/**
 * Phase 0 — freeze the current scientific record.
 *
 * Dumps, mechanically, every quantity the manuscript's headline rests on, from
 * the persisted results rather than from the prose. The point is that any later
 * change to a number is visible as a diff against this file rather than as an
 * unremarked edit to the paper.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const R = (f) => (existsSync(resolve(base, "results", f)) ? JSON.parse(readFileSync(resolve(base, "results", f), "utf8")) : null);
const exp = R("experiments.json"), rc = R("residual_calibration.json"), cf = R("cross_family.json");
const sens = R("sensitivity.json"), mc = R("multi_candidate.json"), cr = R("crash_replay.json");
const meta = JSON.parse(readFileSync(resolve(base, "corpus", "meta.json"), "utf8"));

const pct = (r) => (r == null ? "—" : `${(r.value * 100).toFixed(1)}% [${(r.ci95.lo * 100).toFixed(1)}–${(r.ci95.hi * 100).toFixed(1)}] (${r.successes}/${r.n})`);
const out = [];
const say = (s = "") => out.push(s);

say("# FROZEN SCIENTIFIC RECORD — mechanically extracted");
say(`Extracted: ${new Date().toISOString()}`);
say(`Corpus built: ${meta.generatedAt}   seed ${meta.rngSeed}`);
say(`Experiments run: ${exp?.generatedAt}`);
say("");
say("## Corpus");
for (const [k, v] of Object.entries(meta.counts)) say(`- ${k}: n=${v.total} (cal ${v.cal} / test ${v.test} / attack ${v.attack}) label=${v.label}`);
say(`- generators: ${meta.generation.generators.join(", ")}`);
for (const [g, s] of Object.entries(meta.generation.perGenerator)) say(`  - ${g}: S2 ${s.s2Kept}/${s.s2Kept + s.s2Dropped} kept, S4 ${s.s4Kept}/${s.s4Kept + s.s4Dropped} kept`);
say("");
say("## Judge coverage (experiments.json) — abstention rate, so coverage = 1 - value");
for (const [j, a] of Object.entries(exp?.abstentions ?? {})) {
  say(`- ${j}: abstained ${a.all.successes}/${a.all.n} → coverage ${(100 * (1 - a.all.value)).toFixed(1)}%`);
}
say(`- primary scorer: ${exp?.primaryScorer}`);
say("");
say("## Jurisdiction-matched configurations (residual_calibration.json) — PRIMARY TABLE");
for (const [name, c] of Object.entries(rc?.configs ?? {})) {
  say(`- ${name}: nCalDiff=${c.nCalDiff} tHi=${c.tHi} tLo=${c.tLo} certifiableM=${c.certifiableM}`);
  say(`    full-split : WS ${pct(c.overall?.wrongSuppression)} | dedup ${pct(c.overall?.dedup)} | silent ${pct(c.overall?.silentEscape)} | flagged ${pct(c.overall?.flaggedEscape)} | friction ${pct(c.overall?.friction)}`);
  say(`    residual   : WS ${pct(c.residualOnly?.wrongSuppression)} | dedup ${pct(c.residualOnly?.dedup)} | silent ${pct(c.residualOnly?.silentEscape)}`);
  say(`    attacks    : D4a ${pct(c.attacks?.D4a_field_injection)} | D4b ${pct(c.attacks?.D4b_text_injection)}`);
}
say("");
say("## Ablations (jurisdiction-matched)");
for (const [name, c] of Object.entries(rc?.ablations ?? {})) {
  say(`- ${name}: nCalDiff=${c.nCalDiff} tHi=${c.tHi} | WS ${pct(c.overall?.wrongSuppression)} | dedup ${pct(c.overall?.dedup)} | silent ${pct(c.overall?.silentEscape)} | flagged ${pct(c.overall?.flaggedEscape)}`);
}
say("");
say("## Jurisdiction conditioning (§8.3 correction)");
say(JSON.stringify(rc?.jurisdiction ?? {}, null, 1));
say("");
say("## Tightened schema (§8.9 B)");
for (const [name, c] of Object.entries(rc?.tightened ?? {})) {
  say(`- ${name}: nCalDiff=${c.nCalDiff} tHi=${c.tHi} certifiableM=${c.certifiableM} judgeJurisdiction=${JSON.stringify(c.jurisdiction ?? c.judgeShare ?? null)}`);
  say(`    WS ${pct(c.overall?.wrongSuppression)} | dedup ${pct(c.overall?.dedup)} | silent ${pct(c.overall?.silentEscape)} | flagged ${pct(c.overall?.flaggedEscape)} | D4a ${pct(c.attacks?.D4a_field_injection)} | D4b ${pct(c.attacks?.D4b_text_injection)}`);
}
say("");
say("## Cross-family (§8.8)");
say(`common subset: ${JSON.stringify(cf?.commonSubset ?? {})}`);
for (const [j, v] of Object.entries(cf?.perJudge ?? {})) {
  say(`- ${j}: tHi=${v.tHi} WS ${pct(v.wrongSuppression)} dedup ${pct(v.dedup)} silent ${pct(v.silentEscape)}`);
}
say(`missingness: ${JSON.stringify(cf?.missingness ?? {})}`);
say(`attacks: ${JSON.stringify(cf?.attacks ?? {})}`);
say("");
say("## Sensitivity / paired tests (§8.12)");
say(JSON.stringify(sens?.labelSensitivity ?? {}, null, 1));
say(JSON.stringify(sens?.paired ?? {}, null, 1));
say("");
say("## Multi-candidate (§8.6)");
say(`judge=${mc?.judge} K=${mc?.K} diffUnits=${mc?.nDiffUnits} sameUnits=${mc?.nSameUnits} testDiff=${mc?.nTestDiffUnits}`);
say(`calibration: ${JSON.stringify(mc?.calibration ?? {})}`);
for (const g of mc?.grid ?? []) say(`- m=${g.m}: ${JSON.stringify(g.rules ?? g)}`.slice(0, 400));
say(`maxScoreGrowth: ${JSON.stringify(mc?.maxScoreGrowth ?? {})}`);
say("");
say("## Crash/replay (§8.7) — AS PUBLISHED");
say(`live=${cr?.live} judge=${cr?.judge} trials=${cr?.nTrials} crossFamily=${cr?.crossFamily} thresholds=${JSON.stringify(cr?.thresholds)}`);
for (const mode of ["syntactic", "semantic"]) {
  say(`- ${mode}: all ${pct(cr?.overall?.[mode]?.exactlyOnceRate)} | outside-window ${pct(cr?.defensibleOnly?.[mode]?.exactlyOnceRate)} | inside-window ${pct(cr?.commitWindowOnly?.[mode]?.exactlyOnceRate)} | windowFlagged ${pct(cr?.commitWindowOnly?.[mode]?.windowSuspectFlagged)} | totalWired $${cr?.overall?.[mode]?.totalWiredUSD}`);
}
for (const cp of cr?.crashPoints ?? []) {
  const s = cr.byCrashPoint[cp];
  say(`  - ${cp}${s.isCommitWindow ? " [WINDOW]" : ""}: syn once ${pct(s.syntactic?.exactlyOnceRate)} | sem once ${pct(s.semantic?.exactlyOnceRate)} | sem suppressed ${pct(s.semantic?.suppressionTrials)}`);
}
say("");
say("## Cost (§8.9)");
say(JSON.stringify(exp?.cost ?? {}, null, 1).slice(0, 2000));

writeFileSync(resolve(base, "audit", "FROZEN-RECORD.md"), out.join("\n"));
console.log(out.join("\n"));
