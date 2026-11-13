/**
 * Additional seeds for the two load-bearing cells that were too small to carry
 * the claims resting on them (Task 4).
 *
 * S3 (`loose-schema value reformat`) is THE MOTIVATING EXAMPLE of this paper —
 * §1.2's "$780" vs "seven hundred eighty dollars" — and it shipped with 15
 * pairs, 8 of them in the test split. An observed 8/8 there carries a 95%
 * Wilson lower bound of 67.6%, which is not a number anyone should accept as
 * evidence that the mechanism handles its own motivating case.
 *
 * D3 (`semantic difference`) shipped with 10 pairs, 5 in test. A 0/5
 * wrong-suppression rate admits an upper bound of 43.4%.
 *
 * These are ADDITIVE. Nothing here changes an existing pair, an existing id, or
 * an existing score: the 955-pair record stays intact and the corpus grows
 * around it, so the frozen annotation sheet still verifies and every unrelated
 * number is untouched. What does change is the S3 and D3 denominators, and
 * because D3 is DIFF it also enters the calibration pool — that movement is
 * reported rather than avoided.
 */

// ── S3: more loose-schema wire seeds ─────────────────────────────────────────
/**
 * Amounts are integral on purpose. The word-form variant renders the amount as
 * English words, and a seed with cents would either need a words-and-cents
 * renderer or a rounding step — and a rounding step in a SAME generator is
 * exactly the mislabel the corpus cannot tolerate ("$780.40" and "seven hundred
 * eighty dollars" are NOT the same act). The generator asserts this rather than
 * trusting it.
 */
export const WIRE_SEEDS_GROWTH = [
  { amount_text: "$2,400", beneficiary_text: "Halcyon Logistics", reference: "Invoice INV-1042" },
  { amount_text: "$65", beneficiary_text: "Ridgeway Consulting", reference: "Deposit for August engagement" },
  { amount_text: "$18,000", beneficiary_text: "Trenton Fabrication Co", reference: "Milestone 2 of contract C-77" },
  { amount_text: "$309", beneficiary_text: "Elm & Iron Works", reference: "PO 4488" },
  { amount_text: "$1,075", beneficiary_text: "Sablefish Marine Ltd", reference: "Invoice INV-2210" },
  { amount_text: "$47", beneficiary_text: "Copper Lane Print", reference: "Rush fee for job 9912" },
  { amount_text: "$5,500", beneficiary_text: "Vector Freight Partners", reference: "Shipment 44018" },
  { amount_text: "$230", beneficiary_text: "Quill & Sparrow", reference: "Retainer September 2026" },
  { amount_text: "$860", beneficiary_text: "Northgate Analytics", reference: "Invoice INV-3301" },
  { amount_text: "$12,750", beneficiary_text: "Ferrous Supply Group", reference: "PO 6620" },
].map((input) => ({ tool: "wire_money", input }));

// ── D3: more handcrafted same-surface, different-intent pairs ────────────────
/**
 * The D3 construction: every DECLARED field is identical, and the two calls
 * denote different acts because the free text describes different intended
 * changes to the world. These are the pairs the distinctness witness cannot
 * veto — the residual in its purest form — so they are where the judge carries
 * the decision alone and where the safety claim is most exposed.
 *
 * Each pair below is written so that performing BOTH is correct: dropping the
 * second would lose a real, separate effect. That is the operational test the
 * annotation instructions give, applied by the authors at construction time.
 */
export const D3_PAIRS_GROWTH = [
  // send_email — same recipient, different message, both must be delivered
  {
    tool: "send_email",
    a: { to: "nina@example.com", subject: "Your appointment is confirmed for Sept 3", body: "Hi Nina, your consultation is confirmed for September 3 at 14:00 with Dr Reyes." },
    b: { to: "nina@example.com", subject: "Please bring your referral letter", body: "Hi Nina, a quick reminder to bring the referral letter from your GP to your appointment." },
  },
  {
    tool: "send_email",
    a: { to: "omar@example.com", subject: "Password changed", body: "Hi Omar, the password on your account was changed at 09:14 UTC. If this was not you, contact support." },
    b: { to: "omar@example.com", subject: "New sign-in from a new device", body: "Hi Omar, we noticed a sign-in from a device we have not seen before, at 09:20 UTC from Lisbon." },
  },
  {
    tool: "send_email",
    a: { to: "pia@example.com", subject: "Your refund has been issued", body: "Hi Pia, we have issued the refund for order #5120. It should appear in 3-5 business days." },
    b: { to: "pia@example.com", subject: "Your replacement has shipped", body: "Hi Pia, the replacement unit for order #5120 shipped today and arrives Thursday." },
  },
  {
    tool: "send_email",
    a: { to: "raj@example.com", subject: "Invitation: architecture review, Sept 9", body: "Hi Raj, you are invited to the architecture review on September 9 at 11:00 in room 4B." },
    b: { to: "raj@example.com", subject: "Agenda for the architecture review", body: "Hi Raj, the agenda for the September 9 review is attached; please add any items by Friday." },
  },
  {
    tool: "send_email",
    a: { to: "sara@example.com", subject: "Welcome to the beta", body: "Hi Sara, your beta access is live. Sign in with this address to get started." },
    b: { to: "sara@example.com", subject: "Your beta feedback survey", body: "Hi Sara, now that you have had a week in the beta, could you fill in this short survey?" },
  },

  // create_ticket — distinct incidents that happen to share a title shape
  {
    tool: "create_ticket",
    a: { title: "Search returns no results for valid queries", description: "Since 11:40 UTC, search returns an empty set for queries that previously matched. Index may be stale.", priority: "high" },
    b: { title: "Search returns results for deleted documents", description: "Since 11:40 UTC, search returns documents that were deleted last week. Index may not be honouring tombstones.", priority: "high" },
  },
  {
    tool: "create_ticket",
    a: { title: "Webhook deliveries retrying indefinitely", description: "Deliveries to customer endpoints retry past the documented 5-attempt cap; some have 400+ attempts.", priority: "high" },
    b: { title: "Webhook deliveries dropped without retry", description: "Deliveries to customer endpoints fail once and are never retried, contrary to the documented 5-attempt policy.", priority: "high" },
  },
  {
    tool: "create_ticket",
    a: { title: "Billing page shows the wrong currency", description: "EU customers see USD totals on the billing page; the underlying charge is correct, the display is not.", priority: "medium" },
    b: { title: "Billing page shows the wrong tax rate", description: "EU customers see a 0% VAT line on the billing page; the underlying charge applies VAT correctly.", priority: "medium" },
  },
  {
    tool: "create_ticket",
    a: { title: "Onboarding email not sent to new signups", description: "Signups since 08:00 have not received the welcome email; the queue shows no enqueued jobs.", priority: "medium" },
    b: { title: "Onboarding email sent twice to new signups", description: "Signups since 08:00 received the welcome email twice; the queue shows duplicate enqueued jobs.", priority: "medium" },
  },
  {
    tool: "create_ticket",
    a: { title: "Audit log missing entries for admin actions", description: "Role changes made through the admin console between 02:00 and 06:00 have no corresponding audit rows.", priority: "high" },
    b: { title: "Audit log attributing admin actions to the wrong user", description: "Role changes made through the admin console between 02:00 and 06:00 are attributed to the service account.", priority: "high" },
  },

  // charge_card — identical amount and customer, different occasion
  {
    tool: "charge_card",
    a: { customer_id: "cust_11", amount: 120, currency: "USD", memo: "September seat licence" },
    b: { customer_id: "cust_11", amount: 120, currency: "USD", memo: "October seat licence" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_14", amount: 39.5, currency: "USD", memo: "order #5301 — replacement filter" },
    b: { customer_id: "cust_14", amount: 39.5, currency: "USD", memo: "order #5309 — spare filter, second unit" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_18", amount: 250, currency: "USD", memo: "overage charge for July data transfer" },
    b: { customer_id: "cust_18", amount: 250, currency: "USD", memo: "overage charge for August data transfer" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_22", amount: 60, currency: "USD", memo: "workshop ticket — attendee A. Nkemdirim" },
    b: { customer_id: "cust_22", amount: 60, currency: "USD", memo: "workshop ticket — attendee J. Petrov" },
  },

  // post_refund — same charge, two genuinely separate refunds
  {
    tool: "post_refund",
    a: { charge_id: "ch_220", amount: 15, reason: "refund of expedited shipping — arrived late" },
    b: { charge_id: "ch_220", amount: 15, reason: "partial refund of item price — damaged corner" },
  },
  {
    tool: "post_refund",
    a: { charge_id: "ch_231", amount: 40, reason: "refund for the cancelled second seat" },
    b: { charge_id: "ch_231", amount: 40, reason: "refund for the cancelled third seat" },
  },
  {
    tool: "post_refund",
    a: { charge_id: "ch_244", amount: 8, reason: "sales tax correction for the July invoice" },
    b: { charge_id: "ch_244", amount: 8, reason: "sales tax correction for the August invoice" },
  },

  // transfer_funds — identical accounts and amount, distinct settlements
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_2", to_account: "acct_payroll", amount: 3200, currency: "USD", note: "first half of the September payroll run" },
    b: { from_account: "acct_ops_2", to_account: "acct_payroll", amount: 3200, currency: "USD", note: "second half of the September payroll run" },
  },
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_3", to_account: "acct_reserve", amount: 1000, currency: "USD", note: "monthly reserve top-up for September" },
    b: { from_account: "acct_ops_3", to_account: "acct_reserve", amount: 1000, currency: "USD", note: "monthly reserve top-up for October" },
  },
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_1", to_account: "acct_vendor_4", amount: 750, currency: "USD", note: "settlement of the Q2 support retainer" },
    b: { from_account: "acct_ops_1", to_account: "acct_vendor_4", amount: 750, currency: "USD", note: "settlement of the Q3 support retainer" },
  },

  // wire_money — the loose-schema tool, where D3 is hardest
  {
    tool: "wire_money",
    a: { amount_text: "$900", beneficiary_text: "Ashford Timber", reference: "deposit for the March delivery" },
    b: { amount_text: "$900", beneficiary_text: "Ashford Timber", reference: "deposit for the April delivery" },
  },
  {
    tool: "wire_money",
    a: { amount_text: "$1,500", beneficiary_text: "Pacific Trading", reference: "balance on container SEAU-4471" },
    b: { amount_text: "$1,500", beneficiary_text: "Pacific Trading", reference: "balance on container SEAU-4472" },
  },

  // ── second batch ──────────────────────────────────────────────────────────
  // Added so the D3 TEST cell clears n = 30. The §8.3 row for this category
  // carries a named claim about the residual's hardest population, and a claim
  // resting on 5 test pairs (95% upper bound 43.4% on an observed zero) is not
  // one we would defend in review.

  {
    tool: "send_email",
    a: { to: "tomas@example.com", subject: "Your card ending 4417 was declined", body: "Hi Tomas, the charge on the card ending 4417 was declined. Please update your payment method." },
    b: { to: "tomas@example.com", subject: "Your subscription is now past due", body: "Hi Tomas, your account is past due as of today. Service continues for 7 more days." },
  },
  {
    tool: "send_email",
    a: { to: "ines@example.com", subject: "Export ready: January transactions", body: "Hi Ines, your January transaction export is ready and available for 48 hours." },
    b: { to: "ines@example.com", subject: "Export ready: February transactions", body: "Hi Ines, your February transaction export is ready and available for 48 hours." },
  },
  {
    tool: "send_email",
    a: { to: "hugo@example.com", subject: "Maintenance window Saturday 02:00-04:00", body: "Hi Hugo, we will be performing scheduled maintenance on Saturday between 02:00 and 04:00 UTC." },
    b: { to: "hugo@example.com", subject: "Maintenance completed", body: "Hi Hugo, Saturday's maintenance finished at 03:20 UTC with no downtime observed." },
  },
  {
    tool: "send_email",
    a: { to: "wei@example.com", subject: "Contract renewal — action needed by Oct 1", body: "Hi Wei, your contract renews October 1. Confirm the seat count by then to keep current pricing." },
    b: { to: "wei@example.com", subject: "Contract renewal — pricing confirmed", body: "Hi Wei, thanks for confirming. Your October 1 renewal is locked at the current per-seat rate." },
  },
  {
    tool: "send_email",
    a: { to: "dana@example.com", subject: "You have been added to the Payments project", body: "Hi Dana, you now have write access to the Payments project." },
    b: { to: "dana@example.com", subject: "You have been added to the Ledger project", body: "Hi Dana, you now have write access to the Ledger project." },
  },
  {
    tool: "send_email",
    a: { to: "arjun@example.com", subject: "Interview scheduled — Sept 12, 10:00", body: "Hi Arjun, your first-round interview is scheduled for September 12 at 10:00 with the platform team." },
    b: { to: "arjun@example.com", subject: "Interview scheduled — Sept 19, 10:00", body: "Hi Arjun, your second-round interview is scheduled for September 19 at 10:00 with the platform team." },
  },

  {
    tool: "create_ticket",
    a: { title: "Rate limiter rejecting requests below the documented quota", description: "Customers on the 1000 rps plan see 429s from roughly 700 rps. Limiter may be counting retries.", priority: "high" },
    b: { title: "Rate limiter allowing requests far above the documented quota", description: "Customers on the 1000 rps plan sustain 2400 rps without 429s. Limiter may not be counting at all.", priority: "high" },
  },
  {
    tool: "create_ticket",
    a: { title: "CSV import fails on files with a BOM", description: "Uploads whose first bytes are a UTF-8 BOM are rejected as malformed; the first column header is mangled.", priority: "medium" },
    b: { title: "CSV import fails on files with CRLF line endings", description: "Uploads with Windows line endings import a trailing carriage return into the last column of every row.", priority: "medium" },
  },
  {
    tool: "create_ticket",
    a: { title: "Session expires earlier than the configured 30 days", description: "Users are signed out after roughly 24 hours despite the 30-day setting. Cookie max-age may be wrong.", priority: "medium" },
    b: { title: "Session never expires despite the configured 30 days", description: "Sessions created three months ago are still valid. Expiry may not be enforced server-side.", priority: "high" },
  },
  {
    tool: "create_ticket",
    a: { title: "Duplicate charge on retry after gateway timeout", description: "When the gateway times out, our retry produces a second charge. Reconciliation found 14 today.", priority: "high" },
    b: { title: "Missing charge after gateway timeout", description: "When the gateway times out, our retry is suppressed and no charge is made. Reconciliation found 9 today.", priority: "high" },
  },
  {
    tool: "create_ticket",
    a: { title: "PDF invoices render without the tax breakdown", description: "Invoices generated since the template change omit the VAT line entirely.", priority: "medium" },
    b: { title: "PDF invoices render the tax breakdown twice", description: "Invoices generated since the template change show the VAT line duplicated with the same amount.", priority: "medium" },
  },
  {
    tool: "create_ticket",
    a: { title: "Password reset link expires immediately", description: "Reset links are unusable on first click; the token appears already consumed.", priority: "high" },
    b: { title: "Password reset link remains valid after use", description: "Reset links can be replayed days later and still change the password.", priority: "high" },
  },

  {
    tool: "charge_card",
    a: { customer_id: "cust_31", amount: 199, currency: "USD", memo: "annual plan — first year" },
    b: { customer_id: "cust_31", amount: 199, currency: "USD", memo: "annual plan — second year" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_34", amount: 15, currency: "USD", memo: "additional storage block 1" },
    b: { customer_id: "cust_34", amount: 15, currency: "USD", memo: "additional storage block 2" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_37", amount: 89, currency: "USD", memo: "conference pass — day one" },
    b: { customer_id: "cust_37", amount: 89, currency: "USD", memo: "conference pass — day two" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_40", amount: 500, currency: "USD", memo: "deposit held against booking B-7710" },
    b: { customer_id: "cust_40", amount: 500, currency: "USD", memo: "deposit held against booking B-7711" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_43", amount: 27.5, currency: "USD", memo: "metered usage — compute, September" },
    b: { customer_id: "cust_43", amount: 27.5, currency: "USD", memo: "metered usage — bandwidth, September" },
  },

  {
    tool: "post_refund",
    a: { charge_id: "ch_260", amount: 30, reason: "refund for the unused portion of the September term" },
    b: { charge_id: "ch_260", amount: 30, reason: "refund for the unused portion of the October term" },
  },
  {
    tool: "post_refund",
    a: { charge_id: "ch_271", amount: 22, reason: "price-match adjustment on the first item" },
    b: { charge_id: "ch_271", amount: 22, reason: "price-match adjustment on the second item" },
  },
  {
    tool: "post_refund",
    a: { charge_id: "ch_283", amount: 100, reason: "refund of the setup fee, waived per agreement" },
    b: { charge_id: "ch_283", amount: 100, reason: "refund of the migration fee, waived per agreement" },
  },
  {
    tool: "post_refund",
    a: { charge_id: "ch_295", amount: 45, reason: "chargeback reversal for dispute D-3301" },
    b: { charge_id: "ch_295", amount: 45, reason: "chargeback reversal for dispute D-3302" },
  },

  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_5", to_account: "acct_tax", amount: 2100, currency: "USD", note: "Q3 estimated tax remittance" },
    b: { from_account: "acct_ops_5", to_account: "acct_tax", amount: 2100, currency: "USD", note: "Q4 estimated tax remittance" },
  },
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_1", to_account: "acct_vendor_7", amount: 340, currency: "USD", note: "hosting invoice for the primary region" },
    b: { from_account: "acct_ops_1", to_account: "acct_vendor_7", amount: 340, currency: "USD", note: "hosting invoice for the failover region" },
  },
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_6", to_account: "acct_escrow", amount: 7500, currency: "USD", note: "escrow funding for the Redwood acquisition" },
    b: { from_account: "acct_ops_6", to_account: "acct_escrow", amount: 7500, currency: "USD", note: "escrow funding for the Fairmont acquisition" },
  },
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_2", to_account: "acct_petty", amount: 200, currency: "USD", note: "petty cash float for the London office" },
    b: { from_account: "acct_ops_2", to_account: "acct_petty", amount: 200, currency: "USD", note: "petty cash float for the Dublin office" },
  },

  {
    tool: "wire_money",
    a: { amount_text: "$4,200", beneficiary_text: "Granite Row Builders", reference: "progress payment for phase one" },
    b: { amount_text: "$4,200", beneficiary_text: "Granite Row Builders", reference: "progress payment for phase two" },
  },
  {
    tool: "wire_money",
    a: { amount_text: "$610", beneficiary_text: "Meridian Testing Labs", reference: "sample batch 88-A" },
    b: { amount_text: "$610", beneficiary_text: "Meridian Testing Labs", reference: "sample batch 88-B" },
  },
  {
    tool: "wire_money",
    a: { amount_text: "$3,000", beneficiary_text: "Overton Legal", reference: "retainer for the trademark filing" },
    b: { amount_text: "$3,000", beneficiary_text: "Overton Legal", reference: "retainer for the contract review" },
  },
  {
    tool: "wire_money",
    a: { amount_text: "$275", beneficiary_text: "Salt Creek Couriers", reference: "delivery run on the 14th" },
    b: { amount_text: "$275", beneficiary_text: "Salt Creek Couriers", reference: "delivery run on the 21st" },
  },
];
