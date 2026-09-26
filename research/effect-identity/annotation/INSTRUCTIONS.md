# Annotation Instructions

Thank you for helping with this labelling task. Please read these instructions
in full before you start. The task takes most people about 45–60 minutes. Do it
in one sitting if you can (two sittings within 48 hours is fine). Work on your
own — do not discuss any item with anyone, and do not use any outside tool to
decide an answer.

## What you'll see

You will be shown a series of **pairs of requests** that a piece of software
made to a system on its behalf. Each request is shown as a small structured
record — a request type (for example, sending a payment, sending a message,
creating a record) and its fields (for example, an amount, a recipient, a
reference note).

For each pair, you decide one thing: **do the two requests ask for the same
real-world action, or two different ones?**

## The core question

Imagine the system is careful about not doing the same thing twice. When it
sees the two requests in a pair, it can either treat them as **the same action**
— do the action once and reuse that single result for both requests — or treat
them as **two different actions** and carry both out.

Ask yourself:

> If the system treated these two requests as identical — performing the action
> a single time and reusing that one result for both — would anything that
> either request was supposed to make happen in the real world **fail to
> happen**?

- If **nothing** would be missed — the two requests would cause the exact same
  real-world action — label the pair **SAME**.
- If **something would be missed** — carrying out only one of them would drop a
  payment, a message, a record, an order, or any other real action that the
  other request was supposed to cause — label the pair **DIFFERENT**.
- If you genuinely **cannot tell** from the information shown, label the pair
  **UNSURE**. Use this only when the record itself does not give you enough to
  decide — not merely because the pair is a little tricky.

## What matters, and what doesn't

**Wording and formatting do not matter.** Two requests can look very different on
the surface and still be the exact same action. Judge the action, not the text.

- `"$780.00"` and `"seven hundred eighty dollars"` are the same amount.
- `"Marlow Freight"` and `"MARLOW FREIGHT"` are the same recipient.
- `"Shipment 88213"`, `"shipment #88213"`, and `"  shipment 88213 "` are the
  same reference.
- Reordered fields, extra spaces, and different capitalisation never change the
  action.

**What matters is whether the same real-world things would happen.** If the two
requests would cause the identical payment / message / record / order, they are
SAME even when they read very differently. If carrying out one of them would
leave even one distinct real action undone, they are DIFFERENT — even if the two
requests look almost identical.

**Identical-looking values can still be different actions.** Two requests can
share every visible field and still be two separate things the world is owed.
For example, two calendar invitations with the same title, time, and guest list
may nonetheless be two separate invitations that both need to be sent; reusing
one for the other would drop the second. When you can see that a request is a
genuinely separate instance of an action rather than a repeat of the same one,
label it DIFFERENT.

**Use only what is shown.** Decide from the fields in front of you. Do not invent
missing context, and do not assume the system knows something the record does not
show.

## Examples

These are illustrations of the reasoning, not items from the task.

**SAME**

- `send_payment { amount: "$1,200.00", to: "Delta Parts", note: "Invoice 55" }`
  and
  `send_payment { amount: "one thousand two hundred dollars", to: "DELTA PARTS", note: "invoice #55" }`
  → same amount, same recipient, same invoice. One payment. **SAME.**

- `send_email { to: "ops@site.co", subject: "Re: outage", body: "Restarting now." }`
  and
  `send_email { to: "OPS@SITE.CO", subject: "RE: Outage", body: "Restarting now." }`
  → same recipient, same message. **SAME.**

**DIFFERENT**

- `send_payment { amount: "$500.00", to: "Acme Ltd", note: "Deposit" }`
  and
  `send_payment { amount: "$500.00", to: "Acme Ltd", note: "Balance" }`
  → same amount and recipient, but these are two separate payments (a deposit
  and a balance). Doing only one drops the other. **DIFFERENT.**

- `create_ticket { customer: "R. Osei", issue: "login fails" }`
  and
  `create_ticket { customer: "R. Osei", issue: "billing error" }`
  → two distinct problems that each need a ticket. **DIFFERENT.**

**UNSURE**

- A pair where a field is cut off, empty, or ambiguous in a way that genuinely
  prevents you from telling whether the same action is meant. Prefer SAME or
  DIFFERENT whenever the record lets you decide; reserve UNSURE for when it does
  not.

## How to answer

For each pair, choose exactly one of **SAME**, **DIFFERENT**, or **UNSURE** using
the buttons in the tool. Answer every item — do not skip any. Once you submit an
item you move to the next; you do not need to revisit earlier ones.

The order of items, and which request appears on which side, is randomised, so
there is no pattern to look for and no expected balance of answers. Judge each
pair on its own.

When you finish, use the **Export** button in the tool to save your responses,
and send the exported file back as instructed.
