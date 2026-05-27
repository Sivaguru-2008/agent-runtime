import { z } from "zod";

export const createAgentSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  model: z.object({
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    temperature: z.number().min(0).max(2).optional()
  }).optional(),
  tools: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().default(true)
  })).optional(),
  memoryPolicy: z.object({
    episodicEnabled: z.boolean().optional(),
    semanticEnabled: z.boolean().optional(),
    maxRetrievedItems: z.number().int().min(0).max(50).optional()
  }).optional()
});

export const runTaskSchema = z.object({
  prompt: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  input: z.record(z.unknown()).optional(),
  scheduleAt: z.string().datetime().optional()
}).passthrough();

export const createMemorySchema = z.object({
  type: z.enum(["EPISODIC", "TASK_HISTORY", "SEMANTIC_REFERENCE"]).default("EPISODIC"),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).default({})
});

export const registerWorkerSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  region: z.string().min(1).optional(),
  version: z.string().min(1).default("0.1.0"),
  capacity: z.number().int().positive().max(64).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const workerHeartbeatSchema = z.object({
  cpu: z.number().min(0).max(100).default(0),
  memory: z.number().min(0).max(100).default(0),
  inFlight: z.number().int().min(0).default(0),
  queueDepth: z.number().int().min(0).default(0),
  eventsPerSecond: z.number().min(0).default(0)
});
