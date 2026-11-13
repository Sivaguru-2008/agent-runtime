import { test } from "node:test";
import assert from "node:assert/strict";
import { route, constraintHolds, AUTHZ_TOOLS } from "../src/authz/authorizer.js";
import { buildPairs, seedSplit } from "../src/authz/generate.js";
import { AUTHZ_SEEDS } from "../src/authz/seeds.js";
import { judgeScores } from "../src/judge.js";
import { AUTHZ_JUDGE_OPTIONS } from "../src/authz/judge.js";

const approval = {
  tool: "issue_refund",
  constraints: { customer_id: "cust_1", order_id: "ord_1", max_amount: 20, currency: "USD" },
  scope: "Refund the shipping fee.",
};
const action = { customer_id: "cust_1", order_id: "ord_1", amount: 12.5, currency: "usd", reason: "Refund the shipping fee." };

test("certifies only when every constraint holds and the purpose is canonically the scope", () => {
  assert.equal(route("issue_refund", action, approval), "certified");
  assert.equal(route("issue_refund", { ...action, reason: "  Refund  the shipping fee. " }, approval), "certified");
  // Case is not normalised in free text, as in the identity canonicaliser.
  assert.equal(route("issue_refund", { ...action, reason: "refund the shipping fee." }, approval), "residual");
  assert.equal(route("issue_refund", { ...action, reason: "Give back the delivery charge." }, approval), "residual");
});

test("refutes on every kind of typed violation", () => {
  assert.equal(route("issue_refund", { ...action, amount: 20.01 }, approval), "refuted");
  assert.equal(route("issue_refund", { ...action, amount: "20" }, approval), "certified");
  assert.equal(route("issue_refund", { ...action, order_id: "ord_2" }, approval), "refuted");
  assert.equal(route("issue_refund", { ...action, currency: "EUR" }, approval), "refuted");
  assert.equal(route("transfer_funds", action, approval), "refuted", "a different tool is never covered");
  const g = { tool: "grant_access", constraints: { principal_id: "u", resource_id: "r", max_role: "editor", expires_by: "2026-12-31T00:00:00Z" }, scope: "x" };
  const ga = { principal_id: "u", resource_id: "r", role: "editor", expires_at: "2026-12-31T00:00:00Z", justification: "y" };
  assert.equal(route("grant_access", ga, g), "residual");
  assert.equal(route("grant_access", { ...ga, role: "admin" }, g), "refuted");
  assert.equal(route("grant_access", { ...ga, role: "viewer" }, g), "residual");
  assert.equal(route("grant_access", { ...ga, expires_at: "2027-01-01T00:00:00Z" }, g), "refuted");
});

test("unparseable or missing typed values fail closed", () => {
  const cap = AUTHZ_TOOLS.issue_refund.constraints.find((c) => c.kind === "max");
  assert.equal(constraintHolds(cap, { amount: "twelve" }, approval), false);
  assert.equal(constraintHolds(cap, {}, approval), false);
  assert.equal(constraintHolds(cap, { amount: null }, approval), false);
  const role = { field: "role", kind: "role", approval: "max_role" };
  assert.equal(constraintHolds(role, { role: "owner" }, { constraints: { max_role: "admin" } }), false);
});

test("the corpus routes as constructed and splits by seed", () => {
  const pairs = buildPairs();
  assert.equal(pairs.length, AUTHZ_SEEDS.length * 13);
  for (const p of pairs) assert.equal(route(p.tool, p.b, p.a), p.expectedRoute, p.id);
  const split = seedSplit(AUTHZ_SEEDS);
  for (const p of pairs.filter((q) => q.split !== "attack")) assert.equal(p.split, split[p.seed]);
  for (const tool of Object.keys(AUTHZ_TOOLS)) {
    const ids = AUTHZ_SEEDS.filter((s) => s.tool === tool).map((s) => s.id);
    assert.equal(ids.filter((id) => split[id] === "cal").length, ids.length / 2, tool);
  }
});

test("judgeScores reads the authorisation field and never the identity field", async () => {
  const client = {
    async jsonChat({ system, prompt }) {
      assert.match(system, /authorisation judge/);
      assert.match(prompt, /APPROVAL:/);
      return { json: [{ i: 0, p_within_pct: 80, p_same_pct: 5 }, { i: 1, p_same_pct: 90 }] };
    },
  };
  const pairs = [{ tool: "issue_refund", a: approval, b: action }, { tool: "issue_refund", a: approval, b: action }];
  const s = await judgeScores(client, pairs, { batchSize: 2, maxAttempts: 1, ...AUTHZ_JUDGE_OPTIONS });
  assert.deepEqual(s, [0.8, null]);
});
