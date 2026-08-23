import { POLICY } from "../canonicalize.js";

/**
 * The schema-richness ladder: ONE act family, declared three ways.
 *
 * T6 says the residual is a function of the declaration alone. The v1 corpus
 * tests that with a single before/after — one tool re-declared once — which
 * shows the effect and cannot show its SHAPE. A claim that refinement shrinks
 * the residual monotonically needs at least three points, on the same acts,
 * with everything else held fixed.
 *
 * The act family is a vendor payment. Every act is fully described by seven
 * attributes:
 *
 *     payer, payee, amount, currency, invoice, installment index, cost centre
 *
 * and the three levels differ ONLY in how many of those the schema types:
 *
 *   L1 loose     — none. One prose instruction carries the whole act.
 *   L2 moderate  — payer, payee, amount, currency typed. Invoice, installment
 *                  and cost centre stay in prose.
 *   L3 strict    — the above plus invoice and installment typed. Cost centre
 *                  STILL in prose.
 *
 * The cost centre is deliberately left untyped at every level, and this is the
 * design's most important choice. A ladder whose top rung types everything
 * would make the residual empty at L3 by construction, and the experiment would
 * then be measuring an artefact of our own generosity: real schemas are never
 * complete, and the interesting question is what happens to the calibrated
 * layer on the residual that survives refinement, not what happens when the
 * residual is legislated away. Keeping one act-determining attribute in prose
 * at every level is what makes the refinement dilemma (T6.3') measurable rather
 * than assumed — there is a residual pool at L3 to be starved or replenished.
 *
 * Predicted, before running: residual(L1) > residual(L2) > residual(L3) > 0,
 * judge jurisdiction strictly decreasing, and the calibration pool shrinking at
 * the same rate as the residual unless it is deliberately replenished.
 */

export const SCHEMA_LEVELS = {
  L1_loose: {
    tool: "pay_vendor_l1",
    typedAttributes: [],
    schema: {
      effect: "IRREVERSIBLE",
      fields: { instruction: POLICY.TEXT, memo: POLICY.TEXT },
    },
  },
  L2_moderate: {
    tool: "pay_vendor_l2",
    typedAttributes: ["payer", "payee", "amount", "currency"],
    schema: {
      effect: "IRREVERSIBLE",
      fields: {
        from_account: POLICY.ID, payee: POLICY.CI, amount: POLICY.NUM,
        currency: POLICY.CI, instruction: POLICY.TEXT, memo: POLICY.TEXT,
      },
    },
  },
  L3_strict: {
    tool: "pay_vendor_l3",
    typedAttributes: ["payer", "payee", "amount", "currency", "invoice", "installment"],
    schema: {
      effect: "IRREVERSIBLE",
      fields: {
        from_account: POLICY.ID, payee: POLICY.CI, amount: POLICY.NUM, currency: POLICY.CI,
        invoice_id: POLICY.ID, installment_index: POLICY.NUM, installment_total: POLICY.NUM,
        memo: POLICY.TEXT,
      },
    },
  },
};

export const LEVEL_SCHEMAS = Object.fromEntries(
  Object.values(SCHEMA_LEVELS).map((l) => [l.tool, l.schema])
);

/** The abstract acts. Rendering these at each level is what keeps the ladder controlled. */
export const LADDER_ACTS = [
  { payer: "acct_ops_1", payee: "Northwind Freight", amount: 780, currency: "USD", invoice: "INV-901", index: 1, total: 2, costCentre: "CC-LOGISTICS" },
  { payer: "acct_ops_1", payee: "Blue Harbor LLC", amount: 1200, currency: "USD", invoice: "INV-902", index: 1, total: 3, costCentre: "CC-FACILITIES" },
  { payer: "acct_ops_2", payee: "Kite and Field Ltd", amount: 450.5, currency: "GBP", invoice: "INV-903", index: 2, total: 2, costCentre: "CC-MARKETING" },
  { payer: "acct_ops_2", payee: "North Pine Studios", amount: 96, currency: "EUR", invoice: "INV-904", index: 1, total: 4, costCentre: "CC-PRODUCT" },
  { payer: "acct_ops_3", payee: "Marlow Freight", amount: 3125.75, currency: "USD", invoice: "INV-905", index: 3, total: 4, costCentre: "CC-LOGISTICS" },
  { payer: "acct_ops_3", payee: "Acme Corporation", amount: 240, currency: "USD", invoice: "INV-906", index: 1, total: 2, costCentre: "CC-IT" },
  { payer: "acct_ops_4", payee: "Vireo Analytics", amount: 15750, currency: "USD", invoice: "INV-907", index: 2, total: 6, costCentre: "CC-DATA" },
  { payer: "acct_ops_4", payee: "Halden Supplies", amount: 62.4, currency: "EUR", invoice: "INV-908", index: 1, total: 1, costCentre: "CC-OFFICE" },
];

const words = (n) => {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const whole = Math.floor(n);
  const rec = (v) => {
    const parts = [];
    let x = v;
    if (x >= 1000) { parts.push(rec(Math.floor(x / 1000)), "thousand"); x %= 1000; }
    if (x >= 100) { parts.push(ones[Math.floor(x / 100)], "hundred"); x %= 100; }
    if (x >= 20) { parts.push(tens[Math.floor(x / 10)]); x %= 10; }
    if (x > 0) parts.push(ones[x]);
    return parts.filter(Boolean).join(" ");
  };
  return whole === 0 ? "zero" : rec(whole);
};

const CURRENCY_WORD = { USD: "dollars", EUR: "euros", GBP: "pounds" };

/**
 * Render one abstract act at one level.
 *
 * `style` selects a surface form for the prose parts. Two renderings at the same
 * level with different styles denote the SAME act — that is what makes them an
 * S2 pair — while any change to an ATTRIBUTE makes them distinct at every level.
 * The attribute/style split is the whole reason the ladder is controlled: level
 * changes what is typed, style changes only how the untyped part reads.
 */
export function render(level, act, style = 0) {
  const cur = CURRENCY_WORD[act.currency] ?? act.currency;
  const amountForms = [
    `${act.currency} ${act.amount.toFixed(2)}`,
    `${words(act.amount)} ${cur}`,
    `${act.amount} ${act.currency}`,
  ];
  const instrForms = [
    `Pay ${act.payee} ${amountForms[0]} from ${act.payer} against invoice ${act.invoice}, installment ${act.index} of ${act.total}.`,
    `Send ${amountForms[1]} to ${act.payee} out of ${act.payer}; this covers installment ${act.index} of ${act.total} on invoice ${act.invoice}.`,
    `Transfer of ${amountForms[2]} to ${act.payee}, drawn on ${act.payer}, for invoice ${act.invoice} (installment ${act.index}/${act.total}).`,
  ];
  const memoForms = [
    `Allocate to ${act.costCentre}.`,
    `Cost centre ${act.costCentre} carries this.`,
    `Booked against ${act.costCentre}.`,
  ];
  const s = style % 3;

  if (level === "L1_loose") {
    return { instruction: instrForms[s], memo: memoForms[s] };
  }
  if (level === "L2_moderate") {
    return {
      from_account: act.payer, payee: act.payee, amount: act.amount, currency: act.currency,
      // Invoice and installment remain prose at this level — that is what makes
      // L2 the middle rung rather than a relabelled L3.
      instruction: `Invoice ${act.invoice}, installment ${act.index} of ${act.total}.`,
      memo: memoForms[s],
    };
  }
  if (level === "L3_strict") {
    return {
      from_account: act.payer, payee: act.payee, amount: act.amount, currency: act.currency,
      invoice_id: act.invoice, installment_index: act.index, installment_total: act.total,
      memo: memoForms[s],
    };
  }
  throw new Error(`unknown level ${level}`);
}

/**
 * The mutations that make a genuinely distinct act, tagged with the FIRST level
 * at which the schema types the attribute they touch — i.e. the level at which
 * the refuter starts settling that class without a model call.
 *
 * `decidedFrom: null` marks the class that no level in this ladder decides. Cost
 * centre is act-determining (paying the logistics budget is not paying the
 * marketing budget) and is prose at every rung, so these pairs are residual all
 * the way up. They are the pool the refinement dilemma either starves or is
 * replenished from.
 */
export const LADDER_MUTATIONS = [
  { name: "amount", decidedFrom: "L2_moderate", apply: (a) => ({ ...a, amount: Math.round((a.amount + 1) * 100) / 100 }) },
  { name: "amount_cents", decidedFrom: "L2_moderate", apply: (a) => ({ ...a, amount: Math.round((a.amount + 0.01) * 100) / 100 }) },
  { name: "payee", decidedFrom: "L2_moderate", apply: (a) => ({ ...a, payee: `${a.payee} Holdings` }) },
  { name: "payer", decidedFrom: "L2_moderate", apply: (a) => ({ ...a, payer: a.payer.replace(/(\d+)$/, (m) => String(Number(m) + 1)) }) },
  { name: "currency", decidedFrom: "L2_moderate", apply: (a) => ({ ...a, currency: a.currency === "USD" ? "EUR" : "USD" }) },
  { name: "invoice", decidedFrom: "L3_strict", apply: (a) => ({ ...a, invoice: a.invoice.replace(/(\d+)$/, (m) => String(Number(m) + 1)) }) },
  { name: "installment", decidedFrom: "L3_strict", apply: (a) => ({ ...a, index: a.index === a.total ? Math.max(1, a.index - 1) : a.index + 1 }) },
  { name: "cost_centre", decidedFrom: null, apply: (a) => ({ ...a, costCentre: a.costCentre === "CC-LOGISTICS" ? "CC-FACILITIES" : "CC-LOGISTICS" }) },
];

export const LEVEL_ORDER = ["L1_loose", "L2_moderate", "L3_strict"];

/**
 * Alternative cost centres, used ONLY to build the replenishment pool.
 *
 * The refinement dilemma has two candidate explanations and the base ladder
 * cannot tell them apart. Either refinement intrinsically degrades the
 * calibrated layer on the residual that survives it, or it merely starves the
 * pool, and the degradation would disappear if a deployment gathered more
 * calibration data at the finer schema. The base ladder holds the GENERATION
 * BUDGET fixed, so the pool shrinks with the residual (32 / 12 / 4 distinct
 * calibration pairs at the three levels) and the two explanations are
 * confounded.
 *
 * These pairs differ only in cost centre, which no rung of the ladder types, so
 * they are residual at EVERY level. Topping every level's pool up to a common n
 * with them removes pool size as an explanation: whatever difference survives
 * is the intrinsic part. They are tagged `L_replenish`, held in the calibration
 * split, and excluded from the fixed-budget condition — mixing them in there
 * would be exactly the confound this is meant to remove.
 */
export const COST_CENTRES = [
  "CC-LOGISTICS", "CC-FACILITIES", "CC-MARKETING", "CC-PRODUCT",
  "CC-IT", "CC-DATA", "CC-OFFICE", "CC-LEGAL", "CC-RESEARCH", "CC-SUPPORT",
];

/** Distinct acts differing only in an attribute no level types. */
export function replenishmentPairs(act) {
  const others = COST_CENTRES.filter((c) => c !== act.costCentre);
  return others.slice(0, 6).map((cc) => ({ ...act, costCentre: cc }));
}

/**
 * Is a mutation class decided by the refuter at this level?
 *
 * This is the ladder's ground truth about the DECOMPOSITION, separate from the
 * ground truth about the LABEL. It lets the analysis check the implementation
 * against the design — if a class the design says is decided at L3 is still
 * reaching the judge, the projection is not doing what the declaration claims,
 * and that is a bug in the mechanism rather than a finding about the theory.
 */
export const decidedAtLevel = (mutation, level) => {
  if (!mutation.decidedFrom) return false;
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(mutation.decidedFrom);
};
