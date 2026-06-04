/**
 * Provision a tenant + least-privilege developer API key for a logged-in human.
 *
 * This is onboarding step 2 ("generate developer key"). It mirrors the minting
 * transaction in signupRoutes.ts (tenant → quotas → developer key → signups
 * row) but is keyed off an authenticated user rather than an anonymous email
 * form, and it links the new tenant back onto users.tenant_id so the founder
 * dashboard can attribute the user's agents/tasks.
 *
 * Security posture matches signup: mints ONLY the `developer` role, never
 * owner/admin/operator; the new tenant gets the bounded `starter` default
 * quotas; the raw key is returned exactly once and only its SHA-256 is stored.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PgClient } from "../../infrastructure/persistence/postgres/pgClient.js";
import { createId } from "../../shared/id.js";
import { linkUserTenant } from "./userStore.js";

export interface ProvisionedKey {
  tenantId: string;
  rawKey: string;
  keyPrefix: string;
  plan: string;
  rateLimitRpm: number;
}

function generateApiKey(): { rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
  return { rawKey, keyHash, keyPrefix: rawKey.slice(0, 16) };
}

function deriveTenantId(email: string): string {
  const base =
    (email.split("@")[0] ?? "tenant")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "tenant";
  return `${base}-${randomBytes(4).toString("hex")}`;
}

export async function provisionDeveloperKey(
  db: PgClient,
  opts: { userId: string; email: string; plan: "starter" | "growth" | "enterprise"; rpm: number }
): Promise<ProvisionedKey> {
  const tenantId = deriveTenantId(opts.email);
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  const keyId = createId();
  const signupId = createId();

  await db.withTransaction(async (tx) => {
    await tx.query(
      `insert into tenants (id, name, plan, created_at, updated_at)
       values ($1, $2, $3, now(), now())`,
      [tenantId, opts.email, opts.plan]
    );
    await tx.query(
      `insert into tenant_quotas (tenant_id, updated_at) values ($1, now())
       on conflict (tenant_id) do nothing`,
      [tenantId]
    );
    await tx.query(
      `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role, rate_limit_rpm)
       values ($1, $2, $3, $4, $5, 'developer', $6)`,
      [keyId, tenantId, "onboarding key", keyHash, keyPrefix, opts.rpm]
    );
    // Keep the existing developer-funnel (signups/funnel_events) populated for
    // humans who onboard via Google too, so both acquisition paths are unified.
    await tx.query(
      `insert into signups (id, email, tenant_id, api_key_id, source, source_norm)
       values ($1, $2, $3, $4, 'google-oauth', 'google-oauth')
       on conflict do nothing`,
      [signupId, opts.email, tenantId, keyId]
    );
    await tx.query("update users set tenant_id = $1 where id = $2", [tenantId, opts.userId]);
  });
  // Defensive: ensure the link is set even if the transaction helper swallowed it.
  await linkUserTenant(db, opts.userId, tenantId);

  return { tenantId, rawKey, keyPrefix, plan: opts.plan, rateLimitRpm: opts.rpm };
}
