/**
 * RedisExecutionJobQueue — production queue across the API ⇄ worker boundary.
 *
 * Storage layout (all keys prefixed with `agent-runtime:exec-jobs:`):
 *   - ready (LIST)              : FIFO list of ready jobIds
 *   - delayed (ZSET)             : jobIds scored by visibleAt epoch ms
 *   - inflight (ZSET)            : jobIds scored by visibility deadline epoch ms
 *   - jobs:{jobId} (STRING JSON) : serialised ExecutionJob payload
 *   - receipts:{receiptId} (STR) : receiptId → jobId mapping for ack/nack
 *
 * Delivery loop (per consumer):
 *   1. Promote delayed → ready (ZRANGEBYSCORE up to now, LPUSH ready, ZREM)
 *   2. Promote stale in-flight → ready (ZRANGEBYSCORE inflight up to now, LPUSH ready, ZREM)
 *   3. BRPOP ready (block briefly)
 *   4. Mint receiptId, ZADD inflight with deadline = now + visibilityMs
 *   5. Yield { receiptId, job } to caller
 *
 * Ack:
 *   - DEL jobs:{jobId}, DEL receipts:{receiptId}, ZREM inflight {jobId}
 *
 * Nack:
 *   - If retryDelayMs > 0: ZADD delayed {jobId} score=now+retryDelayMs
 *   - Else: LPUSH ready {jobId}
 *   - ZREM inflight {jobId}, DEL receipts:{receiptId}
 *
 * Idempotency:
 *   - Enqueue checks jobs:{jobId} via SET NX; duplicate enqueue is a no-op.
 *
 * What this NOT does:
 *   - It does not implement Redis Streams consumer groups. We deliberately
 *     use plain LIST/ZSET primitives so visibility timeout semantics and
 *     delayed-retry are explicit and inspectable from redis-cli.
 *   - It does not persist beyond Redis. Redis AOF/RDB is the durability tier.
 *     For stronger durability, use Postgres-backed deduplication on the API
 *     side (executions table) — a lost job is recovered by the BackgroundRecoveryLoop
 *     re-enqueueing on lease expiry.
 */

import { Redis } from "ioredis";
import type {
  ConsumeOptions,
  ExecutionJob,
  ExecutionJobQueue,
  QueueDepthSnapshot,
  QueuedJobMessage
} from "../../domain/jobQueue.js";
import { createRedisClient } from "../reliability/redisClient.js";

const PREFIX = "agent-runtime:exec-jobs:";
const READY_KEY = `${PREFIX}ready`;
const DELAYED_KEY = `${PREFIX}delayed`;
const INFLIGHT_KEY = `${PREFIX}inflight`;
const JOB_KEY = (id: string) => `${PREFIX}jobs:${id}`;
const RECEIPT_KEY = (id: string) => `${PREFIX}receipts:${id}`;

export interface RedisQueueOptions {
  url: string;
  /** Visibility timeout in ms — un-acked deliveries become re-deliverable after this. */
  visibilityMs?: number;
  /** Optional custom Redis client (e.g., test harness). */
  client?: Redis;
}

export class RedisExecutionJobQueue implements ExecutionJobQueue {
  private readonly producer: Redis;
  private readonly consumers: Redis[] = [];
  private readonly visibilityMs: number;
  private closed = false;

  constructor(opts: RedisQueueOptions) {
    this.producer =
      opts.client ?? createRedisClient(opts.url, { name: "job-queue-producer" });
    this.visibilityMs = opts.visibilityMs ?? 30_000;
  }

  async enqueue(job: ExecutionJob): Promise<void> {
    if (this.closed) throw new Error("RedisExecutionJobQueue: closed");
    const payload = JSON.stringify(job);
    // Idempotency: NX on the job key. A duplicate jobId is dropped silently.
    const set = await this.producer.set(JOB_KEY(job.jobId), payload, "NX");
    if (set !== "OK") return;

    const visibleAt = job.notBefore ? new Date(job.notBefore).getTime() : Date.now();
    if (visibleAt > Date.now()) {
      await this.producer.zadd(DELAYED_KEY, visibleAt, job.jobId);
    } else {
      await this.producer.lpush(READY_KEY, job.jobId);
    }
  }

  consume(opts: ConsumeOptions): AsyncIterable<QueuedJobMessage> {
    // Each consumer is a dedicated connection so BRPOP blocking does not
    // starve other queue operations on the producer client. Inherits the
    // producer's url + hardened retry policy.
    const producerOpts = this.producer.options as { host?: string; port?: number };
    const consumer = new Redis({
      ...(this.producer.options as Redis["options"]),
      host: producerOpts.host,
      port: producerOpts.port,
      // BRPOP blocks; cap per-command retries away so ioredis does not
      // re-issue the command underneath us.
      maxRetriesPerRequest: null,
      retryStrategy: (times: number) => Math.min(5_000, 50 * Math.pow(2, Math.min(times, 7))),
      reconnectOnError: (err: Error) => err.message.startsWith("READONLY"),
      enableReadyCheck: true
    });
    consumer.on("error", (err) =>
      // eslint-disable-next-line no-console
      console.error(`[redis:job-queue-consumer:${opts.workerId}] ${err.message}`)
    );
    this.consumers.push(consumer);
    const blockSec = Math.max(1, Math.floor((opts.blockMs ?? 5_000) / 1_000));
    const visibilityMs = this.visibilityMs;
    const workerId = opts.workerId;
    const self = this;

    return {
      [Symbol.asyncIterator](): AsyncIterator<QueuedJobMessage> {
        return {
          async next(): Promise<IteratorResult<QueuedJobMessage>> {
            while (!self.closed) {
              await self.promoteDelayed();
              await self.promoteStaleInflight();

              // BRPOP returns [key, value] or null on timeout.
              const popped = (await consumer.brpop(READY_KEY, blockSec)) as
                | [string, string]
                | null;
              if (!popped) continue;
              const jobId = popped[1];

              const raw = await self.producer.get(JOB_KEY(jobId));
              if (!raw) continue; // job key vanished (acked elsewhere)

              let job: ExecutionJob;
              try {
                job = JSON.parse(raw) as ExecutionJob;
              } catch {
                // Corrupt payload — drop and continue
                await self.producer.del(JOB_KEY(jobId));
                continue;
              }

              const receiptId = `redis:${workerId}:${Date.now()}:${Math.random()
                .toString(36)
                .slice(2, 10)}`;
              const visibilityDeadline = Date.now() + visibilityMs;
              await self.producer
                .multi()
                .zadd(INFLIGHT_KEY, visibilityDeadline, jobId)
                .set(RECEIPT_KEY(receiptId), jobId, "EX", Math.max(60, Math.floor(visibilityMs / 1_000) * 2))
                .exec();

              return { value: { receiptId, job }, done: false };
            }
            await consumer.quit().catch(() => undefined);
            return { value: undefined, done: true };
          },
          async return(): Promise<IteratorResult<QueuedJobMessage>> {
            await consumer.quit().catch(() => undefined);
            return { value: undefined, done: true };
          }
        };
      }
    };
  }

  async ack(receiptId: string): Promise<void> {
    const jobId = await this.producer.get(RECEIPT_KEY(receiptId));
    if (!jobId) return;
    await this.producer
      .multi()
      .del(JOB_KEY(jobId))
      .del(RECEIPT_KEY(receiptId))
      .zrem(INFLIGHT_KEY, jobId)
      .exec();
  }

  async nack(receiptId: string, _reason: string, retryDelayMs: number): Promise<void> {
    const jobId = await this.producer.get(RECEIPT_KEY(receiptId));
    if (!jobId) return;
    const tx = this.producer.multi().del(RECEIPT_KEY(receiptId)).zrem(INFLIGHT_KEY, jobId);
    if (retryDelayMs > 0) {
      tx.zadd(DELAYED_KEY, Date.now() + retryDelayMs, jobId);
    } else {
      tx.lpush(READY_KEY, jobId);
    }
    await tx.exec();
  }

  async depth(): Promise<QueueDepthSnapshot> {
    const [ready, inFlight, delayed] = await Promise.all([
      this.producer.llen(READY_KEY),
      this.producer.zcard(INFLIGHT_KEY),
      this.producer.zcard(DELAYED_KEY)
    ]);
    return { ready, inFlight, delayed };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.consumers.map((c) => c.quit().catch(() => undefined)));
    await this.producer.quit().catch(() => undefined);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** Move delayed jobs whose visibleAt ≤ now onto the ready list. */
  private async promoteDelayed(): Promise<void> {
    const now = Date.now();
    const ready = (await this.producer.zrangebyscore(
      DELAYED_KEY,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      "32"
    )) as string[];
    if (!ready.length) return;
    const tx = this.producer.multi();
    for (const jobId of ready) {
      tx.lpush(READY_KEY, jobId);
      tx.zrem(DELAYED_KEY, jobId);
    }
    await tx.exec();
  }

  /** Move in-flight jobs whose visibility deadline ≤ now back to ready. */
  private async promoteStaleInflight(): Promise<void> {
    const now = Date.now();
    const stale = (await this.producer.zrangebyscore(
      INFLIGHT_KEY,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      "32"
    )) as string[];
    if (!stale.length) return;
    const tx = this.producer.multi();
    for (const jobId of stale) {
      tx.lpush(READY_KEY, jobId);
      tx.zrem(INFLIGHT_KEY, jobId);
    }
    await tx.exec();
  }
}
