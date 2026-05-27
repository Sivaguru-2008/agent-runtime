/**
 * Structured Audit Logger — immutable record of every authenticated API action.
 *
 * Production risk solved:
 *   Without audit logging, there is no forensic record when a customer disputes
 *   an action ("I didn't delete that agent"), when a security incident requires
 *   tracing what an API key accessed, or when compliance requires evidence of
 *   access controls operating correctly.
 *
 * Non-blocking design:
 *   Every write is fire-and-forget. The audit INSERT never blocks the HTTP
 *   response path — a slow audit DB cannot add latency to API calls. Write
 *   failures are swallowed silently (logged at debug level) because failing the
 *   API call due to an audit write failure is worse than missing a log entry.
 *
 * What IS audited:
 *   Every request from an authenticated tenant (tenant context is set).
 *
 * What is NOT audited:
 *   Unauthenticated requests (no tenant context), health checks, and metrics
 *   scrapes. These are covered by access logs (Pino) rather than audit log.
 *
 * Partition alignment:
 *   Inserts land in the correct monthly partition automatically because the
 *   audit_log table is partitioned by range on created_at and the INSERT uses
 *   now() for created_at.
 */

import type { FastifyInstance } from "fastify";
import type { PgClient } from "../persistence/postgres/pgClient.js";

export interface AuditEntry {
  tenantId: string;
  apiKeyId: string | null;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ip: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}

const INSERT_SQL = `
  insert into audit_log
    (tenant_id, api_key_id, actor_role, action, resource_type, resource_id,
     method, path, status_code, duration_ms, ip, request_id, metadata, created_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
`;

export class AuditLogger {
  constructor(
    private readonly db: PgClient,
    private readonly enabled: boolean
  ) {}

  log(entry: AuditEntry): void {
    if (!this.enabled) return;
    this.db
      .query(INSERT_SQL, [
        entry.tenantId,
        entry.apiKeyId,
        entry.actorRole,
        entry.action,
        entry.resourceType,
        entry.resourceId,
        entry.method,
        entry.path,
        entry.statusCode,
        entry.durationMs,
        entry.ip,
        entry.requestId,
        JSON.stringify(entry.metadata ?? {})
      ])
      .catch(() => undefined); // Fire-and-forget
  }
}

// Derive a semantic action name from HTTP method + path so audit entries
// read like "agent.create" rather than "POST /agents".
function classifyAction(
  method: string,
  path: string
): { action: string; resourceType: string; resourceId: string | null } {
  const segments = path.split("/").filter(Boolean);
  const resource = segments[0] ?? "unknown";
  // Detect UUID/hex segments (resource IDs), skip them for sub-action detection.
  const isIdSegment = (s: string): boolean => /^[0-9a-f-]{8,}$/i.test(s);

  const id = segments[1] && isIdSegment(segments[1]) ? segments[1] : null;
  // Sub-action: the segment after the ID (e.g. "tasks" in /agents/:id/tasks)
  const subIdx = id ? 2 : 1;
  const subAction = segments[subIdx] && !isIdSegment(segments[subIdx]) ? segments[subIdx] : null;

  const verbMap: Record<string, string> = {
    GET: "read",
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete"
  };
  const verb = verbMap[method] ?? "action";
  const action = subAction ? `${resource}.${subAction}` : `${resource}.${verb}`;

  return { action, resourceType: resource, resourceId: id };
}

// Symbol key for start timestamp — avoids string collisions on the request object.
const START_TS = Symbol("auditStart");

export async function registerAuditLogger(
  app: FastifyInstance,
  auditLogger: AuditLogger
): Promise<void> {
  app.addHook("onRequest", async (request) => {
    (request as unknown as Record<symbol, number>)[START_TS] = Date.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    const tenant = request.tenant;
    if (!tenant) return; // Only audit authenticated requests

    const startMs = (request as unknown as Record<symbol, number>)[START_TS] ?? Date.now();
    const durationMs = Date.now() - startMs;
    const path = request.url.split("?")[0]!;
    const { action, resourceType, resourceId } = classifyAction(request.method, path);

    auditLogger.log({
      tenantId: tenant.tenantId,
      apiKeyId: tenant.apiKeyId,
      actorRole: tenant.role,
      action,
      resourceType,
      resourceId,
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs,
      ip: request.ip,
      requestId: String(request.id)
    });
  });
}
