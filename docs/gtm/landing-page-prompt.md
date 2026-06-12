# Landing Page Generation Prompt (reusable)

> Paste into v0 / Lovable / Claude / Cursor. Works as a single prompt. Replace the
> two ALL-CAPS tokens before or after generation. Keep the HONESTY CONSTRAINTS —
> a pre-launch page with fake logos kills credibility with exactly the buyers we want.

---

You are a world-class landing page designer + direct-response copywriter who has
shipped pages for Stripe, Vercel, and Datadog. Build me a complete, production-ready
landing page.

## THE PRODUCT
**Runloop** — the proof layer for AI agents. A durable execution runtime that records
every AI-agent action as a cryptographically fenced, deterministically replayable
trace. When a regulator, auditor, or angry customer asks "what exactly did your AI
agent do, and why?" — our users show unforgeable proof instead of stitched-together logs.

What technically backs the claims (real, all built):
- Fence protocol: events can't be inserted, deleted, or reordered after the fact;
  side effects execute exactly once (no double-charges from agent retries)
- Deterministic replay: re-run any execution and get identical decisions — a replay
  that provably matches the original is evidence, not narrative
- Forensic reconstruction: input → active config → rule that fired → side effect,
  plus "is this a one-off or about to happen 500 more times?" pattern detection

## THE AUDIENCE (in priority order)
1. VPs of AI Risk / compliance officers / CROs at banks, fintechs, payment companies
   deploying AI agents on money paths (underwriting, disputes, settlements, refunds)
2. Founders/CTOs of agent companies whose agents take real actions (refunds, emails,
   API calls) and who have personally been burned by a double-fired tool call
They are skeptical, senior, allergic to AI hype. They read Stripe docs for fun.

## THE NARRATIVE ARC (use this exact emotional sequence)
1. **The incident** — your agent did something to a customer's money. It's 9am.
2. **The second question** — remediation was easy; then the boss asks: "prove what
   it did and why — and tell me if it's about to happen 500 more times." Silence.
   Logs were written to debug crashes, not reconstruct decisions.
3. **The reframe** — logs are forgeable; re-runs drift. Neither is proof.
4. **The answer** — fenced execution + deterministic replay = an audit artifact.
5. **The urgency** — EU AI Act traceability is law; US banking supervisors expect
   model-risk governance to cover agents. The question is coming; only the answer
   is optional.

## PAGE STRUCTURE
1. **Hero**: headline ≤ 9 words on the proof-vs-logs tension. Subhead ≤ 2 sentences.
   One primary CTA: "Book a 30-minute compliance demo" → mailto:FOUNDER_EMAIL.
   Secondary text link: "Run it on your own agent →" (/signup). NO fake dashboard
   screenshot — instead render a stylized terminal/trace artifact (see DESIGN).
2. **The incident strip**: one dark full-width band telling the 9am story in ≤ 60
   words, second person ("Your payment agent…"). This is the hook — make it sting.
3. **Three scenario cards**: The Double Charge / The Contested Decision / One-off or
   500 More Times. Each: the question an auditor asks (italic) + how the trace
   answers it (≤ 45 words).
4. **How it works — "Why this is proof, not telemetry"**: 3 numbered steps (Fenced
   execution → Deterministic replay → Forensic reconstruction). Include a simple
   visual metaphor: a sealed evidence bag vs. a sticky note.
5. **Comparison row** (no competitor names): "Observability shows what happened.
   Durable execution re-runs work. Proof shows what happened *and that it couldn't
   have been forged*." Three columns, ours visually distinct.
6. **Regulatory urgency band**: EU AI Act record-keeping, US model-risk expectations.
   One sentence each, no fearmongering adjectives — the facts are scary enough.
7. **Founder credibility block**: "Built by someone who spent years in payment risk
   watching teams reconstruct incidents from half-remembered configs." One paragraph,
   first person, no stock photo.
8. **Final CTA**: "Bring us one incident you couldn't fully explain." Repeat the
   demo CTA. Add: "No deployment needed for the first conversation."
9. **Footer**: minimal — GitHub link, npm package `@agent-platform/sdk`, MIT license.

## COPY RULES (hard constraints)
- Banned words: revolutionize, unleash, supercharge, seamless, game-changing,
  empower, cutting-edge, "AI-powered", journey, effortless
- No exclamation marks. No emoji in body copy.
- Every claim must map to a real capability listed above — nothing invented.
- Sentences average ≤ 14 words. Paragraphs ≤ 3 sentences.
- Write like Stripe docs meet a forensic accountant: precise, calm, slightly dry wit.
- Second person for pain, first person plural for product ("we record", "you show").

## HONESTY CONSTRAINTS (non-negotiable — pre-launch company)
- NO fake customer logos, NO invented testimonials, NO "trusted by" bar
- NO invented metrics ("10,000 agents secured!")
- Social proof substitute: the technical specificity itself + founder credibility
  block + open-source SDK link

## DESIGN DIRECTION
- Dark forensic-terminal aesthetic: zinc-950 background, zinc-200 text,
  emerald-400/600 as the single accent (matches our product console), sky-400 only
  for the regulatory band icon
- Monospace (JetBrains Mono or ui-monospace) for: trace IDs, the hero artifact,
  section numbers, anything "evidence-like" — it should feel like court-admissible
  terminal output
- The hero artifact: a stylized execution trace — 4–5 monospace lines showing an
  agent decision with a fence signature hash and a green "REPLAY: IDENTICAL ✓"
  verdict line. This replaces a product screenshot.
- Generous whitespace, max-width ~72ch for prose, 12-col grid for cards
- Motion: one subtle entrance fade per section max; the trace artifact may "type"
  itself once on load (respect prefers-reduced-motion)
- Fully responsive; dark only (no light mode)

## TECH OUTPUT
- Single self-contained file: semantic HTML + Tailwind via CDN + ≤ 30 lines vanilla
  JS (the typing effect). No frameworks, no build step — deployable to any static host.
- Lighthouse-conscious: system font fallbacks, no external images (SVG inline only),
  total page ≤ 100KB.
- Accessible: WCAG AA contrast, focus states, aria labels on CTAs, single h1.

## TOKENS TO REPLACE
- FOUNDER_EMAIL → the founder's real email
- GITHUB_URL → https://github.com/Sivaguru-2008/agent-runtime

Now build the complete page. Output the full HTML file, then a 5-line summary of
the copy decisions you made and why.
