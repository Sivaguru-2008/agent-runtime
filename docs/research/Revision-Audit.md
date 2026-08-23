# Revision Audit — *Effect Identity for Non-Deterministic Agents: Certifiers, Refuters, and the Calibrated Residual*

Companion to the revised paper (`Semantic-Effect-Identity-Paper.md`). Covers the change log (B), theorem audit (C), experiment audit (D), and hostile reviewer report (E).

**Standing rule applied throughout:** where a corrected experiment produced a worse number than the previous version, the worse number is kept and the improvement claim withdrawn. Where it produced a better number, the improvement is attributed to the harness repair rather than to a design change, because that is what caused it.

---

## B. Change log

### B.0 Reframing: from one mechanism to a theory

**Section:** title, abstract, §1.4, §3.5–3.8, §5.9, §10, §12
**Problem:** The paper presented a single fence and defended it. That framing made the prior art (ACRFence, CapLease) look like competition rather than neighbours, left "schema-first, model-second" as an unargued slogan, and gave the reader no way to see why the layering was forced rather than chosen.
**Change:** Restructured around a general account of effect identity. New §3.5 defines the **certifier / refuter** duality (decidable proofs of sameness vs of difference, which are duals rather than variants) and the **residual** they do not cover. New §3.7 recasts idempotency keys, durable execution, content addressing, verified tool calls, transactional runtimes, authorization leases and LLM analyzers as positions in a four-axis design space. New §3.8 places duplication within the family of replay hazards. New **T6** proves the residual is a function of the declared schema alone; new **T7** gives the composition structure of the three guarantees. New §10 lifts the pattern to bounded-oracle decisions generally, with its transfer claim marked as a conjecture. §4 is retitled as an *instantiation*.
**Why:** The strongest result in the paper was being reported as an ablation. T6 explains why the schema-tightening experiment improves every axis at once while every oracle-side intervention trades axes — a prediction the theory makes and the data matches, which is worth more than the mechanism itself.

### B.0b Literature base and gap analysis

**Section:** §2.7, §2.8, References
**Problem:** The paper carried 17 references — defensible for a single-mechanism systems paper, indefensible once it claims to position a design space. Worse, the novelty claim was asserted against a literature the paper had not surveyed, which is precisely the shape of claim a reviewer rejects on sight.
**Change:** Bibliography expanded to **121 entries**, harvested from the arXiv metadata index (structured records: ID, title, authors, year) rather than recalled, after web search proved too sparse and blog-heavy. Entries are split into **Tier 1** ([1]–[17], abstract or full text read, specific claims characterised) and **Tier 2** ([18]–[121], cited for area coverage only, no claim about individual findings) — stated in the bibliography preamble so the list does not imply more reading than occurred. New §2.7 surveys the literature by design-space axis; new §2.8 is a gap analysis with a per-body-of-work table (what each supplies, what it assumes, why it cannot close the gap), four numbered gaps **G1–G4**, an explicit accounting of which this work closes, partially closes and leaves open, and six **empty cells** offered as open problems for the field. All 121 references are cited in the body (163 citation instances); coverage is checked programmatically.
**Why:** The gap is the paper's justification, and it was previously a claim rather than a finding. Stating it as "no system in this surveyed set satisfies G1–G4" makes it checkable and falsifiable, and the survey turned up its own caveat — the set is arXiv-weighted and 2024–2026-skewed, with classical distributed-systems duplicate-detection work under-represented, which §2.8 discloses rather than hides.

### B.1 Central mathematical corrections

**Section:** §5.5 (T3), `src/conformal.js`, `src/fence.js`
**Problem:** The theorem calibrated a **pairwise** judge score at level α, but the implemented algorithm suppresses on `S* = max` over the candidate set `C`. With `m = |C|` candidates the rule gets `m` chances to cross the threshold, so `P(max_i s_i > t̂) ≤ α` does **not** follow from `P(s_i > t̂) ≤ α`. The stated bound did not cover the implemented algorithm, and the gap grows with `m`. Every experiment in the previous version ran at `m ≤ 1`, where the two coincide — so the defect was invisible by construction.
**Change:** T3 restated for `S*`. Threshold is now `t_hi(m)` = pairwise conformal at level **α/m** (Bonferroni), valid by union bound under *arbitrary dependence* among the `m` comparisons — essential, since they share the candidate `x`. Added explicit treatment of: ties (strict inequality, and integer-percent scores make ties common rather than measure-zero), varying `m` (threshold recomputed per decision; monotone non-decreasing in `m`), `m = 0` (returns `+∞`, never suppresses), and insufficient calibration (`t_hi = +∞` once `m > α(n+1)`). Implemented `maxSuppressionThreshold`, `maxCertifiableCandidates`, `requiredCalibrationSize`, and a direct `setConformalThreshold` alternative for comparison. A6 restated as exchangeability **conditional on `m`**.
**Why:** The previous claim was false as stated for the deployed algorithm. Bonferroni was chosen over direct set-calibration because it reuses one pairwise pool at every `m`, handles an `m` that varies per decision, and needs no assumption beyond the pairwise exchangeability already assumed; direct calibration needs `≥19m` calibration pairs for one value of `m` (950 at `m`=50) and a stronger exchangeability assumption. Both are implemented; the price of the conservatism is measured, not asserted.

**Section:** §5.7 (T5), §4, abstract
**Problem:** T5 offered `σ_t(x)` (the semantic projection) as a provider idempotency key on the grounds of paraphrase-stability. But the witness assumption A5′ only gives `σ(x) ≠ σ(x') ⇒ distinct`. It does **not** give the converse, and the paper's own D4b category contains distinct acts with identical projections. Keying a provider on `σ` would make the provider merge distinct actions — a wrong-suppression at a system boundary where no local audit can see it.
**Change:** T5 split. **Case A** requires a key that is both paraphrase-invariant **and** complete for effect identity (new assumption **A5″**, explicitly *not* assumed elsewhere and explicitly false for `wire_money`); external exactly-once follows. **Case B** (witness-only, A5′ alone): the projection is sound as a veto, **inadmissible** as an idempotency key, and the canonical `op` is admissible but not paraphrase-stable — so the commit window stays open for paraphrased retries and no local mechanism closes it.
**Why:** The previous theorem licensed a deployment pattern that is actively unsafe in the catastrophic direction.

**Section:** §5.0 (new)
**Problem:** "Exactly-once" was used for three claims that fail independently.
**Change:** Explicit separation of (A) identity recognition, (B) fence-level at-most-once commitment, (C) external exactly-once, with each theorem assigned to one. No unqualified "exactly-once" remains in the paper.
**Why:** A mechanism can be perfect at (A) and (B) and still double-charge, because (C) fails in a window during which no local code runs.

### B.2 Harness defects repaired

**Section:** §6.2, `src/judge.js`, `test/judgeParser.test.js`
**Problem:** The judge was instructed to return an integer in `[0,100]`; the parser accepted any finite number and divided by 100. A reply of `0.95` (probability scale) was recorded as `0.0095` — a confident SAME verdict stored as a confident DIFF score. 180/780 scores (23.1%) were affected. The reply is valid JSON, so it never triggered a retry and the "failed to answer" rate read 0%.
**Change:** Output field renamed `p_same_pct` (the contract now names its own scale). Strict parser: accepts integer 0–100 as number or numeric string, optionally with an explicit `%`; **rejects** every non-integer (including `0.95`, `0.950`, `95.5`), out-of-range values (no clamping), and non-numeric values; missing indices are an outcome, not an absence. Batches showing probability-scale replies are retried with an explicit correction. Unscored pairs become **abstentions recorded as `null`, never 0.5** — an imputed mid-score would enter calibration and move both thresholds while appearing to be a judgment. Parser outcomes, retries, transport failures and abstentions are counted and reported. 15 unit tests cover `95`, `0.95`, `"95"`, `"0.95"`, `95.0`, `0.950`, invalid, missing, out-of-range, plus abstention and retry behaviour.
**Why:** Required before any judge-dependent number could be trusted. **All judge-dependent results in the previous version are superseded.**

**Section:** §6.2, `archive/README.md` — *a second, smaller error found while auditing the first*
**Problem:** The previous version's description of its own defect was itself inaccurate. It stated that the mis-scaled values were "precisely `{0.0095, 0.0097, 0.0098, 0.0099}` = `{0.95, 0.97, 0.98, 0.99}/100`", i.e. that only confident same-act verdicts were affected. Re-deriving from the archived scores shows the implied probabilities span the whole range (0.01, 0.02, …, 0.6, 0.8, 0.9, …, 0.99): the judge answered on a `[0,1]` scale generally, not only when confident.
**Change:** Corrected in §6.2 and in `archive/README.md`, with the accurate breakdown — 91 of the 180 were implied same-act verdicts (78 truly-SAME, 13 truly-DIFF); the other 89 were already distinct-act verdicts where rescaling usually changes no decision. A one-line reproduction command is shipped so the claim can be checked rather than believed.
**Why:** A disclosure that misdescribes the defect it discloses is not a disclosure. The 23.1% headline was right; the characterisation underneath it was not, and it had been repeated verbatim into the revision before being caught.

**Section:** `src/groq.js`
**Problem (found during this revision):** HTTP **413** is Groq's rate-limit response for token-allowance breaches, and the client treated only 429/5xx as retryable. A 413 was thrown immediately with no backoff, so two judges scheduled after a long run failed all 288 attempts in ~2 seconds and recorded 955 abstentions each — while the run reported "3 judges scored".
**Change:** 413/408 added to the transient set with server-stated backoff.
**Why:** A capacity refusal must be waited out, not recorded as "the judge declined to answer".

**Section:** `src/groq.js` (introduced and fixed within this revision)
**Problem:** The retry-delay parser read `"try again in 412ms"` as **412 minutes** (`(\d+)m` swallowing the `m` of `ms`), so every rate-limit reply slept the 15-minute ceiling and a healthy quota presented as an outage.
**Change:** Negative lookahead `(\d+)m(?!s)`.
**Why:** Self-inflicted; documented because it caused a multi-hour misdiagnosis of "exhausted quota".

**Section:** `src/experiments/score.js`
**Problem:** `scores.jsonl` was rebuilt only from judges named in the current run, so resuming one failed judge would silently delete a completed judge's column. Separately, it was only written when a judge *finished*, stranding scores from a quota-terminated pass.
**Change:** `loadAllPartials` merges every judge's partial; added `--persist-only` to rebuild from partials with no model calls; `--retry-abstentions` retries `null`-scored pairs.
**Why:** A three-judge comparison could otherwise be silently reduced to one.

### B.3 Experimental scope

**Section:** §6.1 — corpus 780 → **955 pairs**. Added a **Qwen generator arm** and a **hand-authored arm (68 pairs, no model in the loop)**. **Why:** the previous corpus was entirely model-written, so dedup could not be distinguished from recognition of machine phrasing. The hand-authored arm is reported as a *generator* arm and explicitly **not** as human validation.

**Section:** §7.6 — **new multi-candidate experiment** at `m ∈ {1,2,5,10,25,50}` with nested candidate sets, comparing uncorrected / Bonferroni / set-conformal thresholds. **Why:** mandatory to validate the corrected T3; every other experiment runs at `m ≤ 1`.

**Section:** §7.7 — crash/replay **3 → 8 crash points**, with the commit window split into `during_external_commit_window` (provider applied, response never received) and `after_external_effect_before_local_commit` (response received, commit row not durable), plus `--pool-generator` so the paraphrase pool comes from a different family than the judge. **Why:** the previous run's pool was generated by the judge's own model — a confound the corpus evaluation controlled for and that experiment did not.

**Section:** §6.4 — **human-annotation harness added** (blinded stratified export, Fleiss' κ, disagreement and adjudication rates, separate evaluation over the human subset). **Result: PENDING — no annotations exist.** **Why:** labels are by construction and therefore an artefact of the authors' definition; this is disclosed as an open gap rather than filled with the authors' own text.

**Section:** §7.9 — **friction-reduction study added**: per-tool calibration, tightened schema, judge ensembles, deterministic scorer, plus a cost model (calls, tokens, escalations, latency per 1,000 dispatches). **Why:** item-by-item measurement of the escalation cost, including the negative result that per-tool calibration makes friction worse.

### B.4 Positioning and framing

**Section:** §2, §1.4, abstract — **added ACRFence [14], CapLease [15], LogAct [16], Yin [17]**; withdrew any implication of priority on the problem. ACRFence describes semantic rollback in checkpoint-restore and proposes an LLM analyzer, leaving its error modes as future work and reporting no implementation of the defence; CapLease names "semantic replay" and binds authorizations to a canonical action. **Why:** the previous related-work section did not engage the closest prior art, which makes the novelty claim indefensible. Narrowed claim: bounding the identity decision's safety-critical error for the deployed statistic, the decidable pre-judge veto, the auditable escalation band, and the separation of the three guarantees.

**Section:** Title — dropped unqualified "Exactly-Once". **Section:** §8 (new) — "What this paper does not claim", eight explicit non-claims plus the precise statement of what is guaranteed. **Section:** §7 — reorganised around RQ1–RQ7, each with hypothesis, result, interval and limitation.

### B.5 Superseded numbers

Every judge-dependent figure below came from the defective-parser run and is **withdrawn**:

| Quantity | Previous (defective) | Revised (strict parser) | Direction |
|---|---|---|---|
| dedup, hardened α=0.05 | 80.4% | **96.8% [93.8–98.4]** | better (harness repair) |
| wrong-suppression, hardened α=0.05 | 3.4% | **2.4% [1.0–5.6]** | better |
| silent escape | 5.5% | **0.0% [0.0–1.5]** | better |
| friction, hardened α=0.05 | 41.7% | **2.4% [1.0–5.6]** | better |
| L0 dedup | 20.9% | **13.5% [9.9–18.3]** | worse (denominator change) |
| D4a raw-judge WS | 55.0% | **65.0% [43.3–81.9]** | **worse — kept** |
| D4b WS (hardened) | 72.0% | **88.0% [70.0–95.8]** | **worse — kept** |
| S3 (motivating example) dedup | 37.5% (3/8) | **100% (8/8) [67.6–100.0]** | better |
| per-tool calibration | untested | **−19 pts dedup** | new negative result |
| judge gradedness claim | withdrawn | re-measured, now supported, and shown to differ sharply between two judges | restored on new evidence |

**A framing withdrawn, not just a number.** The previous version made escalation friction its headline limitation ("the dominant operating cost", "the most valuable next problem"). At a corrected 2.4% it is neither, and that framing is withdrawn in §7.9 and §9. The defect had inflated it roughly seventeen-fold, and an entire strand of the discussion was built on the artefact.

---

## C. Theorem audit

### T1 — Fence-level at-most-once commitment *(guarantee B)*
- **Status:** HOLDS, unchanged in substance; re-scoped to guarantee (B) explicitly.
- **Assumptions:** A1 (stable run id), A2 (deterministic canonical identity), A3 (atomic insert-if-absent), A4 (effect before commit), **A7 (no concurrent dispatch per identity)**.
- **Implementation satisfies?** Yes for A1–A4 (`src/fence.js`, file-backed log with a uniqueness check). **A7 is supplied by the experiment, not by the mechanism** — dispatches are sequential. A distributed deployment must supply a per-`op` lease or single-writer scheduling.
- **Proof:** Standard first-committer-wins over a uniqueness constraint. Verified by `test/fence.test.js` across fence instances sharing a log.
- **Remaining limitation:** Without A7 only the weaker property survives — at most one commit *row*, with concurrent duplicates rendered observable as `COMMIT_CONFLICT` rather than prevented. Not mechanised in a proof assistant; the concurrent path is not model-checked.

### T2 — L0 soundness
- **Status:** HOLDS.
- **Assumptions:** A5 (each declared field policy is semantics-preserving), A2 (no hash collision).
- **Implementation satisfies?** Yes — L0 consults no score. The *assumption* is an obligation on the schema author, not a property of the code.
- **Proof:** Two lines from A5. Empirically 0/206 false suppressions on held-out DIFF pairs (0.0%† [0.0–1.8]).
- **Remaining limitation:** Entirely contingent on A5. A field mis-declared `num` or `ci` that is in fact effect-determining in its raw form voids it. Policy declarations are neither inferred nor verified.

### T3 — Multiplicity-corrected wrong-suppression bound
- **Status:** **CORRECTED.** The previous statement was false for the deployed algorithm; the revised statement matches it.
- **Assumptions:** A6 — conditionally on `m`, each truly-distinct pairwise score is exchangeable with the calibration pool. Arbitrary dependence among the `m` scores is permitted.
- **Implementation satisfies?** Yes: `decideOverCandidates` takes the max over the surviving candidate set and thresholds at `maxSuppressionThreshold(cal, α, m)`; `m = 0 → +∞`; abstentions are dropped from the max and can never suppress.
- **Proof:** Per-candidate conformal rank argument at level α/m, then union bound over `m`, then average over the distribution of `m`. Monte-Carlo validated in `test/conformal.test.js`, which *also* asserts that the **uncorrected** rule breaks the bound (violation rate > 2α at `m`=10) — if that test ever passes, the correction is untested.
- **Remaining limitation:** (i) Conservative — the union bound is tight only when at most one candidate can score high. (ii) The budget binds hard: `t_hi = +∞` once `m > α(n+1)`, i.e. `m` > 10 at α=0.05 with n=205, so semantic suppression *switches off* rather than degrading gracefully. (iii) **Marginal over calibration draws, not per-draw** — an unlucky draw exceeds α on the test split (§7.6 sweep). (iv) **Does not apply under distribution shift**; the injection split violates A6 deliberately and we do not invoke the bound there.

### T4 — Impossibility of simultaneous zero error
- **Status:** HOLDS.
- **Assumptions:** The score distributions for truly-same and truly-distinct pairs overlap on a set of positive probability.
- **Implementation satisfies?** The premise is measured: SAME median 0.95, DIFF median 0.05, with overlap between.
- **Proof:** Support-separation argument. Zero on both errors requires `sup(supp F_diff) ≤ τ < inf(supp F_same)`, contradicting overlap. With a band, "zero silent escape" is attainable but *relocates* the error into escalation rather than removing it.
- **Remaining limitation:** A short argument, not a deep one. Its role is architectural: it shows the decidable layers are the only route to a zero, so the layering is forced rather than chosen.

### T5 — External exactly-once by composition *(guarantee C)*
- **Status:** **CORRECTED and SPLIT.** The previous version's suggestion that `σ_t` suffices as a provider key is **withdrawn as unsafe**.
- **Assumptions:** A8 (provider applies at most one effect per key). **Case A** additionally requires **A5″** (projection complete for effect identity). **Case B** assumes only A5′.
- **Implementation satisfies?** **No, and this is the point.** Our `wire_money` satisfies A5′ and **not** A5″, so the deployment in our experiments is Case B: the window is open, and §7.7 measures it being open. Case A is a statement about what a schema must provide, not a property we demonstrate.
- **Proof:** Case A: both dispatches carry the same key (paraphrase-invariance) and no distinct act collides onto it (completeness), so A8 yields exactly one effect. Case B: non-completeness exhibits distinct acts sharing a projection, so a `σ`-keyed provider would absorb a legitimate action; `op` is sound but not paraphrase-stable.
- **Remaining limitation:** A8 is assumed of a third party and never verified. Guarantee (C) is unavailable to any deployment whose schema is not effect-complete — which is a schema-design conclusion, not a mechanism result.

### T6 — Residual determination *(new; the paper's central general result)*
- **Status:** HOLDS.
- **Assumptions:** A5 (certifier soundness), A5′ (refuter soundness). Nothing about the oracle, the actor, or the adversary.
- **Implementation satisfies?** Yes by construction — the residual is `{(x,x') : κ_t(x) ≠ κ_t(x') ∧ σ_t(x) = σ_t(x')}`, computed from schema declarations alone. The measured jurisdiction split (26.5% decided without a model call; 43.5% under the tightened schema) is a direct read of `Dec_t`.
- **Proof:** Three lines — the defining condition mentions only `κ_t` and `σ_t`; any error must fall outside `Dec_t` by A5/A5′; a finer projection has a larger refuter, so the complement shrinks.
- **Remaining limitation:** The theorem says the residual is schema-determined, **not** that it is small. On a loose schema it is large, and T6 offers no method for *finding* a better declaration — only the guarantee that improving one dominates. Corollary T6.2 ("schema-first") is supported by a single schema-tightening experiment on one tool; the general claim that declaration-side interventions dominate oracle-side ones is stated in §10 as a falsifiable prediction, not a proved law.

### T7 — Composition structure of the three guarantees *(new)*
- **Status:** HOLDS.
- **Assumptions:** A8 for the (C) clauses; T5 Case A completeness where a provider key is invoked.
- **Implementation satisfies?** The necessity of (A) is demonstrated rather than merely argued: our own deployment is Case B (refuter-only), so (C) is unavailable and the commit window stays open — the configuration the theorem describes.
- **Proof:** Misidentification supplies the wrong key to both keyed mechanisms, so both behave to spec and the outcome is still wrong; a complete provider key gives at-most-once independently of local serialisation; the local fence cannot observe an effect its own durable state does not yet record.
- **Remaining limitation:** Stated for the single-tool, single-run case. Cross-tool and cross-run identity (the same act reachable through two different tools) is not modelled, and would need a notion of identity above the tool schema.

---

## D. Experiment audit

Common to all rows: **Dataset** `research/effect-identity/corpus/pairs.jsonl` (955 pairs, seed 20260712, stratified 50/50 by (category, generator); D4 attack categories held out of calibration entirely). **Parser status:** strict (`p_same_pct`, integer 0–100, abstentions recorded as `null`). **Affected by old parser defect:** **No** — every number below is from the re-scored corpus. **95% CI:** Wilson, reported inline in the paper for every rate.

| # | Metric | Split | n | Calibration | Judge | Reproducible command |
|---|---|---|---|---|---|---|
| D1 | L0 dedup 13.5% [9.9–18.3]; L0 false-suppression 0.0%† [0.0–1.8] | test | 251 SAME / 206 DIFF | none (decidable) | none | `node src/experiments/run.js` |
| D2 | Hardened α=0.05: WS 2.4% [1.0–5.6], dedup 96.8% [93.8–98.4], silent 0.0% [0.0–1.5], friction 2.4% [1.0–5.6] | test | 251 / 206 | 199 DIFF cal scores, `t_hi(m)` at α/m | GPT-OSS-120B | `node src/experiments/run.js` |
| D2b | Hardened α=0.01: WS 0.5% [0.1–2.7], dedup 82.1%, silent 6.0% | test | 251 / 206 | as D2 | GPT-OSS-120B | `node src/experiments/run.js` |
| D3 | Per-category (S1 100%, S3 100% [67.6–100.0] n=8, S2 97.6%, S4 93.9%, D1 0.8%, D2 5.3%) | test | per table | as D2 | GPT-OSS-120B | `node src/experiments/run.js` |
| D4 | Attacks: D4a raw 65.0% [43.3–81.9] → hardened 0.0%† ; D4b hardened 88.0% [70.0–95.8] → tightened 0.0%†; 20B far more robust (D4a 15.0%, D4b 28.0%); `min` tracks the better judge, `mean` the worse | attack (held out) | 20 / 25 | **excluded from calibration**; bound not claimed | both GPT-OSS judges + ensembles | `node src/experiments/run.js` |
| D5 | Ablations: −L0 −0.8 pts dedup; −band converts 3.2% flagged→silent; −calibration WS 1.5% | test | 251 / 206 | as D2 | GPT-OSS-120B | `node src/experiments/run.js` |
| D6 | Calibration-size sweep; certifiable `m` per n (n=199 → `m` ≤ 10); p95 WS 9.2% at every n ≥ 20 | test | 300 resamples/point | resampled n ∈ {10,20,30,50,100,199} | GPT-OSS-120B | `node src/experiments/run.js` |
| D7 | Cross-generator dedup (handwritten 94.1%, llama 98.2%, gpt-oss-self 95.1%, qwen 96.6%) | test | 34/55/61/59 SAME | as D2 | GPT-OSS-120B | `node src/experiments/run.js` |
| D7b | Cross-judge: 120B vs 20B vs `min` vs `mean`; saturation (SAME extremes 6% vs 83%) predicts silent escape (0.0% vs 2.0%) | test | 251 / 206 | per-scorer | both GPT-OSS judges | `node src/experiments/run.js` |
| D8 | Friction reduction: per-tool **−19 pts dedup** (78.1% vs 96.8%); tightened friction 1.5%; lexical scorer 22.7% dedup | test | 251 / 206 | per-arm | GPT-OSS-120B + lexical | `node src/experiments/run.js` |
| D9 | Cost: 735 judge calls and 24 escalations per 1,000 dispatches (565 / 15 tightened); 1,480 ms mean judge latency (96 calls, batch 10, GPT-OSS-20B). **Token totals not reported** — the per-judge counters were destroyed by the metadata-overwrite bug (B.2) and are recoverable only by re-running scoring. | test | 457 | — | GPT-OSS-120B (calls), GPT-OSS-20B (latency) | `node src/experiments/run.js` |
| D10a | Multi-candidate, spurious-maximum accumulation: **65% of DIFF units contain a false 1.0 among 50 candidates** (0% at `m` ≤ 25 — see caveat) | purpose-built units | 40 DIFF + 20 SAME units × K=50 = 3,000 live comparisons | in-experiment pool only | Llama-3.1-8B-Instant | `node src/experiments/multiCandidate.js --judge llama-3.1-8b-instant --K 50 --units-diff 40 --units-same 20` |
| D10b | Multi-candidate, **threshold comparison (uncorrected vs Bonferroni vs set-conformal): NOT COMPLETED** | — | — | `corpusDiffN = 0` for this judge → every threshold `+∞` → nothing suppressed → comparison vacuous. Judge also fully saturated (2,968/3,000 scores exactly 0.00, 32 exactly 1.00). | Llama-3.1-8B-Instant | needs a judge with a corpus calibration pool *and* graded confidence (GPT-OSS-120B qualifies; daily quota exhausted) |
| D10c | Corrected-bound validity (uncorrected rule exceeds α on the max statistic; Bonferroni holds at `m` ∈ {1,2,5,10}) | Monte-Carlo simulation | 300 reps × 20 draws per `m` | synthetic, controlled | none | `node --test "test/*.test.js"` |
| D11 | Crash/replay, 8 crash points, paired, cross-family pool — **RUNNING, results PENDING**; harness verified (47-variant Llama pool, GPT-OSS-20B judge, `cross-family pool: YES`), no partial rates reported because an early prefix is not balanced across crash points. Previous version's 30-trial result **withdrawn** (same-family pool + defective-parser thresholds). | fault injection | — | α=0.05, `t_hi`=0.1 (GPT-OSS-20B) | GPT-OSS-20B | `node src/experiments/crashReplay.js --trials 48 --judge openai/gpt-oss-20b --pool-generator llama-3.1-8b-instant` |
| D12 | Judge coverage / abstentions / parser outcomes | all | 955 | — | per judge | `node src/experiments/score.js --persist-only` |

**Judge coverage.** GPT-OSS-120B 920/955 (96.3%, 35 abstentions, all transport); GPT-OSS-20B **955/955 (100%, zero abstentions, zero parser violations)**; Llama-3.3-70B 60/955 (6.3%) and Qwen3.6-27B 110/955 (11.5%), both halted by per-model daily token allowances and reported as **NOT RUN**. Ensembles are formed only from judges clearing an 80% coverage threshold, so their membership is fixed rather than varying per pair. Rates computed over a judge that abstains are excluded, not printed: such a judge yields `t_hi = +∞` and a row reading "0% wrong-suppression, 0% silent escape" that is the *absence* of a judge wearing the appearance of a perfect one — a trap we fell into mid-revision and corrected.

**Explicitly PENDING / NOT RUN:**
- Human annotation study (§6.4) — harness built, zero annotations, status PENDING.
- Cross-**family** judge comparison — two judges reached coverage and both are GPT-OSS. Llama and Qwen arms not run.
- Judge token totals for the cost model (B.2 metadata bug).
- Any claim of production-scale or longitudinal validity.

---

## E. Reviewer report

Scores are for the **revised** paper, as an independent assessment rather than an author's hope.

| Dimension | Score | Rationale |
|---|---:|---|
| Novelty | **7/10** | The *problem* is prior art (ACRFence, CapLease) and the paper says so plainly. The *framing* is not: the certifier/refuter duality, the residual as a schema-determined object (T6), and the composition structure (T7) turn a scattered set of mechanisms into positions in one design space, and turn "schema-first, model-second" from advice into a corollary. The multiplicity correction is textbook once posed; posing it against the deployed statistic is the contribution. Held below 8 because the general theory is validated on one instantiation, and §10's transfer claim is explicitly a conjecture. |
| Technical correctness | **8/10** | Both central defects (T3's statistic, T5's key) are fixed rather than papered over, with the weaker claim adopted where the stronger one failed. Assumptions are explicit and separated into schema, scheduler and third-party obligations. Deducted for: no mechanised proofs, A7 supplied by experimental setup rather than mechanism, and the conformal guarantee's silence under the very distribution shift the threat model centres on. |
| Experimental rigor | **5/10** | Strong on intervals, basis-of-zero labelling, held-out attacks, generator circularity (four arms including a no-model one), a real two-judge contrast, and genuine negative results kept (per-tool calibration, `min` on benign data). Materially weakened by: **three experiments incomplete** — cross-family judge comparison, the multi-candidate threshold comparison, and the crash/replay — small n on several decisive cells (S3 n=8, D3 n=5, D4a n=20), by-construction labels with human validation PENDING, and a corpus that is not production traffic. |
| Systems significance | **7/10** | The failure is real, expensive and increasingly common; the mechanism is implementable, cheap on the decidable path, and the schema-tightening result is directly actionable. Deducted for single-node storage, unmechanised concurrency, and a guarantee (C) that is delegated rather than delivered. |
| Writing | **8/10** | Clear structure, RQ-organised results, explicit non-claims. Occasionally over-long, and some self-referential meta-discussion about the previous version's errors could be compressed into the change log. |
| Reproducibility | **9/10** | Zero-dependency artifact, seeded splits, persisted scores, resumable scoring, per-metric commands, unit tests that pin the parser contract *and* assert the uncorrected conformal rule fails. Deducted only because the live-judge numbers depend on a rate-limited third-party API whose quota shapes what can be re-run. |
| **Overall** | **7/10** | The theoretical contribution is now the paper's spine and is submission-grade; the evaluation is not. Three experiments are pending, and while each is honestly marked, a reviewer counts them. A theory paper with one instantiation and three open cells is publishable at a good venue; a top-tier acceptance needs the cells filled. |

**Strongest contribution.** T6 and the certifier/refuter decomposition it rests on. Naming the residual as a schema-determined object explains, in one line, a result that would otherwise read as a lucky ablation: tightening one tool's declaration eliminated the worst attack (D4b 88% → 0%†), cut friction, cut wrong-suppression and removed a sixth of the judge's workload *simultaneously*, while every oracle-side intervention traded one axis against another. A theory that predicts the shape of your experimental results before you run them is doing work; this one does, and the paper now states the prediction sharply enough to be falsified.

**Biggest remaining weakness.** Three unfinished experiments, all blocked on the same cause — per-model daily token quotas on a free-tier key — and none of them blocked on ideas: (i) the cross-*family* judge comparison (two judges ran, both GPT-OSS); (ii) the multi-candidate threshold comparison, which ran but on a judge that had no calibration pool and proved fully saturated, so every threshold was `+∞`; (iii) the eight-crash-point replay, still running. Each is marked PENDING rather than filled in, which is the right call and still leaves the evaluation thinner than the theory. The generator-side circularity check is well done and does not substitute for judge-side replication.

**A note on how the pending items are handled.** The paper states, in advance, what the crash experiment is expected to show — including that the mechanism must *fail* inside the commit window — so that the completed run can contradict it. That is the correct way to leave an experiment open, and a reviewer should hold the authors to it.

**Likely reviewer objections, and their status.**
1. *"Your conformal guarantee evaporates exactly where your threat model lives."* — **Valid and conceded.** A6 fails under injection; the paper states it and shows the calibrated layer performing slightly *worse* than the raw judge on D4a. Mitigation is the decidable veto, not the bound. Group-conditional/shift-robust conformal is future work.
2. *"The Bonferroni correction makes the mechanism useless at realistic `m`."* — **Valid.** Beyond `m` > 10 at α=0.05 the layer stops suppressing entirely. The paper reports this as a budget (`n ≥ m/α − 1`) rather than hiding it, but a deployment with many effects per run gets little from the semantic layer.
3. *"Zero wrong-suppression on D4a is a tautology, not a result."* — **Conceded and stated.** It is a logical consequence of A5′, marked †. The measurement tests the implementation; the *placement* of the veto before the judge is the design claim, and the raw-judge row (65%) is what makes it falsifiable.
4. *"Your labels are your own definition of 'the same action'."* — **Valid, unresolved.** Human study is built and PENDING. The hand-authored arm addresses machine-generation bias only.
5. *"Removing calibration gave better wrong-suppression — why keep it?"* — **Reported honestly.** Calibration buys a transferable guarantee, not a better operating point on this judge; a hand-set τ carries no bound to an unseen judge or corpus.
6. *"You are not first."* — **Conceded in §1.4, §2 and the abstract.**
7. *"n=8 for the motivating example."* — **Valid.** 100% on 8 pairs has a 67.6% lower bound; the paper says so rather than quoting the point estimate alone.

**Is it ready for submission?** **No — but the remaining work is execution, not research.** The theory is submission-ready and the two central corrections (T3's statistic, T5's key) are the substantive contributions of this revision. What is missing is three runs that the harness already implements and that are blocked only on API quota:

1. **Cross-family judge comparison** — score the corpus with a Llama-family and a Qwen-family judge. Unblocks the judge side of RQ7, the ensembles, and the claim that any reported property is a property of the mechanism rather than of GPT-OSS.
2. **Multi-candidate threshold comparison** — re-run with GPT-OSS-120B, which has both a corpus calibration pool and graded confidence. Unblocks the empirical half of the paper's central correction.
3. **Crash/replay** — let the eight-crash-point run finish.

With those three, experimental rigor goes to 8 and the overall to 8; the paper would then be a credible submission to a systems or ML-systems venue. Submitting today would mean defending an evaluation with three holes in it — survivable given how explicitly they are marked, but an unforced weakness, and reviewers rarely reward candour as much as authors hope. The human-annotation study is the one genuinely open *research* question and is not blocking, provided its PENDING status stays as prominent as it is.
