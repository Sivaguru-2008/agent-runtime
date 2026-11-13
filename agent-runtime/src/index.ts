/**
 * agent-runtime — the unified runtime intelligence layer.
 *
 * One pipeline, eight stages, one runId:
 *   predict (1) · watch (2) · validate (3) · fence (4) ·
 *   explain (5) · intervene (6) · learn (7) · evaluate (8)
 */
export { Runtime } from "./runtime.js";
export type { RuntimeOptions, RunResult } from "./runtime.js";

export { RuntimeDB } from "./db/database.js";
export { renderPanel } from "./panel.js";

export { GroqClient, ScriptedClient, estimateCostUSD, extractJson, tokenize } from "./llm/client.js";
export type { LLMClient, ChatRequest, StreamResult } from "./llm/client.js";
export { readGroqEnv, loadEnv } from "./llm/env.js";

export { TOOLS, defaultEffectMap, toolNames, toolCatalogText } from "./tools/registry.js";
export type { ToolDef, ToolResult } from "./tools/registry.js";

// Stage modules, exported so they can be used / tested individually.
export { extractIntent, runPreFlight, heuristicPreFlight, heuristicIntent } from "./stages/preflight.js";
export { StreamAnalyzer } from "./stages/streamAnalyzer.js";
export { validateStep, scoreQuality, isEmptyResult } from "./stages/stepValidator.js";
export { FenceEnforcer } from "./stages/fenceEnforcement.js";
export { buildCausalChain, hasFailure, deriveFailureType } from "./stages/causalAttribution.js";
export { InterventionEngine } from "./stages/intervention.js";
export { PatternLearner } from "./stages/patternLearner.js";
export { evaluateFinal } from "./stages/qualityEvaluator.js";

export * from "./types.js";
