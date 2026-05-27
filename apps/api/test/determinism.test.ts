import { describe, it, expect } from "vitest";
import { canonicalize, fingerprint, syncFingerprint, deterministicId } from "../src/shared/determinism.js";

describe("Determinism & Event Loop Protection Hashing Engine", () => {
  describe("Canonicalize (Iterative)", () => {
    it("should canonicalize primitive types identically to native JSON.stringify", () => {
      expect(canonicalize(null)).toBe("null");
      expect(canonicalize(42)).toBe("42");
      expect(canonicalize("hello")).toBe('"hello"');
      expect(canonicalize(true)).toBe("true");
    });

    it("should canonicalize key-sorted JSON objects independently of property insertion order", () => {
      const obj1 = { b: 2, a: 1, c: { e: 5, d: 4 } };
      const obj2 = { c: { d: 4, e: 5 }, a: 1, b: 2 };
      
      const res1 = canonicalize(obj1);
      const res2 = canonicalize(obj2);

      expect(res1).toBe(res2);
      expect(res1).toBe('{"a":1,"b":2,"c":{"d":4,"e":5}}');
    });

    it("should canonicalize arrays correctly and maintain item order", () => {
      const arr = [1, { b: 2, a: 1 }, 3];
      expect(canonicalize(arr)).toBe('[1,{"a":1,"b":2},3]');
    });

    it("should reject circular references and protect against event loop starvation", () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      expect(() => canonicalize(circular)).toThrowError("Circular reference detected");
    });
  });

  describe("Fingerprint (Async & Adaptive Worker)", () => {
    it("should generate stable, deterministic 16-character hexadecimal hashes", async () => {
      const payload = { goal: "test", steps: ["step1", "step2"], options: { debug: true } };
      const hash1 = await fingerprint(payload);
      const hash2 = await fingerprint(payload);

      expect(hash1).toHaveLength(16);
      expect(/^[0-9a-f]{16}$/.test(hash1)).toBe(true);
      expect(hash1).toBe(hash2);
    });

    it("should maintain perfect equivalence between sync and async execution", async () => {
      const largePayload = {
        id: "cognition-123",
        role: "EXECUTOR",
        history: Array.from({ length: 200 }, (_, i) => ({
          step: i,
          tokens: ["token", "confidence", "prediction"],
          meta: { duration: 1.25 * i, workerId: `worker-${i}` }
        }))
      };

      const syncHash = syncFingerprint(largePayload);
      const asyncHash = await fingerprint(largePayload);

      expect(asyncHash).toBe(syncHash);
    });

    it("should safely reject circular references asynchronously without blocking the event loop", async () => {
      const circular: any = { name: "poison-pill" };
      circular.loop = circular;

      await expect(fingerprint(circular)).rejects.toThrow("Circular reference detected");
    });

    it("should survive high concurrency stress hashing", async () => {
      const payloads = Array.from({ length: 50 }, (_, i) => ({
        index: i,
        data: `concurrency-stress-${i}`,
        nested: { key: `val-${i}`, list: [i, i + 1, i + 2] }
      }));

      const startTime = Date.now();
      const hashes = await Promise.all(payloads.map(fingerprint));
      const duration = Date.now() - startTime;

      expect(hashes).toHaveLength(50);
      hashes.forEach((hash) => {
        expect(hash).toHaveLength(16);
      });

      // Verify that parallel executions yielded identical, stable hashes when rerun
      const rerunHashes = await Promise.all(payloads.map(fingerprint));
      expect(hashes).toEqual(rerunHashes);
    });
  });

  describe("Deterministic ID Generation", () => {
    it("should produce a stable 32-character hexadecimal sha256 hash", () => {
      const parts = ["cognition-xyz", 15, "PLANNER", "c12d3e4f"];
      const id1 = deterministicId(parts);
      const id2 = deterministicId(parts);

      expect(id1).toHaveLength(32);
      expect(id1).toBe(id2);
      expect(id1).toBe("a8a84e02c534d9c40c002ac17fc1dbf6");
    });
  });
});
