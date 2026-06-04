#!/usr/bin/env node
/**
 * seed-owner-key.mjs — bootstrap the first `owner` API key.
 *
 * Why this exists:
 *   The production RBAC privilege-escalation guard forbids any API key from
 *   minting a key MORE privileged than itself (apps/api adminRoutes). An admin
 *   therefore cannot create an `owner` key through POST /admin/api-keys, and a
 *   freshly-migrated database has zero owner keys. This script is the sanctioned
 *   OUT-OF-BAND path that creates the initial owner — exactly as the very first
 *   admin key has always been seeded by hand.
 *
 * Security model (mirrors apps/api adminRoutes.generateApiKey):
 *   • Only the SHA-256 hash of the raw key is stored. The plaintext is printed
 *     ONCE to stdout and never persisted — copy it into your secret manager now.
 *   • key_prefix stores the first 16 chars ("sk_live_" + 8) for log triage.
 *
 * Idempotency:
 *   Refuses to create a second active owner key for the same tenant unless
 *   --force is passed, so re-running in CI/bootstrap doesn't mint duplicates.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/seed-owner-key.mjs \
 *     [--tenant <id>] [--name <label>] [--force]
 *
 * Defaults: tenant=system, name=bootstrap-owner.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

function parseArgs(argv) {
  const args = { tenant: "system", name: "bootstrap-owner", force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tenant") args.tenant = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a === "--force") args.force = true;
  }
  return args;
}

function generateApiKey() {
  const rawKey = `sk_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = createHash("sha256").update(rawKey, "utf8").digest("hex");
  const keyPrefix = rawKey.slice(0, 16);
  return { rawKey, keyHash, keyPrefix };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[seed-owner-key] DATABASE_URL is required.");
    process.exit(2);
  }
  const { tenant, name, force } = parseArgs(process.argv.slice(2));

  // Mirror the API's TLS handling (pgClient.resolvePoolSsl): managed Postgres
  // refuses non-TLS connections, so DATABASE_SSL must be honoured here too or
  // seeding the bootstrap owner key against a hosted DB fails with a TLS error.
  const sslMode = (process.env.DATABASE_SSL ?? "").trim().toLowerCase();
  const ssl =
    sslMode === "require" || sslMode === "no-verify" || sslMode === "prefer"
      ? { rejectUnauthorized: false }
      : sslMode === "verify-full" || sslMode === "verify-ca" || sslMode === "strict" || sslMode === "true"
        ? { rejectUnauthorized: true }
        : false;
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl });
  try {
    // The tenant must exist (FK). 'system' is seeded by migration 0002.
    const { rows: tenantRows } = await pool.query("select id from tenants where id = $1", [tenant]);
    if (!tenantRows.length) {
      console.error(`[seed-owner-key] tenant '${tenant}' does not exist. Create it first.`);
      process.exit(1);
    }

    if (!force) {
      const { rows: existing } = await pool.query(
        "select id, key_prefix from api_keys where tenant_id = $1 and role = 'owner' and is_active = true and revoked_at is null",
        [tenant]
      );
      if (existing.length) {
        console.error(
          `[seed-owner-key] an active owner key already exists for tenant '${tenant}' ` +
            `(id=${existing[0].id}, prefix=${existing[0].key_prefix}). Re-run with --force to mint another.`
        );
        process.exit(0);
      }
    }

    const { rawKey, keyHash, keyPrefix } = generateApiKey();
    const id = randomUUID();
    await pool.query(
      `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role, rate_limit_rpm)
       values ($1, $2, $3, $4, $5, 'owner', 10000)`,
      [id, tenant, name, keyHash, keyPrefix]
    );

    // Print the raw key ONCE. It cannot be recovered after this line.
    console.log("[seed-owner-key] owner API key created — store this securely, it is shown only once:\n");
    console.log(`  tenant:  ${tenant}`);
    console.log(`  id:      ${id}`);
    console.log(`  name:    ${name}`);
    console.log(`  rawKey:  ${rawKey}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seed-owner-key] failed:", err?.message ?? err);
  process.exit(1);
});
