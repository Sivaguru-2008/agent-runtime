/**
 * Seed acts for the eight tools added in corpus v2, plus a hand-authored
 * paraphrase arm and hand-authored same-surface/different-intent pairs for each.
 *
 * Two rules govern everything here and both exist to stop the corpus flattering
 * the mechanism.
 *
 * 1. A SAME pair must denote one act. Every hand-authored variant below rewords
 *    only fields the tool's spec lists as non-effect-determining, or reformats a
 *    value the tool's canonicalisation policy is documented to normalise. The
 *    numeric validator still runs over these, so a slip is caught rather than
 *    trusted.
 *
 * 2. A DIFF pair must denote two acts a careful reader would agree are two. The
 *    D3-style pairs are written to be maximally similar on the surface — that is
 *    the point of them — but never ambiguous about intent. Where a pair IS
 *    genuinely arguable it belongs in the sensitivity analysis, not in the
 *    headline, and it is labelled as such here.
 */

export const ORDER_SEEDS = [
  { customer_id: "cust_21", sku: "SKU-4410", quantity: 2, unit_price: 34.5, currency: "USD", shipping_note: "leave with the concierge if nobody answers" },
  { customer_id: "cust_22", sku: "SKU-1180", quantity: 1, unit_price: 129, currency: "USD", shipping_note: "gift wrap, no invoice in the box" },
  { customer_id: "cust_23", sku: "SKU-7702", quantity: 6, unit_price: 8.75, currency: "EUR", shipping_note: "deliver to the loading bay before 11:00" },
  { customer_id: "cust_24", sku: "SKU-3391", quantity: 3, unit_price: 260, currency: "GBP", shipping_note: "fragile — do not stack" },
  { customer_id: "cust_25", sku: "SKU-9004", quantity: 12, unit_price: 2.4, currency: "USD", shipping_note: "consolidate with order for the same site" },
].map((input) => ({ tool: "place_order", input }));

export const RESERVATION_SEEDS = [
  { property_id: "prop_seaview_12", guest_email: "rhea@example.com", check_in: "2026-09-14", nights: 3, room_type: "double", request_note: "high floor if one is free" },
  { property_id: "prop_oakline_04", guest_email: "tomas@example.com", check_in: "2026-10-02", nights: 1, room_type: "single", request_note: "late arrival, around 23:00" },
  { property_id: "prop_seaview_12", guest_email: "ines@example.com", check_in: "2026-09-14", nights: 5, room_type: "suite", request_note: "quiet side of the building please" },
  { property_id: "prop_harbour_31", guest_email: "dmitri@example.com", check_in: "2026-11-20", nights: 2, room_type: "twin", request_note: "two separate beds, travelling with a colleague" },
].map((input) => ({ tool: "book_reservation", input }));

export const ACCESS_SEEDS = [
  { principal_id: "svc_reporting", resource_id: "db_analytics_prod", role: "reader", expires_at: "2026-09-30T00:00:00Z", justification: "quarterly close needs read access to the warehouse" },
  { principal_id: "user_kmarsh", resource_id: "repo_payments", role: "maintainer", expires_at: "2026-12-31T00:00:00Z", justification: "taking over the payments service from the previous owner" },
  { principal_id: "svc_backup", resource_id: "bucket_ledger_archive", role: "writer", expires_at: "2027-01-15T00:00:00Z", justification: "nightly archival job needs to write snapshots" },
  { principal_id: "user_ophelia", resource_id: "dash_revenue", role: "viewer", expires_at: "2026-10-01T00:00:00Z", justification: "board pack preparation" },
].map((input) => ({ tool: "grant_access", input }));

export const DELETE_SEEDS = [
  { resource_type: "bucket_object", resource_id: "s3://ledger-archive/2025-11/part-0007.parquet", hard_delete: "true", reason: "retention window elapsed" },
  { resource_type: "user_session", resource_id: "sess_9f2a11c4", hard_delete: "false", reason: "user requested sign-out from all devices" },
  { resource_type: "api_key", resource_id: "key_live_88213", hard_delete: "true", reason: "key was pasted into a public issue" },
  { resource_type: "document", resource_id: "doc_onboarding_v3", hard_delete: "false", reason: "superseded by v4, keeping it recoverable for a quarter" },
].map((input) => ({ tool: "delete_resource", input }));

export const DOCUMENT_SEEDS = [
  { document_id: "doc_runbook_payments", section: "rollback", body: "If the reconciliation job reports a mismatch above 0.5%, freeze payouts and page the on-call before rerunning.", change_note: "tightened the rollback trigger" },
  { document_id: "doc_policy_refunds", section: "eligibility", body: "Refunds are available within 30 days of delivery for unopened items, and within 14 days for opened items in resaleable condition.", change_note: "clarified the opened-item window" },
  { document_id: "doc_runbook_payments", section: "escalation", body: "Page the payments on-call first; escalate to the platform lead only if the incident crosses two services.", change_note: "added the two-service condition" },
  { document_id: "doc_sla_enterprise", section: "availability", body: "Monthly availability is measured over successful requests to the public API, excluding scheduled maintenance announced 72 hours in advance.", change_note: "defined the measurement basis" },
].map((input) => ({ tool: "update_document", input }));

export const SMS_SEEDS = [
  { to: "+15550142", body: "Your delivery for order 4410 arrives tomorrow between 09:00 and 12:00. Reply STOP to opt out." },
  { to: "+15550188", body: "Reminder: your appointment at the Oakline clinic is on 2 October at 14:30." },
  { to: "+15550231", body: "Your one-time code is 448120. It expires in 10 minutes and we will never ask you for it." },
  { to: "+15550377", body: "Payment of 129.00 USD to Northwind received. Balance is now zero." },
].map((input) => ({ tool: "send_sms", input }));

export const PATCH_SEEDS = [
  { resource_id: "cfg_rate_limits", field: "requests_per_minute", value: "600", if_match_etag: "W/\"a17f\"", note: "raising the ceiling for the launch window" },
  { resource_id: "user_kmarsh", field: "display_name", value: "K. Marsh", if_match_etag: "W/\"3b09\"", note: "user asked for the abbreviated form" },
  { resource_id: "feature_checkout_v2", field: "rollout_percent", value: "25", if_match_etag: "W/\"c204\"", note: "second ramp step" },
  { resource_id: "cfg_retention", field: "days", value: "365", if_match_etag: "W/\"7e51\"", note: "aligning with the new policy" },
].map((input) => ({ tool: "patch_resource", input }));

export const ACCOUNT_SEEDS = [
  { account_id: "acct_10021", attribute: "billing_email", new_value: "finance@northwind.example", reason: "AP address changed after the reorg" },
  { account_id: "acct_10044", attribute: "plan", new_value: "enterprise", reason: "signed the annual contract" },
  { account_id: "acct_10098", attribute: "mfa_required", new_value: "true", reason: "security review action item" },
  { account_id: "acct_10112", attribute: "billing_currency", new_value: "EUR", reason: "entity moved to the EU billing entity" },
].map((input) => ({ tool: "update_account", input }));

export const V2_SEEDS = [
  ...ORDER_SEEDS, ...RESERVATION_SEEDS, ...ACCESS_SEEDS, ...DELETE_SEEDS,
  ...DOCUMENT_SEEDS, ...SMS_SEEDS, ...PATCH_SEEDS, ...ACCOUNT_SEEDS,
];

/**
 * Hand-authored paraphrases, in seed order (`V2_SEEDS[i]` ↔ `V2_HANDWRITTEN[i]`),
 * two per seed. Same purpose as the v1 arm: an arm with no model in the loop, so
 * that a judge scoring well cannot be explained by it recognising machine
 * phrasing. Same caveat too — the authors wrote these, so it controls the
 * generator confound and not the author-definition confound.
 *
 * Only non-effect-determining fields are reworded. Where a tool has no such
 * field (send_sms, update_document), the variant reformats the payload in ways
 * the tool's own documentation treats as immaterial — whitespace, punctuation,
 * and equivalent renderings of the same numbers — rather than rewriting meaning.
 */
export const V2_HANDWRITTEN = [
  // place_order (shipping_note)
  [{ shipping_note: "if there's no answer, the concierge can take it" }, { shipping_note: "hand to the concierge when nobody is in" }],
  [{ shipping_note: "wrap as a gift and keep the invoice out of the parcel" }, { shipping_note: "gift wrapping please, no paperwork inside" }],
  [{ shipping_note: "drop at the loading bay, must be before 11am" }, { shipping_note: "loading bay delivery, no later than 11:00" }],
  [{ shipping_note: "handle as fragile, nothing on top" }, { shipping_note: "fragile — please do not stack anything on it" }],
  [{ shipping_note: "combine with the other order going to the same site" }, { shipping_note: "ship together with the same-site order" }],
  // book_reservation (request_note)
  [{ request_note: "a high floor would be appreciated if available" }, { request_note: "if you have anything on a high floor, we'll take it" }],
  [{ request_note: "arriving late — expect us near 23:00" }, { request_note: "late check-in, roughly 11pm" }],
  [{ request_note: "please pick a room on the quiet side" }, { request_note: "quiet side of the building if that's possible" }],
  [{ request_note: "twin beds needed, travelling with a colleague" }, { request_note: "two beds please — colleague travelling with me" }],
  // grant_access (justification)
  [{ justification: "read access to the warehouse for the quarterly close" }, { justification: "needs warehouse reads while we close the quarter" }],
  [{ justification: "inheriting the payments service from its previous owner" }, { justification: "takes over payments from the outgoing owner" }],
  [{ justification: "the nightly archival job writes snapshots here" }, { justification: "needed so nightly archival can write its snapshots" }],
  [{ justification: "preparing the board pack" }, { justification: "board pack prep" }],
  // delete_resource (reason)
  [{ reason: "past its retention window" }, { reason: "retention period has elapsed" }],
  [{ reason: "user asked to be signed out everywhere" }, { reason: "sign-out from all devices, at the user's request" }],
  [{ reason: "the key was leaked in a public issue" }, { reason: "key exposed in a public issue thread" }],
  [{ reason: "v4 supersedes it; keep it recoverable for a quarter" }, { reason: "replaced by v4 — recoverable for the next quarter" }],
  // update_document (change_note only; the body is the act and is not reworded)
  [{ change_note: "made the rollback trigger stricter" }, { change_note: "rollback trigger tightened" }],
  [{ change_note: "clarified how long an opened item can be returned" }, { change_note: "spelled out the opened-item window" }],
  [{ change_note: "added the condition about crossing two services" }, { change_note: "noted the two-service escalation condition" }],
  [{ change_note: "wrote down what availability is measured over" }, { change_note: "defined the measurement basis for availability" }],
  // send_sms (immaterial reformatting only — the body IS the act)
  [{ body: "Your delivery for order 4410 arrives tomorrow between 09:00 and 12:00.  Reply STOP to opt out." },
   { body: "Your delivery for order 4410 arrives tomorrow between 09:00 and 12:00. Reply STOP to opt out. " }],
  [{ body: "Reminder: your appointment at the Oakline clinic is on 2 October at 14:30." },
   { body: "Reminder: your appointment at the Oakline clinic is on 2 October at 14:30. " }],
  [{ body: "Your one-time code is 448120. It expires in 10 minutes and we will never ask you for it." },
   { body: "Your one-time code is 448120.  It expires in 10 minutes and we will never ask you for it." }],
  [{ body: "Payment of 129.00 USD to Northwind received. Balance is now zero." },
   { body: "Payment of 129.00 USD to Northwind received.  Balance is now zero." }],
  // patch_resource (note)
  [{ note: "lifting the ceiling for launch" }, { note: "raised for the launch window" }],
  [{ note: "the user prefers the short form" }, { note: "switching to the abbreviated name at the user's request" }],
  [{ note: "second step of the ramp" }, { note: "ramp step two" }],
  [{ note: "bringing this in line with the new policy" }, { note: "aligned to the updated policy" }],
  // update_account (reason)
  [{ reason: "accounts payable moved address after the reorg" }, { reason: "AP contact changed following the reorganisation" }],
  [{ reason: "the annual contract has been signed" }, { reason: "annual contract signed" }],
  [{ reason: "action item from the security review" }, { reason: "security review asked for this" }],
  [{ reason: "the entity moved to EU billing" }, { reason: "now billed through the EU entity" }],
];

/**
 * Hand-authored D3 pairs for the new tools: same tool, same principals, and a
 * deliberately similar surface, but two acts. These are the wrong-suppression
 * danger zone — the population where a judge that pattern-matches on surface
 * similarity will fail, and where a mechanism has to be right.
 */
export const V2_D3_PAIRS = [
  {
    tool: "place_order",
    a: { customer_id: "cust_21", sku: "SKU-4410", quantity: 2, unit_price: 34.5, currency: "USD", shipping_note: "leave with the concierge" },
    b: { customer_id: "cust_21", sku: "SKU-4411", quantity: 2, unit_price: 34.5, currency: "USD", shipping_note: "leave with the concierge" },
  },
  {
    tool: "book_reservation",
    a: { property_id: "prop_seaview_12", guest_email: "rhea@example.com", check_in: "2026-09-14", nights: 3, room_type: "double", request_note: "high floor if free" },
    b: { property_id: "prop_seaview_12", guest_email: "rhea@example.com", check_in: "2026-09-21", nights: 3, room_type: "double", request_note: "high floor if free" },
  },
  {
    tool: "grant_access",
    a: { principal_id: "svc_reporting", resource_id: "db_analytics_prod", role: "reader", expires_at: "2026-09-30T00:00:00Z", justification: "quarterly close" },
    b: { principal_id: "svc_reporting", resource_id: "db_analytics_prod", role: "writer", expires_at: "2026-09-30T00:00:00Z", justification: "quarterly close" },
  },
  {
    tool: "delete_resource",
    a: { resource_type: "document", resource_id: "doc_onboarding_v3", hard_delete: "false", reason: "superseded by v4" },
    b: { resource_type: "document", resource_id: "doc_onboarding_v3", hard_delete: "true", reason: "superseded by v4" },
  },
  {
    tool: "update_document",
    a: { document_id: "doc_policy_refunds", section: "eligibility", body: "Refunds are available within 30 days of delivery for unopened items.", change_note: "policy update" },
    b: { document_id: "doc_policy_refunds", section: "eligibility", body: "Refunds are available within 60 days of delivery for unopened items.", change_note: "policy update" },
  },
  {
    tool: "update_document",
    a: { document_id: "doc_runbook_payments", section: "rollback", body: "Freeze payouts and page the on-call before rerunning.", change_note: "rollback" },
    b: { document_id: "doc_runbook_payments", section: "rollback", body: "Rerun first; freeze payouts only if the second run also mismatches.", change_note: "rollback" },
  },
  {
    tool: "send_sms",
    a: { to: "+15550231", body: "Your one-time code is 448120. It expires in 10 minutes." },
    b: { to: "+15550231", body: "Your one-time code is 448121. It expires in 10 minutes." },
  },
  {
    tool: "send_sms",
    a: { to: "+15550188", body: "Reminder: your appointment at the Oakline clinic is on 2 October at 14:30." },
    b: { to: "+15550188", body: "Your appointment at the Oakline clinic on 2 October at 14:30 has been cancelled." },
  },
  {
    tool: "patch_resource",
    a: { resource_id: "feature_checkout_v2", field: "rollout_percent", value: "25", if_match_etag: "W/\"c204\"", note: "ramp" },
    b: { resource_id: "feature_checkout_v2", field: "rollout_percent", value: "50", if_match_etag: "W/\"c204\"", note: "ramp" },
  },
  {
    // The etag case: same field, same target value, different precondition.
    // Two compare-and-set acts against different base versions are two acts,
    // and this is the pair we most expect a judge to call identical.
    tool: "patch_resource",
    a: { resource_id: "cfg_rate_limits", field: "requests_per_minute", value: "600", if_match_etag: "W/\"a17f\"", note: "launch window" },
    b: { resource_id: "cfg_rate_limits", field: "requests_per_minute", value: "600", if_match_etag: "W/\"b280\"", note: "launch window" },
  },
  {
    tool: "update_account",
    a: { account_id: "acct_10044", attribute: "plan", new_value: "enterprise", reason: "contract signed" },
    b: { account_id: "acct_10044", attribute: "plan", new_value: "business", reason: "contract signed" },
  },
  {
    tool: "update_account",
    a: { account_id: "acct_10098", attribute: "mfa_required", new_value: "true", reason: "security review" },
    b: { account_id: "acct_10098", attribute: "sso_required", new_value: "true", reason: "security review" },
  },
];

/**
 * Distinguishing-token pairs for the v2 tools — the D2 population, where two
 * genuinely distinct acts agree on every declared field and differ only by a
 * token in prose.
 *
 * Which field carries the token is a per-tool decision and is listed here rather
 * than inferred, because inferring it is how a corpus ends up with a "legitimate
 * repeat" that is actually a retry. The token pairs themselves must describe two
 * acts, never one act attempted twice: "second attempt" is a retry and would be
 * a mislabel.
 */
export const V2_D2_TOKEN_FIELD = {
  place_order: "shipping_note",
  book_reservation: "request_note",
  grant_access: "justification",
  delete_resource: "reason",
  update_document: "change_note",
  patch_resource: "note",
  update_account: "reason",
  // send_sms has no non-effect-determining field: its body IS the act, so a D2
  // pair for it would have to alter the payload, which makes it a D3. Omitted
  // deliberately rather than forced.
};
