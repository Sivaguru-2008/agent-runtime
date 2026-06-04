/**
 * watcherLock.test.ts — Unit tests for dev-mode watcher deduplication.
 *
 * Verifies:
 *   1. First acquireWatcherLock() succeeds and creates a lock file.
 *   2. Second acquireWatcherLock() fails when a live process holds the lock.
 *   3. A stale lock (dead PID) is reclaimed successfully.
 *   4. releaseWatcherLock() removes the lock file.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWatcherLock, releaseWatcherLock } from "../src/infrastructure/reliability/watcherLock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_LOCK_DIR = resolve(HERE, "..", ".test-lock-dir");
const LOCK_FILENAME = ".api-dev.lock";

describe("watcherLock", () => {
  beforeEach(() => {
    // Create a fresh temp directory for each test
    mkdirSync(TEST_LOCK_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    try {
      rmSync(TEST_LOCK_DIR, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  describe("acquireWatcherLock", () => {
    it("acquires the lock when no lock file exists", () => {
      const result = acquireWatcherLock(TEST_LOCK_DIR);

      expect(result.acquired).toBe(true);
      expect(existsSync(join(TEST_LOCK_DIR, LOCK_FILENAME))).toBe(true);

      // Lock file should contain our PID
      const content = JSON.parse(readFileSync(join(TEST_LOCK_DIR, LOCK_FILENAME), "utf8"));
      expect(content.pid).toBe(process.pid);
      expect(content.timestamp).toBeDefined();
      expect(content.startedAt).toBeGreaterThan(0);
    });

    it("rejects when a live process holds the lock", () => {
      // First acquisition succeeds
      const first = acquireWatcherLock(TEST_LOCK_DIR);
      expect(first.acquired).toBe(true);

      // Second acquisition should fail (our own PID is alive)
      const second = acquireWatcherLock(TEST_LOCK_DIR);
      expect(second.acquired).toBe(false);
      expect(second.holder).toBeDefined();
      expect(second.holder!.pid).toBe(process.pid);
    });

    it("reclaims a stale lock from a dead process", () => {
      // Write a lock file with a PID that's almost certainly dead
      // PID 99999999 is unlikely to be alive on any real system
      const staleLock = {
        pid: 99999999,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        startedAt: Date.now() - 60_000
      };
      writeFileSync(
        join(TEST_LOCK_DIR, LOCK_FILENAME),
        JSON.stringify(staleLock, null, 2),
        "utf8"
      );

      // Should reclaim the stale lock
      const result = acquireWatcherLock(TEST_LOCK_DIR);
      expect(result.acquired).toBe(true);

      // Verify the lock now has our PID
      const content = JSON.parse(readFileSync(join(TEST_LOCK_DIR, LOCK_FILENAME), "utf8"));
      expect(content.pid).toBe(process.pid);
    });

    it("handles corrupted lock files gracefully", () => {
      // Write garbage to the lock file
      writeFileSync(join(TEST_LOCK_DIR, LOCK_FILENAME), "not-json-at-all", "utf8");

      // Should treat corrupted lock as reclaimable
      const result = acquireWatcherLock(TEST_LOCK_DIR);
      expect(result.acquired).toBe(true);
    });
  });

  describe("releaseWatcherLock", () => {
    it("removes the lock file", () => {
      // Acquire first
      const result = acquireWatcherLock(TEST_LOCK_DIR);
      expect(result.acquired).toBe(true);
      expect(existsSync(join(TEST_LOCK_DIR, LOCK_FILENAME))).toBe(true);

      // Release
      releaseWatcherLock(TEST_LOCK_DIR);
      expect(existsSync(join(TEST_LOCK_DIR, LOCK_FILENAME))).toBe(false);
    });

    it("only releases if current process owns the lock", () => {
      // Write a lock for a different PID
      const otherLock = {
        pid: 99999999,
        timestamp: new Date().toISOString(),
        startedAt: Date.now()
      };
      writeFileSync(
        join(TEST_LOCK_DIR, LOCK_FILENAME),
        JSON.stringify(otherLock, null, 2),
        "utf8"
      );

      // Release should NOT remove the lock (we don't own it)
      releaseWatcherLock(TEST_LOCK_DIR);
      expect(existsSync(join(TEST_LOCK_DIR, LOCK_FILENAME))).toBe(true);
    });

    it("is safe to call when no lock file exists", () => {
      // Should not throw
      expect(() => releaseWatcherLock(TEST_LOCK_DIR)).not.toThrow();
    });
  });
});
