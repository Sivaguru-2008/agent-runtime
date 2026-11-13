#!/usr/bin/env node
/**
 * Blind labelling tool (PREREG_EXP2.md §A3.2).
 *
 *   node src/labelling/label.js --items <labelling.jsonl> --labels <labels.jsonl>
 *
 * Shows one pair at a time (opaque id and the two tool calls only), in the
 * order fixed when the labelling file was prepared, and asks the §5.2 question.
 * Answers are appended to the labels file and cannot be revised: there is no
 * back, undo, or edit command, and the session refuses a labels file that
 * labels an item twice.
 *
 * ENFORCEMENT. The tool re-launches itself under Node's permission model with
 * read access to the labelling file, the labels file and its own code only, and
 * write access to the labels file only. The key file (intended labels, strata,
 * prompts) is therefore unreadable from inside the labelling process, whatever
 * the code does. The tool never takes the key file's path as an argument.
 *
 * `--probe-read <path>` (used by the unit test) makes the jailed process try to
 * read <path>, print PROBE:read or PROBE:denied, and exit without labelling.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LabellingSession } from "./session.js";

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const items = argAfter("--items");
const labels = argAfter("--labels");
const probe = argAfter("--probe-read");
if (!items || !labels) {
  console.error("usage: node src/labelling/label.js --items <labelling.jsonl> --labels <labels.jsonl>");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));

// ── outer process: re-launch under the permission model ─────────────────────
if (!process.permission) {
  const pkg = resolve(here, "..", "..", "package.json");
  const flags = [
    "--permission",
    `--allow-fs-read=${resolve(here)}${process.platform === "win32" ? "\\" : "/"}*`,
    `--allow-fs-read=${resolve(items)}`,
    `--allow-fs-read=${resolve(labels)}`,
    `--allow-fs-write=${resolve(labels)}`,
  ];
  if (existsSync(pkg)) flags.push(`--allow-fs-read=${pkg}`);
  const r = spawnSync(process.execPath, [...flags, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// ── inner process: jailed ───────────────────────────────────────────────────
if (probe) {
  try { readFileSync(probe); console.log("PROBE:read"); } catch (e) { console.log(`PROBE:denied ${e.code ?? ""}`.trim()); }
  process.exit(0);
}

const QUESTION =
  "Would silently returning the recorded response of call A in place of executing call B\n" +
  "leave an intended action undone?   y = yes (different acts)   n = no (same act)";

const session = new LabellingSession({ itemsPath: items, labelsPath: labels });
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = rl[Symbol.asyncIterator]();

console.log(`Blind labelling: ${session.labelled}/${session.total} already labelled. Labels are final.\n`);
for (let item = session.current(); item; item = session.current()) {
  console.log(`──── ${item.id}  (${item.position} of ${item.total}) ────`);
  console.log("A:", JSON.stringify(item.A, null, 2));
  console.log("B:", JSON.stringify(item.B, null, 2));
  console.log(QUESTION);
  let label = null;
  while (!label) {
    process.stdout.write("> ");
    const { value, done } = await lines.next();
    if (done) { console.log("\nStopped. Progress is saved; rerun to continue."); process.exit(0); }
    const a = value.trim().toLowerCase();
    if (a === "y") label = "DIFF";
    else if (a === "n") label = "SAME";
    else console.log("Answer y or n. (There is no back or undo: labels are final.)");
  }
  session.submit(label);
  console.log("");
}
console.log(`All ${session.total} items labelled.`);
process.exit(0);
