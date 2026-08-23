import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Freeze the annotation export (Task 1a).
 *
 * The annotation study measures whether the corpus's constructed labels match
 * an independent reader's. That measurement is only worth anything if the items
 * being judged are fixed BEFORE any judgement is collected — otherwise the
 * sample can drift toward whatever agrees, and no amount of interval reporting
 * detects it.
 *
 * This writes a content hash over the exported sheet AND a per-item hash over
 * the exact call pair each annotator sees. The per-item hashes are the load-
 * bearing ones: the corpus grows later in this revision (S3 and D3 are enlarged
 * for statistical power, §8.3), and the honest requirement is not "the corpus
 * file never changes" but "no item in the frozen sheet changed". `--verify`
 * checks exactly that, and is wired into the build verifier.
 *
 *   node src/experiments/annotationFreeze.js --freeze
 *   node src/experiments/annotationFreeze.js --verify
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const annDir = resolve(base, "annotation");
const freezePath = resolve(annDir, "FREEZE.json");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const readKey = () =>
  readFileSync(resolve(annDir, "key.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

/**
 * The item hash covers what the annotator is shown and what the study will
 * compare it against — the two calls and the constructed label — and nothing
 * else. Presentation randomisation (which call is "A") is inside it because a
 * re-export that flipped a pair would change what was judged.
 */
const itemHash = (k) =>
  sha(JSON.stringify({ item: k.item, pairId: k.pairId, stratum: k.stratum,
    constructed: k.constructedLabel, callA: k.callA, callB: k.callB }));

function freeze() {
  if (!existsSync(resolve(annDir, "key.jsonl"))) throw new Error("no export to freeze — run annotation.js --export first");
  const key = readKey();
  const files = {};
  for (const f of ["key.jsonl", "sheet.jsonl", "sheet.csv", "INSTRUCTIONS.md"]) {
    if (existsSync(resolve(annDir, f))) files[f] = sha(readFileSync(resolve(annDir, f)));
  }
  const items = Object.fromEntries(key.map((k) => [k.item, itemHash(k)]));
  const strata = {};
  for (const k of key) strata[k.stratum] = (strata[k.stratum] ?? 0) + 1;

  const record = {
    frozenAt: new Date().toISOString(),
    nItems: key.size ?? key.length,
    exportSeed: 20260818,
    sheetHash: sha(key.map(itemHash).join("\n")),
    files,
    strata,
    constructedLabelCounts: key.reduce((a, k) => ({ ...a, [k.constructedLabel]: (a[k.constructedLabel] ?? 0) + 1 }), {}),
    items,
    contract: [
      "No item in this sheet may change after this timestamp.",
      "The corpus MAY grow (new pairs appended); --verify enforces that every FROZEN item is byte-identical in the corpus as shipped.",
      "Any judgement collected against a sheet whose --verify fails is void.",
    ],
  };
  writeFileSync(freezePath, JSON.stringify(record, null, 2));
  console.log(`frozen ${key.length} items`);
  console.log(`sheet hash: ${record.sheetHash}`);
  for (const [f, h] of Object.entries(files)) console.log(`  ${f.padEnd(16)} ${h.slice(0, 16)}…`);
  return record;
}

/** Re-derive every item hash from the CORPUS as it currently stands. */
function verify() {
  if (!existsSync(freezePath)) return { ok: false, reason: "annotation/FREEZE.json missing — sheet was never frozen" };
  const record = JSON.parse(readFileSync(freezePath, "utf8"));
  const key = readKey();
  const readJsonl = (f) => (existsSync(resolve(base, f))
    ? readFileSync(resolve(base, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const corpus = new Map([...readJsonl("corpus/pairs.jsonl"), ...readJsonl("corpus/pairs-v2ext.jsonl")].map((p) => [p.id, p]));

  const drifted = [];
  const missing = [];
  for (const k of key) {
    const h = itemHash(k);
    if (record.items[k.item] !== h) drifted.push({ item: k.item, reason: "sheet item changed since freeze" });
    const p = corpus.get(k.pairId);
    if (!p) { missing.push(k.item); continue; }
    // The sheet stores callA/callB possibly flipped; compare as an unordered pair.
    const sheetCalls = [JSON.stringify(k.callA), JSON.stringify(k.callB)].sort().join("|");
    const corpusCalls = [JSON.stringify(p.a), JSON.stringify(p.b)].sort().join("|");
    if (sheetCalls !== corpusCalls) drifted.push({ item: k.item, pairId: k.pairId, reason: "corpus pair content changed" });
    if (p.label !== k.constructedLabel) drifted.push({ item: k.item, pairId: k.pairId, reason: `corpus label changed ${k.constructedLabel}→${p.label}` });
  }
  const ok = drifted.length === 0 && missing.length === 0;
  return { ok, nItems: key.length, frozenAt: record.frozenAt, sheetHash: record.sheetHash, drifted, missingFromCorpus: missing };
}

// CLI only when invoked directly: annotation.js imports verify() and must not
// inherit this module's exit code.
const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  if (process.argv.includes("--freeze")) freeze();
  else {
    const r = verify();
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  }
}

export { verify as verifyAnnotationFreeze };
