import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmount, parseCurrency, beneficiaryKey, buildPayeeRegistry, resolveBeneficiary,
  parseReference, typeWirePair, WIRE_RUNGS,
} from "../src/corpus/paymentTyping.js";
import { classifyPair } from "../src/evaluate.js";

const registry = buildPayeeRegistry(["Acme Corporation", "Blue Harbor LLC", "Kite & Field Ltd"]);
const schemas = (rung) => ({ wire_money: WIRE_RUNGS[rung] });

test("amounts parse across formats and spelled-out numbers; ambiguity is null", () => {
  assert.equal(parseAmount("$1,200.00"), 1200);
  assert.equal(parseAmount("USD 1,200"), 1200);
  assert.equal(parseAmount("one thousand two hundred dollars"), 1200);
  assert.equal(parseAmount("two thousand four hundred dollars ($2,400)"), 2400);
  assert.equal(parseAmount("dollars"), null);
  assert.equal(parseCurrency("ninety six dollars"), "USD");
  assert.equal(parseCurrency("2400"), null);
});

test("payee resolution ignores legal suffixes, filler, case and word order", () => {
  assert.equal(beneficiaryKey("Kite & Field Ltd."), beneficiaryKey("Kite and Field Limited"));
  assert.equal(resolveBeneficiary("LLC Blue Harbor", registry), resolveBeneficiary("Blue Harbor LLC", registry));
  assert.equal(resolveBeneficiary("Payment to Acme Corp", registry), resolveBeneficiary("Acme Corporation", registry));
  assert.match(resolveBeneficiary("K&F Ltd.", registry), /^unresolved:/);
});

test("reference splits into document number and schedule line", () => {
  assert.deepEqual(parseReference("Invoice INV-901 — installment 1 of 2"),
    { document_ref: "INV-901", schedule_line: "installment 1 of 2" });
  assert.deepEqual(parseReference("purchase order #7731"), { document_ref: "7731", schedule_line: null });
  assert.deepEqual(parseReference("progress payment for phase one"), { document_ref: null, schedule_line: null });
});

const instalments = {
  id: "t1", tool: "wire_money", label: "DIFF",
  a: { amount_text: "$1,200.00", beneficiary_text: "Acme Corporation", reference: "Invoice INV-901 — installment 1 of 2" },
  b: { amount_text: "$1,200.00", beneficiary_text: "Acme Corporation", reference: "Invoice INV-901 — installment 2 of 2" },
};

test("R1 leaves instalments in the residual; R2 refutes them", () => {
  assert.equal(classifyPair(typeWirePair(instalments, "R1", "P", registry), schemas("R1")).residual, true);
  const r2 = classifyPair(typeWirePair(instalments, "R2", "P", registry), schemas("R2"));
  assert.equal(r2.refutes, true);
  assert.equal(r2.certifies, false);
});

test("variant A gives a SAME pair the original act's typed fields; P may refute it", () => {
  const same = {
    id: "t2", tool: "wire_money", label: "SAME",
    a: { amount_text: "$1,200.00", beneficiary_text: "Acme Corporation", reference: "Invoice INV-901" },
    b: { amount_text: "$1,200.00", beneficiary_text: "Acme Co. Holdings", reference: "Invoice INV-901" },
  };
  assert.equal(classifyPair(typeWirePair(same, "R1", "P", registry), schemas("R1")).refutes, true);
  const a = classifyPair(typeWirePair(same, "R1", "A", registry), schemas("R1"));
  assert.equal(a.refutes, false);
  assert.equal(a.certifies, true);
});

test("variant A never alters a DIFF pair", () => {
  for (const rung of ["R1", "R2"]) {
    assert.deepEqual(typeWirePair(instalments, rung, "A", registry), typeWirePair(instalments, rung, "P", registry));
  }
});
