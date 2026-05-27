/**
 * redisChaosProxy — wraps an ioredis client to inject controlled faults.
 *
 * Faults injected (gated by ChaosController scenarios):
 *   - redis.latency      Adds `ms` of delay before forwarding each command.
 *   - redis.disconnect   Calls `disconnect()` synchronously to force the
 *                        client through its retry strategy. Models a network
 *                        blip / replica failover. Optionally with `count` to
 *                        do this on N consecutive commands.
 *   - redis.pubsubDrop   Discards `publish()` payloads silently — models a
 *                        partial pub/sub failure where the producer believes
 *                        the message went out but no subscriber will see it.
 *   - redis.ackDelay     Adds latency only on the ack/commit paths used by
 *                        the queue layer (MULTI / EXEC), simulating slow
 *                        commit-log acknowledgement.
 *
 * What this does NOT mock:
 *   The underlying Redis is a real connection. Faults are layered on top of
 *   real I/O so we exercise the real driver, real reconnect logic, real
 *   pipeline handling. The proxy ONLY adds delay or short-circuits — it never
 *   fabricates responses.
 *
 * The proxy is implemented with a JS Proxy so every existing ioredis method
 * (hundreds of them) is covered without an explicit wrapper per command.
 * Only the commands we want to fault-inject are intercepted; everything else
 * passes through unchanged.
 */

import type { Redis } from "ioredis";
import { chaosController } from "./chaosController.js";
import { assertChaosSafeEnvironment, isChaosEnabled } from "./chaosConfig.js";

// Commands that perform an actual write commit and whose latency should be
// delayed by `redis.ackDelay`. Pipeline constructors (`multi`, `pipeline`) are
// deliberately EXCLUDED — they return a synchronous Pipeline object that the
// caller chains additional methods onto; wrapping them in a setTimeout/Promise
// would turn the return value into a Promise<Pipeline> and break the chain
// (caller would call `.zadd` on a Promise). The delay is applied to `exec()`
// instead, which is genuinely async and is the actual commit boundary.
const COMMIT_LIKE = new Set(["exec", "set", "lpush", "rpush", "zadd"]);

// Synchronous methods that return chainable objects. The proxy must pass them
// straight through — never wrap them in latency/ackDelay timers — because the
// caller chains further calls on the return value synchronously.
const PIPELINE_CONSTRUCTORS = new Set(["multi", "pipeline"]);

export function wrapRedisWithChaos(client: Redis): Redis {
  if (!isChaosEnabled()) return client;
  assertChaosSafeEnvironment();

  const controller = chaosController();

  return new Proxy(client, {
    get(target: Redis, prop: string | symbol, receiver: unknown): unknown {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") return original;

      // Don't intercept lifecycle hooks; they are called by ioredis internals
      // and proxying them changes `this` binding semantics in ways that break
      // event emitter behaviour.
      if (
        prop === "on" ||
        prop === "off" ||
        prop === "once" ||
        prop === "emit" ||
        prop === "removeListener" ||
        prop === "removeAllListeners" ||
        prop === "addListener" ||
        prop === "listeners" ||
        prop === "rawListeners" ||
        prop === "eventNames" ||
        prop === "listenerCount" ||
        prop === "setMaxListeners" ||
        prop === "getMaxListeners" ||
        prop === "quit" ||
        prop === "disconnect" ||
        prop === "connect"
      ) {
        return original.bind(target);
      }

      const fnName = typeof prop === "string" ? prop.toLowerCase() : "";

      // Pipeline constructors return a synchronous Pipeline that the caller
      // chains methods on — pass them straight through with no delay wrapping.
      if (PIPELINE_CONSTRUCTORS.has(fnName)) {
        return original.bind(target);
      }

      return function chaosWrapped(this: unknown, ...args: unknown[]): unknown {
        // 1) publish() short-circuit
        if (fnName === "publish") {
          if (controller.maybeFire("redis.pubsubDrop", { channel: String(args[0] ?? "") })) {
            // Resolve with 0 subscribers — same shape as a real publish with
            // no listeners. Caller cannot distinguish.
            return Promise.resolve(0);
          }
        }

        // 2) latency injection on ALL data commands
        const latencyPayload = controller.maybeFire("redis.latency", { command: fnName });

        // 3) ack/commit-path delay
        const ackPayload =
          COMMIT_LIKE.has(fnName)
            ? controller.maybeFire("redis.ackDelay", { command: fnName })
            : null;

        const runOriginal = (): unknown => (original as (...a: unknown[]) => unknown).apply(target, args);

        // 4) disconnect storm — forces the client through retryStrategy
        const disconnectPayload = controller.maybeFire("redis.disconnect", { command: fnName });
        if (disconnectPayload) {
          // Trigger a disconnect ON THE SAME TICK as the command. The
          // command itself is allowed to proceed; ioredis's queue and
          // reconnect path then handle re-issue. This is the canonical
          // network-blip model.
          try {
            (target as unknown as { disconnect: (reconnect?: boolean) => void }).disconnect(true);
          } catch {
            /* ignore — defensive */
          }
        }

        const totalDelay =
          (Number((latencyPayload as { ms?: number } | null)?.ms ?? 0) || 0) +
          (Number((ackPayload as { ms?: number } | null)?.ms ?? 0) || 0);

        if (totalDelay > 0) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              Promise.resolve(runOriginal()).then(resolve, reject);
            }, totalDelay);
          });
        }

        return runOriginal();
      };
    }
  });
}
