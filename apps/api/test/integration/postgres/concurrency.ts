/**
 * Concurrent worker / contention helpers for the lease + event store suites.
 *
 * These produce repeatable concurrent invocations without spawning child
 * processes — Node's event loop interleaves the awaits, and our adapters use
 * the Postgres pool so each `withTransaction` runs in its own underlying
 * connection. That's enough to validate `FOR UPDATE SKIP LOCKED` and parallel
 * append safety without leaving the test process.
 */

export interface FanOutResult<T> {
  results: T[];
  errors: unknown[];
}

/**
 * Invoke `fn(idx)` `count` times in parallel and collect both fulfilled
 * results and rejections. Used to verify that exactly K of N concurrent
 * lease acquires succeed.
 */
export async function fanOut<T>(count: number, fn: (idx: number) => Promise<T>): Promise<FanOutResult<T>> {
  const settled = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => fn(i))
  );
  const results: T[] = [];
  const errors: unknown[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(s.value);
    else errors.push(s.reason);
  }
  return { results, errors };
}

/**
 * Run `fn` `count` times in parallel and assert that every invocation throws
 * is *not* the expected case — we want successful concurrency. The return
 * preserves ordering by invocation index so callers can correlate `success`
 * to a worker id.
 */
export async function parallelMap<T, R>(
  items: readonly T[],
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  return Promise.all(items.map((item, idx) => fn(item, idx)));
}

/**
 * Resolves on the next microtask after `ms` real milliseconds. Tests that
 * involve real time (heartbeat expiry crossing wall clock) need a real sleep;
 * everything else should use the ManualClock.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until `predicate()` returns true or `timeoutMs` elapses. Returns
 * `true` if satisfied, `false` if timed out. Used by chaos tests waiting
 * for an async recovery to complete.
 */
export async function eventually(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Shuffle an array using a stable seed so test reorderings are reproducible.
 * Used in replay tests to verify retrieval-order independence.
 */
export function shuffleDeterministic<T>(items: readonly T[], seed: string): T[] {
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  if (state === 0) state = 1;
  const next = () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
