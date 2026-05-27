/**
 * Public chaos API. Importers should only depend on this module so the
 * internal layout (controller / proxies / metrics) can evolve without
 * breaking call sites.
 *
 * The runtime entry points (server.ts / workerProcess.ts) do not import this
 * file; the proxies are layered on at the client factory level inside
 * redisClient.ts and pgClient.ts. That keeps the chaos surface a single
 * env-flag away from being a no-op everywhere.
 */

export { isChaosEnabled, assertChaosSafeEnvironment, chaosEnvironmentSnapshot } from "./chaosConfig.js";
export {
  ChaosController,
  chaosController,
  __setChaosControllerForTests,
  type ChaosEvent,
  type ChaosEventKind,
  type ChaosScenario,
  type ChaosMetricsSnapshot
} from "./chaosController.js";
export { wrapRedisWithChaos } from "./redisChaosProxy.js";
export { wrapPgClientWithChaos } from "./pgChaosProxy.js";
