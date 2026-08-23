import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, canonicalString, operationId } from "../src/canonicalize.js";
import { TOOLS } from "../src/tools.js";

const canon = (tool, input) => canonicalString(canonicalize(input, TOOLS[tool]));

test("L0: key order, whitespace, number format, currency case are identity-preserving", () => {
  const a = { customer_id: "cust_42", amount: 120, currency: "USD", memo: "order #4242" };
  const b = { memo: "  order   #4242 ", currency: "usd", amount: "120.00", customer_id: "cust_42" };
  assert.equal(canon("charge_card", a), canon("charge_card", b));
});

test("L0: unicode NFD/NFC forms canonicalize identically", () => {
  const a = { to: "rené@example.com", subject: "café order", body: "hi" };
  const b = { to: "rené@EXAMPLE.com", subject: "café   order", body: "hi" };
  assert.equal(canon("send_email", a), canon("send_email", b));
});

test("L0: differing amounts yield different canonical forms (no wrong suppression)", () => {
  const a = { customer_id: "cust_42", amount: 120, currency: "USD", memo: "order #4242" };
  const b = { ...a, amount: 121 };
  assert.notEqual(canon("charge_card", a), canon("charge_card", b));
});

test("L0: id fields stay case-sensitive", () => {
  const a = { charge_id: "ch_ABC", amount: 10, reason: "dup" };
  const b = { charge_id: "ch_abc", amount: 10, reason: "dup" };
  assert.notEqual(canon("post_refund", a), canon("post_refund", b));
});

test("L0: paraphrased free text is NOT canonically equal (escapes to semantic layer)", () => {
  const a = { customer_id: "c1", amount: 50, currency: "USD", memo: "payment for order 99" };
  const b = { customer_id: "c1", amount: 50, currency: "USD", memo: "order 99 payment" };
  assert.notEqual(canon("charge_card", a), canon("charge_card", b));
});

test("operationId is stable across runs and distinct across runIds", () => {
  const input = { customer_id: "c1", amount: 5, currency: "USD", memo: "m" };
  const x = operationId("run-1", "charge_card", input, TOOLS.charge_card);
  const y = operationId("run-1", "charge_card", { ...input }, TOOLS.charge_card);
  const z = operationId("run-2", "charge_card", input, TOOLS.charge_card);
  assert.equal(x.operationId, y.operationId);
  assert.notEqual(x.operationId, z.operationId);
});

test("tightened projection pins numbers mentioned in free text", async () => {
  const { tightenedProjection } = await import("../src/canonicalize.js");
  const { extractNumbers } = await import("../src/judge.js");
  const schema = TOOLS.charge_card;
  const proj = (x) => tightenedProjection(x, schema, extractNumbers);
  const baseArgs = { customer_id: "c1", amount: 120, currency: "USD" };

  // A paraphrase that preserves the referenced order number keeps the same
  // projection, so the witness stays silent and the judge still decides.
  assert.equal(
    proj({ ...baseArgs, memo: "payment for order #4242" }),
    proj({ ...baseArgs, memo: "order 4242 payment" })
  );
  // A distinguishing token living only in prose — the case the declared-field
  // witness cannot reach — now separates the projections.
  assert.notEqual(
    proj({ ...baseArgs, memo: "rent — installment 1 of 2" }),
    proj({ ...baseArgs, memo: "rent — installment 2 of 2" })
  );
  // A different referenced order is likewise separated.
  assert.notEqual(
    proj({ ...baseArgs, memo: "payment for order #4242" }),
    proj({ ...baseArgs, memo: "payment for order #4243" })
  );
  // Spelled-out numbers normalise, so a legitimate reformat is not split.
  const wire = TOOLS.wire_money;
  assert.equal(
    tightenedProjection({ amount_text: "$780.00", beneficiary_text: "Marlow Freight", reference: "Shipment 88213" }, wire, extractNumbers),
    tightenedProjection({ amount_text: "seven hundred eighty dollars", beneficiary_text: "MARLOW FREIGHT", reference: "shipment #88213" }, wire, extractNumbers)
  );
});

test("tightened projection fails toward EXECUTE, never toward suppression", async () => {
  const { tightenedProjection } = await import("../src/canonicalize.js");
  const { extractNumbers } = await import("../src/judge.js");
  // A legitimate paraphrase that re-expresses a number in different units is
  // split by the wider projection. That costs deduplication (the dispatch
  // executes as distinct) — it cannot cause a wrong suppression, because a
  // projection MISMATCH only ever vetoes suppression.
  const schema = TOOLS.send_email;
  const a = { to: "x@e.com", subject: "s", body: "arrives within 3 business days" };
  const b = { to: "x@e.com", subject: "s", body: "arrives within 72 hours" };
  assert.notEqual(
    tightenedProjection(a, schema, extractNumbers),
    tightenedProjection(b, schema, extractNumbers)
  );
});
