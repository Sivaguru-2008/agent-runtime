import { POLICY, normalizeField } from "../canonicalize.js";

/**
 * A second instance of the certifier / refuter / residual recipe: action
 * authorisation.
 *
 * The question is no longer "is this request the same act as a committed
 * effect?" but "is this action within what a standing user approval
 * authorised?". The safety-critical error is WRONG AUTHORISATION: permitting an
 * action that no approval covers. It is silent in the way wrong suppression is
 * silent: the action executes, and nobody was asked. The other error, declining
 * an action the user did approve, is visible by construction, because a
 * declined action goes back to the user for confirmation.
 *
 * An approval carries typed constraints and a free-text scope. The recipe maps
 * onto it field for field:
 *
 *   certifier  every typed constraint holds AND the action's purpose text is
 *              canonically equal to the approved scope      -> PERMIT, no model
 *   refuter    some typed constraint fails (a different recipient, an amount
 *              over the cap, a higher role, a later expiry)  -> ASK, no model
 *   residual   typed constraints hold, purpose text differs  -> judge
 *
 * On the residual the judge scores P(covered), and the action is permitted only
 * if the maximum score over the surviving approvals exceeds a threshold
 * calibrated on NOT-covered residual pairs at level alpha/m. That is the
 * fence's rule with "covered" in place of "same act", so Theorem 1 applies
 * verbatim with wrong authorisation in place of wrong suppression.
 */

const ROLE_ORDER = ["viewer", "editor", "admin"];

/**
 * Per-tool declarations. `constraints` pair an action field with the approval
 * field that bounds it; `purpose` names the action's free-text field that the
 * approval's scope governs.
 *
 *   eq     action value must equal the approval value (ID policy: exact)
 *   eq_ci  equal after case-insensitive normalisation (emails, currency codes)
 *   max    numeric action value must not exceed the approval value
 *   role   role must not rank above the approved maximum
 *   before ISO date/time must not be later than the approval's
 */
export const AUTHZ_TOOLS = {
  issue_refund: {
    constraints: [
      { field: "customer_id", kind: "eq", approval: "customer_id" },
      { field: "order_id", kind: "eq", approval: "order_id" },
      { field: "amount", kind: "max", approval: "max_amount" },
      { field: "currency", kind: "eq_ci", approval: "currency" },
    ],
    purpose: "reason",
  },
  transfer_funds: {
    constraints: [
      { field: "from_account", kind: "eq", approval: "from_account" },
      { field: "to_account", kind: "eq", approval: "to_account" },
      { field: "amount", kind: "max", approval: "max_amount" },
      { field: "currency", kind: "eq_ci", approval: "currency" },
    ],
    purpose: "memo",
  },
  send_email: {
    constraints: [{ field: "to", kind: "eq_ci", approval: "to" }],
    purpose: "body",
  },
  grant_access: {
    constraints: [
      { field: "principal_id", kind: "eq", approval: "principal_id" },
      { field: "resource_id", kind: "eq", approval: "resource_id" },
      { field: "role", kind: "role", approval: "max_role" },
      { field: "expires_at", kind: "before", approval: "expires_by" },
    ],
    purpose: "justification",
  },
};

// normalizeField returns the canonical decimal as a string; a missing or
// non-numeric value becomes NaN so that the constraint fails closed.
const num = (v) => {
  const c = normalizeField(v, POLICY.NUM);
  return c === null || c === "" ? NaN : Number(c);
};

/** Does one typed constraint hold? Unparseable values fail closed (the constraint does not hold). */
export function constraintHolds(c, action, approval) {
  const a = action[c.field], b = approval.constraints[c.approval];
  switch (c.kind) {
    case "eq": return normalizeField(a, POLICY.ID) === normalizeField(b, POLICY.ID);
    case "eq_ci": return normalizeField(a, POLICY.CI) === normalizeField(b, POLICY.CI);
    case "max": {
      const x = num(a), y = num(b);
      return Number.isFinite(x) && Number.isFinite(y) && x <= y;
    }
    case "role": {
      const i = ROLE_ORDER.indexOf(String(a).trim().toLowerCase()), j = ROLE_ORDER.indexOf(String(b).trim().toLowerCase());
      return i !== -1 && j !== -1 && i <= j;
    }
    case "before": {
      const x = Date.parse(a), y = Date.parse(b);
      return Number.isFinite(x) && Number.isFinite(y) && x <= y;
    }
    default: throw new Error(`unknown constraint kind ${c.kind}`);
  }
}

/**
 * Route one (action, approval) pair through the decidable layers.
 * @returns {"certified" | "refuted" | "residual"}
 */
export function route(tool, action, approval) {
  const spec = AUTHZ_TOOLS[tool];
  if (!spec) throw new Error(`no authorisation schema for ${tool}`);
  if (approval.tool !== tool) return "refuted";
  for (const c of spec.constraints) if (!constraintHolds(c, action, approval)) return "refuted";
  const scope = approval.scope ?? "";
  if (scope === "") return "certified";
  const same = normalizeField(action[spec.purpose] ?? "", POLICY.TEXT) === normalizeField(scope, POLICY.TEXT);
  return same ? "certified" : "residual";
}
