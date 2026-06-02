/**
 * Determinism certification routes.
 *
 * A replay certification is the cryptographic baseline (chain hash + per-frame
 * digests) that proves an execution replays deterministically. It is the audit
 * artifact a compliance reviewer inspects and an operator captures before a
 * recovery/branch. RBAC splits the two halves of that workflow:
 *
 *   • certification:read  — inspect the current certification and how it
 *     compares to the persisted baseline. Granted to developer (own replays),
 *     operator, admin, owner, AND the read-only auditor (compliance review).
 *   • certification:write — CAPTURE and persist a new baseline. This is an
 *     attestation/control action, so it is operator-grade (operator/admin/owner)
 *     and excludes developer/auditor/viewer.
 *
 * Every route additionally enforces tenant ownership of the target execution
 * (owner/admin bypass for cross-tenant platform tooling) so an enumerated
 * execution id cannot leak another tenant's determinism trail.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContainer } from "../../application/runtimeContainer.js";
import { requireTenant } from "../../infrastructure/security/tenantContext.js";
import { requirePermission } from "../../infrastructure/security/rbac.js";
import type { TenantGuard } from "../../infrastructure/security/tenantGuard.js";

// workflowVersion labels the certification so replays across workflow versions
// are not compared as if equivalent. Callers supply it; default to "current".
const certifyBodySchema = z
  .object({ workflowVersion: z.string().min(1).max(120).default("current") })
  .default({ workflowVersion: "current" });

export async function registerCertificationRoutes(
  app: FastifyInstance,
  container: RuntimeContainer
): Promise<void> {
  const guard: TenantGuard = app.hasDecorator("tenantGuard")
    ? app.tenantGuard
    : container.tenantGuard;
  const detector = container.replayDivergenceDetector;

  const readCertification = requirePermission("certification:read");
  const writeCertification = requirePermission("certification:write");

  // ── GET /executions/:executionId/certification ───────────────────────────
  // Read-only: recompute the current certification and compare it against the
  // most recent persisted baseline. Never persists (capture is the POST below).
  app.get(
    "/executions/:executionId/certification",
    { preHandler: readCertification },
    async (request) => {
      const ctx = requireTenant(request);
      const { executionId } = request.params as { executionId: string };
      await guard.assertOwnsExecution(ctx, executionId);
      const workflowVersion = String(
        (request.query as { workflowVersion?: string }).workflowVersion ?? "current"
      );
      const divergence = await detector.compare(executionId, workflowVersion);
      // request.id is the per-request correlation id (Fastify genReqId). Used
      // directly so this RBAC module carries no dependency on the observability
      // metadata helper — keeping the RBAC layer self-contained.
      return { ...divergence, runtimeId: request.id };
    }
  );

  // ── POST /executions/:executionId/certification ──────────────────────────
  // Capture and persist a new determinism baseline for the execution. Each
  // call appends a row, so the certification table is itself an audit timeline.
  app.post(
    "/executions/:executionId/certification",
    { preHandler: writeCertification },
    async (request, reply) => {
      const ctx = requireTenant(request);
      const { executionId } = request.params as { executionId: string };
      await guard.assertOwnsExecution(ctx, executionId);
      const { workflowVersion } = certifyBodySchema.parse(request.body ?? {});
      const certification = await detector.certify(executionId, workflowVersion);
      return reply.status(201).send({ ...certification, runtimeId: request.id });
    }
  );
}
