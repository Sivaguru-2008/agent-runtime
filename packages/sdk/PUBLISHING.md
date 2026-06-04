# Publishing the SDK (task EN-2)

The package is publish-ready: scoped public access is configured, a
`prepublishOnly` guard runs typecheck + tests + build, and `npm pack --dry-run`
shows a clean tarball (`dist/` + `README.md` + manifest, ~27 kB). The only steps
left require **your npm account** and are outward-facing/irreversible, so they
are not automated here.

## 0. Decide the published name (one-time)

The current name is `@agent-platform/sdk`. Publish under it **only if you own /
create the `@agent-platform` org on npm**. To rename, change `name` in
`package.json` and the install lines in `README.md` (and optionally the import
paths in `examples/`). For an unscoped name you can drop `publishConfig`.

## 1. Point the default at your hosted API

The SDK requires an explicit `baseUrl` (no hardcoded default — good). After the
EN-1 deploy, put the real URL in:
- `README.md` Quickstart (`baseUrl: "https://api.example.com"` → your URL)
- `examples/*.ts` (`AGENT_API_URL` default `http://localhost:4000` is fine to keep)

## 2. Publish

```bash
cd packages/sdk
npm login                      # your npm account
npm whoami                     # confirm
npm pack --dry-run             # final contents check

# first release of a scoped package must be public:
npm publish --access public    # prepublishOnly runs typecheck+test+build first
```

For later releases, bump the version first (`npm version patch|minor`), which
also updates `SDK_VERSION` consumers via the manifest — note `src/config.ts`
hardcodes `SDK_VERSION = "0.1.0"` for the User-Agent; bump it in lockstep.

## 3. Clean-room smoke test (the EN-2 acceptance test)

In a throwaway directory, prove a stranger can install and call the hosted API:

```bash
mkdir /tmp/sdk-smoke && cd /tmp/sdk-smoke && npm init -y
npm install @agent-platform/sdk     # your published name

AGENT_API_URL=https://<your-hosted-url> \
AGENT_API_KEY=sk_live_<owner-key-from-deploy> \
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

**Done when:** `npm install <name>` works from a clean dir and the script runs an
execution to a terminal state against the hosted URL. Track the npm install
count in the founder evidence dashboard (OP-1).
```
