import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { LabellingSession } from "../src/labelling/session.js";
import { prepareBlind } from "../src/labelling/prepare.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "labelling", "label.js");

const pairs = [1, 2, 3, 4].map((i) => ({
  id: `p${i}`, tool: "send_email", label: i % 2 ? "SAME" : "DIFF", stratum: i % 2 ? "same" : "hard",
  a: { to: "x@y.z", thread_id: "T1", subject: `s${i}`, body: `b${i}` },
  b: { to: "x@y.z", thread_id: "T1", subject: `s${i}'`, body: `b${i}'` },
}));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "blind-"));
  const { items, key } = prepareBlind(pairs, { seed: 20261004 });
  const itemsPath = join(dir, "labelling.jsonl");
  const keyPath = join(dir, "key.jsonl");
  const labelsPath = join(dir, "labels.jsonl");
  writeFileSync(itemsPath, items.map((x) => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(keyPath, key.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return { dir, itemsPath, keyPath, labelsPath, items, key };
}

/** An fs that records every path handed to it. */
function recordingFs() {
  const touched = [];
  const wrap = (name) => (p, ...rest) => { touched.push(resolve(String(p))); return realFs[name](p, ...rest); };
  return { touched, fs: { readFileSync: wrap("readFileSync"), existsSync: wrap("existsSync"), appendFileSync: wrap("appendFileSync") } };
}

test("the labelling file carries only an opaque id and the two calls", () => {
  const { items, key } = prepareBlind(pairs, { seed: 20261004 });
  for (const it of items) {
    assert.deepEqual(Object.keys(it).sort(), ["A", "B", "id"]);
    assert.match(it.id, /^L\d{4}$/);
    assert.deepEqual(Object.keys(it.A).sort(), ["args", "tool"]);
  }
  assert.equal(JSON.stringify(items).includes("SAME") || JSON.stringify(items).includes("hard"), false);
  // Seeded: the same seed gives the same order and swaps.
  assert.deepEqual(prepareBlind(pairs, { seed: 20261004 }).key, key);
});

test("a session touches only the labelling and labels files, never the key file", () => {
  const f = fixture();
  const rec = recordingFs();
  const s = new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath, fs: rec.fs });
  while (s.current()) s.submit("SAME");
  new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath, fs: rec.fs }); // resume
  const allowed = new Set([resolve(f.itemsPath), resolve(f.labelsPath)]);
  assert.ok(rec.touched.length > 0);
  for (const p of rec.touched) assert.ok(allowed.has(p), `session touched ${p}`);
  assert.equal(rec.touched.includes(resolve(f.keyPath)), false);
});

test("the CLI's labelling process cannot read the key file (permission jail)", () => {
  const f = fixture();
  const run = (path) => spawnSync(process.execPath, [CLI, "--items", f.itemsPath, "--labels", f.labelsPath, "--probe-read", path], { encoding: "utf8" });
  // Positive control: the jail allows the labelling file...
  assert.match(run(f.itemsPath).stdout, /PROBE:read/);
  // ...and denies the key file sitting next to it.
  const denied = run(f.keyPath);
  assert.match(denied.stdout, /PROBE:denied ERR_ACCESS_DENIED/, denied.stderr);
});

test("the CLI labels end to end and rejects anything but y/n", () => {
  const f = fixture();
  const r = spawnSync(process.execPath, [CLI, "--items", f.itemsPath, "--labels", f.labelsPath],
    { input: "back\ny\nundo\nn\ny\nn\n", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /There is no back or undo/);
  const labels = readFileSync(f.labelsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(labels.map((l) => l.label), ["DIFF", "SAME", "DIFF", "SAME"]);
  assert.deepEqual(labels.map((l) => l.id), f.items.map((i) => i.id));
});

test("a submitted label cannot be revised", () => {
  const f = fixture();
  const s = new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath });
  const first = s.current().id;
  s.submit("DIFF");
  // The session moves on; nothing addresses the first item again.
  assert.notEqual(s.current().id, first);
  const before = readFileSync(f.labelsPath, "utf8");
  s.submit("SAME");
  // Append-only: earlier bytes are unchanged.
  assert.ok(readFileSync(f.labelsPath, "utf8").startsWith(before));
  // A resumed session continues after the labelled items, never before them.
  const resumed = new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath });
  assert.equal(resumed.labelled, 2);
  assert.equal(resumed.current().id, f.items[2].id);
  // Editing the file to label an item a second time is refused on load.
  realFs.appendFileSync(f.labelsPath, JSON.stringify({ id: first, label: "SAME", at: "x" }) + "\n");
  assert.throws(() => new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath }), /twice/);
});

test("finished sessions accept no further labels; bad labels are refused", () => {
  const f = fixture();
  const s = new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath });
  assert.throws(() => s.submit("MAYBE"), /label must be/);
  while (s.current()) s.submit("DIFF");
  assert.throws(() => s.submit("SAME"), /already labelled/);
  assert.ok(existsSync(f.labelsPath));
});

test("an item carrying extra fields (a leaked label) is refused", () => {
  const f = fixture();
  writeFileSync(f.itemsPath, JSON.stringify({ ...f.items[0], label: "SAME" }) + "\n");
  assert.throws(() => new LabellingSession({ itemsPath: f.itemsPath, labelsPath: f.labelsPath }), /beyond id\/A\/B/);
});
