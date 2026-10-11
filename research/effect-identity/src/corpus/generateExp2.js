#!/usr/bin/env node
/**
 * Experiment 2 corpus generation (PREREG_EXP2.md, Amendments 2 and 3).
 *
 *   node src/corpus/generateExp2.js            generate (resumable: saved raw responses are reused)
 *   node src/corpus/generateExp2.js --report   rebuild pairs + report from saved responses, no calls
 *
 * Generator: gemini-3.8-flash, temperature 1.0, default thinking, no fallback
 * (§A3.1). The prompts below are committed before the first generation call.
 * Nothing here scores a pair.
 *
 * Design, per tool (send_email, create_ticket):
 *   1. SEEDS. Base scenarios are generated separately for each split, so no
 *      seed exists in both (§6.1). Counterparties are then checked: a recipient
 *      address or thread id (email), or a project key (ticket), that appears in
 *      both splits drops the test-split seed; duplicates within a split drop the
 *      later seed.
 *   2. VARIANTS. One call per seed returns the original call and, as complete
 *      tool calls, two duplicates (SAME), one easy distinct act and two hard
 *      distinct acts (§4), all with the seed's typed fields.
 *   3. MECHANICAL CHECKS (§3). Each (original, variant) pair is rejected if a
 *      call is malformed, if the typed projections σ differ (the refuter would
 *      settle it, so it never enters the residual), or if the two calls are
 *      canonically identical (the certifier would settle it).
 *   4. SELECTION. Surviving pairs are subsampled per split and stratum, by a
 *      seeded shuffle, to targets that keep the §4 proportions (30% easy / 70%
 *      hard) with a margin above the preregistered minima for later author and
 *      human exclusions. A stratum short of its target keeps everything and the
 *      shortfall is reported.
 *   5. BLIND FILES. The selected pairs are split into the labelling file and
 *      its key (src/labelling/prepare.js, seed 20261004).
 *
 * Outputs (corpus/exp2/): seeds.json, raw/*.json (every response verbatim),
 * candidates.jsonl and rejected.jsonl and selected.jsonl (KEY FILES: they carry
 * intended labels and strata, and the author must not open them before
 * labelling), labelling.jsonl (blind), labelling-key.jsonl (key), and
 * generation_report.json (counts only).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GroqClient, extractJson } from "../groq.js";
import { POLICY, canonicalize, canonicalString, semanticProjection } from "../canonicalize.js";
import { prepareBlind } from "../labelling/prepare.js";

export const GENERATOR = "openai/gpt-oss-120b";
const TEMPERATURE = 0.7;
const MAX_OUTPUT_TOKENS = 3000;
const CONCURRENCY = 2;
const MIN_INTERVAL_MS = 2000;
const SELECTION_SEED = 20261003;
const LABELLING_SEED = 20261004;
const SEEDS_PER_CALL = 8;

/** §3 realistic schemas. TEXT fields are outside σ. */
export const EXP2_SCHEMAS = {
  send_email: {
    effect: "IRREVERSIBLE",
    fields: { to: POLICY.CI, thread_id: POLICY.ID, subject: POLICY.TEXT, body: POLICY.TEXT },
  },
  create_ticket: {
    effect: "IRREVERSIBLE",
    fields: { project: POLICY.ID, component: POLICY.CI, priority: POLICY.CI, title: POLICY.TEXT, description: POLICY.TEXT },
  },
};

/** Seeds generated per split (≈15% above what selection needs). */
const SEED_COUNTS = { cal: 28, test: 66 };

/**
 * Selection targets: the §2/§A2.1 minima plus a margin, in §4 proportions.
 *   minima:  cal DIFF 60 (18 easy / 42 hard), cal SAME 30;
 *            test DIFF 140 (42 easy / 98 hard), test SAME 60.
 */
export const TARGETS = {
  cal: { hard: 48, easy: 21, same: 35 },
  test: { hard: 113, easy: 48, same: 69 },
};
export const MINIMA = {
  cal: { hard: 42, easy: 18, same: 30 },
  test: { hard: 98, easy: 42, same: 60 },
};

const DOMAINS = [
  "B2B SaaS billing and subscriptions", "hospital IT and clinical systems", "freight logistics and shipping",
  "university admissions and student services", "e-commerce order fulfilment", "municipal public services",
  "law firm operations", "manufacturing quality control", "fintech compliance and payments operations",
  "online game live operations", "residential property management", "clinical research site coordination",
  "airline ground operations", "newsroom and media publishing",
];

// ── prompts (frozen with this file) ─────────────────────────────────────────

const SYSTEM = "You write realistic test data for a study of AI agents that call tools. Output JSON only, exactly in the requested shape.";

const SEED_PROMPT = {
  send_email: ({ n, domain, slug }) => `Invent ${n} distinct, realistic ongoing email threads in this domain: ${domain}.
Each thread is one in which an AI agent sends emails on behalf of an organisation to one recipient.

For each thread give:
- "to": the recipient's email address. It MUST end with "@${slug}.example" and every thread must use a different address.
- "thread_id": an opaque thread identifier of the form "TH-" followed by 6 random uppercase letters and digits; all different.
- "situation": 2-4 sentences describing what is happening in this thread: who the recipient is, what work is in progress, and what kinds of emails the agent sends in it. Include concrete specifics (names, dates, amounts, reference numbers) so that several different emails could plausibly be sent in this one thread.

Return a JSON array of ${n} objects with exactly the keys "to", "thread_id", "situation".`,

  create_ticket: ({ n, domain, slug }) => `Invent ${n} distinct, realistic software or operations components in this domain: ${domain}, each tracked in an issue tracker where an AI agent files tickets.

For each give:
- "project": a project key. It MUST start with "${slug.toUpperCase()}-" followed by 2-5 uppercase letters, and every entry must use a different project key.
- "component": the name of one subsystem or component (a short lowercase identifier, such as "auth-service" or "label-printing").
- "priority": one of "P1", "P2", "P3", "P4".
- "situation": 2-4 sentences describing this component, how it is used, and the kinds of problems or requests that get filed against it. Include concrete specifics (error codes, versions, customer or site names, dates) so that several different tickets could plausibly be filed against this one component at this priority.

Return a JSON array of ${n} objects with exactly the keys "project", "component", "priority", "situation".`,
};

const VARIANT_PROMPT = {
  send_email: (seed) => `An AI agent sends emails through a tool with this exact argument schema:
  to (recipient address), thread_id (thread identifier), subject (free text), body (free text).

The thread:
  to: ${seed.to}
  thread_id: ${seed.thread_id}
  situation: ${seed.situation}

Write the following tool calls. EVERY call must use exactly to = "${seed.to}" and thread_id = "${seed.thread_id}". Only subject and body may differ.

1. "original": one realistic email the agent sends in this thread. It performs one specific action (informs of something, requests something, confirms something). Include concrete specifics.

2. "same": TWO duplicates of the original: the agent retrying the SAME email after a timeout, but regenerating its wording. Each must perform exactly the same act as the original: same facts, numbers, dates, names, references and requests; nothing added, nothing removed. Reword substantially (different sentences, word choice, order; the subject may be reworded too). Sending a duplicate after the original would be sending the same message twice.

3. "easy_diff": ONE different email in the same thread about a clearly different topic or purpose. Suppressing it as a duplicate of the original would obviously drop a needed message.

4. "hard_diff": TWO different emails in the same thread that are easy to mistake for the original: same thread and recipient, a closely overlapping or even identical subject, much of the same context and wording, but each is a genuinely distinct real-world act. Not sending it because "the original was already sent" would leave a necessary action undone. Examples of the kind of distinction meant: two different status updates in the same incident thread (root cause identified vs rollback deployed); a gentle reminder vs a new action item; confirmations of two consecutive patches; a second, different request in the same thread. The difference must be real and must be stated in the subject and/or body, but keep the surface as close to the original as a real email like this would be. Do NOT make the difference obvious through a changed topic, and do NOT write a paraphrase of the original.

Each call is an object with exactly the keys "to", "thread_id", "subject", "body".
Return JSON: {"original": {...}, "same": [{...}, {...}], "easy_diff": [{...}], "hard_diff": [{...}, {...}]}`,

  create_ticket: (seed) => `An AI agent files tickets through a tool with this exact argument schema:
  project (project key), component (component name), priority (P1-P4), title (free text), description (free text).

The component:
  project: ${seed.project}
  component: ${seed.component}
  priority: ${seed.priority}
  situation: ${seed.situation}

Write the following tool calls. EVERY call must use exactly project = "${seed.project}", component = "${seed.component}" and priority = "${seed.priority}". Only title and description may differ.

1. "original": one realistic ticket the agent files: one specific issue or request, with concrete specifics (symptoms, error messages, steps, affected customer or site, dates).

2. "same": TWO duplicates of the original: the agent re-filing the SAME ticket after a timeout, but regenerating its wording. Each must describe exactly the same issue as the original: same symptoms, facts, identifiers and requested work; nothing added, nothing removed. Reword substantially (different sentences, word choice, order; the title may be reworded too). Filing a duplicate after the original would open the same work item twice.

3. "easy_diff": ONE different ticket for the same component about a clearly different issue or request. Suppressing it as a duplicate of the original would obviously lose a real work item.

4. "hard_diff": TWO different tickets for the same component that are easy to mistake for the original: same project, component and priority, a closely overlapping or even near-identical title, much of the same context and wording, but each is a genuinely distinct issue. Not filing it because "the original was already filed" would lose a real work item. Examples of the kind of distinction meant: two separate bugs in the same component with different reproduction steps or error logs (an OAuth token-expiry race vs a malformed SAML assertion); a duplicate-billing complaint vs a cancellation request from the same customer; an out-of-memory crash vs a deadlock in the same worker. The difference must be real and must be stated in the title and/or description, but keep the surface as close to the original as real tickets like this would be. Do NOT make the difference obvious through a changed topic, and do NOT write a paraphrase of the original.

Each call is an object with exactly the keys "project", "component", "priority", "title", "description".
Return JSON: {"original": {...}, "same": [{...}, {...}], "easy_diff": [{...}], "hard_diff": [{...}, {...}]}`,
};

// ── plumbing ─────────────────────────────────────────────────────────────────

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(base, "corpus", "exp2");
const RAW = resolve(OUT, "raw");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const TOOLS = Object.keys(EXP2_SCHEMAS);
const SHORT = { send_email: "em", create_ticket: "tk" };

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const r = mulberry32(seed), a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

import { createHash } from "node:crypto";

let client = null;
const stats = { calls: 0, retries: 0, failures: [] };

/** One generation call, cached verbatim under raw/<key>.json. */
async function callOnce(key, prompt, validate, offline) {
  const path = resolve(RAW, `${key}.json`);
  let prior = [];
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved.ok) return saved.parsed;
    prior = saved.attempts ?? [];
  }
  if (offline) return null;
  client ??= new GroqClient({ model: GENERATOR });
  const attempts = [...prior];
  for (let attempt = 1; attempt <= 3; attempt++) {
    stats.calls += 1;
    if (attempt > 1) stats.retries += 1;
    let out, parsed = null, error = null;
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
    try {
      out = await client.jsonChat({
        system: SYSTEM,
        prompt: prompt + "\n\nRespond with valid JSON only.",
        temperature: TEMPERATURE,
        maxTokens: MAX_OUTPUT_TOKENS,
        model: GENERATOR,
        rawBudget: true,
      });
      parsed = out.json;
      const problem = validate(parsed);
      if (problem) { error = `invalid shape: ${problem}`; parsed = null; }
    } catch (e) {
      error = String(e.message ?? e);
    }
    attempts.push({ attempt: attempts.length + 1, at: new Date().toISOString(), error, raw: out?.text ?? null });
    if (parsed) {
      writeFileSync(path, JSON.stringify({ ok: true, key, model: GENERATOR, temperature: TEMPERATURE, promptSha256: sha(SYSTEM + "\n" + prompt), prompt, attempts, parsed }, null, 2));
      return parsed;
    }
  }
  writeFileSync(path, JSON.stringify({ ok: false, key, model: GENERATOR, prompt, attempts }, null, 2));
  stats.failures.push(key);
  return null;
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

const SEED_KEYS = { send_email: ["situation", "thread_id", "to"], create_ticket: ["component", "priority", "project", "situation"] };
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

function validateSeeds(tool, n) {
  return (x) => {
    if (!Array.isArray(x)) return "not an array";
    if (x.length !== n) return `expected ${n} seeds, got ${x.length}`;
    for (const s of x) {
      if (Object.keys(s).sort().join(",") !== SEED_KEYS[tool].join(",")) return `seed keys ${Object.keys(s)}`;
      if (!Object.values(s).every(isStr)) return "empty seed field";
    }
    return null;
  };
}

function validateVariants(x) {
  if (!x || typeof x !== "object") return "not an object";
  const want = { original: null, same: 2, easy_diff: 1, hard_diff: 2 };
  for (const [k, n] of Object.entries(want)) {
    if (n === null ? !x[k] || typeof x[k] !== "object" : !Array.isArray(x[k]) || x[k].length !== n) return `bad ${k}`;
  }
  return null;
}

/** A call is well-formed when it has exactly the schema's fields, all non-empty strings. */
function malformed(tool, call) {
  const fields = Object.keys(EXP2_SCHEMAS[tool].fields).sort();
  if (!call || typeof call !== "object") return "not an object";
  if (Object.keys(call).sort().join(",") !== fields.join(",")) return `fields ${Object.keys(call).sort().join(",")}`;
  if (!Object.values(call).every(isStr)) return "empty field";
  return null;
}

// ── run ──────────────────────────────────────────────────────────────────────

async function main() {
  const offline = process.argv.includes("--report");
  mkdirSync(RAW, { recursive: true });

  // 1. Seeds, per tool and split, in separate calls.
  const seedTasks = [];
  for (const tool of TOOLS) for (const split of ["cal", "test"]) {
    const calls = Math.ceil(SEED_COUNTS[split] / SEEDS_PER_CALL);
    for (let c = 0; c < calls; c++) {
      const n = Math.min(SEEDS_PER_CALL, SEED_COUNTS[split] - c * SEEDS_PER_CALL);
      const domain = DOMAINS[(c + (split === "test" ? 5 : 0) + (tool === "create_ticket" ? 2 : 0)) % DOMAINS.length];
      const slug = `${SHORT[tool]}${split === "cal" ? "c" : "t"}${c + 1}`;
      const key = `seeds-${tool}-${split}-${c + 1}`;
      seedTasks.push(async () => ({ tool, split, key, domain, seeds: await callOnce(key, SEED_PROMPT[tool]({ n, domain, slug }), validateSeeds(tool, n), offline) }));
    }
  }
  const seedBatches = await pool(seedTasks, CONCURRENCY);

  // Counterparty partition (§6.1): cal seeds claim their counterparties first.
  const counterparty = (tool, s) => (tool === "send_email"
    ? [`to:${s.to.trim().toLowerCase()}`, `thread:${s.thread_id.trim()}`]
    : [`project:${s.project.trim()}`]);
  const seeds = [], droppedSeeds = [];
  for (const tool of TOOLS) {
    const claimed = new Map();
    for (const split of ["cal", "test"]) {
      let idx = 0;
      for (const b of seedBatches.filter((x) => x.tool === tool && x.split === split)) {
        for (const s of b.seeds ?? []) {
          idx += 1;
          const seedId = `E2-${SHORT[tool]}-${split}-${String(idx).padStart(3, "0")}`;
          const clash = counterparty(tool, s).find((k) => claimed.has(k));
          if (clash) { droppedSeeds.push({ seedId, tool, split, reason: `counterparty ${clash} already used by ${claimed.get(clash)}` }); continue; }
          counterparty(tool, s).forEach((k) => claimed.set(k, seedId));
          seeds.push({ seedId, tool, split, domain: b.domain, ...s });
        }
      }
    }
  }
  writeFileSync(resolve(OUT, "seeds.json"), JSON.stringify({ seeds, droppedSeeds }, null, 2));

  // 2. Variants, one call per seed.
  const variantResults = await pool(seeds.map((s) => async () => ({
    seed: s,
    v: await callOnce(`variants-${s.seedId}`, VARIANT_PROMPT[s.tool](s), validateVariants, offline),
  })), CONCURRENCY);

  // 3. Mechanical checks.
  const candidates = [], rejected = [];
  const STRATA = [["same", "SAME"], ["easy_diff", "DIFF"], ["hard_diff", "DIFF"]];
  for (const { seed, v } of variantResults) {
    if (!v) { rejected.push({ seedId: seed.seedId, tool: seed.tool, split: seed.split, reason: "generation failed" }); continue; }
    const schema = EXP2_SCHEMAS[seed.tool];
    for (const [key, label] of STRATA) {
      v[key].forEach((b, k) => {
        const stratum = key === "same" ? "same" : key === "easy_diff" ? "easy" : "hard";
        const id = `${seed.seedId}-${stratum}${k + 1}`;
        const meta = { id, tool: seed.tool, split: seed.split, label, stratum, seedId: seed.seedId };
        const bad = malformed(seed.tool, v.original) ?? malformed(seed.tool, b);
        if (bad) { rejected.push({ ...meta, reason: `malformed call: ${bad}` }); return; }
        if (semanticProjection(v.original, schema) !== semanticProjection(b, schema)) {
          rejected.push({ ...meta, reason: "typed fields differ (σ mismatch)", sigmaA: semanticProjection(v.original, schema), sigmaB: semanticProjection(b, schema) });
          return;
        }
        if (canonicalString(canonicalize(v.original, schema)) === canonicalString(canonicalize(b, schema))) {
          rejected.push({ ...meta, reason: "canonically identical (certifier would settle it)" });
          return;
        }
        candidates.push({ ...meta, a: v.original, b, source: "generated", generator: GENERATOR });
      });
    }
  }

  // 4. Seeded selection to targets.
  const selected = [];
  const counts = {};
  for (const tool of TOOLS) for (const split of ["cal", "test"]) for (const stratum of ["hard", "easy", "same"]) {
    const pool_ = candidates.filter((p) => p.tool === tool && p.split === split && p.stratum === stratum);
    const target = TARGETS[split][stratum];
    const pick = seededShuffle(pool_, SELECTION_SEED).slice(0, target).sort((x, y) => x.id.localeCompare(y.id));
    selected.push(...pick);
    counts[`${tool}|${split}|${stratum}`] = {
      label: stratum === "same" ? "SAME" : "DIFF", available: pool_.length, target,
      selected: pick.length, minimum: MINIMA[split][stratum], meetsMinimum: pick.length >= MINIMA[split][stratum],
    };
  }

  // 5. Blind labelling file + key.
  const { items, key } = prepareBlind(selected, { seed: LABELLING_SEED });

  writeFileSync(resolve(OUT, "candidates.jsonl"), jsonl(candidates));
  writeFileSync(resolve(OUT, "rejected.jsonl"), jsonl(rejected));
  writeFileSync(resolve(OUT, "selected.jsonl"), jsonl(selected));
  writeFileSync(resolve(OUT, "labelling.jsonl"), jsonl(items));
  writeFileSync(resolve(OUT, "labelling-key.jsonl"), jsonl(key));

  const rejectCounts = {};
  for (const r of rejected) {
    const k = `${r.tool}|${r.reason.startsWith("malformed") ? "malformed call" : r.reason}`;
    rejectCounts[k] = (rejectCounts[k] ?? 0) + 1;
  }
  const rawFiles = readdirSync(RAW);
  const report = {
    generator: GENERATOR, temperature: TEMPERATURE, generatedAt: new Date().toISOString(),
    scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    calls: { thisRun: stats.calls, retriesThisRun: stats.retries, rawResponseFiles: rawFiles.length, failedKeys: stats.failures },
    seeds: { kept: seeds.length, droppedForCounterparty: droppedSeeds.length },
    candidatesAfterChecks: candidates.length,
    rejected: { total: rejected.length, byToolAndReason: rejectCounts },
    selectedByToolSplitStratum: counts,
    selectedTotal: selected.length,
    sha256: {
      selected: sha(readFileSync(resolve(OUT, "selected.jsonl"), "utf8")),
      labelling: sha(readFileSync(resolve(OUT, "labelling.jsonl"), "utf8")),
    },
    note: "Counts only. selected.jsonl, candidates.jsonl, rejected.jsonl and labelling-key.jsonl carry intended labels; the author must not open them before labelling.",
  };
  writeFileSync(resolve(OUT, "generation_report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ calls: report.calls, seeds: report.seeds, candidates: candidates.length, rejected: report.rejected, selectedTotal: selected.length }, null, 2));
  for (const [k, c] of Object.entries(counts)) console.log(`${k.padEnd(28)} ${c.label} available=${c.available} selected=${c.selected}/${c.target} (min ${c.minimum}) ${c.meetsMinimum ? "" : "SHORT"}`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
