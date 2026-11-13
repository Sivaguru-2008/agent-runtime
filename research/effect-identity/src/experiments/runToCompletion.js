#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Run scoreV2.js to completion, resuming as many times as needed, with a
 * process-level watchdog rather than the shell `timeout` command.
 *
 * `timeout` (the Git-for-Windows build used elsewhere in this session) does
 * not reliably deliver its kill signal to a Node child on this platform: the
 * wrapped process can survive past the deadline while the shell loop that
 * invoked `timeout` moves on to its next iteration, spawning a SECOND scorer
 * against the same partial-score file. Two writers racing on one JSON file is
 * indistinguishable, from the outside, from a hung scorer — which is how an
 * earlier run of this experiment produced four orphaned `timeout.exe`
 * processes and two live scorers overwriting each other's progress.
 *
 * This runner owns the child process directly (`spawn`, not a shell `timeout`
 * wrapper) and kills it itself via `.kill()` if a single batch has not
 * completed within `staleMs`. Exactly one child exists at any moment, because
 * this process does not proceed to the next attempt until the previous
 * child has actually exited.
 *
 *   node src/experiments/runToCompletion.js --pairs corpus/ladder.jsonl \
 *        --out corpus/scores-ladder.jsonl --judges openai/gpt-oss-120b \
 *        --batch 6 [--max-attempts 12] [--stale-ms 90000]
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const args = process.argv.slice(2);
const argAfter = (flag, fb) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] ? args[i + 1] : fb; };
const PAIRS = argAfter("--pairs", "corpus/pairs-v2ext.jsonl");
const JUDGES = argAfter("--judges", "openai/gpt-oss-120b");
const MAX_ATTEMPTS = Number(argAfter("--max-attempts", "12"));
const STALE_MS = Number(argAfter("--stale-ms", "90000"));
const scoreArgs = args.filter((a) => a !== "--max-attempts" && a !== "--stale-ms").reduce((acc, a, i, arr) => {
  if (a === "--max-attempts" || a === "--stale-ms") return acc;
  if (i > 0 && (arr[i - 1] === "--max-attempts" || arr[i - 1] === "--stale-ms")) return acc;
  acc.push(a);
  return acc;
}, []);

const judgeKeyOf = (m) => m.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
const tag = PAIRS.split("/").pop().replace(/\.jsonl$/, "");
const partialPath = (model) => resolve(base, "results", `partial-${tag}-${judgeKeyOf(model)}.json`);

function countRemaining() {
  const pairs = readFileSync(resolve(base, PAIRS), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let remaining = 0;
  for (const model of JUDGES.split(",")) {
    const p = partialPath(model);
    const scores = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).scores ?? {}) : {};
    remaining += pairs.filter((row) => scores[row.id] === undefined || scores[row.id] === null).length;
  }
  return remaining;
}

function runOnce() {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [resolve(here, "scoreV2.js"), ...scoreArgs], { cwd: base });
    let lastOutput = Date.now();
    let killedForStall = false;
    child.stdout.on("data", (d) => { lastOutput = Date.now(); process.stdout.write(d); });
    child.stderr.on("data", (d) => { lastOutput = Date.now(); process.stderr.write(d); });
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput > STALE_MS) {
        killedForStall = true;
        process.stdout.write(`\n[watchdog] no output for ${STALE_MS}ms — killing child pid ${child.pid}\n`);
        child.kill("SIGKILL");
      }
    }, 5000);
    child.on("exit", (code) => {
      clearInterval(watchdog);
      resolvePromise({ code, killedForStall });
    });
  });
}

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const before = countRemaining();
    if (before === 0) { console.log(`\nAll pairs scored. Done in ${attempt - 1} attempt(s).`); return; }
    console.log(`\n=== attempt ${attempt}/${MAX_ATTEMPTS} — ${before} pairs remaining ===`);
    const { code, killedForStall } = await runOnce();
    const after = countRemaining();
    console.log(`--- attempt ${attempt} ended (exit ${code}${killedForStall ? ", stalled" : ""}) — ${after} remaining (was ${before}) ---`);
    if (after === before && !killedForStall) {
      console.log("No progress made and the child exited on its own — stopping rather than looping forever.");
      process.exitCode = 1;
      return;
    }
  }
  const left = countRemaining();
  console.log(`\nStopped after ${MAX_ATTEMPTS} attempts with ${left} pairs still unscored.`);
  process.exitCode = left === 0 ? 0 : 1;
}

main();
