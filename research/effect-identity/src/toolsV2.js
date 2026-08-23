import { POLICY } from "./canonicalize.js";
import { TOOLS as TOOLS_V1 } from "./tools.js";

/**
 * The EXTENDED tool surface (corpus v2).
 *
 * The v1 surface was six tools and three effect shapes — move money, send a
 * message, open a record — which is enough to state the problem and not enough
 * to say anything about how the residual varies with what a tool actually does.
 * T6 makes the residual a property of the declaration, so a benchmark that
 * varies declarations weakly cannot test T6 at all: every measured residual is
 * a measurement of one schema author's habits.
 *
 * This file adds eight tools chosen for structural difference rather than for
 * domain variety. What distinguishes them is where the act's identity LIVES:
 *
 *   - fully pinned by typed fields (delete_resource, grant_access): the
 *     projection is a complete invariant, so A5″ holds and the residual is
 *     nearly empty. These are the cases where the theory predicts the judge
 *     should have almost nothing to do.
 *   - pinned except for a quantity or an index (place_order, book_reservation):
 *     two orders for the same SKU by the same customer are distinct acts, and
 *     nothing in the typed fields says so. The residual is a repeat-detection
 *     problem.
 *   - carried mostly by prose (update_document, send_sms): the payload IS the
 *     act, so canonicalisation cannot help and the projection pins only the
 *     addressee. Maximal residual.
 *   - carried by a version token (patch_resource): an etag makes two otherwise
 *     identical patches distinct, which is the one case in this surface where
 *     a typed field distinguishes acts that a human reader would call the same.
 *
 * Each tool carries an explicit `spec` block. It is not documentation: the
 * manifest generator reads it, the corpus generator reads it to decide which
 * mutations are act-changing, and the schema-level sweep reads it to build
 * loose/moderate/strict variants of the same acts. Writing the ambiguity
 * classes down is also the only honest way to declare, in advance of the
 * measurement, which pairs we expect to land in the residual.
 */

/**
 * @typedef {object} ToolSpec
 * @property {string} effectStructure  what the act does to the world
 * @property {string[]} effectDetermining  fields that decide WHICH act this is
 * @property {string[]} nonEffectDetermining  fields that do not
 * @property {string[]} canonicalizable  fields with a semantics-preserving normal form
 * @property {string} witnessProjection  what sigma pins for this tool
 * @property {string[]} ambiguityClasses  known ways two calls can be residual
 * @property {boolean} irreversible
 * @property {boolean} projectionComplete  does A5'' hold (projection decides identity outright)?
 */

export const TOOLS_V2_NEW = {
  // ── purchase / order ────────────────────────────────────────────────────────
  place_order: {
    effect: "IRREVERSIBLE",
    fields: {
      customer_id: POLICY.ID, sku: POLICY.ID, quantity: POLICY.NUM,
      unit_price: POLICY.NUM, currency: POLICY.CI, shipping_note: POLICY.TEXT,
    },
    spec: {
      effectStructure: "creates a fulfilment obligation and charges for it",
      effectDetermining: ["customer_id", "sku", "quantity", "unit_price", "currency"],
      nonEffectDetermining: ["shipping_note"],
      canonicalizable: ["quantity", "unit_price", "currency", "shipping_note"],
      witnessProjection: "customer_id, sku, quantity, unit_price, currency",
      ambiguityClasses: [
        "a genuine re-order of the same SKU by the same customer is a distinct act with an identical projection",
        "a quantity change expressed as a second order vs a corrected first order",
      ],
      irreversible: true,
      projectionComplete: false,
    },
  },

  // ── reservation ─────────────────────────────────────────────────────────────
  book_reservation: {
    effect: "IRREVERSIBLE",
    fields: {
      property_id: POLICY.ID, guest_email: POLICY.CI, check_in: POLICY.ID,
      nights: POLICY.NUM, room_type: POLICY.CI, request_note: POLICY.TEXT,
    },
    spec: {
      effectStructure: "holds inventory for a date range and commits to a price",
      effectDetermining: ["property_id", "guest_email", "check_in", "nights", "room_type"],
      nonEffectDetermining: ["request_note"],
      canonicalizable: ["guest_email", "nights", "room_type", "request_note"],
      witnessProjection: "property_id, guest_email, check_in, nights, room_type",
      ambiguityClasses: [
        "two rooms of the same type for the same guest on the same night are distinct acts with an identical projection",
        "date expressed relatively ('tomorrow') vs absolutely — an id-policy field cannot resolve it",
      ],
      irreversible: true,
      projectionComplete: false,
    },
  },

  // ── access / permission change ──────────────────────────────────────────────
  grant_access: {
    effect: "IRREVERSIBLE",
    fields: {
      principal_id: POLICY.ID, resource_id: POLICY.ID, role: POLICY.CI,
      expires_at: POLICY.ID, justification: POLICY.TEXT,
    },
    spec: {
      effectStructure: "monotonically widens an authorization set",
      effectDetermining: ["principal_id", "resource_id", "role", "expires_at"],
      nonEffectDetermining: ["justification"],
      canonicalizable: ["role", "justification"],
      witnessProjection: "principal_id, resource_id, role, expires_at",
      ambiguityClasses: [
        "re-granting an already-held role is idempotent in the world but not in the audit log",
      ],
      irreversible: true,
      // Granting the same principal the same role on the same resource until the
      // same instant IS the same act: nothing outside these fields can make two
      // such grants different.
      projectionComplete: true,
    },
  },

  // ── resource deletion ───────────────────────────────────────────────────────
  delete_resource: {
    effect: "IRREVERSIBLE",
    fields: {
      resource_type: POLICY.CI, resource_id: POLICY.ID, hard_delete: POLICY.CI, reason: POLICY.TEXT,
    },
    spec: {
      effectStructure: "removes a named object; not transparently invertible",
      effectDetermining: ["resource_type", "resource_id", "hard_delete"],
      nonEffectDetermining: ["reason"],
      canonicalizable: ["resource_type", "hard_delete", "reason"],
      witnessProjection: "resource_type, resource_id, hard_delete",
      ambiguityClasses: [
        "a soft delete followed by a hard delete of the same id are distinct acts distinguished by one flag",
      ],
      irreversible: true,
      // A deletion is identified by what it deletes and how. There is no second
      // deletion of the same object.
      projectionComplete: true,
    },
  },

  // ── document mutation ───────────────────────────────────────────────────────
  update_document: {
    effect: "IRREVERSIBLE",
    fields: {
      document_id: POLICY.ID, section: POLICY.ID, body: POLICY.TEXT, change_note: POLICY.TEXT,
    },
    spec: {
      effectStructure: "replaces a section's content; the payload IS the act",
      effectDetermining: ["document_id", "section", "body"],
      nonEffectDetermining: ["change_note"],
      canonicalizable: ["change_note"],
      witnessProjection: "document_id, section — the body is text and is not pinned",
      ambiguityClasses: [
        "two genuinely different edits to the same section have an identical projection",
        "a reworded edit with the same meaning is the same act and the same projection",
        "the residual here is the whole decision: this is the maximal-residual case",
      ],
      irreversible: true,
      projectionComplete: false,
    },
  },

  // ── message dispatch ────────────────────────────────────────────────────────
  send_sms: {
    effect: "IRREVERSIBLE",
    fields: { to: POLICY.ID, body: POLICY.TEXT },
    spec: {
      effectStructure: "delivers one message to one handset",
      effectDetermining: ["to", "body"],
      nonEffectDetermining: [],
      canonicalizable: ["body"],
      witnessProjection: "to — the body is text and is not pinned",
      ambiguityClasses: [
        "a reminder resent deliberately is a distinct act with an identical projection and near-identical text",
        "two different messages to the same number share a projection",
      ],
      irreversible: true,
      projectionComplete: false,
    },
  },

  // ── generic API mutation, version-token identity ────────────────────────────
  patch_resource: {
    effect: "IRREVERSIBLE",
    fields: {
      resource_id: POLICY.ID, field: POLICY.ID, value: POLICY.TEXT,
      if_match_etag: POLICY.ID, note: POLICY.TEXT,
    },
    spec: {
      effectStructure: "compare-and-set on one field of one object",
      effectDetermining: ["resource_id", "field", "value", "if_match_etag"],
      nonEffectDetermining: ["note"],
      canonicalizable: ["note"],
      witnessProjection: "resource_id, field, if_match_etag — the value is text",
      ambiguityClasses: [
        "the etag makes two otherwise identical patches DISTINCT, which is the one case here where a typed field separates acts a reader would call the same",
        "a retried patch under a stale etag is the same act, but the provider will reject it — identity and admissibility diverge",
      ],
      irreversible: true,
      projectionComplete: false,
    },
  },

  // ── account mutation ────────────────────────────────────────────────────────
  update_account: {
    effect: "IRREVERSIBLE",
    fields: {
      account_id: POLICY.ID, attribute: POLICY.CI, new_value: POLICY.TEXT, reason: POLICY.TEXT,
    },
    spec: {
      effectStructure: "overwrites one attribute of one account",
      effectDetermining: ["account_id", "attribute", "new_value"],
      nonEffectDetermining: ["reason"],
      canonicalizable: ["attribute", "reason"],
      witnessProjection: "account_id, attribute — the new value is text",
      ambiguityClasses: [
        "the same attribute set to a differently-formatted equal value is one act; the projection cannot see it",
        "two successive changes to the same attribute are distinct acts with an identical projection",
      ],
      irreversible: true,
      projectionComplete: false,
    },
  },
};

/**
 * Specs for the six v1 tools, written down for the manifest so that the
 * benchmark's declaration story is uniform across corpus versions. These
 * describe the schemas as they already are; nothing here changes v1 behaviour.
 */
export const TOOL_SPECS_V1 = {
  charge_card: {
    effectStructure: "moves money from a stored instrument",
    effectDetermining: ["customer_id", "amount", "currency"], nonEffectDetermining: ["memo"],
    canonicalizable: ["amount", "currency", "memo"], witnessProjection: "customer_id, amount, currency",
    ambiguityClasses: ["a second legitimate charge of the same amount to the same customer shares a projection"],
    irreversible: true, projectionComplete: false,
  },
  post_refund: {
    effectStructure: "returns money against a prior charge",
    effectDetermining: ["charge_id", "amount"], nonEffectDetermining: ["reason"],
    canonicalizable: ["amount", "reason"], witnessProjection: "charge_id, amount",
    ambiguityClasses: ["a partial refund issued twice for different reasons shares a projection"],
    irreversible: true, projectionComplete: false,
  },
  transfer_funds: {
    effectStructure: "moves money between two named accounts",
    effectDetermining: ["from_account", "to_account", "amount", "currency"], nonEffectDetermining: ["note"],
    canonicalizable: ["amount", "currency", "note"], witnessProjection: "from_account, to_account, amount, currency",
    ambiguityClasses: ["scheduled instalments of equal size share a projection"],
    irreversible: true, projectionComplete: false,
  },
  send_email: {
    effectStructure: "delivers one message to one address",
    effectDetermining: ["to", "subject", "body"], nonEffectDetermining: [],
    canonicalizable: ["to", "subject", "body"], witnessProjection: "to — subject and body are text",
    ambiguityClasses: ["a follow-up with different content shares the projection"],
    irreversible: true, projectionComplete: false,
  },
  create_ticket: {
    effectStructure: "opens a work item",
    effectDetermining: ["title", "description", "priority"], nonEffectDetermining: [],
    canonicalizable: ["priority", "title", "description"], witnessProjection: "priority only — the whole subject matter is text",
    ambiguityClasses: ["two different incidents at the same priority share the projection"],
    irreversible: true, projectionComplete: false,
  },
  wire_money: {
    effectStructure: "moves money to an external beneficiary",
    effectDetermining: ["amount_text", "beneficiary_text", "reference"], nonEffectDetermining: [],
    canonicalizable: ["amount_text", "beneficiary_text", "reference"],
    witnessProjection: "NOTHING — every field is text, so the witness is empty and the judge decides alone",
    ambiguityClasses: [
      "the deliberately loose case: amount and payee live in prose, so paraphrase is unconstrained",
      "instalments are distinguished only by a token in the reference",
    ],
    irreversible: true, projectionComplete: false,
  },
};

/** The full v2 surface: the six v1 tools plus the eight added here. */
export const TOOLS_V2 = { ...TOOLS_V1, ...TOOLS_V2_NEW };

/** Tool → spec, for every tool in the v2 surface. */
export const TOOL_SPECS = Object.fromEntries([
  ...Object.entries(TOOL_SPECS_V1),
  ...Object.entries(TOOLS_V2_NEW).map(([name, t]) => [name, t.spec]),
]);

export const V1_TOOLS = Object.keys(TOOLS_V1);
export const V2_NEW_TOOLS = Object.keys(TOOLS_V2_NEW);

/**
 * A DELIBERATELY BROKEN schema, used by the adversarial suite.
 *
 * `account_no` is an identifier whose leading zeros are significant — account
 * 0012 is not account 12 — and it is declared `num`, which normalises both to
 * the same canonical value. That declaration violates A5: the policy is not
 * semantics-preserving for this field's contribution to the effect.
 *
 * Nothing in the mechanism detects this. The certifier will suppress across the
 * two accounts unconditionally, with no judge consulted and no escalation band
 * in the path, because L0 suppression is exact BY ASSUMPTION and the assumption
 * is false. It is here to measure that: A5 is an obligation the schema author
 * signs, the paper's guarantees are void without it, and the cost of getting it
 * wrong is a silent wrong suppression rather than a degraded rate.
 */
export const MISDECLARED_SCHEMA = {
  effect: "IRREVERSIBLE",
  fields: { account_no: POLICY.NUM, amount: POLICY.NUM, currency: POLICY.CI, memo: POLICY.TEXT },
};
