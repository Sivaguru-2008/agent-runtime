#!/usr/bin/env node
/**
 * guard-web-build.mjs — refuse to run `next build` while a dev server holds
 * port 3000.
 *
 * The trap this makes impossible: `next dev` and `next build` share the same
 * `.next` directory. Running a production build while the dev server is live
 * corrupts the dev server's chunk manifest — every page starts returning 500
 * and open tabs throw ChunkLoadError until the dev server is stopped and
 * `.next` is deleted. This bit twice on 2026-06-12.
 *
 * Wired as `prebuild` in apps/web. CI and production image builds are
 * unaffected (nothing listens on 3000 there). Escape hatch for the rare
 * intentional case: SKIP_BUILD_GUARD=1.
 */

import { execSync } from "node:child_process";

const PORT = Number(process.env.WEB_PORT ?? 3000);

if (process.env.SKIP_BUILD_GUARD === "1") {
  console.log("[guard-web-build] SKIP_BUILD_GUARD=1 — skipping dev-server check");
  process.exit(0);
}

function portIsListening(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
        windowsHide: true
      });
      return out
        .split(/\r?\n/)
        .some((line) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`).test(line));
    }
    execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" });
    return true; // lsof exits 0 only when something matched
  } catch {
    return false; // findstr/lsof exit non-zero when nothing matches
  }
}

if (portIsListening(PORT)) {
  console.error(
    `[guard-web-build] REFUSING to build: a dev server is listening on port ${PORT}.\n` +
      `  next build and next dev share .next — building now would corrupt the live\n` +
      `  dev server (every page 500s + ChunkLoadError) until .next is wiped.\n` +
      `  Stop the dev server first (Ctrl+C / close the task), then re-run the build.\n` +
      `  Intentional override: SKIP_BUILD_GUARD=1 npm run build`
  );
  process.exit(1);
}

console.log(`[guard-web-build] port ${PORT} quiet — safe to build`);
