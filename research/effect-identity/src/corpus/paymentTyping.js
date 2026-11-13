import { POLICY } from "../canonicalize.js";
import { extractNumbers } from "../judge.js";

/**
 * Experiment 3 (PREREG_EXP3.md §2–3): re-declaring the loose `wire_money` tool
 * with the fields a real payment API carries, and the deterministic parser that
 * derives those typed values from the corpus's free-text inputs.
 *
 * The parser never sees labels or scores. Its errors act in one direction only:
 * a parse that differs across a duplicate pair makes the refuter EXECUTE (an
 * escape); a parse that collapses two distinct values leaves the pair in the
 * residual, exactly as under the published declaration. The refuter can never
 * cause a suppression, so no parse error can create a wrong suppression by
 * itself.
 *
 * This file is frozen with the preregistration. The analysis script may not
 * change it.
 */

export const WIRE_RUNGS = {
  R0: {
    effect: "IRREVERSIBLE",
    fields: { amount_text: POLICY.TEXT, beneficiary_text: POLICY.TEXT, reference: POLICY.TEXT },
  },
  R1: {
    effect: "IRREVERSIBLE",
    fields: { amount: POLICY.NUM, currency: POLICY.CI, beneficiary_id: POLICY.ID, reference: POLICY.TEXT },
  },
  R2: {
    effect: "IRREVERSIBLE",
    fields: {
      amount: POLICY.NUM, currency: POLICY.CI, beneficiary_id: POLICY.ID,
      document_ref: POLICY.ID, schedule_line: POLICY.CI, reference: POLICY.TEXT,
    },
  },
};

const FILLER = new Set(["payment", "payments", "funds", "to", "for", "company", "transfer"]);
const LEGAL = new Set(["llc", "ltd", "limited", "inc", "co", "corp", "corporation", "group", "plc"]);
const SEP = " — ";

export function parseAmount(text) {
  const nums = extractNumbers(String(text ?? ""));
  return nums.size === 1 ? [...nums][0] : null;
}

export function parseCurrency(text) {
  return /\$|usd|dollar|bucks/i.test(String(text ?? "")) ? "USD" : null;
}

export function beneficiaryKey(text) {
  const toks = String(text ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !FILLER.has(t) && !LEGAL.has(t));
  return toks.sort().join(" ");
}

/** Saved-payee list: registry id keyed by the normalised name. */
export function buildPayeeRegistry(names) {
  const reg = new Map();
  for (const n of names) {
    const k = beneficiaryKey(n);
    if (!reg.has(k)) reg.set(k, `payee_${String(reg.size + 1).padStart(3, "0")}`);
  }
  return reg;
}

export function resolveBeneficiary(text, registry) {
  const k = beneficiaryKey(text);
  return registry.get(k) ?? `unresolved:${k}`;
}

export function parseReference(text) {
  const s = String(text ?? "").normalize("NFC");
  const i = s.indexOf(SEP);
  const head = i >= 0 ? s.slice(0, i) : s;
  const tail = i >= 0 ? s.slice(i + SEP.length) : null;
  const ids = head
    .split(/\s+/)
    .map((t) => t.replace(/^[^A-Za-z0-9-]+|[^A-Za-z0-9-]+$/g, ""))
    .filter((t) => /\d/.test(t))
    .map((t) => t.toUpperCase())
    .sort();
  return {
    document_ref: ids.length ? ids.join(" ") : null,
    schedule_line: tail === null ? null : tail.replace(/\s+/g, " ").trim().toLowerCase(),
  };
}

/** Variant P: the typed input a rung's declaration would carry, parsed from text. */
export function typeWireInput(input, rung, registry) {
  if (rung === "R0") return { ...input };
  const out = {
    amount: parseAmount(input.amount_text),
    currency: parseCurrency(input.amount_text),
    beneficiary_id: resolveBeneficiary(input.beneficiary_text, registry),
    reference: input.reference,
  };
  if (rung === "R2") Object.assign(out, parseReference(input.reference));
  return out;
}

/**
 * Re-declare one wire_money pair at a rung, in variant "P" (parser on both
 * sides) or "A" (act-typed: for a SAME pair the duplicate carries the typed
 * fields of the original act; the free-text `reference` is kept as sent).
 */
export function typeWirePair(p, rung, variant, registry) {
  const a = typeWireInput(p.a, rung, registry);
  let b = typeWireInput(p.b, rung, registry);
  if (rung !== "R0" && variant === "A" && p.label === "SAME") {
    b = { ...a, reference: p.b.reference };
  }
  return { ...p, a, b };
}
