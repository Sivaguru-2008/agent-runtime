#!/usr/bin/env node
/**
 * supervisor.mjs — crash-recovery supervisor for the API (section F).
 *
 * Runs the API as a child process and keeps exactly one healthy listener alive:
 *   • Before every (re)start it runs free-api.mjs so no duplicate listener and
 *     no stale lock can survive into the new instance.
 *   • On a crash (non-zero exit / killing signal) it appends a structured crash
 *     record — timestamp, exit code, signal, run duration, restart count — to
 *     logs/api-crashes.log so the root cause is preserved across restarts.
 *   • It restarts with exponential backoff (1s → 30s cap).
 *   • A circuit breaker stops after MAX_RAPID_CRASHES crashes inside
 *     RAPID_WINDOW_MS so a hard boot failure does not spin forever; it exits
 *     non-zero so an outer orchestrator (or the operator) is alerted.
 *
 * Usage:
 *   node scripts/supervisor.mjs                      # runs: node dist/server.js
 *   API_CMD="npx tsx apps/api/src/server.ts" node scripts/supervisor.mjs
 *
 * Clean shutdown: SIGINT/SIGTERM are forwarded to the child and the supervisor
 * exits 0 without restarting.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const LOG_DIR = join(REPO_ROOT, "logs");
const CRASH_LOG = join(LOG_DIR, "api-crashes.log");
const FREE_API = join(HERE, "free-api.mjs");

const API_CMD = process.env.API_CMD ?? "node dist/server.js";
const MAX_RAPID_CRASHES = Number(process.env.SUPERVISOR_MAX_RAPID_CRASHES ?? 5);
const RAPID_WINDOW_MS = Number(process.env.SUPERVISOR_RAPID_WINDOW_MS ?? 60_000);
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

mkdirSync(LOG_DIR, { recursive: true });

let restarts = 0;
let shuttingDown = false;
const recentCrashes = [];
/** @type {import("node:child_process").ChildProcess | null} */
let child = null;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[supervisor] ${new Date().toISOString()} ${msg}`);
}

function recordCrash(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  try {
    appendFileSync(CRASH_LOG, line + "\n");
  } catch {
    /* never let crash logging crash the supervisor */
  }
  log(`crash recorded → ${CRASH_LOG}: ${line}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run free-api.mjs and resolve when it exits (never rejects). */
function freePort() {
  return new Promise((resolve_) => {
    const p = spawn(process.execPath, [FREE_API], { stdio: "inherit" });
    p.on("exit", () => resolve_());
    p.on("error", () => resolve_());
  });
}

async function runOnce() {
  await freePort();
  const startedAt = Date.now();
  const [cmd, ...args] = API_CMD.split(" ");

  log(`starting API: ${API_CMD}`);
  child = spawn(cmd, args, {
    stdio: "inherit",
    cwd: REPO_ROOT,
    shell: process.platform === "win32" // resolve npx/node.cmd on Windows
  });

  const code = await new Promise((resolve_) => {
    child.on("exit", (exitCode, signal) => resolve_({ exitCode, signal }));
    child.on("error", (err) => resolve_({ exitCode: -1, signal: null, err: String(err) }));
  });
  const runMs = Date.now() - startedAt;
  child = null;
  return { ...code, runMs };
}

async function supervise() {
  for (;;) {
    const { exitCode, signal, runMs, err } = await runOnce();

    if (shuttingDown) return;

    // Clean voluntary exit (code 0, no signal) → do not restart.
    if (exitCode === 0 && !signal) {
      log("API exited cleanly (code 0) — not restarting");
      return;
    }

    restarts += 1;
    const now = Date.now();
    recentCrashes.push(now);
    while (recentCrashes.length && now - recentCrashes[0] > RAPID_WINDOW_MS) {
      recentCrashes.shift();
    }
    recordCrash({ exitCode, signal, runMs, restarts, rapidCrashes: recentCrashes.length, err });

    if (recentCrashes.length >= MAX_RAPID_CRASHES) {
      log(
        `circuit breaker OPEN — ${recentCrashes.length} crashes within ${RAPID_WINDOW_MS}ms. ` +
          `Refusing to restart-loop. Fix the boot failure (see ${CRASH_LOG}) and relaunch.`
      );
      process.exit(1);
    }

    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (recentCrashes.length - 1), BACKOFF_MAX_MS);
    log(`API crashed (code=${exitCode} signal=${signal}) after ${runMs}ms — restarting in ${backoff}ms`);
    await sleep(backoff);
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    shuttingDown = true;
    log(`received ${sig} — forwarding to child and exiting`);
    if (child) {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => process.exit(0), 500);
  });
}

supervise().catch((err) => {
  log(`supervisor fatal: ${err}`);
  process.exit(1);
});
