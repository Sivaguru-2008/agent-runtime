#!/usr/bin/env node
/**
 * free-web.mjs — guarantee port 3000 is free before `next dev` starts.
 *
 * Same disease free-api.mjs cures for port 4000, seen on the web side: a
 * leftover dev server (a previous `npm run dev`, a tool-launched preview, a
 * crashed watcher's orphan) keeps LISTENING on 3000, so the next
 * `next dev --port 3000` dies with EADDRINUSE and the operator gets a dead
 * frontend while the API boots fine beside it.
 *
 * Run as `predev` in apps/web: kill whatever is listening on the target port,
 * so a fresh `npm run dev` always converges to one healthy web server. Safe at
 * predev time — Next has not bound the port yet, so this never targets the
 * process tree that is about to start. Cross-platform, never throws.
 */

import { execSync } from "node:child_process";

const PORT = Number(process.env.WEB_PORT ?? 3000);
const IS_WIN = process.platform === "win32";
const SELF_PID = process.pid;
const PPID = process.ppid;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[free-web] ${msg}`);
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

const victims = pidsOnPort(PORT);
if (victims.length === 0) {
  log(`port ${PORT} free — clean`);
} else {
  log(`reaping ${victims.length} process(es) holding port ${PORT}: ${victims.join(", ")}`);
  for (const pid of victims) kill(pid);
}
log("done — port is clear for a single fresh web dev server");
