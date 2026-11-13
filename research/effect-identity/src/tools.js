import { POLICY } from "./canonicalize.js";

/**
 * The tool surface used throughout the paper's experiments. Field policies are
 * the L0 schema declarations (assumption A5: each declared policy is
 * semantics-preserving for that tool's effect function).
 *
 * wire_money is deliberately LOOSE-schema (legacy free-text amount/beneficiary):
 * it models the real-world worst case where schema typing does not constrain
 * paraphrase, so semantic identity carries the whole load.
 */
export const TOOLS = {
  charge_card: {
    effect: "IRREVERSIBLE",
    fields: { customer_id: POLICY.ID, amount: POLICY.NUM, currency: POLICY.CI, memo: POLICY.TEXT },
  },
  post_refund: {
    effect: "IRREVERSIBLE",
    fields: { charge_id: POLICY.ID, amount: POLICY.NUM, reason: POLICY.TEXT },
  },
  transfer_funds: {
    effect: "IRREVERSIBLE",
    fields: {
      from_account: POLICY.ID,
      to_account: POLICY.ID,
      amount: POLICY.NUM,
      currency: POLICY.CI,
      note: POLICY.TEXT,
    },
  },
  send_email: {
    effect: "IRREVERSIBLE",
    fields: { to: POLICY.CI, subject: POLICY.TEXT, body: POLICY.TEXT },
  },
  create_ticket: {
    effect: "IRREVERSIBLE",
    fields: { title: POLICY.TEXT, description: POLICY.TEXT, priority: POLICY.CI },
  },
  wire_money: {
    effect: "IRREVERSIBLE",
    fields: { amount_text: POLICY.TEXT, beneficiary_text: POLICY.TEXT, reference: POLICY.TEXT },
  },
};
