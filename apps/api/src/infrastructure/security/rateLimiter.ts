/**
 * Redis Sliding-Window Rate Limiter — Fastify plugin.
 *
 * Production risk solved:
 *   Without rate limiting, a single misconfigured client or adversarial caller
 *   can saturate the execution queue, exhaust Postgres connections, or spike
 *   model API costs with no feedback signal until the system falls over.
 *
 * Algorithm — sliding window via Lua atomic script:
 *   Each request appends a timestamped member to a Redis sorted set keyed by
 *   tenant (or IP for unauthenticated paths). Old members outside the window
 *   are pruned atomically before counting, giving a true sliding window rather
 *   than the reset spikes of fixed-window counters.
 *
 * Atomicity:
 *   The entire ZREMRANGEBYSCORE → ZADD → ZCARD sequence executes as a single
 *   Redis command via EVAL. This prevents TOCTOU races under concurrent requests
 *   from the same tenant.
 *
 * Failure mode:
 *   Redis unavailability causes the limiter to FAIL OPEN (allow the request).
 *   This is an intentional tradeoff: a rate-limiter outage should not take
 *   the API offline. The alternative (fail closed) would block all traffic
 *   when Redis is temporarily unreachable during a failover.
 *
 * Headers (RFC 6585 + draft-ietf-httpapi-ratelimit-headers):
 *   X-RateLimit-Limit     — requests allowed per window
 *   X-RateLimit-Remaining — remaining requests in current window
 *   X-RateLimit-Reset     — Unix timestamp (seconds) when window resets
 *   Retry-After           — seconds to wait on 429
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Redis } from "ioredis";

export interface RateLimiterOptions {
  redis: Redis | null;
  enabled: boolean;
  defaultRpm: number;
  windowMs: number;
}

// Lua script executed atomically inside Redis.
// Returns [allowed: 0|1, current_count: number, window_reset_ms: number]
const SLIDING_WINDOW_LUA = `
local key      = KEYS[1]
local now_ms   = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]

local cutoff   = now_ms - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

local count = tonumber(redis.call('ZCARD', key))
if count >= limit then
  local oldest_set = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local reset_ms   = oldest_set[2] and (tonumber(oldest_set[2]) + window) or (now_ms + window)
  return {0, count, reset_ms}
end

redis.call('ZADD', key, now_ms, member)
redis.call('PEXPIRE', key, window + 1000)
return {1, count + 1, now_ms + window}
`;

export async function registerRateLimiter(
  app: FastifyInstance,
  opts: RateLimiterOptions
): Promise<void> {
  if (!opts.enabled) return;
  if (!opts.redis) {
    app.log.warn("Rate limiter enabled but no Redis client available — skipping");
    return;
  }

  const redis = opts.redis;
  const windowMs = opts.windowMs;
  const defaultRpm = opts.defaultRpm;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenant = request.tenant;

    // Use tenant-scoped key when authenticated, IP-based key otherwise.
    // IP-based limiting prevents unauthenticated endpoint abuse.
    const key = tenant
      ? `rl:t:${tenant.tenantId}`
      : `rl:ip:${request.ip}`;
    const limit = tenant?.rateLimitRpm ?? defaultRpm;

    const nowMs = Date.now();
    // Unique member prevents sorted-set deduplication of concurrent requests.
    const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}`;

    let allowed = true;
    let remaining = limit;
    let resetMs = nowMs + windowMs;

    try {
      const result = (await redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        String(nowMs),
        String(windowMs),
        String(limit),
        member
      )) as [number, number, number];

      allowed = result[0] === 1;
      remaining = Math.max(0, limit - result[1]);
      resetMs = result[2];
    } catch (err) {
      // Redis error — fail open, log for monitoring
      app.log.warn({ err, key }, "Rate limiter Redis error — failing open");
    }

    // Attach headers to every response (informational even on allowed requests)
    reply.header("X-RateLimit-Limit", String(limit));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(Math.floor(resetMs / 1000)));

    if (!allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));
      reply.header("Retry-After", String(retryAfterSec));
      return reply.status(429).send({
        error: "RATE_LIMIT_EXCEEDED",
        message: `Rate limit of ${limit} requests per minute exceeded`,
        retryAfterSec
      });
    }
  });
}
