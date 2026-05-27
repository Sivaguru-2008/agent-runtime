import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

/**
 * Deterministic ID generation for replayable cognition.
 *
 * Goal: identical (executionId, sequence, role, fingerprint) → identical ID.
 * Hash of a stable, canonical JSON projection of the inputs. No timestamps.
 */
export function deterministicId(parts: ReadonlyArray<string | number | null | undefined>): string {
  const canonical = parts
    .map((part) => (part === undefined || part === null ? "" : String(part)))
    .join(" ");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Bounded cycle protection and iterative traversal for V8 performance
export function canonicalize(value: unknown): string {
  const seen = new Set<unknown>();
  
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  interface StackFrame {
    value: unknown;
    keys?: string[];
    index: number;
    isObject: boolean;
    isArray: boolean;
    parts: string[];
  }

  const stack: StackFrame[] = [];
  
  function makeFrame(val: unknown): StackFrame {
    const isObj = typeof val === "object" && val !== null;
    const isArr = Array.isArray(val);
    let keys: string[] | undefined;
    if (isObj && !isArr) {
      keys = Object.keys(val as Record<string, unknown>).sort();
    }
    return {
      value: val,
      keys,
      index: 0,
      isObject: isObj && !isArr,
      isArray: isArr,
      parts: []
    };
  }

  stack.push(makeFrame(value));
  seen.add(value);

  let result = "";

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.isArray) {
      const arr = frame.value as unknown[];
      if (frame.index < arr.length) {
        const item = arr[frame.index];
        frame.index++;
        if (item !== null && typeof item === "object") {
          if (seen.has(item)) {
            throw new Error("Circular reference detected in canonicalization");
          }
          seen.add(item);
          stack.push(makeFrame(item));
        } else {
          frame.parts.push(JSON.stringify(item));
        }
      } else {
        const serialized = "[" + frame.parts.join(",") + "]";
        seen.delete(frame.value);
        stack.pop();
        if (stack.length > 0) {
          stack[stack.length - 1].parts.push(serialized);
        } else {
          result = serialized;
        }
      }
    } else if (frame.isObject) {
      const obj = frame.value as Record<string, unknown>;
      const keys = frame.keys!;
      if (frame.index < keys.length) {
        const key = keys[frame.index];
        const val = obj[key];
        frame.index++;

        const prefix = JSON.stringify(key) + ":";
        if (val !== null && typeof val === "object") {
          if (seen.has(val)) {
            throw new Error("Circular reference detected in canonicalization");
          }
          seen.add(val);
          frame.parts.push(prefix);
          stack.push(makeFrame(val));
        } else {
          frame.parts.push(prefix + JSON.stringify(val));
        }
      } else {
        const assembledParts: string[] = [];
        for (let i = 0; i < frame.parts.length; i++) {
          const part = frame.parts[i];
          if (part.endsWith(":")) {
            const val = frame.parts[i + 1];
            assembledParts.push(part + val);
            i++;
          } else {
            assembledParts.push(part);
          }
        }
        const serialized = "{" + assembledParts.join(",") + "}";
        seen.delete(frame.value);
        stack.pop();
        if (stack.length > 0) {
          stack[stack.length - 1].parts.push(serialized);
        } else {
          result = serialized;
        }
      }
    } else {
      result = JSON.stringify(frame.value);
      stack.pop();
    }
  }

  return result;
}

let fingerprintWorker: Worker | null = null;
const pendingCallbacks = new Map<number, { resolve: (res: string) => void; reject: (err: Error) => void }>();
let nextTaskId = 0;

function getFingerprintWorker(): Worker {
  if (!fingerprintWorker) {
    const workerCode = `
      const { parentPort } = require("node:worker_threads");
      const { createHash } = require("node:crypto");

      parentPort.on("message", ({ id, value }) => {
        try {
          const canonical = canonicalize(value);
          const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
          parentPort.postMessage({ id, hash });
        } catch (err) {
          parentPort.postMessage({ id, error: err.message });
        }
      });

      function canonicalize(value) {
        const seen = new Set();
        if (value === null || typeof value !== "object") {
          return JSON.stringify(value);
        }

        const stack = [];

        function makeFrame(val) {
          const isObj = typeof val === "object" && val !== null;
          const isArr = Array.isArray(val);
          let keys;
          if (isObj && !isArr) {
            keys = Object.keys(val).sort();
          }
          return {
            value: val,
            keys,
            index: 0,
            isObject: isObj && !isArr,
            isArray: isArr,
            parts: []
          };
        }

        stack.push(makeFrame(value));
        seen.add(value);

        let result = "";

        while (stack.length > 0) {
          const frame = stack[stack.length - 1];

          if (frame.isArray) {
            const arr = frame.value;
            if (frame.index < arr.length) {
              const item = arr[frame.index];
              frame.index++;
              if (item !== null && typeof item === "object") {
                if (seen.has(item)) {
                  throw new Error("Circular reference detected in canonicalization");
                }
                seen.add(item);
                stack.push(makeFrame(item));
              } else {
                frame.parts.push(JSON.stringify(item));
              }
            } else {
              const serialized = "[" + frame.parts.join(",") + "]";
              seen.delete(frame.value);
              stack.pop();
              if (stack.length > 0) {
                stack[stack.length - 1].parts.push(serialized);
              } else {
                result = serialized;
              }
            }
          } else if (frame.isObject) {
            const obj = frame.value;
            const keys = frame.keys;
            if (frame.index < keys.length) {
              const key = keys[frame.index];
              const val = obj[key];
              frame.index++;

              const prefix = JSON.stringify(key) + ":";
              if (val !== null && typeof val === "object") {
                if (seen.has(val)) {
                  throw new Error("Circular reference detected in canonicalization");
                }
                seen.add(val);
                frame.parts.push(prefix);
                stack.push(makeFrame(val));
              } else {
                frame.parts.push(prefix + JSON.stringify(val));
              }
            } else {
              const assembledParts = [];
              for (let i = 0; i < frame.parts.length; i++) {
                const part = frame.parts[i];
                if (part.endsWith(":")) {
                  const val = frame.parts[i + 1];
                  assembledParts.push(part + val);
                  i++;
                } else {
                  assembledParts.push(part);
                }
              }
              const serialized = "{" + assembledParts.join(",") + "}";
              seen.delete(frame.value);
              stack.pop();
              if (stack.length > 0) {
                stack[stack.length - 1].parts.push(serialized);
              } else {
                result = serialized;
              }
            }
          } else {
            result = JSON.stringify(frame.value);
            stack.pop();
          }
        }

        return result;
      }
    `;

    fingerprintWorker = new Worker(workerCode, { eval: true });
    fingerprintWorker.on("message", ({ id, hash, error }) => {
      const cb = pendingCallbacks.get(id);
      if (cb) {
        pendingCallbacks.delete(id);
        if (error) {
          cb.reject(new Error(error));
        } else {
          cb.resolve(hash);
        }
      }
    });
    fingerprintWorker.on("error", (err) => {
      for (const [_, cb] of pendingCallbacks.entries()) {
        cb.reject(err);
      }
      pendingCallbacks.clear();
      fingerprintWorker = null;
    });
    fingerprintWorker.unref();
  }
  return fingerprintWorker;
}

export function syncFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex").slice(0, 16);
}

/**
 * Stable fingerprint for an arbitrary JSON-compatible value: independent of key order.
 * Used to detect "same inputs → same output" replay equivalence.
 */
export function fingerprint(value: unknown): Promise<string> {
  if (value === null || typeof value !== "object") {
    return Promise.resolve(syncFingerprint(value));
  }

  let isSmall = false;
  let syncResult = "";
  try {
    const stringified = JSON.stringify(value);
    if (stringified.length < 4096) {
      isSmall = true;
      syncResult = syncFingerprint(value);
    }
  } catch {
    // If stringify fails (circular), let the worker execute and throw its error
  }

  if (isSmall) {
    return Promise.resolve(syncResult);
  }

  return new Promise((resolve, reject) => {
    const worker = getFingerprintWorker();
    const id = nextTaskId++;
    pendingCallbacks.set(id, { resolve, reject });
    worker.postMessage({ id, value });
  });
}

/**
 * Lehmer-style seeded PRNG. Stable across runs given the same seed.
 * Used by the deterministic model provider so replay is bit-identical.
 */
export function seededRandom(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i++) {
    state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  }
  if (state === 0) state = 1;
  return () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
}
