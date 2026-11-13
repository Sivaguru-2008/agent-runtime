#!/usr/bin/env node
/**
 * Channel H, targeted follow-up (AIJ revision, Phase 4).
 *
 * The preregistered human study (annotation/CHANNEL-H-PROTOCOL.md) covers all
 * 154 frozen items and was never collected. This is a SMALLER, TARGETED
 * follow-up on the two strata the model panel contested — legitimate repeats
 * (`diff_text_only`) and prose-only injection (`attack_text`) — with the three
 * preregistered catch trials, three annotators and one adjudicator. It is not
 * the preregistered study and must never be reported as it.
 *
 *   node src/experiments/channelHTargeted.js --build      write the packet (no labels in it)
 *   node src/experiments/channelHTargeted.js --analyze    ingest responses, write results/channel_h_targeted.json
 *   node src/experiments/channelHTargeted.js --self-test  prove the ingest path on synthetic files (temp dir; writes nothing to results/)
 *
 * Everything shown to an annotator is copied verbatim from the frozen sheet and
 * its hashes are checked against annotation/FREEZE.json, so the responses are
 * read by the ordinary ingest (annotation.js --ingest --channel H) unchanged.
 * The analysis applies the preregistered rules without modification:
 *   - catch trials: an annotator failing ANY catch trial is dropped in full,
 *     UNSURE counts as a failure, and a dropped annotator is replaced, never
 *     reweighted;
 *   - labels: strict majority of three; everything else goes to the
 *     adjudicator; an unadjudicated item has no label;
 *   - a stratum is CONTESTED when the Wilson 95% upper bound of its agreement
 *     with the construction falls below 0.80 (PREREGISTRATION.md §6).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { rate, wilson } from "../stats.js";

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const annDir = resolve(base, "annotation");
const PACKET = resolve(annDir, "channel-h-targeted");
const STRATA = ["diff_text_only", "attack_text"];
const STRATUM_NAME = { diff_text_only: "legitimate repeats (D2)", attack_text: "prose-only injection (D4b and extension analogues)" };
const OUT = resolve(base, "results", "channel_h_targeted.json");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const freeze = JSON.parse(readFileSync(resolve(annDir, "FREEZE.json"), "utf8"));
const key = readJsonl(resolve(annDir, "key.jsonl"));
const catchTrials = JSON.parse(readFileSync(resolve(annDir, "catch-trials.json"), "utf8")).trials;
const catchIds = new Set(catchTrials.map((c) => c.item));
const targetIds = new Set(key.filter((k) => STRATA.includes(k.stratum)).map((k) => k.item));
const packetIds = new Set([...targetIds, ...catchIds]);

// ── build ────────────────────────────────────────────────────────────────────
// The PREREGISTERED materials. annotation/INSTRUCTIONS.md and the in-page text
// of annotation/instrument.html were edited after the freeze (the working
// copies no longer match FREEZE.json); the versions the model panel saw are
// preserved in annotation/preregistered-collection/, and those are what a
// Channel H annotator must see.
const PREREG = resolve(annDir, "preregistered-collection");

function build() {
  // The frozen files must be the frozen files.
  const frozenSource = { "sheet.jsonl": annDir, "sheet.csv": annDir, "key.jsonl": annDir, "INSTRUCTIONS.md": PREREG };
  for (const [f, dir] of Object.entries(frozenSource)) {
    const h = sha(readFileSync(resolve(dir, f)));
    if (h !== freeze.files[f]) throw new Error(`${dir.slice(base.length + 1)}/${f} does not match FREEZE.json — the frozen materials have drifted; stop`);
  }
  mkdirSync(resolve(PACKET, "responses"), { recursive: true });
  const sheetLines = readFileSync(resolve(annDir, "sheet.jsonl"), "utf8").split("\n").filter(Boolean);
  const kept = sheetLines.filter((l) => packetIds.has(JSON.parse(l).item));
  writeFileSync(resolve(PACKET, "sheet.jsonl"), kept.join("\n") + "\n");
  const csvLines = readFileSync(resolve(annDir, "sheet.csv"), "utf8").split(/\r?\n/);
  writeFileSync(resolve(PACKET, "sheet.csv"), [csvLines[0], ...csvLines.slice(1).filter((l) => packetIds.has(l.split(",")[0]))].join("\n") + "\n");
  copyFileSync(resolve(PREREG, "INSTRUCTIONS.md"), resolve(PACKET, "INSTRUCTIONS.md"));

  // The instrument: the preregistered page with only its item list replaced by
  // the packet's items (same ids, same content, same per-annotator
  // randomisation) and the save-location hint pointed at this packet.
  const src = readFileSync(resolve(PREREG, "instrument.html"), "utf8");
  const itemsLine = src.split("\n").findIndex((l) => l.startsWith("const ITEMS = "));
  if (itemsLine < 0) throw new Error("preregistered instrument has no ITEMS line");
  const all = JSON.parse(src.split("\n")[itemsLine].replace(/^const ITEMS = /, "").replace(/;\s*$/, ""));
  const subset = all.filter((it) => packetIds.has(it.item));
  if (subset.length !== packetIds.size) throw new Error(`instrument has ${subset.length} of ${packetIds.size} packet items`);
  for (const it of subset) {
    const k = key.find((x) => x.item === it.item);
    if (JSON.stringify(it.x) !== JSON.stringify(k.callA) || JSON.stringify(it.y) !== JSON.stringify(k.callB)) throw new Error(`${it.item}: instrument content differs from the frozen key`);
  }
  const lines = src.split("\n");
  lines[itemsLine] = `const ITEMS = ${JSON.stringify(subset)};`;
  const html = lines.join("\n").replace("in the <code>annotation/</code> directory.", "in the <code>responses/</code> folder of this packet.");
  if (html === src) throw new Error("instrument unchanged — refusing to write a full-sheet instrument into the packet");
  writeFileSync(resolve(PACKET, "instrument.html"), html);

  const itemHashes = Object.fromEntries([...packetIds].sort().map((it) => [it, freeze.items[it]]));
  const manifest = {
    what: "Channel H targeted follow-up — NOT the preregistered 154-item study",
    builtAt: new Date().toISOString(),
    strata: Object.fromEntries(STRATA.map((s) => [s, key.filter((k) => k.stratum === s).map((k) => k.item)])),
    catchTrials: [...catchIds],
    nItems: packetIds.size,
    frozenItemHashes: itemHashes,
    frozenSheetHash: freeze.sheetHash,
    files: Object.fromEntries(["sheet.jsonl", "sheet.csv", "INSTRUCTIONS.md", "instrument.html"].map((f) => [f, sha(readFileSync(resolve(PACKET, f)))])),
    annotators: 3, adjudicators: 1,
    rules: {
      catch: "an annotator failing ANY catch trial is dropped in full; UNSURE counts as a failure; a dropped annotator is replaced, never reweighted",
      label: "strict majority of three; otherwise the adjudicator's SAME/DIFF; otherwise no label",
      contested: "Wilson 95% upper bound of agreement with the construction below 0.80",
    },
    analysis: "node src/experiments/channelHTargeted.js --analyze",
  };
  writeFileSync(resolve(PACKET, "PACKET.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(resolve(PACKET, "adjudication-template.csv"), "item,label,orientation,ms,annotator\n");
  console.log(`packet: ${PACKET.slice(base.length + 1)} — ${targetIds.size} target items (${STRATA.map((s) => `${s} ${manifest.strata[s].length}`).join(", ")}) + ${catchIds.size} catch trials`);
}

// ── analyze ──────────────────────────────────────────────────────────────────
function analyze(respDir = resolve(PACKET, "responses"), outPath = OUT) {
  const files = existsSync(respDir) ? readdirSync(respDir).filter((f) => /^responses-.+\.csv$/i.test(f)) : [];
  if (files.filter((f) => !/adjudicator/i.test(f)).length === 0) {
    const out = { status: "PENDING", reason: "no Channel H responses collected", packet: PACKET.slice(base.length + 1).replace(/\\/g, "/"),
      note: "The absence is recorded so that it is machine-checkable. No number from this file may appear in the manuscript." };
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log("PENDING — no responses in", respDir);
    return out;
  }
  // Refuse responses to anything outside the packet: they would mean the
  // annotator saw a different instrument.
  for (const f of files) {
    const rows = readFileSync(join(respDir, f), "utf8").split(/\r?\n/).slice(1).filter(Boolean);
    const stray = rows.map((r) => r.split(",")[0].replace(/"/g, "")).filter((it) => !packetIds.has(it));
    if (stray.length) throw new Error(`${f} answers items outside the packet (${stray.slice(0, 5).join(", ")}) — wrong instrument`);
  }
  const ingestOut = outPath.replace(/\.json$/, ".ingest.json");
  const r = spawnSync("node", [resolve(base, "src", "experiments", "annotation.js"), "--ingest", "--responses-dir", respDir.slice(base.length + 1), "--channel", "H", "--out", ingestOut.startsWith(base) ? ingestOut.slice(base.length + 1) : ingestOut], { cwd: base, encoding: "utf8" });
  if (!existsSync(ingestOut)) throw new Error(`ingest wrote nothing: ${r.stderr || r.stdout}`);
  const ing = JSON.parse(readFileSync(ingestOut, "utf8"));
  if (ing.status !== "COMPLETE") {
    const out = { status: ing.status, reason: ing.reason, catchTrials: ing.catchTrials ?? null, droppedAnnotators: ing.dropped ?? ing.catchTrials?.droppedAnnotators ?? null };
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`${ing.status} — ${ing.reason}`);
    return out;
  }
  if (ing.channel !== "H") throw new Error(`ingest reports channel ${ing.channel}; a targeted Channel H result must be channel H only`);
  if (ing.annotators.length < 3) console.warn(`WARNING: only ${ing.annotators.length} admissible annotators — the protocol needs three; replace any dropped annotator`);

  // Channel M on the same items, for comparison only (never pooled).
  const m = JSON.parse(readFileSync(resolve(base, "results", "human_annotation.json"), "utf8"));
  const perStratum = {};
  for (const s of STRATA) {
    const h = ing.perStratum[s];
    const a = h.constructionAgreement;
    perStratum[s] = {
      name: STRATUM_NAME[s], nItems: h.n,
      constructionAgreement: a,
      contested: a && a.ci95 ? a.ci95.hi < 0.8 : null,
      unsureRate: h.unsureRate, adjudicationRate: h.adjudicationRate, krippendorff: h.krippendorff,
      disagreements: h.disagreements,
      channelMOnSameStratum: m.perStratum?.[s]?.constructionAgreement ?? null,
    };
  }
  const out = {
    status: "COMPLETE", generatedAt: new Date().toISOString(), channel: "H",
    scope: "TARGETED follow-up on the two strata contested by the model panel; not the preregistered 154-item study",
    annotators: ing.annotators, adjudicators: ing.adjudicators, droppedOnCatchTrials: ing.catchTrials.droppedAnnotators,
    nFullyAnnotated: ing.nFullyAnnotated, adjudicationRate: ing.adjudicationRate,
    fleissKappa: ing.fleissKappa, krippendorffAlpha: ing.krippendorffAlpha,
    perStratum,
    rule: "contested iff Wilson 95% upper bound of agreement < 0.80 (PREREGISTRATION.md §6)",
    ingestFile: ingestOut.slice(base.length + 1).replace(/\\/g, "/"),
  };
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  for (const s of STRATA) {
    const p = perStratum[s], a = p.constructionAgreement;
    console.log(`${p.name.padEnd(52)} n=${p.nItems}  agreement ${a ? `${(100 * a.value).toFixed(1)}% [${(100 * a.ci95.lo).toFixed(1)}–${(100 * a.ci95.hi).toFixed(1)}]` : "—"}  ${p.contested ? "CONTESTED" : "not contested"}`);
  }
  return out;
}

// ── self-test: the ingest path on synthetic files, in a temp dir ─────────────
function selfTest() {
  const tmp = mkdtempSync(join(tmpdir(), "chH-"));
  const inBase = resolve(base, "annotation", `.selftest-${process.pid}`);
  mkdirSync(inBase, { recursive: true });
  try {
    const items = [...packetIds];
    const constructed = new Map(key.map((k) => [k.item, k.constructedLabel]));
    const expectCatch = new Map(catchTrials.map((c) => [c.item, c.expect]));
    // Three synthetic annotators who agree with the construction except on a
    // fixed set of legitimate-repeat items; one who fails a catch trial.
    const flipped = new Set(key.filter((k) => k.stratum === "diff_text_only").slice(0, 8).map((k) => k.item));
    const write = (name, fn) => writeFileSync(join(inBase, `responses-${name}.csv`),
      "item,label,orientation,ms,annotator\n" + items.map((it) => `${it},${fn(it)},AB,1000,${name}`).join("\n") + "\n");
    const truth = (it) => expectCatch.get(it) ?? constructed.get(it);
    write("syn-a", (it) => (flipped.has(it) ? "SAME" : truth(it)));
    write("syn-b", (it) => (flipped.has(it) ? "SAME" : truth(it)));
    write("syn-c", (it) => truth(it));
    write("syn-d", (it) => (it === [...catchIds][0] ? "UNSURE" : truth(it))); // must be dropped
    const out = analyze(inBase, join(tmp, "selftest.json"));
    const d2 = out.perStratum?.diff_text_only;
    const ok = out.status === "COMPLETE" && out.droppedOnCatchTrials.length === 1 &&
      d2.constructionAgreement.successes === d2.nItems - flipped.size && d2.contested === true &&
      out.perStratum.attack_text.contested === false;
    console.log(ok ? "SELF-TEST OK — catch-trial drop, majority labels, per-stratum Wilson and the contested rule behave as preregistered"
      : `SELF-TEST FAILED: ${JSON.stringify(out).slice(0, 600)}`);
    if (!ok) process.exitCode = 1;
  } finally {
    rmSync(inBase, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--build")) build();
else if (process.argv.includes("--self-test")) selfTest();
else if (process.argv.includes("--analyze")) analyze();
else console.log("usage: --build | --analyze | --self-test");
