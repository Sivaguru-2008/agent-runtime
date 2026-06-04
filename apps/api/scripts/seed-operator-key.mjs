/**
 * Seed (or rotate) a local operator API key.
 *
 * The first key for a tenant must be created out-of-band: POST /admin/api-keys
 * itself requires an existing apikey:manage credential (chicken/egg). This
 * script mints an `operator` key on the built-in `system` tenant so the web
 * dashboard (which authenticates via the /api/runtime proxy) can reach the
 * operator/observability routes when the backend runs with AUTH_ENABLED=true.
 *
 * Usage:  node apps/api/scripts/seed-operator-key.mjs
 * Reads DATABASE_URL from the environment, falling back to apps/api/.env.
 * Prints the RAW key ONCE — copy it into apps/web/.env as RUNTIME_API_KEY.
 * Only the SHA-256 hash is stored; re-running rotates the same logical key.
 */
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");
const here = dirname(fileURLToPath(import.meta.url));

// Load DATABASE_URL from env, or apps/api/.env as a fallback.
require("dotenv").config({ path: resolve(here, "..", ".env") });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (env or apps/api/.env). Aborting.");
  process.exit(1);
}

const KEY_ID = process.env.SEED_KEY_ID ?? "local-operator-key";
const ROLE = process.env.SEED_KEY_ROLE ?? "operator";
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const rawKey = "sk_local_op_" + randomBytes(24).toString("hex");

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query(
    `insert into api_keys (id, tenant_id, name, key_hash, key_prefix, role, rate_limit_rpm, is_active)
     values ($1, 'system', 'Local dev operator (web proxy)', $2, $3, $4, 100000, true)
     on conflict (id) do update set
       key_hash = excluded.key_hash, key_prefix = excluded.key_prefix,
       role = excluded.role, is_active = true, revoked_at = null, expires_at = null`,
    [KEY_ID, sha256(rawKey), rawKey.slice(0, 12), ROLE]
  );
  console.log(`seeded api key id=${KEY_ID} role=${ROLE} tenant=system`);
  console.log("RUNTIME_API_KEY=" + rawKey);
} finally {
  await c.end();
}
