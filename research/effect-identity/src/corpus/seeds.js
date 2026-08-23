/**
 * Seed tool calls for corpus construction. Every seed is a realistic
 * irreversible action; generators derive SAME pairs (paraphrases/reformats of
 * the same act) and DIFF pairs (near-miss distinct acts) from them.
 */

const orderNo = (i) => 4000 + i;
const cust = (i) => `cust_${String(i).padStart(2, "0")}`;

export const CHARGE_SEEDS = [23.5, 120, 49.99, 250, 75, 1200, 18, 640, 99, 310].map((amount, i) => ({
  tool: "charge_card",
  input: {
    customer_id: cust(i + 1),
    amount,
    currency: "USD",
    memo: `payment for order #${orderNo(i + 1)}`,
  },
}));

export const REFUND_SEEDS = [12, 42.5, 99.99, 8, 250].map((amount, i) => ({
  tool: "post_refund",
  input: {
    charge_id: `ch_10${i + 1}`,
    amount,
    reason: `customer cancelled order #${orderNo(i + 20)} before shipment`,
  },
}));

export const TRANSFER_SEEDS = [500, 1250, 80, 9600, 300].map((amount, i) => ({
  tool: "transfer_funds",
  input: {
    from_account: `acct_ops_${i + 1}`,
    to_account: `acct_vendor_${i + 1}`,
    amount,
    currency: "USD",
    note: `settlement of invoice INV-9${i + 10}`,
  },
}));

export const EMAIL_SEEDS = [
  { to: "maya@example.com", subject: "Your order #4042 has shipped", body: "Hi Maya, your order #4042 shipped today via UPS and should arrive within 3 business days." },
  { to: "liam@example.com", subject: "Receipt for order #4043", body: "Hi Liam, thanks for your purchase. Your receipt for order #4043 (total $120) is attached." },
  { to: "ava@example.com", subject: "Password was changed", body: "Hi Ava, the password on your account was changed at 14:02 UTC. If this wasn't you, contact support immediately." },
  { to: "noah@example.com", subject: "Refund issued for order #4044", body: "Hi Noah, we've issued a refund of $42.50 for order #4044. It should appear on your statement in 5 business days." },
  { to: "emma@example.com", subject: "Your subscription renews on July 20", body: "Hi Emma, your Pro subscription renews on July 20 for $29. Manage your plan in account settings." },
].map((input) => ({ tool: "send_email", input }));

export const TICKET_SEEDS = [
  { title: "Checkout page returns 500 for order #4045", description: "Since 09:12 UTC roughly 8% of checkout attempts fail with HTTP 500. Trace id abc123. Affects order #4045 and others.", priority: "high" },
  { title: "Nightly export job missed its 02:00 window", description: "The warehouse export did not start at 02:00; downstream reports for July 11 are stale.", priority: "medium" },
  { title: "Customer cust_07 reports double receipt email", description: "cust_07 received two identical receipt emails for order #4046. Investigate email dispatcher retries.", priority: "low" },
  { title: "Payment webhook latency above 4s", description: "p95 latency for provider webhooks exceeded 4 seconds for 30 minutes starting 11:40 UTC.", priority: "high" },
].map((input) => ({ tool: "create_ticket", input }));

export const WIRE_SEEDS = [
  { amount_text: "$1,200.00", beneficiary_text: "Acme Corporation", reference: "Invoice INV-901" },
  { amount_text: "$120", beneficiary_text: "Blue Harbor LLC", reference: "Retainer July 2026" },
  { amount_text: "$96 USD", beneficiary_text: "North Pine Studios", reference: "PO 7731" },
  { amount_text: "$450.00", beneficiary_text: "Kite & Field Ltd", reference: "Invoice INV-des-118" },
  { amount_text: "$780", beneficiary_text: "Marlow Freight", reference: "Shipment 88213" },
].map((input) => ({ tool: "wire_money", input }));

export const ALL_SEEDS = [
  ...CHARGE_SEEDS,
  ...REFUND_SEEDS,
  ...TRANSFER_SEEDS,
  ...EMAIL_SEEDS,
  ...TICKET_SEEDS,
  ...WIRE_SEEDS,
];

/**
 * Hand-authored paraphrases of the free-text fields of each seed, in seed
 * order (`ALL_SEEDS[i]` ↔ `HANDWRITTEN_VARIANTS[i]`).
 *
 * These exist to break one specific circularity: every other SAME pair in the
 * corpus was written by an instruction-tuned LLM, so a judge that scores them
 * well may be recognising machine phrasing rather than understanding the act.
 * This arm is written by hand, by the authors, with no model in the loop.
 *
 * It is NOT a human-annotation study and must not be read as one. The authors
 * know what the mechanism does and wrote text a mechanism they designed would
 * plausibly handle; that is author bias, and it is why this arm is reported as
 * a *generator* arm (does dedup hold when no LLM wrote the paraphrase?) and
 * never as ground-truth validation. Third-party labelling is the separate,
 * unrun study whose harness lives in src/experiments/annotation.js.
 *
 * Every variant still passes the same numeric validator as the LLM arms: a
 * paraphrase that dropped or changed a referenced number would be a mislabel.
 */
export const HANDWRITTEN_VARIANTS = [
  // ── charge_card (memo) ────────────────────────────────────────────────────
  [{ memo: "charge for order 4001" }, { memo: "order no. 4001 — payment taken" }],
  [{ memo: "settling order 4002" }, { memo: "payment against order number 4002" }],
  [{ memo: "collecting funds for order 4003" }, { memo: "order 4003 payment" }],
  [{ memo: "order 4004 — amount due collected" }, { memo: "billing for order no 4004" }],
  [{ memo: "payment on order 4005" }, { memo: "order 4005 charge" }],
  [{ memo: "invoice payment, order 4006" }, { memo: "order number 4006 paid" }],
  [{ memo: "order 4007 payment received" }, { memo: "charging for order no. 4007" }],
  [{ memo: "order 4008 settlement" }, { memo: "payment covering order 4008" }],
  [{ memo: "order 4009 — card charged" }, { memo: "taking payment for order 4009" }],
  [{ memo: "order 4010 payment" }, { memo: "charge against order number 4010" }],
  // ── post_refund (reason) ──────────────────────────────────────────────────
  [{ reason: "order 4020 was cancelled by the customer prior to shipping" },
   { reason: "customer called off order no. 4020 before it shipped" }],
  [{ reason: "buyer cancelled order 4021 ahead of dispatch" },
   { reason: "order 4021 cancelled at customer request, not yet shipped" }],
  [{ reason: "cancellation of order 4022 by the customer, pre-shipment" },
   { reason: "customer withdrew order no 4022 before we shipped it" }],
  [{ reason: "order 4023 pulled by the customer before shipment" },
   { reason: "customer cancelled order 4023 prior to dispatch" }],
  [{ reason: "pre-shipment cancellation — customer cancelled order 4024" },
   { reason: "order no. 4024 cancelled by the buyer before it left the warehouse" }],
  // ── transfer_funds (note) ─────────────────────────────────────────────────
  [{ note: "settling invoice INV-910" }, { note: "payment of invoice number INV-910" }],
  [{ note: "invoice INV-911 settlement" }, { note: "paying down invoice INV-911" }],
  [{ note: "settlement against invoice INV-912" }, { note: "invoice INV-912 — funds transferred in settlement" }],
  [{ note: "clearing invoice INV-913" }, { note: "settlement payment for invoice no. INV-913" }],
  [{ note: "invoice INV-914 settled" }, { note: "transfer settling invoice INV-914" }],
  // ── send_email (subject, body) ────────────────────────────────────────────
  [{ subject: "Order 4042 is on its way",
     body: "Hi Maya — order 4042 went out today with UPS; expect it inside 3 business days." },
   { subject: "Shipped: order no. 4042",
     body: "Hi Maya, we handed order 4042 to UPS today. Delivery should take about 3 business days." }],
  [{ subject: "Your receipt — order 4043",
     body: "Hi Liam, thanks for the order. The receipt for order 4043, totalling $120, is attached." },
   { subject: "Order no. 4043 receipt",
     body: "Hi Liam — attached is your receipt for order 4043 (120 dollars in total). Thanks for shopping with us." }],
  [{ subject: "Your password has been updated",
     body: "Hi Ava — the password for your account was updated at 14:02 UTC. If that wasn't you, get in touch with support right away." },
   { subject: "Account password change",
     body: "Hi Ava, someone changed your account password at 14:02 UTC. Not you? Contact support immediately." }],
  [{ subject: "Order 4044 — refund processed",
     body: "Hi Noah, we've refunded $42.50 against order 4044. Expect it on your statement within 5 business days." },
   { subject: "Refund for order no. 4044",
     body: "Hi Noah — a refund of 42.50 dollars for order 4044 has gone through; allow 5 business days for it to show on your statement." }],
  [{ subject: "Renewal notice: July 20",
     body: "Hi Emma — your Pro plan renews July 20 at $29. You can manage it from account settings." },
   { subject: "Pro plan renews July 20",
     body: "Hi Emma, heads up: the Pro subscription bills again on July 20 for 29 dollars. Change your plan any time in settings." }],
  // ── create_ticket (title, description) ────────────────────────────────────
  [{ title: "Order 4045 checkout hits HTTP 500",
     description: "From 09:12 UTC about 8% of checkout attempts return HTTP 500. Trace abc123. Order #4045 is affected among others." },
   { title: "500 error on checkout for order no. 4045",
     description: "Starting 09:12 UTC, roughly 8% of checkouts fail with a 500. See trace abc123; order 4045 is among those affected." }],
  [{ title: "Nightly export did not run at 02:00",
     description: "The warehouse export never started at its 02:00 slot, so downstream reports for July 11 are stale." },
   { title: "Missed 02:00 window for the nightly export",
     description: "Warehouse export failed to kick off at 02:00; July 11 downstream reports are now stale." }],
  [{ title: "cust_07 got a duplicate receipt email",
     description: "cust_07 says two identical receipts arrived for order 4046. Check the email dispatcher's retry path." },
   { title: "Double receipt email reported by cust_07",
     description: "Two copies of the same receipt reached cust_07 for order #4046 — look into dispatcher retries." }],
  [{ title: "Provider webhook latency over 4s",
     description: "p95 for provider webhooks went past 4 seconds and stayed there 30 minutes from 11:40 UTC." },
   { title: "Payment webhooks slower than 4s",
     description: "For 30 minutes beginning 11:40 UTC the p95 provider-webhook latency was above 4 seconds." }],
  // ── wire_money (amount_text, beneficiary_text, reference) ─────────────────
  [{ amount_text: "1200.00 USD", beneficiary_text: "Acme Corp", reference: "INV-901" },
   { amount_text: "one thousand two hundred dollars", beneficiary_text: "ACME CORPORATION", reference: "against invoice INV-901" }],
  [{ amount_text: "120 dollars", beneficiary_text: "Blue Harbor", reference: "July 2026 retainer" },
   { amount_text: "USD 120.00", beneficiary_text: "BLUE HARBOR LLC", reference: "retainer for July 2026" }],
  [{ amount_text: "ninety six dollars", beneficiary_text: "North Pine Studios Inc", reference: "purchase order 7731" },
   { amount_text: "96.00 US dollars", beneficiary_text: "north pine studios", reference: "PO number 7731" }],
  [{ amount_text: "450 USD", beneficiary_text: "Kite and Field Ltd", reference: "INV-des-118" },
   { amount_text: "four hundred fifty dollars", beneficiary_text: "KITE & FIELD", reference: "invoice INV-des-118" }],
  [{ amount_text: "seven hundred eighty dollars", beneficiary_text: "MARLOW FREIGHT", reference: "shipment #88213" },
   { amount_text: "780.00 USD", beneficiary_text: "Marlow Freight Co", reference: "for shipment no. 88213" }],
];

/**
 * Handcrafted D3 pairs: same tool, same principals, materially different
 * intent. The surface text is deliberately similar — these are the wrong-
 * suppression danger zone.
 */
export const D3_PAIRS = [
  {
    tool: "send_email",
    a: { to: "maya@example.com", subject: "Your order #4042 has shipped", body: "Hi Maya, your order #4042 shipped today via UPS and should arrive within 3 business days." },
    b: { to: "maya@example.com", subject: "Your order #4042 is delayed", body: "Hi Maya, unfortunately order #4042 is delayed at the carrier and now expected next week. We're sorry." },
  },
  {
    tool: "send_email",
    a: { to: "liam@example.com", subject: "Re: invoice INV-902", body: "Hi Liam, attached is the corrected invoice INV-902 with the updated billing address." },
    b: { to: "liam@example.com", subject: "Re: invoice INV-902", body: "Hi Liam, please disregard the previous invoice INV-902; a corrected one will follow shortly." },
  },
  {
    tool: "send_email",
    a: { to: "emma@example.com", subject: "Your subscription renews on July 20", body: "Hi Emma, your Pro subscription renews on July 20 for $29. Manage your plan in account settings." },
    b: { to: "emma@example.com", subject: "Your subscription was cancelled", body: "Hi Emma, your Pro subscription has been cancelled as requested and will not renew on July 20." },
  },
  {
    tool: "create_ticket",
    a: { title: "Checkout page returns 500 for order #4045", description: "Since 09:12 UTC roughly 8% of checkout attempts fail with HTTP 500. Trace id abc123.", priority: "high" },
    b: { title: "Checkout page latency spike", description: "Since 10:05 UTC checkout p95 latency tripled; no errors, pages eventually load. Possibly related to CDN change.", priority: "high" },
  },
  {
    tool: "create_ticket",
    a: { title: "Nightly export job missed its 02:00 window", description: "The warehouse export did not start at 02:00; downstream reports for July 11 are stale.", priority: "medium" },
    b: { title: "Nightly export produced truncated file", description: "The warehouse export ran at 02:00 but the output file is 40% smaller than usual; likely truncated mid-write.", priority: "medium" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_03", amount: 49.99, currency: "USD", memo: "order #4042 — wireless headphones" },
    b: { customer_id: "cust_03", amount: 49.99, currency: "USD", memo: "order #4043 — charging cable bundle" },
  },
  {
    tool: "charge_card",
    a: { customer_id: "cust_05", amount: 75, currency: "USD", memo: "July invoice for workspace plan" },
    b: { customer_id: "cust_05", amount: 75, currency: "USD", memo: "August invoice for workspace plan" },
  },
  {
    tool: "post_refund",
    a: { charge_id: "ch_101", amount: 12, reason: "refund shipping fee — late delivery on order #4020" },
    b: { charge_id: "ch_101", amount: 12, reason: "goodwill credit — support wait time complaint" },
  },
  {
    tool: "transfer_funds",
    a: { from_account: "acct_ops_1", to_account: "acct_vendor_1", amount: 500, currency: "USD", note: "settlement of invoice INV-910" },
    b: { from_account: "acct_ops_1", to_account: "acct_vendor_1", amount: 500, currency: "USD", note: "advance on invoice INV-911" },
  },
  {
    tool: "wire_money",
    a: { amount_text: "$780", beneficiary_text: "Marlow Freight", reference: "Shipment 88213" },
    b: { amount_text: "$780", beneficiary_text: "Marlow Freight", reference: "Shipment 88214" },
  },
];
