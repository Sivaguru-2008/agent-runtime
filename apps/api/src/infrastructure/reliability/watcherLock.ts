/**
 * watcherLock — Prevents multiple dev-mode watcher instances.
 *
 * When `tsx watch` (or nodemon, etc.) restarts a process on file change,
 * it's possible for multiple instances to race if the developer runs
 * `npm run dev:api` in two terminals. This module uses a simple lock file
 * containing `{ pid, timestamp }` to detect and reject duplicate instances.
 *
 * Lock acquisition rules:
 *   1. If no lock file exists → acquire (create file with current PID).
 *   2. If lock file exists and PID is alive → reject (another instance is running).
 *   3. If lock file exists but PID is dead → reclaim (stale lock from a crashed process).
 *
 * The lock is automatically released on process exit (normal, SIGINT, SIGTERM).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_FILENAME = ".api-dev.lock";

/**
 * Canonical lock directory for the running API.
 *
 * Root-cause fix: the lock was previously written into `apps/api/` — INSIDE the
 * directory tree that `tsx watch` observes. A file written on every boot inside
 * the watched tree is a restart hazard. Anchoring the lock in the OS temp
 * directory removes it from the watch scope entirely, so writing it can never
 * trigger a reload, and keeps it per-machine rather than committed to the repo.
 */
export function defaultWatcherLockDir(): string {
  return join(tmpdir(), "agent-runtime-api");
}

interface LockContent {
  pid: number;
  timestamp: string;
  startedAt: number;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, does not kill
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user — still alive.
    // Any other error (ESRCH) means it is gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Terminate a previous dev instance so the newest `npm run dev` / watcher
 * restart can take over port 4000. Best-effort and cross-platform:
 *   • POSIX: SIGTERM, then SIGKILL if it has not exited within the grace window.
 *   • Windows: process.kill maps to TerminateProcess (there is no graceful
 *     SIGTERM), which frees the bound socket immediately.
 *
 * Returns once the PID is confirmed gone or the timeout elapses. Never throws —
 * a failure to kill is reported via `terminated:false` so the caller can decide
 * whether to refuse the boot.
 */
export async function terminateLockHolder(
  pid: number,
  graceMs = 3_000
): Promise<{ terminated: boolean; alreadyDead: boolean }> {
  if (!isPidAlive(pid)) return { terminated: true, alreadyDead: true };

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Could not even signal it — fall through to the liveness poll.
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return { terminated: true, alreadyDead: false };
    await sleep(100);
  }

  // Still alive after the grace window — escalate to a hard kill.
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* best effort */
  }
  // Brief final confirmation poll.
  const hardDeadline = Date.now() + 1_000;
  while (Date.now() < hardDeadline) {
    if (!isPidAlive(pid)) return { terminated: true, alreadyDead: false };
    await sleep(100);
  }
  return { terminated: !isPidAlive(pid), alreadyDead: false };
}

/**
 * Attempt to acquire the dev-mode watcher lock.
 *
 * @param lockDir Directory where the lock file will be placed (typically `apps/api/`).
 * @returns `{ acquired: true }` on success, or `{ acquired: false, holder: { pid, timestamp } }` if
 *          another live instance holds the lock.
 */
export function acquireWatcherLock(lockDir: string): {
  acquired: boolean;
  holder?: LockContent;
  lockPath: string;
} {
  const lockPath = join(lockDir, LOCK_FILENAME);

  // Ensure the directory exists (should always exist for apps/api, but be safe)
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, "utf8");
      const existing: LockContent = JSON.parse(raw);

      if (typeof existing.pid === "number" && isPidAlive(existing.pid)) {
        // Another live instance holds the lock
        return { acquired: false, holder: existing, lockPath };
      }

      // Stale lock — PID is dead. Reclaim it.
    } catch {
      // Corrupted lock file — remove and re-acquire
    }

    // Remove stale/corrupt lock
    try {
      unlinkSync(lockPath);
    } catch {
      // Best effort
    }
  }

  // Write new lock
  const content: LockContent = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    startedAt: Date.now()
  };

  writeFileSync(lockPath, JSON.stringify(content, null, 2), "utf8");

  return { acquired: true, lockPath };
}

/**
 * Release the watcher lock. Safe to call multiple times.
 */
export function releaseWatcherLock(lockDir: string): void {
  const lockPath = join(lockDir, LOCK_FILENAME);
  try {
    if (existsSync(lockPath)) {
      // Only delete if WE own it (our PID)
      const raw = readFileSync(lockPath, "utf8");
      const existing: LockContent = JSON.parse(raw);
      if (existing.pid === process.pid) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    // Best effort — process is exiting anyway
  }
}

/**
 * Register automatic lock release on process exit signals.
 * Call this after a successful acquireWatcherLock().
 */
export function registerLockCleanup(lockDir: string): void {
  const cleanup = () => releaseWatcherLock(lockDir);

  process.on("exit", cleanup);
}
