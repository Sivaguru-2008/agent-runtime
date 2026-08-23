import { createHash } from "node:crypto";

/**
 * L0: the decidable canonical core of the layered identity relation.
 *
 * A tool schema declares, per field, a normalization POLICY. Each policy is a
 * transform that is semantics-preserving for that tool's effect function
 * (assumption A5 in the paper): the tool is documented to treat the raw and
 * normalized forms identically. Under A5, canonical equality implies true
 * effect identity, so L0 suppression is provably safe (zero wrong-suppression
 * within the fragment).
 *
 * Policies:
 *   id   — opaque identifier. NFC + trim only. Case-SENSITIVE.
 *   ci   — case-insensitive token (currency code, email, enum). NFC + trim +
 *          lowercase.
 *   num  — numeric value. "120.00", " 120 ", 120.0 and 120 normalize to the
 *          same canonical decimal. Thousands separators stripped.
 *   text — free text. NFC + trim + internal-whitespace collapse. Deliberately
 *          NOT semantic: "order #4242" and "payment for order 4242" stay
 *          distinct at L0 (that is the semantic layer's job).
 */
export const POLICY = Object.freeze({ ID: "id", CI: "ci", NUM: "num", TEXT: "text" });

const collapseWs = (s) => s.normalize("NFC").replace(/\s+/g, " ").trim();

function normalizeNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return numToCanonical(v);
  if (typeof v === "string") {
    const cleaned = v.normalize("NFC").trim().replace(/,/g, "");
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) return numToCanonical(Number(cleaned));
  }
  // Not parseable as a number: fall back to text normalization so the value
  // still canonicalizes deterministically (it just won't match numeric forms).
  return typeof v === "string" ? collapseWs(v) : v;
}

function numToCanonical(n) {
  if (Object.is(n, -0)) n = 0;
  // String(n) already strips trailing zeros ("120.50" -> "120.5").
  return String(n);
}

export function normalizeField(value, policy) {
  if (value === null || value === undefined) return null;
  switch (policy) {
    case POLICY.NUM:
      return normalizeNumber(value);
    case POLICY.CI:
      return typeof value === "string" ? collapseWs(value).toLowerCase() : value;
    case POLICY.ID:
      return typeof value === "string" ? value.normalize("NFC").trim() : value;
    case POLICY.TEXT:
    default:
      return normalizeDefault(value);
  }
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return collapseWs(value);
  if (typeof value === "number") return normalizeNumber(value);
  if (Array.isArray(value)) return value.map(normalizeDefault); // array order may be semantic — preserved
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normalizeDefault(value[k]);
    return out;
  }
  return value;
}

/**
 * Canonicalize a tool input against its schema. Unknown fields get the default
 * (text-level) normalization; keys are sorted so serialization is stable.
 */
export function canonicalize(input, schema) {
  const fields = schema?.fields ?? {};
  const out = {};
  for (const k of Object.keys(input ?? {}).sort()) {
    out[k] = normalizeField(input[k], fields[k] ?? POLICY.TEXT);
  }
  return out;
}

/** Deterministic serialization of an already-canonical value (keys sorted). */
export function canonicalString(canonical) {
  return JSON.stringify(canonical);
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** L0 identity: operation id = H(runId ‖ tool ‖ H(canonical input)). */
export function operationId(runId, tool, input, schema) {
  const inputHash = sha256(canonicalString(canonicalize(input, schema)));
  return { operationId: sha256(`${runId}|${tool}|${inputHash}`), inputHash };
}

/**
 * The semantic projection: canonical values of the declared non-text fields
 * (id / ci / num policies). Under A5′ (declared semantic fields are
 * effect-determining), two calls whose semantic projections DIFFER are
 * provably distinct acts — a decidable DISTINCTNESS witness that vetoes
 * suppression no matter what any judge says.
 */
export function semanticProjection(input, schema) {
  const fields = schema?.fields ?? {};
  const out = {};
  for (const k of Object.keys(input ?? {}).sort()) {
    const policy = fields[k] ?? POLICY.TEXT;
    if (policy !== POLICY.TEXT) out[k] = normalizeField(input[k], policy);
  }
  return canonicalString(out);
}

/**
 * The TIGHTENED projection: the declared non-text fields, plus the numeric
 * magnitudes each free-text field mentions.
 *
 * This models a tool author following the paper's own advice — lifting
 * act-distinguishing tokens (invoice ids, installment indices, amounts) out of
 * prose into declared fields — without requiring the corpus to be rebuilt: the
 * numbers a text field mentions are a mechanical stand-in for the typed fields
 * the tool should have declared.
 *
 * Direction of failure. If a legitimate paraphrase re-expresses a number in
 * different units ("3 business days" → "72 hours"), the projections differ and
 * the witness vetoes: the dispatch EXECUTES as distinct. That is a duplicate
 * escape — loud and recoverable — not a wrong suppression. Widening the
 * projection can only move errors into the safe direction, which is why it is
 * usable at all; what it costs is deduplication, and that cost is measured
 * rather than assumed (§ tightened-schema rows).
 *
 * It is used ONLY as the witness projection σ, never as the canonicalisation κ.
 * Folding a lossy extraction into κ would make L0 suppress on it, and L0
 * suppression is unconditional — a collision there is a wrong suppression with
 * no judge and no band to catch it.
 */
export function tightenedProjection(input, schema, extractNumbers) {
  const fields = schema?.fields ?? {};
  const out = {};
  for (const k of Object.keys(input ?? {}).sort()) {
    const policy = fields[k] ?? POLICY.TEXT;
    if (policy !== POLICY.TEXT) { out[k] = normalizeField(input[k], policy); continue; }
    const v = input[k];
    if (typeof v !== "string") continue;
    out[`${k}#nums`] = [...extractNumbers(v)].sort((a, b) => a - b);
  }
  return canonicalString(out);
}
