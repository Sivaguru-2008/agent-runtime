/**
 * watcherLockTakeover.test.ts — the dev single-instance take-over helpers.
 *
 * These back the root-cause fix: the lock now lives outside the watched tree,
 * liveness detection is robust, and a previous holder can be terminated so the
 * newest instance takes over instead of exiting into a zombie watcher.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import {
  defaultWatcherLockDir,
  isPidAlive,
  terminateLockHolder
} from "../src/infrastructure/reliability/watcherLock.js";

describe("defaultWatcherLockDir", () => {
  it("anchors the lock in the OS temp dir, OUT of the watched source tree", () => {
    const dir = defaultWatcherLockDir();
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toContain("agent-runtime-api");
    // It must NOT be inside apps/api/src where tsx watch would observe it.
    expect(dir.replace(/\\/g, "/")).not.toContain("apps/api/src");
  });
});

describe("isPidAlive", () => {
  it("reports the current process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("reports an implausible PID as dead", () => {
    expect(isPidAlive(99_999_999)).toBe(false);
  });
});

describe("terminateLockHolder", () => {
  it("returns alreadyDead for a PID that is not running", async () => {
    const result = await terminateLockHolder(99_999_999, 200);
    expect(result.terminated).toBe(true);
    expect(result.alreadyDead).toBe(true);
  });
});
