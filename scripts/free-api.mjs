#!/usr/bin/env node
/**
 * free-api.mjs — guarantee a single, clean API instance before the dev server
 * (or supervisor) starts.
 *
 * Root cause this prevents: multiple `npm run dev` / `tsx watch src/server.ts`
 * trees accumulate over a session. They race for port 4000 and the dev lock;
 * the losers `process.exit(1)` and their `tsx watch` parents go permanently
 * idle, so frequently NOBODY ends up listening on 4000 → ERR_CONNECTION_REFUSED.
 *
 * This script (run as `predev` in apps/api, and by the supervisor) reaps that
 * soup so a fresh start always converges to one instance:
 *   1. Kill whatever process is LISTENING on the target port.
 *   2. Kill stray `tsx … server.ts` watcher/child processes (the API servers).
 *   3. Delete the stale dev lock file.
 *
 * It is SAFE to run as `predev`: at that point `tsx watch` has not started yet,
 * so this script's own npm ancestor chain contains no `server.ts` process and
 * is never targeted. It is cross-platform (Windows / macOS / Linux) and never
 * throws — a failure to reap is logged and ignored.
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.PORT ?? 4000);
const IS_WIN = process.platform === "win32";
const SELF_PID = process.pid;
const PPID = process.ppid;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[free-api] ${msg}`);
}

/** Best-effort: return PIDs currently LISTENING on the port. */
function pidsOnPort(port) {
  try {
    if (IS_WIN) {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
        windowsHide: true
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
      return [...pids];
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return []; // findstr/lsof exit non-zero when nothing matches
  }
}

/** Best-effort: return PIDs of `tsx … server.ts` watcher/child processes. */
function pidsOfApiServerProcesses() {
  try {
    if (IS_WIN) {
      // CIM gives us the full command line to match on. Use Where-Object with
      // ONLY single-quoted literals inside the command — a nested double-quoted
      // -Filter ("Name='node.exe'") collides with the outer double quotes that
      // cmd.exe passes to powershell and fails with "Invalid query".
      const ps =
        `Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server\\.ts' } | ` +
        `Select-Object -ExpandProperty ProcessId`;
      const out = execSync(`powershell -NoProfile -Command "${ps}"`, {
        encoding: "utf8",
        windowsHide: true
      });
      return out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
    const out = execSync(`pgrep -f "server\\.ts"`, { encoding: "utf8" });
    return out
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function kill(pid) {
  if (pid === SELF_PID || pid === PPID) return; // never reap ourselves/parent
  try {
    if (IS_WIN) {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
    log(`killed PID ${pid}`);
  } catch {
    /* already gone or no permission — ignore */
  }
}

// 1 + 2. Reap port owners and stray API server processes.
const victims = new Set([...pidsOnPort(PORT), ...pidsOfApiServerProcesses()]);
if (victims.size === 0) {
  log(`port ${PORT} free, no stray server.ts processes — clean`);
} else {
  log(`reaping ${victims.size} process(es): ${[...victims].join(", ")}`);
  for (const pid of victims) kill(pid);
}

// 3. Delete the stale dev lock (now in the OS temp dir, out of the watched tree).
const lockPath = join(tmpdir(), "agent-runtime-api", ".api-dev.lock");
if (existsSync(lockPath)) {
  try {
    rmSync(lockPath, { force: true });
    log(`removed stale lock ${lockPath}`);
  } catch {
    /* ignore */
  }
}

log("done — port is clear for a single fresh API instance");
