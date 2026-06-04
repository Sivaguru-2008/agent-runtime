# SDK Publishing Checklist (P0.3 / EN-2)

> Publish the TS SDK to npm so the PLG loop can start. The package is already publish-ready: scoped public access configured, `prepublishOnly` runs typecheck+test+build, `npm pack --dry-run` is clean (~27 kB). Canonical: `packages/sdk/PUBLISHING.md`. This is the executable checklist version.
>
> **Artifact:** a published npm package + a clean-room smoke test that runs an execution against the hosted URL. Time-box: 2h.

---

## Pre-flight

- [ ] P0.2 done — you have the live hosted URL + an `sk_live_…` owner key.
- [ ] An npm account (`npm login` works).
- [ ] If keeping the scoped name `@agent-platform/sdk`: you own/created the `@agent-platform` npm org. (Else rename — see step 0.)

---

## Step 0 — Decide the published name (one-time, <30 min)

- [ ] **Keep `@agent-platform/sdk`** only if you own the `@agent-platform` org on npm.
- [ ] **To rename:** change `name` in `packages/sdk/package.json` + install lines in `README.md` (and optionally import paths in `examples/`).
- [ ] **Unscoped name:** drop `publishConfig` from `package.json`.
- [ ] Name collision → pick an unscoped fallback and move on. Do not agonize.

## Step 1 — Point the SDK at your hosted API

> The SDK requires an explicit `baseUrl` (no hardcoded default — good).

- [ ] `README.md` Quickstart: `baseUrl: "https://api.example.com"` → your real P0.2 URL.
- [ ] `examples/*.ts`: `AGENT_API_URL` default `http://localhost:4000` is fine to keep.
- [ ] `src/config.ts`: confirm `SDK_VERSION` matches `package.json` version (it's hardcoded for the User-Agent — bump in lockstep on every release).

## Step 2 — Publish

```bash
cd packages/sdk
npm login                      # your npm account
npm whoami                     # confirm
npm pack --dry-run             # final contents check (dist/ + README + manifest)

# first release of a scoped package must be public:
npm publish --access public    # prepublishOnly runs typecheck+test+build first
```
- [ ] `npm pack --dry-run` shows a clean tarball (no stray files/secrets).
- [ ] `npm publish --access public` succeeded (prepublishOnly gate passed).
- [ ] Package visible on npmjs.com.

> **Later releases:** `npm version patch|minor` first, then publish. Bump `SDK_VERSION` in `src/config.ts` in lockstep.

## Step 3 — Clean-room smoke test (the EN-2 acceptance test)

In a throwaway directory, prove a stranger can install + call the hosted API:

```bash
mkdir /tmp/sdk-smoke && cd /tmp/sdk-smoke && npm init -y
npm install @agent-platform/sdk        # your published name

AGENT_API_URL=https://<your-hosted-url> \
AGENT_API_KEY=sk_live_<owner-key> \
AGENT_ID=<an-agent-id> \
node --input-type=module -e '
import { AgentRuntimeClient } from "@agent-platform/sdk";
const c = new AgentRuntimeClient({ baseUrl: process.env.AGENT_API_URL, apiKey: process.env.AGENT_API_KEY });
const ex = await c.createExecution({ agentId: process.env.AGENT_ID, prompt: "hello" });
console.log("started", ex.id);
const final = await c.waitForExecution(ex.id);
console.log("final", final.status);
'
```
- [ ] `npm install <name>` works from a clean dir (not the repo).
- [ ] Script runs an execution to a terminal state against the hosted URL.

---

## Failure tripwires

| Symptom | Action |
|---|---|
| `prepublishOnly` fails (typecheck/test/build) | Fix that one gate only. Do not expand scope. Discount known environmental test failures (memory `project_test-topology`). |
| Name collision on npm | Pick unscoped fallback name, redo step 0–1. <30 min decision. |
| Smoke test 401/403 | Wrong key or `AUTH_ENABLED` mismatch — re-check the owner key from P0.2. |
| Smoke test connection refused | Wrong `baseUrl` / hosted URL not healthy — re-verify P0.2. |

---

## Done when
- [ ] `npm install <name>` works from a clean directory.
- [ ] Smoke script reaches a terminal execution state against the hosted URL.
- [ ] Package name + URL pasted into `03-founder-dashboard.md` KEY LINKS.
- [ ] Start tracking npm install count weekly in `04-kpi-dashboard.md` (feeds the launch metrics).
- [ ] Unblocks P1.5 (landing `npm install` line) and P2.2 (launch "try it" path).
