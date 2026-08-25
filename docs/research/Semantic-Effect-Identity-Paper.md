# Effect Identity for Non-Deterministic Agents: Certifiers, Refuters, and the Calibrated Residual

**A theory of when two differently-worded agent actions are the same act — decomposing the decision into a decidable certifier, a decidable refuter, and a conformally calibrated residual — together with one instantiation, a semantic fence for paraphrased replay of irreversible tool calls.**

*We avoid the unqualified term "exactly-once" throughout. What is provable locally is at-most-once commitment by the fence under stated scheduling assumptions, together with a bounded identity-recognition error; end-to-end exactly-once additionally requires a provider whose idempotency key is complete for effect identity (§6.8).*

---

*Sivaguru R. M.*
*Independent Research · AgentRuntime Project*
*Correspondence: sivagurumurugan1@gmail.com*

*Research Paper — August 2026*

---

## Abstract

An agent retrying an irreversible action after a crash must not perform it twice. Every mechanism preventing this — idempotency keys, durable-execution journals, content-addressed fences, the LLM "analyzers" proposed for agent checkpoint-restore [14, 15] — rests on an implicit question: **when are two differently-worded requests the same act?** Existing answers are total by fiat (a journal position, a client token) or unbounded (a model's opinion). The first fails the moment an actor re-synthesises its own arguments — which a language model does on every retry.

Any procedure deciding effect identity decomposes necessarily into three parts: a **certifier** (decidable, proves sameness, licenses suppression), a **refuter** (decidable, proves difference, licenses execution), and the **residual** neither settles. We prove **T6**: the residual is a function of the declared schema alone — independent of oracle, actor and adversary — so no model moves a pair out of it, every non-provable error lies inside it, and refining the declaration shrinks it monotonically. With **T4** (no score-threshold rule achieves both zero errors on overlapping distributions) this gives a design law: oracle quality trades one error direction against the other; schema quality removes both. **T7** separates three guarantees "exactly-once" conflates — (A) identity recognition, (B) fence-level at-most-once commitment, (C) external exactly-once — and proves only (A) irreplaceable.

We instantiate this as a layered fence, evaluated on 1,066 labelled tool-call pairs over six irreversible tools.

**Measured.** The fence deduplicates **94.7% [91.4–96.7]** of true duplicates at **1.7% [0.7–4.3]** wrong-suppression, against a content-addressed baseline's **12.1% [8.8–16.4]**. Under injection a raw judge wrongly suppresses **65.0% [43.3–81.9]** of different-amount actions; the refuter drives that to zero *by construction*, while text-only distinctions — pure residual — fail **84.0% [65.3–93.6]** of the time. Across three judges spanning two vendors at full coverage, wrong-suppression stays inside α (1.7%, 1.3%, 0.9%) while deduplication moves freely (82.6–94.7%). Under seed-level splitting it rises to **2.7%** mean, exceeding α on 10.5% of splits.

**Limits.** Wrong-suppression is non-zero and by T4 cannot be zero. A blinded independent panel agrees with our labels overall (Krippendorff α = 0.828, agreement **87.9% [80.8–92.7]**) but **contests the one category we preregistered as most disputable**; 13 of its 14 disagreements fall where act-distinguishing information lives only in prose — the residual is where readers disagree, not merely where oracles do. Under that relabelling our own preregistered test declares the safety claim not to survive. Independent *human* validation remains uncollected; the instrument is shipped unrun.

**Keywords:** effect identity, exactly-once, idempotency, LLM agents, semantic equivalence, conformal prediction, adversarial robustness, durable execution.

---

## 1. Introduction

> ### What is guaranteed, in one place
>
> This paper is careful about a phrase the field uses loosely, so we state the
> scope before the argument rather than after it. "Exactly-once" conflates three
> claims that fail independently. We keep them apart everywhere, and an
> unqualified "exactly-once" appears nowhere in this paper.
>
> | | claim | status here | governed by |
> |---|---|---|---|
> | **(A)** | **Identity recognition** — did the mechanism correctly decide that a candidate dispatch and a committed effect denote *the same intended action*? | **Bounded, not exact.** Exact on the decidable fragments; conformally bounded on the residual; provably not both-ways-exact anywhere else. | T2, T3, T4, T6 |
> | **(B)** | **Fence-level at-most-once commitment** — *given* correct identity, does the local fence commit at most once? | **Proved**, under stated serialisation and storage assumptions (A7). False without them. | T1 |
> | **(C)** | **External exactly-once** — does the *provider* apply the effect exactly once, including when the process dies after the call lands and before the commit row is written? | **Not supplied by this mechanism.** It requires a provider whose idempotency key is complete for effect identity. | T5 |
>
> The separation is not pedantry: a mechanism can be perfect at (A) and (B) and
> still double-charge, because the failure in (C) happens in a window during
> which no local code is running. We measure that window rather than argue around
> it — inside it the fence is wrong in 12 of 12 trials (§8.7).
>
> **What the theory adds** is that (A) has a forced structure. Any procedure
> deciding effect identity decomposes into a *certifier*, a *refuter*, and the
> *residual* neither settles; the residual is fixed by the **declared schema
> alone** (T6), so it bounds what *any* mechanism on that declaration can
> achieve — ours included. Of the three guarantees, only (A) is irreplaceable
> (T7): a provider contract can subsume (B), and nothing substitutes for
> recognising identity correctly, because every keyed mechanism downstream is
> keyed on that answer.


### 1.1 From position to content to meaning

Reliable distributed systems have a single, well-worn defence against the duplicated side effect: *identify* the effect, record that it committed, and refuse to do it again. Everything turns on the identity function.

Durable-execution systems (Temporal, Restate, DBOS) identify an effect by its **position** in a recorded command history and replay the program deterministically, matching commands by order. This is correct only under a *determinism contract* the runtime aggressively enforces — no unguarded clocks, no randomness, no unordered iteration — because a divergent path would make "the command at position *N*" refer to a different operation on replay.

An LLM agent structurally violates that contract: its control flow is a sample from a distribution, so "the tool call at step 3" is not stable across a retry. A prior line of work — which we will call **content-addressed fencing**, and which we restate in full in §2 so this paper stands alone — dissolves the determinism requirement by identifying an effect by its **content** rather than its position:

```
operation_id = H( runId ‖ tool ‖ H( canonicalise(input) ) )
```

Two dispatches are "the same effect" iff they share a run, a tool, and a canonically identical input, *regardless of where on the trace they occur*. A durable committed-effects log checked before every dispatch turns any number of replays into at most one commit. This is a real advance: it is exactly-once for a non-deterministic *control flow*.

But it buys path-invariance and stops one step short. It is exactly-once for a non-deterministic control flow over a **syntactically stable action**. It is *not* exactly-once when the non-determinism reaches into the *arguments of the action itself*.

### 1.2 The gap: the agent paraphrases its own retry

Here is the failure, concretely. An agent is asked to wire \$780 to Marlow Freight for shipment 88213. On its first attempt it calls

```json
wire_money { amount_text: "$780.00", beneficiary_text: "Marlow Freight", reference: "Shipment 88213" }
```

the fence commits the effect durably, and the process is then killed — OOM, deploy, power loss — before the run completes. A fresh process reloads the run and asks the model to continue. The model, being non-deterministic, re-emits the *same intended action* with *different surface text*:

```json
wire_money { amount_text: "seven hundred eighty dollars", beneficiary_text: "MARLOW FREIGHT", reference: "shipment #88213" }
```

Canonicalisation normalises whitespace, case, and key order — but it cannot know that `"seven hundred eighty dollars"` and `"$780.00"` denote the same amount, or that `"shipment #88213"` and `"Shipment 88213"` reference the same shipment, without *understanding* them. The two inputs canonicalise differently, hash differently, and the fence — seeing no matching `operation_id` — **wires the money again.** \$1560 leaves the account. No exception is thrown; the double-charge surfaces days later in a reconciliation report.

The behaviour is not exceptional. It is what should be expected whenever the retried action is regenerated by the model rather than replayed from a journal — which is what happens whenever an agent recovers by re-prompting.

The nearest systems in the literature control *when* an effect becomes permanent, not *whether two effects are the same*. Atomix [4] makes tool use transactional: it tags calls with epochs, tracks per-resource frontiers, and commits a transaction only once progress predicates show that no earlier conflicting work can still arrive, buffering what can be delayed and compensating what has already escaped. Its own motivation is that idempotency keys and Saga-style compensation are insufficient — but the insufficiency it addresses is *timing and isolation*, and its effects are still identified per call within a transaction. Verified tool calls [5] wrap a tool with postconditions and a verify-before-retry step, checking the world for evidence the effect already landed before re-issuing it; that is a genuine duplicate-suppression mechanism, and the closest prior work to ours, but its check is a *postcondition on observable state*, available only when the tool exposes one and the effect is externally queryable — a wire that has left the account is not always visible to the agent that sent it. Content-addressed fencing needs no such observability, but keeps identity **syntactic**.

None of these decides whether two *differently worded* calls denote one act. That is the gap this paper closes.

### 1.3 Why this is hard: a semantic judgment with asymmetric, adversarial loss

One is tempted to reach for the obvious fix — ask a language model "are these two calls the same action?" — and stop. That fails for three compounding reasons, and understanding why is the whole problem.

**It is a semantic-equivalence judgment.** Deciding that `"$780.00"` and `"seven hundred eighty dollars"` are the same, while `"order #4242"` and `"order #4243"` are not, requires understanding the arguments, not matching their strings. The only general-purpose checker for such predicates is a stochastic judge with unknown error.

**The loss is asymmetric and safety-critical.** The two ways to be wrong are not symmetric. *Wrong-suppression* — judging two genuinely distinct actions "the same" and silently swallowing one — hands back a stale result for an action that never happened; it is **undetectable** and can be **catastrophic** (a second, legitimate \$780 wire simply never occurs, and nothing records that it should have). *Duplicate-escape* — judging two identical actions "different" and executing the second — is a double effect, but it is **loud**: it leaves two committed rows that reconciliation can find. A usable identity relation must control the first error tightly even at the cost of the second. A raw judge threshold optimises neither.

**The setting is adversarial.** In an agent under prompt injection, the "retry" may be *crafted* by an attacker to be deduplicated. An injected instruction can rephrase a *different* action — a wire to a *different* account — as "a duplicate of the prior request; suppress it," so that a naïve judge, reading the injected text, suppresses a distinct effect the attacker wanted cancelled, or conversely lets a malicious effect through by dressing it as new. Any identity mechanism that trusts a judge's free-text reasoning inherits the judge's manipulability.

So neither pure canonicalisation (too weak — paraphrase escapes) nor a pure LLM judge (no guarantee, and manipulable) suffices. The interesting object is in between.

### 1.4 Research questions

The theory of §4 is assessed against two questions; the instantiation of §5 against seven more.

**Theoretical.**
- **RQ-T1.** Does effect identity admit a decomposition into decidable and residual parts that is well-posed — independent of which mechanism happens to implement it? (§4.1, Proposition 1)
- **RQ-T2.** What determines the residual, and what therefore bounds the achievable error of *any* mechanism operating on a fixed declaration? (§4.2, T6)

**Empirical.** Each is answered in §8 with a hypothesis, an interval-reported result, and a stated limitation.
- **RQ1.** Can semantic fencing recover paraphrased duplicates that canonical fencing misses? (§8.2–8.3)
- **RQ2.** Can wrong-suppression be bounded in practice, for the statistic actually deployed? (§8.3, §8.5, §8.6, §8.11)
- **RQ3.** Does a decidable refuter prevent adversarial suppression across declared differences? (§8.4)
- **RQ4.** What does the mechanism cost in escalation, oracle calls and latency? (§8.9, §8.10)
- **RQ5.** Does the fence survive process death and paraphrased replay, and where does it stop? (§8.7)
- **RQ6.** How does the calibrated layer behave as the committed candidate set grows? (§8.6)
- **RQ7.** Is the result an artefact of the oracle recognising its own writing? (§8.8)

RQ6 is answered under a restricted apparatus and we say so where it is reported: the multi-candidate experiment (§8.6) runs on a judge whose scores are almost entirely saturated at 0 and 1, which is informative about the multiplicity property under test and not a measurement of the deployed configuration's accuracy at scale. RQ5 was answered the same way in an earlier version of this experiment — against the deterministic offline scorer rather than the deployed judge — and that run contradicted the design's own prediction. §8.7 reports the experiment re-run against the deployed judge, at the threshold the corpus evaluation actually produces, with a second arm that makes the safety-critical error observable for the first time.


### 1.5 Contributions

**The gap, in one paragraph.** Surveying 121 works (§2.7–2.8), effect identity is not unstudied — it falls in a **seam between two mature literatures**. Systems work on durability, transactions and authorization *needs* an identity decision and assumes one, fixing it by position, by client token, or by syntactic normal form: all of which a re-synthesising actor invalidates. Statistics work on conformal prediction *knows how to bound* a fallible oracle, but has been applied to prediction sets, generations and factuality claims rather than to a control decision with an irreversible, asymmetric cost. The two recent works that name the problem directly [14, 15] propose a model-based decider and explicitly leave its error rate open. Against that set we find no system that has all four of: a decidable fragment proving *sameness*, a decidable fragment proving *difference*, a bound attached to the statistic actually deployed, and an auditable policy for what neither settles — with its cost reported. §2.8 states these as G1–G4, records which we close and which we do not, and lists six empty cells that are open problems for others rather than for us.

**What we do not claim as a contribution.** We did not identify this problem first. ACRFence [14] describes semantic rollback in agent checkpoint-restore, and CapLease [15] names semantic replay of authorizations; both predate this work, and ACRFence additionally proposes an LLM analyzer as the mitigation. Our contribution is what those works leave open — ACRFence explicitly notes that its analyzer "introduces its own failure modes (misclassification, adversarial evasion) that require further study", and reports attack validation without an implementation of the defence. We do not claim to be the first to use semantic comparison for replay protection, nor to be the first to suppress duplicate tool calls. With that said:

1. **A theory of effect identity** (§4), which is the paper's primary contribution and the frame for everything else. An effect algebra distinguishing an *action* from its *dispatches*; the **certifier / refuter** duality (Definitions 4–5), which separates decidable proofs of sameness from decidable proofs of difference and shows they are duals rather than variants; and the **residual** (Definition 6), the pairs a declaration cannot settle. A four-axis design space in which idempotency keys, durable execution, content addressing, verified tool calls, transactional runtimes, authorization leases and LLM analyzers are all positions rather than rivals (§4.3), and a taxonomy locating duplication among the replay hazards it belongs to (§4.4).

2. **Two structural results about that theory.** **T6 (residual determination):** the residual is a function of the declared schema alone, so no oracle moves a pair out of it, every non-provable error lies inside it, and refining the declaration shrinks it monotonically — from which *schema-first, model-second* follows as a corollary rather than a slogan. **T7 (composition structure):** of the three guarantees "exactly-once" conflates, identity recognition is the only irreplaceable one; a complete provider key subsumes local at-most-once, and nothing substitutes for identity, because every downstream mechanism is keyed on it. A third result, **T6.3′ (the refinement dilemma)**, follows from taking T6 seriously and cost us a headline: the calibration pool is drawn from the residual, so refining a declaration shrinks the pool at the same rate it shrinks the residual, and schema refinement therefore dominates on the fragment it decides while degrading the calibrated layer on the fragment it does not.

3. **A layered identity relation** (§5) that is neither a hash nor a judge but a composition of three layers with different epistemic status: a **decidable canonical core** (L0) that is provably sound; a **conformally calibrated semantic layer** (L1) with a distribution-free wrong-suppression bound; and an **auditable escalation** band (L2) that makes escapes loud. A **distinctness witness** derived from declared effect-determining fields (§5.4) hardens L1 against adversarial paraphrase.

4. **A correctness account** (§6). T3 is stated for the statistic the fence actually thresholds — the *maximum over the candidate set* — with a multiplicity correction valid under arbitrary dependence, together with its treatment of ties, varying and zero candidate-set size, and insufficient calibration data. T5 is split into the case where the provider key is complete for effect identity (external exactly-once follows) and the case where it is only a distinctness witness, in which the projection must **not** be used as an idempotency key and the commit window stays open. Alongside these: at-most-once fence commitment under explicit serialisation and storage assumptions (T1), L0 soundness (T2), and an impossibility result (T4) showing the layering is forced rather than chosen. §6.2 is explicit about which proofs are deep and which are short arguments that nonetheless must be made.

5. **A labelled corpus and a reproducible evaluation** (§7–8): 955 tool-call pairs over six irreversible tools in nine categories including adversarial paraphrase and prompt-injection attacks, with four generator arms — three model families and one written by hand with no model in the loop — scored by a live judge under a strict, unit-tested output parser that records abstentions rather than imputing them. Baselines, ablations, an attack evaluation, a generator-circularity check, a calibration-resampling study that measures what a declared α does and does not promise, a **multi-candidate experiment** at `m` ∈ {1,2,5,10,25,50} that the corrected T3 requires, an **eight-crash-point** multi-process paraphrased crash/replay, and four measured interventions on the mechanism's operating cost. Every rate carries a Wilson 95% interval; rates that are zero by construction are distinguished from rates that are zero in the sample; and a checker in the artifact fails the build if the manuscript quotes an interval the results cannot produce.

6. **A limitations account that measures rather than asserts** (§10–11), stating the boundary of the claim explicitly, distinguishing rates that are zero by construction from rates that are zero in a sample, and reporting the apparatus of each experiment beside its result.

7. **A validation round targeted at this paper's own weakest points** (§8.7, §8.13–8.14, §9.2), undertaken after an adversarial internal audit of the first version of this manuscript identified five specific gaps. The crash/replay experiment (§8.7) is re-run against the deployed judge rather than a deterministic stand-in, with a second arm added because the original design could not observe a wrong suppression even in principle; the corrected experiment reverses the earlier version's central negative finding. A 15-configuration baseline/ablation matrix (§8.13) adds seven configurations to the original six and reports that two of the reported layers — the certifier and the escalation band — contribute nothing measurable to the outcome *on this judge*, which the original version did not say plainly. A statistical audit (§8.14) validates the multiplicity correction independently of any corpus by Monte-Carlo, discloses a provenance-sharing rate between calibration and test we had not previously measured, and **corrects an over-strong claim in our own earlier resampling study** rather than restating it. A judge-admission rule is extended to catch a failure mode coverage checking alone permits: a judge that answers every pair with the same score produces a row indistinguishable from a perfect result. Of three further extensions built in that round, the schema-richness ladder was scored and is reported in §8.15; the other two — a fourteen-tool surface and an eleven-class adversarial matrix — were **cut from the body entirely** rather than described without results, and appear once in §9.3 as future work. A described-but-unscored apparatus occupies the space of a result while carrying none of the obligations of one, and an earlier revision of this manuscript let two of them do so.

The artifact (`research/effect-identity/`) is zero-dependency, runs offline except for the judge, and regenerates every number here. A machine-readable reproducibility configuration (`repro.config.json`) records every seed, split, prompt, threshold rule and model identifier this paper depends on, and a verifier (`src/experiments/verify.js`) checks eleven assertion classes — split separation, score validity, abstention handling, jurisdiction-matched pools, multiplicity budgets — against the data as shipped, and fails the build on any violation.

---

## 2. Related Work

### 2.1 Durable execution and positional identity

Temporal, Restate [12], DBOS, and Azure Durable Functions journal a workflow's steps and replay them positionally after failure, under a determinism contract. They are exactly-once for deterministic code and the wrong tool for an actor whose control flow *and arguments* are sampled. Our work is complementary: content-addressed and semantic fencing can live *inside* a durable activity to make it robust to agent non-determinism.

### 2.2 Content-addressed fencing (baseline B2)

The scheme this paper extends identifies an effect by the content of its dispatch rather than its position. Because we take it as the baseline (B2) throughout, we state it here in full rather than by reference. Fix a run id `r` stable across retries, a tool `t`, and a canonicalisation `κ_t` that normalises each declared field under a semantics-preserving policy (§5.1). The effect's name is

```
operation_id = H( r ‖ t ‖ H( κ_t(input) ) )
```

A durable log holds one row per committed `operation_id` under a uniqueness constraint. Before any dispatch the fence looks up the id; on a hit it returns the recorded response without re-executing, and on a miss it executes and then inserts. Two dispatches are "the same effect" iff they agree on run, tool, and canonical input — *wherever* on the execution path they occur, which is what makes it robust to a non-deterministic control flow. Its guarantee is at-most-once across process death for dispatches that are canonically identical, and its stated identity assumption is that semantically identical effects canonicalise to identical inputs. Paraphrased retries are exactly where that assumption breaks, and closing it is this paper's subject.

### 2.3 Idempotency keys

Stripe-style idempotency keys [11] are syntactic, client-chosen, and endpoint-local; they answer "have I seen this token," not "is this the same act." They compose with our mechanism rather than competing with it (T5).

### 2.4 Transactional and verification-based tool runtimes

Atomix [4] and CoAgent [6] address *when* effects may be released and how conflicting concurrent work is ordered or repaired — epochs and per-resource frontiers in the first, saga-style inverses and conflict repair in the second. Both take the identity of an individual effect as given. Verified tool calls [5] suppress duplicates by checking a postcondition before retrying, which requires the effect to be observable in the world; our mechanism decides identity from the *calls themselves* and so applies where no postcondition is queryable. These are complementary: a verified postcondition, where one exists, is stronger evidence than any judge score, and a deployment holding both should prefer it.

### 2.5 Semantic replay: a named, prior problem

Two concurrent lines identify the failure this paper attacks, and we state them before our own contribution rather than after it. **ACRFence** [14] describes "semantic rollback attacks" in agent checkpoint-restore: it observes that checkpoint-restore tacitly assumes a retried call will be identical to the original, that LLM agents instead *re-synthesise subtly different requests* after restore, and that this enables duplicate payments and credential misuse. Its proposed mitigation records irreversible tool effects and enforces replay-or-fork semantics on restoration, using a "lightweight analyzer LLM" that compares a post-restore call against logged entries and classifies it as semantically equivalent, semantically different, or a consumed-credential reuse — distinguishing fields that legitimately change across runs (request ids, timestamps) from fields that carry intent (amount, recipient). **CapLease** [15] names the same phenomenon "semantic replay" — one user authorization consumed repeatedly under freshly issued single-use tokens across replanning, retry, delegation and crash recovery — and binds an authenticated confirmation to a *canonical action*, enforcing transactional issue–prepare–commit transitions and preventing duplicate external effects when paired with an idempotent sink.

The overlap is substantial and we do not minimise it: the *problem statement* of §1.2, and the *idea* of consulting a model to decide whether a re-synthesised call denotes an already-executed act, are prior art. What we add is what those works explicitly leave open. ACRFence states that "the analyzer LLM introduces its own failure modes (misclassification, adversarial evasion) that require further study", and its evaluation validates the attacks *without* implementing the defence. CapLease's canonical action is a syntactic normal form, and its guarantee is carried by the token-consumption state machine rather than by any bound on the equivalence judgment. Neither offers an error guarantee on the identity decision, an adversarially robust veto, an escalation path for the undecidable middle, or a measurement of what the mechanism costs in false suppression and review load. Those are this paper's contributions, and they are contributions *on top of* a problem someone else posed.

### 2.6 Semantic equivalence of tool calls

Semantic equivalence between model outputs is studied extensively for *grading* (did the agent produce the right call?) and for corpus deduplication [13], where the loss is symmetric and errors are cheap. We are not the first to suppress duplicate tool calls [5, 14], not the first to use semantic similarity to decide two texts mean the same thing [13], and not the first to apply either to agent replay [14, 15]. Our claim is narrower: that the *suppression decision itself* can be given a distribution-free bound on its safety-critical error direction — correctly stated for the max-over-candidates statistic a fence actually computes — and that the classes where no such bound is achievable can be removed from the scorer's jurisdiction by decidable vetoes. We know of no prior work that calibrates a semantic-equivalence judgment into a fencing decision with a stated and measured error guarantee.

**Shared logs, authorization state, and irreversibility.** LogAct [16] treats agents as deconstructed state machines over a shared log, making actions visible and vetoable *before* execution and recoverable after failure — a complementary placement of the same durability concern, and the natural substrate on which a semantic fence would sit. Yin [17] formalises safety invariants for agents driving irreversible ledger transitions, with an "execution fidelity" condition (a session's realized effect is nothing at all, or exactly the rendered transition, exactly once) and reports deployed operations across public chains; that work fixes identity by the rendered transaction rather than deciding it across paraphrase.

**Conformal prediction.** Split-conformal methods [1, 2] give distribution-free, finite-sample coverage under exchangeability. Conformal ideas have reached LLMs for *action selection* (KnowNo [3]) and *generation-level acceptance* (ACSE [10]). We use one-sided conformal calibration for a different object — the *suppression* decision of a fence — turning a judge's uncalibrated score into a bounded wrong-suppression rate.

**LLM-as-judge and its manipulability.** LLM judges are known to be biased and promptable [8]; R-Judge [9] and related work document systematic blind spots in agent-safety judgments specifically. Rather than trust the judge, we (a) bound its aggregate error by calibration and (b) remove entire adversarial classes from its jurisdiction with a decidable witness.

**Positioning.**

| Dimension | Idempotency keys | Content-addressed fence | Raw LLM judge | ACRFence [14] / CapLease [15] | **This work** |
|---|---|---|---|---|---|
| Tolerates non-deterministic control flow | no | **yes** | yes | **yes** | **yes** |
| Tolerates paraphrased arguments | no | no | yes | **yes** (ACRFence) / no (CapLease: canonical form) | **yes** |
| Identifies the semantic-replay problem | no | no | — | **yes — prior to us** | yes |
| Wrong-suppression bound | n/a (exact) | exact (syntactic) | none | none (stated as open) | **≤ α for the deployed max-over-candidates statistic** |
| Correct under multiple committed candidates | n/a | n/a | n/a | not analysed | **yes, with a measured budget limit (§8.6)** |
| Escapes are loud, not silent | — | — | no | fork prompt (ACRFence) | **yes (escalation band)** |
| Robust to adversarial paraphrase | n/a | n/a | no | no | **on declared fields only** (witness veto; prose-only distinctions remain judge-dependent, §8.4) |
| Implemented and evaluated | yes | yes | — | attacks evaluated; defence **not implemented** [14] | **yes** |

Three rows carry deliberate qualifications. The problem-identification row is the one that matters most for novelty: **we did not pose this problem first**, and §2 says so at length. Our adversarial guarantee covers exactly the part of an act that the tool schema pins in a typed field; where the distinguishing information lives in free text we offer no defence and measure the resulting failure rate (§8.4). And no row claims exactly-once inside the irreducible commit window, where we perform no better than the content-addressed baseline (§8.7) and where the guarantee is the provider's to give (§6.8).

---

### 2.7 The wider literature, read through the design space

The four axes of §4.3 — identity relation, decision locus, lifecycle point, residual policy — sort a large and fast-moving literature that would otherwise be a list. We survey it here by axis, and state at the outset what this survey is for: **almost every line below assumes an answer to "is this the same act?" and almost none supplies one.** That is the gap, and seeing it requires reading the areas together.

**Durability and recovery: identity by position.** Beyond the industrial systems of §2, a research literature is forming around durable execution for agents specifically. Transactional and isolation-based treatments extend database semantics to agent workflows [4, 18, 19]; shared-log architectures make actions visible and vetoable before execution [16]; machine-checked conformance contracts pin down what "resume" is even supposed to mean [20]; and speculative-execution designs trade re-work against latency under failure [21, 24]. Streaming and revision-oriented execution models ask what it means for an agent's output to be revisable at all [22], while workflow engines are increasingly separated from the reasoning that drives them [23], and rollback frameworks handle stepwise recovery [25]. All of these fix identity **by position or by construction** — a journal offset, a transaction boundary, a log sequence number — which is exactly the assumption a re-synthesising actor violates. Storage and memory costs of keeping such records are themselves now under study [26, 27].

**Authorization and autonomy bounds: identity as a consumption unit.** A second line asks not "did this happen twice?" but "was this permitted, and is the permission used up?" CapLease binds an approval to a canonical action and consumes it transactionally [15]; confused-deputy analyses show capability gates are not authorization [28]; and a governance literature bounds where an agent may act at all [29, 30, 31, 32]. Oversight itself has been modelled as a finite resource with its own calibration problem [33] — directly relevant to our escalation band, since a band that emits more work than a human can absorb is not a safety mechanism. Runtime guardrails [34] and verification frameworks [36] sit here too, as does empirical work on how much users actually trust a plan-then-execute agent and how team performance changes when they do [35]. Every one of these mechanisms is keyed on an identity judgment it inherits rather than establishes; T7 says that inheritance is where their guarantees actually rest.

**Tools and schemas: where the residual comes from.** Our T6 makes the residual a property of the declared schema, which puts tool-definition research on the critical path rather than adjacent to it. Work on tool synchronisation and discovery [37], typed skill graphs [38], tool-selection failure modes [39], tool cloning and impersonation [40], and dependency risk in skill supply chains [41] all shape what a schema pins and therefore how large the residual is. Boundary testing of agent workflows [42] is the closest existing analogue to measuring a residual empirically. We know of no work that treats schema expressiveness as *the* determinant of an identity mechanism's error floor, which is what §4.2 argues it is.

**Adversarial pressure: why the refuter must precede the oracle.** The prompt-injection literature has grown quickly and is now well past demonstrations. Attacks reach agents through navigation [45], robotics [46], browsers [57, 60], compressed context [53], cross-session storage [44], and proxying through other agents [52]; consequences studied include privacy-leakage chains [54] and attacks on reverse-engineering agents [55]; systematic red-teaming is automated [47, 48, 49, 50, 56] and benchmarked [51, 67, 68]. Defences span design patterns [43], guard models [61], rule-based monitors [62], privilege separation [63], polymorphic prompting [64], multi-agent pipelines [65, 66], detector ensembles [58, 59], and small calibrated classifiers [69]. What this body of work establishes, for our purposes, is a negative: **every defence that reads the adversary's text inherits the adversary's leverage.** Our distinctness witness is not a better detector; it is a decision that never reads the text at all, which is why its D4a rate is zero by construction rather than by measurement (§8.4) — and why the residual, where text must be read, is where our own attack results are worst.

**The oracle: judges are biased, promptable, and now measurably so.** Using a model to judge a semantic property is a well-studied practice with well-documented pathologies: position and scoring bias [70, 74, 75], divergence from human judgement [71], preference leakage, contamination and inherited teacher bias [73, 79, 80], judge-specific idiosyncrasy across agreement and consistency [72, 81, 82], and multi-judge aggregation that can amplify rather than cancel bias [76]. Most directly relevant to us, judges are *persuadable*: adversarial persuasion [77] and jailbreak-style manipulation [78] both move judgments. Fine-tuned and preference-optimised judges [83, 84], reference-adapted judging [85], domain-specific judge validation [88, 89], and auditing frameworks [86, 87, 90] improve the picture without closing it. We take this literature as settling the premise our design starts from — **an LLM judge is an uncalibrated, manipulable oracle** — and as the reason we bound it rather than trust it, restrict its jurisdiction with a decidable veto, and treat one judge's numbers as one vendor's idiosyncrasy (§8.8).

**Calibration: conformal methods for language models.** Conformal prediction has been applied to language models along several lines: conformal language modelling and generation [91, 112, 113], factuality guarantees [92, 96, 103], abstention and hallucination mitigation [95], multiple-choice and QA settings [94], RAG context selection [105], interactive querying [106], detection with bounded false positives [107], token-entropy variants [108], agent policy optimisation under cost constraints [104], and multi-turn stopping rules [114]; surveys collect the area [93] and general-purpose treatments address set length [101], group-conditional coverage [102], and empirical-Bayes refinements [109, 110]. Crucially for us, the assumptions are known to be fragile: non-exchangeable generation [98], domain shift [99], unknown subpopulation shift [100], and marginal coverage under-covering a minority class [111] are all documented failure modes — the last being precisely the shape of our §8.4 caveat, where the guarantee lapses under deliberate distribution shift. Conformal treatment of *judges* specifically has begun [97], and uncertainty quantification for agents is being surveyed as its own problem [115, 116, 117]. **What is absent is a conformal treatment whose calibrated object is a control decision with an asymmetric, irreversible consequence** — and, as §6.6 records, getting that object right (the max over a candidate set, not a pairwise score) is critical for statistical correctness.

**Semantic equivalence itself.** The underlying NLP question — when do two texts mean the same thing — has a long history in paraphrase identification [118, 119], semantic textual similarity [120], and textual entailment [121], and a practical one in corpus deduplication [13]. That literature optimises symmetric accuracy on cheap errors. Our setting inverts both premises: the errors are wildly asymmetric, and one of them is unobservable. This is why we do not report accuracy or F1 anywhere in this paper, and why a mechanism that is merely a good similarity model is not a solution.

**What the survey shows.** Read across, the areas are complementary and disjoint in a specific way. Durability research controls *when* an effect settles; authorization research controls *whether* it is permitted; tool research determines *what a schema pins*; injection research establishes *what an adversary can reach*; judge and conformal research characterise *how far an oracle can be trusted*. Effect identity is the primitive they all consume and none defines. Our contribution is to define it as a decomposition — certifier, refuter, residual — and to show that doing so puts a bound where the literature currently has an assumption.

---

### 2.8 The gap: a seam, not a hole

Across the 121 works surveyed, the conclusion is not that effect identity is unstudied. It is that the problem falls in a **seam between two mature literatures**, each of which has half of what a solution needs and neither of which is incentivised to supply the other half. Systems work needs an identity oracle and assumes one; statistics work knows how to bound an oracle but has been applied to predictions rather than to control decisions. The seam is where an irreversible action gets committed twice.

**Where each body of work stops, and why.**

| Body of work | Supplies | Assumes / does not supply | Why it cannot close the gap from where it stands |
|---|---|---|---|
| Durable execution, journaling, recovery [4, 16, 18–27] | *When* an effect settles; deterministic replay; crash-consistent records | Identity **by position or construction** (journal offset, transaction boundary) | Positional identity is exactly what a re-synthesising actor invalidates. The determinism contract these systems enforce is the assumption an LLM violates by design. |
| Idempotency keys [11] | Provider-side at-most-once per token | The token is **client-chosen and syntactic** | Answers "have I seen this token", never "is this the same act". A fresh token for a paraphrased retry is, to the provider, a new action — correctly so. |
| Transactional / concurrency control for agents [4, 6, 19] | Isolation, ordering, compensation, conflict repair | Per-call identity **taken as given** | Their unit of work is the call; two differently-worded calls are two units. Identity is upstream of everything they control. |
| Authorization & autonomy bounds [15, 28–36] | Whether an action is *permitted*; consumption of approvals | An identity judgment to **key the lease on** | CapLease's "canonical action" is a syntactic normal form; the guarantee rests on the state machine, not on the identity decision feeding it. |
| Verified tool calls [5] | Duplicate suppression via **postcondition on world state** | That the effect is **externally observable** | A wire that has left the account is often not queryable. Where observation exists it is stronger evidence than any judge; where it does not, the method is silent. |
| Agent checkpoint-restore [14] | The problem statement, and an LLM analyzer as mitigation | Any **bound on the analyzer's error**; an implementation | States the open problem in its own words — misclassification and adversarial evasion "require further study" — and evaluates the attacks, not the defence. |
| Prompt injection [43–69] | What an adversary can reach and how defences fail | A decision path the adversary **cannot reach at all** | Every defence that reads adversarial text inherits adversarial leverage. Detection quality is a rate; it is never zero. |
| LLM-as-judge [8, 9, 70–90] | Extensive evidence that judges are biased, promptable, persuadable | A **decision rule** that survives those pathologies | This literature characterises the oracle. It does not build a mechanism whose guarantee is independent of the oracle's trustworthiness. |
| Conformal prediction for LMs [1, 2, 10, 91–117] | Distribution-free finite-sample bounds; known failure modes under shift [98–100, 111] | Application to a **control decision with asymmetric irreversible cost** | The calibrated object is almost always a prediction set, a generation, or a factuality claim. Nobody calibrates *suppress-or-execute*. |
| Semantic equivalence, paraphrase, dedup [13, 118–121] | Similarity judgments and benchmarks | **Asymmetric, unobservable loss** | Optimises symmetric accuracy on cheap errors. In our setting one error is catastrophic and silent, so accuracy and F1 are the wrong objectives — we report neither. |

**The gap, stated so it can be checked.** Against the 121 works surveyed, we find **no system that satisfies all four** of the following:

- **G1 — two-sided soundness.** A decidable fragment on which *sameness* is proved (a certifier) **and** a decidable fragment on which *difference* is proved (a refuter). Systems have one or the other implicitly; none names both, and none observes that they are duals rather than variants.
- **G2 — the residual as a first-class object.** An explicit account of what the decidable fragments leave over, whose size is a property of the declaration and not of the model. Without this, "improve the judge" and "improve the schema" look like comparable interventions, and T6 shows they are not.
- **G3 — a bound on the deployed statistic.** A guarantee attached to the decision the system actually makes. This is the subtlest of the four: calibrating a pairwise score and deploying a maximum over a candidate set voids the conformal bound because it does not cover the max statistic actually deployed (§6.6). A reader should treat that as a data point about the difficulty of the gap.
- **G4 — an auditable residual policy, with its cost reported.** What happens to pairs the mechanism cannot settle, and what that policy costs in review load, latency and oracle calls. Every system has a residual policy by default — usually "execute" — and none reports its cost.

**What we close, partially close, and do not close.** Stated plainly, because a gap analysis that concludes "we close everything" is not an analysis.

| | Status | Basis |
|---|---|---|
| **G1** two-sided soundness | **closed** | Certifier/refuter duality (§4.1), sound under A5 / A5′ (T2, P4). The zeros are constructive, not measured. |
| **G2** residual as first-class | **closed** | T6 proves schema-determination, T6.3′ gives the cost of acting on it, and treating the residual as the unit of analysis changed two results in this paper: it fixed a mis-specified calibration pool (§8.3) and it explained a deduplication collapse that would otherwise read as a defect (§8.9). The general claim that declaration-side interventions dominate is still marked as a conjecture in §9.1. |
| **G3** bound on deployed statistic | **closed** | T3 corrected, Monte-Carlo validated, and exercised on live nested candidate sets: at `m` = 50 the uncorrected rule wrongly suppresses 65.0% of held-out distinct units where the corrected rule suppresses none (§8.6). |
| **G4** auditable residual + cost | **partially closed** | Judge calls, escalations, tokens and latency reported per 1,000 dispatches (§8.9); the band's contribution is visible at α=0.01 (8.8% of duplicates flagged rather than escaping) and is empty at α=0.05 on this judge, which we report rather than claim as a benefit. |
| Cross-family generality | **closed for two vendors** | Three judges over two vendors, all at full-corpus coverage (97.4–100%), agree that wrong-suppression stays inside α while deduplication moves twelve points (§8.8). A third vendor remains unmeasured. |
| Independent validation of the ground truth | **partially closed** | Labels are by construction. A preregistered, blinded **model** panel relabels a frozen 154-item subset: α = 0.828, agreement 87.9%, with disagreement concentrated in the residual (§8.16). Independent **human** validation is instrumented and uncollected. |

**Empty cells in the design space — open problems we are not addressing.** These follow from §4.3 and are, we think, the more valuable output of this survey than our own positioning:

1. **Nobody decides identity at the provider.** The commit window (§6.8) is closable only there, and T5 Case A describes what such a provider would need to accept — a paraphrase-invariant, identity-complete key. No deployed payment or messaging API offers one. This is a protocol gap, not a modelling gap.
2. **Nobody uses a refuter to reduce oracle workload.** The witness removes 19% of decisions from the judge before any model call and simultaneously loosens the multiplicity correction on what remains (§5). Treating decidable vetoes as a *cost* mechanism rather than only a safety mechanism appears unexplored.
3. **Schema expressiveness is never measured against an error floor.** T6 makes the residual a function of the declaration, which implies a measurable quantity — "how much of this tool's act is pinned?" — that no tool-definition work [37–42] reports.
4. **Oversight capacity is studied but never connected to band sizing.** Turan [33] models human oversight as a finite, fatiguing resource; escalation bands are sized by α. Nobody closes that loop, and a band that emits more work than the reviewer can absorb is not a safety mechanism.
5. **Conformal methods under adversarial rather than natural shift.** The documented failures [98–100, 111] are distributional; injection is adversarial and targeted. Our §8.4 shows the calibrated layer performing *worse* than the raw judge under attack, which is the expected behaviour and an open problem rather than a solved one.
6. **Identity above the tool schema.** All of this is per-tool. The same intended act reachable through two different tools — a refund via `post_refund` or via `transfer_funds` — is outside every framework here, including ours.

**A caveat on the strength of these claims.** "No system satisfies G1–G4" is a claim about a surveyed set, not a proof of absence. The survey is arXiv-weighted, English-language, and skewed to 2024–2026; classical distributed-systems and database literature on duplicate detection is under-represented, and the paraphrase/entailment tradition predates the indexing our search reached (§2.7). We would expect a determined reader to find precedents for individual components — certifier-like canonicalisation is ancient, and refuter-like guards are folklore. What we have not found, and would want to be shown, is the *combination* under an asymmetric loss with a stated bound.

---

## 3. Problem Formulation

**Notation.** We fix the following throughout.

| Symbol | Meaning |
|---|---|
| `t`, `X_t` | a tool, and its space of input values |
| `r` | logical run identifier, stable across retries and replays |
| `⟦·⟧_t` | denotation: the intended action a dispatch expresses |
| `≈_t`, `≉_t` | ground-truth identity of intended actions, and its complement |
| `κ_t` | canonicalisation under declared field policies; `≡_κ` its induced equality |
| `σ_t` | semantic projection onto declared effect-determining fields |
| `C_t`, `D_t` | the certifier and refuter lattices for `t` (Proposition 1) |
| `Dec_t`, `Res_t` | the decided set and the residual (Definition 6) |
| `J` | the equivalence oracle (a stochastic judge), scores in `[0,1]` |
| `C`, `m` | the surviving candidate set for a dispatch, and its size |
| `S*` | `max_{x' ∈ C} J(t, x, x')`, the statistic the fence thresholds |
| `t_hi(m)`, `t_lo` | suppression threshold at candidate-set size `m`; escalation floor |
| `α`, `γ` | target wrong-suppression level; unflagged-escape level |
| `n` | calibration pool size (distinct-pair scores) |
| WS, dedup | wrong-suppression rate; `P(SUPPRESS \| duplicate)` |

### 3.1 System model

A **logical run** has a stable identifier `r ∈ RunId`, chosen by the application (an order id, job id) and reused across every retry, crash, and replay. An agent driven by an LLM emits, within a run, a finite sequence of **tool calls** — the reason-and-act loop of ReAct [7] and its descendants. A tool call is a pair `c = (t, x)` where `t ∈ Tools` and `x` is a structured input value drawn from a space `X_t`.

Each tool `t` has an **effect function** `eff_t : X_t → Ω`, where `Ω` is the space of world states, modelled as a state transformer on an external world `w ∈ World`. Tools are classified:

- **IRREVERSIBLE** — `eff_t` is not transparently invertible (charge, wire, email, POST). Applying it twice for one intended action is a defect.
- **IDEMPOTENT** — `eff_t ∘ eff_t = eff_t` on the observable world. Duplicates are harmless.

We treat only IRREVERSIBLE tools; idempotent tools pass through unfenced.

**Actions vs. dispatches.** The crux of the problem is that one *intended action* in the world can be denoted by *many distinct inputs*. We model this explicitly. Let `A_t` be the (unobservable) space of **intended actions** for tool `t` — e.g. "wire \$780 to Marlow Freight for shipment 88213." Each dispatch carries a hidden intended action via a **denotation** `⟦·⟧_t : X_t → A_t`; the agent, and any adversary, control the *input* `x` but the *denotation* is fixed by the world's semantics. Two inputs are **the same effect** iff they denote the same intended action:

> **Definition 1 (Ground-truth identity).** `x ≈_t x'` iff `⟦x⟧_t = ⟦x'⟧_t`.

`≈_t` is an equivalence relation. It is the thing we must decide and cannot observe directly; a *judge* is an estimator of it.

**On what Definition 1 does and does not settle.** As stated, Definition 1 is denotational rather than operational: it reduces sameness of effect to equality of an unanalysed semantic primitive `⟦·⟧_t`, and a careful reader is entitled to ask what fixes `⟦·⟧_t` beyond the paper's own intuition. We do not derive `A_t` and `⟦·⟧_t` from anything more basic — doing so is a general problem in the semantics of natural-language reference that this paper does not attempt to solve, and treating denotation as a primitive is standard practice one level up from where formal semantics stops and world-knowledge begins. What we owe a reader instead is the **operational criterion** that turns the primitive into a checkable test, because it is this criterion — not Definition 1 verbatim — that the corpus construction (§7.1) and the annotation instructions (§7.4) actually apply:

> **Operational test.** `x ≈_t x'` counts as SAME iff, were the fence to observe `x` after having already committed `x'` and silently return `x'`'s recorded response without dispatching `x`, nothing that the world was owed would fail to happen — no distinct payment, message, or record goes unsent because of the substitution. It counts as DIFFERENT iff that substitution would drop something owed.

This is a counterfactual criterion, not a further reduction of `⟦·⟧_t` to something more primitive — it is the same relation restated in the vocabulary the loss function of §3.3 already uses (a wrong suppression is exactly a case where the substitution drops something owed), which is why it is checkable by a human reader with no access to `A_t` and is what we in fact hand to annotators (§7.4) rather than the notation above. The corpus's *constructed* labels (§7.1) satisfy it by fiat — a SAME pair is generated so the substitution is provably harmless (identical referenced amounts, recipients, and referenced records after validation), a DIFF pair by construction changes one of them — which is exactly the sense in which those labels are an operationalisation of Definition 1 rather than an independent measurement of it, and exactly why §7.4's human study, applying the same operational test to a reader with no knowledge of the construction, is the check the paper cannot supply from its own definitions alone.

An **execution** of a run is the sequence of dispatches actually made. Because the agent is non-deterministic, two executions of the same run (an original and a post-crash replay) may differ arbitrarily — in length, order, *and in the surface form of the inputs they dispatch*. We assume **no positional alignment** and, crucially, **no syntactic stability of inputs** across executions.

### 3.2 Threat model

We consider three sources of duplication, and one adversary.

- **Benign retry / crash / replay.** A client, queue, or orchestrator re-invokes the run under the same `runId`; or the process dies at an arbitrary point (including between an effect committing externally and the fence recording it) and a fresh process replays. The replay may **paraphrase** inputs (§1.2) because it is regenerated by the model.

- **Adversary (prompt injection).** Untrusted content reaching the agent's context (a tool result, a retrieved document, a user-supplied field) may contain instructions aimed at the fence's judge. The adversary's goals are dual: (i) **forced suppression** — cause a *distinct* irreversible action to be judged a duplicate and silently dropped (e.g. cancel a legitimate second wire, or suppress a refund); (ii) **forced execution** — cause a true duplicate to be judged distinct and fire twice. The adversary controls input *text* but not the declared field *semantics* enforced by the tool schema (a wire's amount field is a number; injection text lives in free-text fields), and not the durable log.

We assume durable storage with atomic insert-if-absent under a uniqueness constraint (a standard RDBMS or a crash-consistent file). We do **not** assume reliable networks or the ability to retract an effect an external API has accepted.

### 3.3 What a fence does, and the two errors

A **fence** is a function that, given a candidate dispatch `(t, x)` and the durable set `C_{r,t}` of already-committed effects for `(r, t)`, returns a decision in `{SUPPRESS, ESCALATE, EXECUTE}`. SUPPRESS returns a committed effect's recorded response without re-executing; EXECUTE performs `eff_t(x)` and commits it; ESCALATE executes **and** durably flags the dispatch as a suspected duplicate.

Fix a run and tool. Over the population of candidate dispatches paired with the committed set, define the two error functionals:

> **Definition 2 (Wrong-suppression).** `WS = P( decision = SUPPRESS ∧ x is NOT ≈_t any committed effect )` — a distinct action silently dropped.

> **Definition 3 (Duplicate-escape).** `DE = P( decision ∈ {EXECUTE, ESCALATE} ∧ x ≈_t some committed effect )`, split into **silent escape** (EXECUTE) and **flagged escape** (ESCALATE).

The design goal is a *strict priority*: drive `WS` below a chosen, small α (it is undetectable and catastrophic), and among mechanisms meeting that bound, minimise **silent** escape (flagged escapes are recoverable by reconciliation). Formally the objective is

```
minimise  P(EXECUTE ∧ duplicate)      subject to   WS ≤ α.
```

We also track **dedup** `= P(SUPPRESS | duplicate)` (the benefit) and **friction** `= P(ESCALATE | distinct)` (the cost of escalating genuine distinct actions).

### 3.4 Correctness properties

For a fixed run `r` and effect identity, across all executions:

- **(P1) At-most-once commitment.** For inputs the fence recognises as identical, and for dispatches serialised per identity (A7, §6.3), the real effect commits at most once; without that serialisation, at most one *commit row* exists and concurrent duplicates are made observable rather than prevented.
- **(P2) Bounded wrong-suppression.** `WS ≤ α` for a declared α, distribution-free in the score and finite-sample, under the exchangeability assumption stated in §6.6 — and stated there for the **maximum over the candidate set**, which is the statistic the fence thresholds, rather than for a single pairwise comparison.
- **(P3) No silent escape by design where avoidable.** Any duplicate the semantic layer *suspects* but does not suppress is executed **and durably flagged** (ESCALATE), never dropped from the audit trail.
- **(P4) Adversarial soundness of the core.** No judge output — however manipulated — can cause suppression across a declared effect-determining difference (the distinctness witness, §5.4).

---

## 4. Effect-Identity Framework

### 4.1 Certifiers, refuters, and the residual

The mechanisms in this literature — content addressing, idempotency keys, canonical actions, LLM analyzers — are usually presented as competing designs. They are better understood as different *positions in one lattice*, and once they are placed there the design space, its empty cells, and its hard limits all become visible. This subsection defines that lattice; it is the paper's central abstraction and everything later is an instance of it.

Fix a tool `t`. Ground-truth identity `≈_t` (Definition 1) is an equivalence relation on `X_t` that no procedure observes. A mechanism instead computes some *decidable* relation and uses it as a proxy. Two dual notions of correctness apply, and conflating them is the source of most of the confusion in this area.

> **Definition 4 (certifier).** A relation `C ⊆ X_t × X_t` is a **certifier** if `C ⊆ ≈_t`: whenever `C(x, x')` holds, the two dispatches *provably* denote the same act. A certifier may be arbitrarily incomplete; what it may never do is claim identity falsely.
>
> **Definition 5 (refuter).** A relation `D ⊆ X_t × X_t` is a **refuter** if `D ∩ ≈_t = ∅`: whenever `D(x, x')` holds, the two dispatches *provably* denote different acts. A refuter may be arbitrarily incomplete; what it may never do is claim difference falsely.

Certifiers and refuters are duals, and neither is a weakened version of the other. A certifier licenses **suppression**; a refuter licenses **execution**. Each is one-sided: a certifier that fails to fire says nothing about difference, and a refuter that fails to fire says nothing about sameness.

The relations this paper uses instantiate the pair:

| Relation | Kind | Decidable? | Sound under | Role |
|---|---|---|---|---|
| `≡_exact` — byte equality | certifier | yes | — (trivially) | the naïve baseline |
| `≡_κ` — canonical equality | certifier | yes | A5 | L0; licenses suppression |
| `≉_σ` — projection difference | **refuter** | yes | A5′ | the distinctness witness; licenses execution |
| `J > τ` — judge score | **neither** | yes (a model call) | nothing | must be calibrated, never trusted |
| `≈_t` — ground truth | — | **no** | — | the target |

Certifiers are ordered by strength: `≡_exact ⊆ ≡_κ ⊆ ≈_t`. Enriching the normalisation policy moves `≡_κ` up this chain, capturing more true identities without ever admitting a false one — *provided* the enrichment remains semantics-preserving, which is precisely what A5 obliges the schema author to guarantee. Refuters are ordered dually. The two families approach `≈_t` from opposite sides and, in general, do not meet.

The structure is not merely a chain, and saying so precisely is what licenses the results in §4.2.

> **Proposition 1 (lattice structure).** Fix a tool `t` and order relations on `X_t × X_t` by inclusion. Then:
>
> 1. The certifiers form a bounded lattice `(C_t, ⊆)` with join `∪`, meet `∩`, least element `∅` and greatest element `≈_t`.
> 2. The refuters form a bounded lattice `(D_t, ⊆)` with the same operations, least element `∅` and greatest element `≉_t` (the complement of `≈_t`).
> 3. Each family is closed under *finite* unions of decidable members: a schema author who has assembled a finite collection of sound decidable certifiers may take their union as a single, still-decidable, still-sound certifier, and dually for refuters. We write `κ*_t` and `σ*_t` for the union of whichever finite family a given declaration supplies, not for a supremum over all decidable certifiers whatsoever.
> 4. `C_t` and `D_t` intersect only in `∅`.

*Proof.* (1) If `C₁, C₂ ⊆ ≈_t` then `C₁ ∪ C₂ ⊆ ≈_t` and `C₁ ∩ C₂ ⊆ ≈_t`, so `C_t` is closed under both operations; `∅` and `≈_t` are members and bound it. Associativity, commutativity and absorption are inherited from the powerset lattice, so `C_t` is a sublattice of `(P(X_t × X_t), ⊆)`. (2) is identical with `≉_t` in place of `≈_t`. (3) Set-theoretic closure of `C_t` under *arbitrary* union follows from (1) exactly as before, but decidability does not transfer to arbitrary unions: a countable union of decidable relations need not itself be decidable, so "the union of every decidable certifier" is not, in general, a decidable object, and the proposition does not claim it is. What transfers is the finite case: decision procedures for `C₁,…,C_k` compose into a decision procedure for `C₁ ∪ … ∪ C_k` by running all `k` and taking OR, so a finite union of decidable certifiers is again a decidable certifier. This finite fact is the only closure property used anywhere else in the paper. (4) A relation in both would satisfy `R ⊆ ≈_t` and `R ∩ ≈_t = ∅`, forcing `R = ∅`. ∎

Three consequences are worth drawing out, because they are what make the decomposition of §4.2 well-posed rather than merely suggestive. First, **combining sound mechanisms is always safe**: by finite closure under union, any decidable certifiers a schema declares may be run in parallel and their disjunction is still a decidable certifier, so a system may accumulate proofs of sameness without re-arguing soundness. The same holds for refuters. Second, **the resulting union is the right object to reason about for a fixed, finite declaration**: `κ*_t` and `σ*_t` denote the union of whatever finite family of decidable certifiers (respectively refuters) a given schema actually supplies. L0's canonical equality is, in every deployment in this paper, the only certifier declared, so `κ*_t = ≡_κ` throughout, and the residual of §4.2 is defined relative to this finite, declared union rather than to an unbounded supremum. Third, **no mechanism is both**: by (4), a procedure cannot prove sameness and difference on the same pair, so certifier and refuter are genuinely distinct roles and a design must supply each separately. This last point is where the literature of §2.8 divides: every surveyed system supplies one of the two, and the choice of which is usually implicit.

We note two limits of the formalism, not one. Proposition 1 gives no procedure for finding the best decidable certifier a tool specification *could* support — constructing `κ*_t` and `σ*_t` from a tool specification, equivalently deciding how much of an act a schema pins, is the inference problem we identify as open in §9.3 and do not solve. But there is a prior limit the "no procedure" framing can obscure: for an *unbounded* or infinitely-growing family of decidable certifiers, the union is not even guaranteed to remain decidable, so "the maximal decidable certifier" is not a well-defined object in general — only a finite, declared family is guaranteed to compose into one. Every certifier and refuter this paper actually uses (§5) is a single, fixed, finite construction, so the gap does not bite on anything reported in §8; we flag it because a reader extending this framework to a schema that accumulates decidable checks without bound would need to re-establish decidability at each step rather than assume it survives the union.

> **Definition 6 (decided set and residual).** For a schema declaring `κ_t` and `σ_t`, the **decided set** is `Dec_t = ≡_κ ∪ ≉_σ` — the pairs settled with a proof, by a procedure that consults no model. The **residual** is its complement,
>
> ```
> Res_t  =  { (x, x')  :  κ_t(x) ≠ κ_t(x')  ∧  σ_t(x) = σ_t(x') }
> ```
>
> — dispatches that differ after canonicalisation yet agree on every declared effect-determining field.

The residual is where this paper's difficulty lives, and naming it is what lets us say something general. Everything in `Dec_t` is settled exactly and for free. Everything in `Res_t` is a pair the schema *cannot distinguish*, so a decision there is a claim about meaning that some fallible oracle must make.

### 4.2 What the residual determines, and what it does not

The residual has a property that we think is the single most useful consequence of setting the problem up this way.

> **Theorem T6 (residual determination).** `Res_t` is a function of the declared schema alone. It does not depend on the judge, on the actor that generates dispatches, on the adversary, or on any run-time observation. Consequently:
>
> 1. **No model changes the residual.** A better, larger, or ensembled judge redistributes decisions *within* `Res_t`; it cannot move a pair out of it.
> 2. **Every non-provable error lies in the residual.** Any wrong suppression or wrong execution that a sound mechanism commits — one whose certifier and refuter are sound under A5 and A5′ — is a pair in `Res_t`.
> 3. **Refining the declaration shrinks it monotonically.** If `κ'` refines `κ` and `σ'` refines `σ` (both remaining sound), then `Res'_t ⊆ Res_t`.

*Proof.* (1) is immediate: the defining condition mentions only `κ_t` and `σ_t`. (2): if a pair is in `≡_κ` the mechanism suppresses and, by A5, correctly; if it is in `≉_σ` it executes and, by A5′, correctly; so any error is outside `Dec_t`. (3): a finer `σ'` distinguishes at least the pairs `σ` distinguishes, so `≉_σ ⊆ ≉_σ'`, and dually for `κ`; the complement therefore shrinks. ∎

Two corollaries are worth stating because they are the results a practitioner would act on.

> **Corollary T6.1 (limit of model scaling).** For a fixed schema, the set of pairs on which *any* mechanism can be wrong is fixed. Improving the oracle is a redistribution of error inside `Res_t`, subject to T4: while the score distributions overlap on `Res_t`, no threshold rule drives both error directions to zero. **Model quality trades one error for the other; schema quality removes both.**

> **Corollary T6.2 (schema-first, model-second).** On the fragment it decides, the only intervention that strictly dominates — reducing wrong suppression, wrong execution, oracle cost and adversarial exposure simultaneously — is moving act-determining information from free text into declared fields, because that alone shrinks `Res_t`.

This gives a design heuristic the status of a theorem, and it explains an experimental result that would otherwise look like a coincidence: in §8.9 the tightened schema drives an entire injection class to zero *by construction* and removes a sixth of the oracle's workload, while every oracle-side intervention we tried trades one axis against another. What T6 actually proves is narrower than "the only shape the trade can take": it establishes that *within the two intervention classes this paper's framework distinguishes* — changing the oracle, and changing the declaration — the first can only redistribute error inside `Res_t` (T6.1) while the second is the only lever that shrinks `Res_t` itself (T6.3). It does not rule out some third kind of intervention, outside the oracle/declaration dichotomy this decomposition draws, that might also dominate; we have not found one; §9.1 states the resulting pattern as a falsifiable prediction rather than as a corollary of T6 for exactly this reason, and that is the more careful of the two claims.

The qualification "on the fragment it decides" is doing real work, and we add a corollary for it because our own experiments contradicted the unqualified reading.

> **Corollary T6.3′ (the refinement dilemma).** The calibration pool for the residual layer is itself drawn from `Res_t`. Refining the declaration shrinks `Res_t` (T6.3) and therefore shrinks the pool. By the certifiable-`m` formula of §6.6 (`m ≤ α(n+1)`), a smaller pool `n` admits a smaller or equal certifiable `m`, forcing `t_hi = +∞` — no semantic suppression — once refinement pushes `m` past what the shrunken pool can certify. Refinement strictly dominates on the decided fragment and strictly degrades the undecided one; whether the net effect is favourable depends on how much of the residual it decides and on whether the pool can be replenished.

Two precisions on what is and is not proved here. First, the certifiable-`m` clause is exact — it follows from the threshold construction, not from an empirical tendency. What is *not* a theorem is that a smaller pool must in general produce a numerically larger finite threshold: for a fixed `m` still within budget, `t_hi` is an order statistic of whatever scores the pool happens to contain, and a smaller sample is not guaranteed to have a higher top value than a larger one on any particular draw — only the *typical* direction is upward, because a smaller `n` pushes the required index toward a higher percentile of the sample. Second, and sharpened by §8.15's finding on the schema-richness ladder: pool *size* is not the only lever. A pool of any size whose top-ranked scores come from a mutation class the judge scores confidently high — for whatever reason, correctly or not — pins `t_hi` near or at that ceiling regardless of how many such pairs it contains, which is a *composition* effect the certifiable-`m` formula does not capture and replenishment does not fix unless the added pairs are drawn from a difficulty distribution that matches the residual under test. The dilemma is therefore at least two distinct mechanisms wearing one name: a hard sample-size budget, exact and provable, and a softer composition effect, empirical and dependent on what the residual's hardest pairs look like.

The two clauses are the same mechanism seen from opposite ends, which is why the dilemma is structural rather than an artefact of our tool surface. §8.9 measures it: tightening one tool's declaration closes the D4b attack class outright and drops the calibration pool from 117 pairs to 35, at which point the conformal threshold becomes the pool maximum and deduplication falls from 94.0% to 19.9%. A practitioner following T6.2 without T6.3′ would tighten a schema, watch deduplication collapse, and blame the judge.

It also delimits the claim. T6 says nothing about how *large* the residual is for a given tool — that is an empirical property of a schema, and on our deliberately loose-schema tool it is large. Nor does it say the residual is harmless: our worst results (D2 wrong-suppression, D4b injection) are exactly residual pairs. What it says is where to look.

### 4.3 A design space, and where the literature sits

With certifiers, refuters and the residual named, the mechanisms in §2 stop being alternatives and become choices along four axes:

1. **Identity relation** — what proxy for `≈_t` is computed: byte equality, canonical form, projection, model judgment, observed world state.
2. **Decision locus** — who decides: the client, the runtime, the provider, or a human.
3. **Lifecycle point** — when: before dispatch (prevention), after dispatch (detection), or after commitment (compensation).
4. **Residual policy** — what happens to pairs the relation cannot settle: execute, suppress, escalate, or refuse.

| System | Identity relation | Locus | Lifecycle point | Residual policy |
|---|---|---|---|---|
| Idempotency keys [11] | client-chosen token (`≡_exact` on the token) | provider | prevention | execute (a fresh token is a fresh act) |
| Durable execution [12] | position in a journal | runtime | prevention | n/a — determinism contract forbids a residual |
| Content-addressed fencing | `≡_κ` (certifier) | runtime | prevention | execute |
| Verified tool calls [5] | postcondition on world state | runtime + world | detection before retry | execute if unobservable |
| Atomix [4] | per-call, within a transaction | runtime | commitment / compensation | buffer or compensate |
| CapLease [15] | canonical action bound to an authorization | runtime | prevention | refuse (consume the lease) |
| ACRFence [14] | LLM analyzer verdict | runtime | prevention on restore | fork after human prompt |
| **This work** | `≡_κ` ∪ `≉_σ` ∪ calibrated `J` | runtime | prevention + detection | **escalate (execute + durable flag)** |

Read this way, several things become clear that a list of related work does not show. Every prior system either has *no* residual policy (because its identity relation is total by fiat, like a journal position or a client token) or resolves the residual by a single unbounded judgment. **No prior system separates a sound certifier from a sound refuter and treats what remains as a calibrated decision** — which is the gap this paper occupies, and also the reason its guarantees are stated as a triple rather than a single property.

The empty cells are as informative as the full ones. Nothing in this table decides identity at the **provider**, where the commit window could actually be closed (T5 Case A is a proposal, not a deployed system). Nothing uses a refuter to *reduce the oracle's workload*, which is what makes the calibrated layer affordable here. And no system reports what its residual policy costs.

### 4.4 Beyond duplication: the hazard family this belongs to

Duplicated effects are one member of a family of replay hazards, and the framework above covers a specific slice of it. We set out the family so that the paper's scope is legible and so that the parts it does not address are named rather than implied.

| Hazard | Failure | Governed by | Addressed here |
|---|---|---|---|
| **Duplication** | one intended act commits twice | identity recognition + at-most-once | **yes** |
| **Omission** | a distinct act is suppressed as a duplicate | identity recognition (the dual error) | **yes** — it is our safety-critical rate |
| **Authorization over-consumption** | one approval consumed by many acts | identity + a consumption counter | partially; CapLease [15] is the dedicated treatment |
| **Rollback resurrection** | a consumed credential or effect revived by restore | identity + monotonic state | no; ACRFence [14] |
| **Reordering** | acts commit in an order the plan forbids | ordering constraints, not identity | no |
| **Partial / torn effects** | a multi-step act commits in fragments | transactions | no; Atomix [4] |
| **Phantom effects** | an effect lands with no local record at all | the commit window | detected, not prevented (T5) |

Identity is the primitive under the first three rows: none of duplication, omission or over-consumption can even be *stated* without an answer to "is this the same act?". That is the sense in which we regard effect identity as foundational to the others rather than parallel to them — and it is also why an unbounded identity oracle contaminates every mechanism built on top of it, which is the observation that motivated this paper.

---

## 5. Proposed Fence

§4 is the general account: a certifier, a refuter, and a calibrated residual. This section instantiates it for one concrete setting — irreversible tool calls whose arguments a language model may paraphrase on retry — and everything below is a *choice* within the framework rather than part of it. A different deployment with a different schema, a different oracle, or a different loss asymmetry would make different choices and still be an instance of §4.

The instantiation fixes: the certifier as canonical equality `≡_κ` under declared field policies; the refuter as projection difference `≉_σ` over declared non-text fields; the oracle as an LLM equivalence judge; the calibration as one-sided split-conformal on the safety-critical direction; and the residual policy as a three-way rule with an auditable middle band. The control flow — in particular the order in which certifier, refuter and oracle are consulted — is as much the contribution as any single layer, so we give it first:

```
                        candidate tool call (t, x)
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  deterministic canonical core │   L0 — decidable, judge-free
                    │        op = H(r‖t‖H(κ_t(x)))  │
                    └───────────────┬───────────────┘
                                    │  exact match in committed log?
                          ┌─────────┴─────────┐
                        yes                   no
                          │                   │
                    ┌─────▼─────┐             ▼
                    │ SUPPRESS  │   ┌───────────────────────┐
                    │ (WS = 0,  │   │  semantic projection  │
                    │   T2)     │   │        σ_t(x)         │
                    └───────────┘   └───────────┬───────────┘
                                                │  for each committed candidate
                                                ▼
                                    ┌───────────────────────┐
                                    │ DISTINCTNESS WITNESS  │  decidable veto (A5′)
                                    │   σ_t(x) ≠ σ_t(x') ?  │
                                    └───────────┬───────────┘
                                    ┌───────────┴───────────┐
                            definitely different      same projection
                                    │                       │
                              ┌─────▼─────┐                 ▼
                              │  EXECUTE  │      ┌──────────────────────┐
                              │ (no judge │      │   semantic judge J   │   L1 — stochastic
                              │  consulted)│     │  m surviving cands   │
                              └───────────┘      └──────────┬───────────┘
                                                            │  S* = max over candidates
                                                            ▼
                                            ┌───────────────────────────────┐
                                            │  conformal threshold t_hi(m)  │  corrected for
                                            │       (α/m, Theorem T3)       │  multiplicity
                                            └───────────────┬───────────────┘
                                        ┌───────────────────┼───────────────────┐
                                  S* > t_hi(m)      t_lo < S* ≤ t_hi(m)     S* ≤ t_lo
                                        │                   │                   │
                                  ┌─────▼─────┐       ┌─────▼─────┐       ┌─────▼─────┐
                                  │ SUPPRESS  │       │ ESCALATE  │       │  EXECUTE  │
                                  │  WS ≤ α   │       │ execute + │       │           │
                                  │           │       │ flag (L2) │       │           │
                                  └───────────┘       └───────────┘       └───────────┘
```

Two properties of this ordering carry the design. First, **the witness runs before the judge, not after it**: a candidate whose declared fields differ is removed from the judge's jurisdiction entirely, so no judge output — however manipulated — participates in that decision. Second, **the witness shrinks `m`**, and because the corrected threshold is `t_hi(m)` at level `α/m` (§6.6), every candidate the witness removes also loosens the multiplicity correction on the ones that remain. The veto is thus not only a safety device but the mechanism that keeps the calibrated layer usable at all.

The witness is **deterministic** (a canonical-value comparison), **judge-independent** (computed without a model call), **adversarially robust** (an attacker controlling free text cannot change a declared field's canonical value), and derived entirely from **declared effect-determining fields**. We state the resulting principle as bluntly as we can:

> **Schema-first, model-second.** Decide identity from what the schema pins wherever the schema pins it; consult a model only for the residue, and only under a calibrated bound.

We do **not** claim this solves adversarial paraphrase. It reduces adversarial paraphrase to schema design, exactly and measurably: whatever the tool author leaves in free text stays in the judge's jurisdiction, remains judge-dependent, and is where our attack results are worst (§8.4). §8.9 measures what happens when the same tool is re-declared with those fields typed.

### 5.1 L0 — the decidable canonical core

Each tool schema declares, per field, a **normalisation policy** π that is *semantics-preserving for that field's contribution to `eff_t`* (Assumption A5, §6.3): the tool is documented to treat the raw and normalised forms identically. Policies used here:

- `id` — opaque identifier: Unicode NFC + trim, **case-sensitive**.
- `ci` — case-insensitive token (currency code, email, enum): NFC + trim + lowercase.
- `num` — numeric value: `"120.00"`, `" 120 "`, `120.0`, `120` all normalise to one canonical decimal; thousands separators stripped.
- `text` — free text: NFC + trim + internal-whitespace collapse. Deliberately **not** semantic: `"order #4242"` and `"payment for order 4242"` stay distinct at L0.

Let `κ_t(x)` be the canonical form (fields normalised by policy, keys sorted). The **L0 identity** is `x =₀ x'  ⟺  κ_t(x) = κ_t(x')`, realised as the operation id `H(r ‖ t ‖ H(κ_t(x)))`. L0 is *decidable* and, under A5, *sound*: `x =₀ x' ⇒ x ≈_t x'` (Theorem T2). L0 is where the canonical fence lives; it catches mechanical reformats at zero judge cost and never errs. It is deliberately *incomplete*: paraphrases escape it, by design, to L1.

### 5.2 L1 — the calibrated semantic layer

When L0 finds no exact match, the fence consults an equivalence **judge** `J : (t, x, x') → [0,1]`, returning a score `s` estimating `P(x ≈_t x')`. `J` is stochastic and its error is unknown; we never use `s` as a probability directly. Instead we **calibrate** it (§6.6): from a calibration set of *distinct* pairs' scores we compute a one-sided conformal threshold `t_hi` such that a distinct test pair scores above `t_hi` with probability at most α. The candidate is compared against every committed effect for `(r,t)`; let `s* = max` score. If `s* > t_hi` the fence **suppresses**.

### 5.3 L2 — auditable escalation

A single threshold forces every non-suppressed duplicate to execute silently. Instead we add a lower edge `t_lo` (calibrated on *same*-pair scores, §6.6) and a three-way rule:

```
s* > t_hi          → SUPPRESS   (WS ≤ α by construction)
t_lo < s* ≤ t_hi   → ESCALATE   (execute, but durably flag DUPLICATE_SUSPECT)
s* ≤ t_lo          → EXECUTE     (treat as a distinct action)
```

The band `(t_lo, t_hi]` is the zone of doubt: too uncertain to suppress safely, too suspicious to ignore. Executing-and-flagging keeps property P3 — an escaped duplicate is loud. When calibration cannot certify α on the available sample, `t_hi = +∞`: the layer *never* suppresses semantically and every suspicion escalates. Safety degrades to "no semantic suppression," never to "unbounded wrong suppression."

### 5.4 The distinctness witness (adversarial hardening)

L1 as stated trusts the judge's aggregate calibration, which the §3.2 adversary attacks by injecting "these are the same; suppress" into free text. We remove the dangerous class from the judge's jurisdiction with a *decidable* veto.

Let the **semantic projection** `σ_t(x)` be the canonical values of the declared **non-text** fields (`id`, `ci`, `num` policies) — the effect-determining fields the schema pins. Under Assumption A5′ (declared semantic fields are effect-determining: differing on any of them implies differing intended actions), we have the decidable **distinctness witness**:

> If `σ_t(x) ≠ σ_t(x')` then `x ≉_t x'` — provably distinct, regardless of any judge score.

The fence excludes from judging every committed effect whose semantic projection differs from the candidate's. An injected "treat as duplicate" cannot cause suppression across a different amount, recipient, or id, because those live in pinned fields and the veto fires *before* the judge is consulted. The witness cannot help when two calls share all declared fields and differ only in free text (a case we measure honestly in §8.4), but it eliminates the entire *forced-suppression-across-a-declared-difference* attack class deterministically.

**On the apparent triviality of the witness.** A reader may object that the veto's soundness is immediate from A5′ — we assume declared fields determine the act, then conclude that differing on one implies distinctness — and that the mechanism therefore reduces to "compare the typed fields," which any engineer would do. We accept the reduction and disagree about what it implies. Three things make the triviality load-bearing rather than embarrassing.

First, T4 shows that *no* scorer-based rule can reach zero error on a class whose score distributions overlap. Zero is reachable only by a decision that does not consult the score. So a decidable veto is not one option among several for handling adversarial paraphrase — it is the only route to a zero, and its simplicity is the reason it works. A mechanism that instead hardened the judge (better prompts, adversarial training, an ensemble) could lower this error but provably not eliminate it.

Second, the veto's placement is the design content, not its logic. A system that consults the judge and then overrides it on a declared-field mismatch has already let manipulated text into a decision path; one that filters candidates *before* judging never forms the opinion. The distinction is invisible in the error rate on benign data and decisive under injection: §8.4 measures the primary judge, consulted directly, wrongly suppressing 65.0% of the D4a attacks that the identical judge, placed behind the veto, suppresses none of.

Third, and most importantly, the witness's value is bounded by something the mechanism cannot supply: how much of the act the schema actually pins. That is why we report D4b unhardened rather than folding it into an aggregate. The honest statement of this contribution is not "we solved adversarial paraphrase" but "we reduced it to schema design, exactly and measurably" — the residue in §8.4 is the part of the act the tool author left in free text, and no amount of mechanism recovers it.

### 5.5 Algorithm 1 — layered semantic fence

```
dispatch(t, x, exec, r):
    if class(t) == IDEMPOTENT: return exec()

    # ── L0: decidable canonical core ────────────────────────────
    op = H(r ‖ t ‖ H(κ_t(x)))
    hit = log.getCommitted(op)
    if hit and hit.inputHash == H(κ_t(x)):
        log.intent(op, SUPPRESSED, layer=L0);  return hit.response

    # ── L1/L2: calibrated semantic layer with witness veto ──────
    cands = log.listCommitted(r, t)
    cands = [c for c in cands if σ_t(c.input) == σ_t(x)]      # distinctness witness (A5′)
    if cands:
        s* , c* = max((J(t, c.input, x), c) for c in cands)
        if   s* >  t_hi:  log.intent(op, SUPPRESSED, layer=L1, match=c*); return c*.response
        elif s* >  t_lo:  log.flag(op, DUPLICATE_SUSPECT, suspect=c*, score=s*)   # fall through to execute

    # ── Execute as a new effect ─────────────────────────────────
    log.intent(op, PENDING)
    resp = exec()                       #   <-- irreducible commit window (see T1 remark)
    inserted = log.putCommitted(op, H(κ_t(x)), σ_t(x), x, resp)   # atomic insert-if-absent
    log.intent(op, inserted ? COMMITTED : COMMIT_CONFLICT)
    return resp
```

L0 and the witness are decidable and judge-free; the judge is consulted only for candidates that survive the witness and miss L0 — **73.5%** of test decisions in our data (§8.10), the remaining 26.5% being settled by the decidable layers, and only 56.5% under the tightened schema of §8.9.

Note the two places `m` enters. The witness *shrinks* the candidate set before any model call, and the surviving `m` then sets the multiplicity correction `t_hi(m)` at level `α/m` (§6.6). A candidate the witness removes therefore costs nothing, risks nothing, and loosens the threshold applied to the candidates that remain.

---

## 6. Theoretical Analysis

### 6.1 Three guarantees, deliberately not one

The phrase "exactly-once" hides three separate claims that fail independently, and much of the confusion in this area comes from stating them as one. We name them and keep them apart everywhere below.

> **(A) Identity recognition.** Did the mechanism correctly decide whether the candidate dispatch and a committed effect denote the same intended action? This is a *statistical* property of a decision procedure that consults a stochastic judge. It is governed by T2 (the decidable fragment, exact), T3 (the calibrated fragment, bounded), and T4 (the fragment where no bound of both kinds is achievable).
>
> **(B) Fence-level at-most-once commitment.** *Given* that identity was recognised correctly, and given the scheduling and storage assumptions, does the local fence commit the effect at most once? This is a *systems* property of an execute-then-record scheme with a uniqueness constraint. It is governed by T1, and it is false without the serialisation assumption A7.
>
> **(C) External exactly-once.** Does the *provider* apply the effect exactly once, including when the process dies between the external call landing and the local commit row being written? This is a property of the **provider's** contract, not of our mechanism. It is governed by T5, and our mechanism cannot supply it alone.

The separation is not pedantry. A mechanism can be perfect at (A) and (B) and still double-charge, because the failure in (C) happens in a window during which no local code is running at all. Our crash experiment reproduces this directly: inside the execute-before-record window the semantic fence double-fires in 11 of 12 trials, exactly as T1's remark predicts, and no better than the syntactic baseline it otherwise beats (§8.7). **The irreducible execute-before-record window cannot be closed locally.** What closes it is an external idempotency contract, and T5 states precisely what that contract must provide — which, as §6.8 now makes explicit, is strictly more than the distinctness witness alone can supply.

We keep these labels attached to every claim: an unqualified "exactly-once" appears nowhere in this paper.

### 6.2 What these results are, and are not

We label the five results T1–T5 for reference, but they are not of uniform depth and it would be misleading to present them as though they were. T1 (at-most-once) and T5 (composition with a provider key) are the standard uniqueness-constraint arguments of any execute-then-record scheme, restated for a fence whose identity relation is not equality. T2 (L0 soundness) follows in two lines once A5 is granted — its entire content is in the assumption, which is why §6.3 is careful about what A5 obliges a schema author to guarantee. T4 is a short support-separation argument.

T3 carries the most weight. Split-conformal calibration is standard, but the object it is applied to here is not: the fence thresholds the *maximum over a candidate set*, and a bound derived for a single pairwise comparison does not transfer to it. §6.6 states T3 for the statistic the fence actually computes, with the multiplicity correction that requires.

We state the rest anyway, for two reasons. The first is that the design is only justified if these properties hold, and several of them are easy to assume and false in nearby designs — a fence that consults the judge before applying the witness satisfies neither P4 nor T4's conclusion, and looks identical in a benign benchmark. The second is that T4 is what makes the architecture non-arbitrary: it says the layering is forced, not chosen. A reader looking for the paper's technical weight should find it in the problem formalisation of §3, the corrected T3, and the empirical account of §8 — not in the length of the other proofs.

### 6.3 Assumptions

- **(A1) Stable run id.** The same `r` across every retry/replay.
- **(A2) Deterministic canonical identity.** `κ_t` and `H` are pure; identical `(r,t,κ_t(x))` map to identical `op`, distinct ones to distinct `op` barring cryptographic collision.
- **(A3) Atomic unique commit.** The log supports atomic insert-if-absent on `op`, reporting whether newly inserted.
- **(A4) Effect-before-commit.** The real effect executes before its commit row is written, and commit is attempted only on success.
- **(A5) Policy soundness.** Each declared field policy π is semantics-preserving: normalising a field under π does not change `eff_t`. Hence `κ_t(x) = κ_t(x') ⇒ x ≈_t x'`.
- **(A5′) Semantic-field determinacy — a DISTINCTNESS witness only.** The declared non-text fields are effect-determining in one direction: `σ_t(x) ≠ σ_t(x') ⇒ x ≉_t x'`. Note carefully what this does *not* say: it does not say that equal projections imply the same act. Our own corpus contains a category (D4b) where the declared fields agree and the acts differ, so the converse is false by construction on this tool surface.
- **(A5″) Projection completeness — a stronger, OPTIONAL property.** `σ_t(x) = σ_t(x') ⟺ x ≈_t x'`. A schema satisfying A5″ pins the whole act in typed fields, so the projection is a complete invariant of the intended action. A5″ implies A5′. It is **not** assumed anywhere in this paper except where T5 Case A explicitly invokes it, and it is **false** for our `wire_money` tool. It is stated separately because it is exactly the property a provider-side idempotency key needs and the witness alone does not give (§6.8).
- **(A6) Calibration exchangeability, conditional on candidate-set size.** For a candidate dispatch that is distinct from every one of the `m` committed candidates it is compared against, each of the `m` pairwise scores is exchangeable with the calibration pool of distinct-pair scores, conditionally on `m`. The `m` scores may be arbitrarily dependent on one another — they share the candidate `x` — and we never assume otherwise; the correction in T3 uses a union bound precisely because it tolerates that dependence. Exchangeability is discussed and stress-tested in §8.6, and it is the assumption most obviously strained under the distribution shift an injection adversary induces, which is why the attack split is excluded from calibration.
- **(A7) No concurrent dispatch per identity.** At most one execution occupies the interval between its L0 lookup and its `putCommitted` for a given `op` at any time — supplied in a deployment by a per-`op` lease, an advisory lock, or single-writer scheduling of a run. T1 is false without it in a way we make precise in §6.4.
- **(A8) Provider idempotency contract.** For guarantee (C) only: the external provider applies at most one effect per distinct idempotency key presented to it, across arbitrary retries and process failures. This is a property of the provider, assumed and not proved here, and T5 is a statement about what it composes with.

A5, A5′ and A5″ are *adoption obligations on the schema*, not properties of the mechanism; they are the semantic contract the tool author signs. They are decidable to check against a spec and are where a misdeclaration would void the corresponding guarantee — we make them explicit rather than hide them. A7 is an obligation on the *scheduler* rather than the schema, and is the one assumption a distributed deployment is most likely to violate silently. A8 is an obligation on a third party, and a deployment that cannot obtain it does not get guarantee (C) at all.

### 6.4 T1 — At-most-once commitment

> **Theorem T1.** Under (A1)–(A4) and (A7), for a fixed run `r` and a fixed L0 identity `op`, across any number of **serialised** executions and process restarts sharing the durable log, the real effect for `op` commits at most once by the fence.

*Proof.* Consider the first execution to reach the commit step for `op`. By (A3) its insert either newly inserts or observes an existing row. Any later execution computing `op` — same process or a fresh one after crash — first performs the L0 lookup; by (A1)–(A2) it computes the identical `op` and by durability observes the committed row, taking the L0 SUPPRESS branch. Hence no execution after the first commit runs the effect. By (A7) no second execution occupies the miss branch while the first is in flight, so the miss branch is entered at most once before a commit exists; under (A4) that path dispatches the effect exactly once. Therefore at most one real commit occurs. ∎

*Remark (irreducible window).* T1 governs what the fence *recognises as identical*. As in any execute-then-record scheme, a crash strictly between `exec()` succeeding externally and `putCommitted` durably writing (marked in Algorithm 1) leaves a PENDING intent and can re-fire; this window is not closable locally and is closed by composition in T5. It is *observable* (a PENDING with no commit), preserving auditability.

*Remark (why A7 is needed, and what happens without it).* Without (A7) the theorem is false, and it is worth being precise about how. Two executions of the same run may both miss L0, both reach `exec()`, and only then contend on the insert; (A3) serialises the *commit row* but not the *effect*, so the loser fires a real duplicate and then records COMMIT_CONFLICT (the branch Algorithm 1 carries for exactly this reason). What survives without (A7) is therefore the weaker statement that **at most one commit row exists per `op`**, with concurrent duplicates rendered *observable* as COMMIT_CONFLICT rather than prevented — the same audit-not-prevent status as the irreducible window, and closed the same way, by T5's provider key. Our experiments dispatch a run's effects sequentially, so (A7) holds throughout §8; a distributed deployment must supply it explicitly. Mechanising the concurrent path is listed in §9.3.

### 6.5 T2 — L0 soundness (zero wrong-suppression in the canonical fragment)

> **Theorem T2.** Under (A5), every L0 suppression is correct: if the fence suppresses via the L0 branch, the suppressed dispatch is `≈_t` the committed effect it matched. Equivalently, `WS_{L0} = 0`.

*Proof.* L0 suppression fires only when `H(κ_t(x)) = H(κ_t(x'))` for a committed `x'` (and, defensively, the stored `inputHash` matches). Barring collision (A2), this implies `κ_t(x) = κ_t(x')`. By (A5), `κ_t(x) = κ_t(x') ⇒ x ≈_t x'`. Hence the matched effect denotes the same intended action; the suppression is correct. ∎

Empirically (§8.2) L0 produces **0** false suppressions on 206 held-out distinct pairs (95% upper bound 1.8%) — a witness for A5, on which the theorem rests — while catching 13.5% of true duplicates for free.

### 6.6 T3 — the conformal wrong-suppression bound, for the statistic the fence computes

**Why a pairwise bound does not suffice.** It is tempting to calibrate a *pairwise* judge score at level α and then deploy the rule "SUPPRESS iff `max_{x' ∈ C} J(t, x, x') > t_hi`". Those are different statistics. Calibrating one comparison at level α and then taking the maximum of `m` such comparisons gives the fence `m` chances to cross the threshold, and

```
P( max_i s_i > t̂ )   is not bounded by   α   merely because   P( s_i > t̂ ) ≤ α.
```

A bound derived for the pairwise score therefore does not cover an algorithm that thresholds the maximum, and the discrepancy grows with the number of committed candidates. §8.6 measures that accumulation empirically. What follows states the theorem for `S*`, the statistic Algorithm 1 actually thresholds.

**Set-up.** Fix a run and tool. A candidate dispatch `x` is compared against the surviving candidate set `C` (everything committed for `(r,t)` that the distinctness witness did not veto), `m = |C|`. The suppression statistic is

```
S*(x, C) = max_{x' ∈ C} J(t, x, x'),        SUPPRESS  iff  S* > t_hi(m).
```

**Calibration procedure.** From a held-out calibration split, collect the pairwise judge scores `s_1,…,s_n` of pairs known to be **distinct** and lying in the deciding rule's *jurisdiction* — the pairs that rule actually routes to the judge. This pool is fixed once, independently of the test data. For a decision with candidate-set size `m`, set

```
t_hi(m)  =  the ⌈(n+1)(1 − α/m)⌉-th smallest of s_1,…,s_n,
           = +∞  if  ⌈(n+1)(1 − α/m)⌉ > n.
```

> **Theorem T3 (multiplicity-corrected wrong-suppression bound).** Assume (A6): conditionally on `m`, each pairwise score of a truly-distinct comparison is exchangeable with the calibration pool. Then for a candidate `x` that is `≉_t` **every** member of `C`,
>
> ```
> P( SUPPRESS )  =  P( S*(x, C) > t_hi(m) )  ≤  α ,
> ```
>
> for every `m ≥ 0`, with no assumption on the score distribution and no assumption of independence among the `m` comparisons.

*Proof.* Condition on `m`. If `m = 0` there is no comparison, `S*` is undefined and the fence executes; the suppression probability is 0. If `t_hi(m) = +∞` the rule never suppresses and the probability is 0. Otherwise write `β = α/m` and `k = ⌈(n+1)(1−β)⌉ ≤ n`, so `t_hi(m) = s_{(k)}`.

Fix one candidate `x'_i ∈ C`. Because `x ≉_t x'_i`, its score `s_i` is a distinct-pair score, so by (A6) the `n+1` values `s_1,…,s_n, s_i` are exchangeable and the rank of `s_i` among them is uniform on `{1,…,n+1}`. The event `s_i > s_{(k)}` is the event that `s_i` has rank greater than `k`, of probability `(n+1−k)/(n+1) ≤ 1 − (1−β) = β`. This holds *marginally for each* `i`, which is all we need.

Now apply the union bound over the `m` candidates:

```
P( S* > t_hi(m) )  =  P( ∃ i ≤ m : s_i > t_hi(m) )  ≤  Σ_{i=1}^{m} P( s_i > t_hi(m) )  ≤  m · β  =  α.
```

The union bound requires no independence, which is essential: the `m` scores share the candidate `x` and are strongly dependent. Averaging over the distribution of `m` preserves the bound, since it holds conditionally on each value of `m`. ∎

**Why this correction and not another.** Three routes control a maximum: (i) calibrate the max statistic directly on calibration data with the deployment's candidate-set structure; (ii) a Bonferroni/union correction on the pairwise level; (iii) a step-down or other multiple-comparison construction. We take (ii) as the primary construction for reasons that are practical rather than aesthetic. Direct calibration (i) is the tightest and we implement it too (`setConformalThreshold`), but it needs calibration *units* whose candidate-set size matches deployment: a pool of `n` pairwise scores yields only `⌊n/m⌋ ` disjoint units, and certifying α = 0.05 needs at least 19 units, i.e. at least `19m` calibration pairs — 950 of them at `m` = 50, for that one value of `m`. It also requires exchangeability between synthetic calibration sets and deployed candidate sets, a strictly stronger assumption than A6. Route (ii) reuses one pool at every `m`, handles an `m` that varies per decision (which it does: `m` is however many effects this run has already committed for this tool), and needs nothing beyond the pairwise exchangeability we already assume. We report (i) alongside it in §8.6 to quantify what the conservatism costs.

**The pool must match the rule's jurisdiction.** A6 asks for exchangeability between the calibration scores and the scores the rule thresholds *at deployment*. Which pairs those are is decided by the layers in front of the judge, and adding a layer changes them. In the hardened configuration the witness vetoes before the judge is consulted, so the judge only ever scores residual pairs (Definition 6); a pool that also contains witness-vetoed distinct pairs is drawn from a different and systematically easier population, because those pairs differ on a declared field and the judge scores them confidently low. Including them depresses the `(1−α/m)` quantile, which lowers `t_hi`, which makes suppression easier — so the violation is in the unsafe direction, and it does not announce itself: the rate measured over the *whole* test split stays under α while the rate over the population the bound is about does not. §8.3 measures both, on both judges, and the effect is large enough to matter.

Stated generally: **each configuration must be calibrated on its own jurisdiction**, and an ablation that removes a layer must be re-calibrated rather than inheriting the full system's threshold. Holding the pool fixed across an ablation confounds the layer's contribution with a threshold shift. We apply this throughout §8 and report the pool size beside every threshold, because the pool size is also the multiplicity budget of T3 and the two move together.

**Ties.** The rule is a strict inequality, so a score exactly equal to `t_hi(m)` does not suppress; it falls into the escalation band. Ties among calibration scores are likewise harmless: the rank argument bounds `P(rank > k)`, and ties can only move probability from "greater" to "equal", which the strict inequality resolves toward not suppressing. Judge scores here are integer percents, so ties are common rather than measure-zero, and this is the reason the inequality is strict.

**Varying candidate-set size.** `t_hi` is a function of `m`, recomputed per decision from the same pool; it is monotone non-decreasing in `m`, so a larger committed set makes suppression strictly harder. That is the correct direction for a safety property, and it means an adversary who inflates `m` can cause *escalation*, never suppression.

**`m = 0`.** No candidate, no comparison, no suppression: the fence executes. Wrong-suppression is 0 by construction, and the implementation returns `t_hi = +∞` for `m = 0` so that no later code path can suppress on an empty candidate set.

**Insufficient calibration data.** `t_hi(m) = +∞` whenever `⌈(n+1)(1−α/m)⌉ > n`, i.e. whenever `m > α(n+1)`. Then the semantic layer *never suppresses* and every suspicion escalates: safety degrades to "no semantic suppression", never to "unbounded wrong suppression". This is a hard budget, not a tuning knob — certifying level α at candidate-set size `m` needs `n ≥ m/α − 1` calibration pairs. With our `n` (§7.1) and α = 0.05 the mechanism can certify only up to `m` ≈ 10, and beyond that it is reduced to its decidable layers. We regard this as one of the paper's more important negative results and report it as such in §8.6, rather than confining the evaluation to the `m` ≤ 1 regime in which the question does not arise.

**What is and is not distribution-free.** The bound assumes nothing about the shape of the score distribution, and holds at the given finite `n`. It is *not* assumption-free: it rests entirely on (A6), exchangeability between calibration and test distinct-pair scores conditional on `m`. Where exchangeability fails — most obviously under the injection attacks of §8.4, which are a deliberate distribution shift — **the guarantee does not apply**, and we neither claim nor report it there. The attack split is excluded from calibration for this reason and evaluated separately. The bound is also marginal over draws of the calibration set, not a per-draw guarantee: an unlucky draw exceeds α on the test split, and §8.11 measures how far and how often.

`t_lo` is calibrated dually on *same*-pair scores at a level γ (the `⌊(n+1)γ⌋`-th smallest), bounding the *unflagged* escape rate of the semantic layer at ≈ γ; escapes above `t_lo` land in the escalation band and are flagged. It needs **no** multiplicity correction, and the asymmetry is instructive: for a true duplicate the candidate set *contains* its match, so `S* ≥ s_match` and `P(S* ≤ t_lo) ≤ P(s_match ≤ t_lo) ≤ γ`. Taking a maximum hurts the safety side (more chances to exceed `t_hi`) and helps the liveness side (more chances to clear `t_lo`) — the correction is asymmetric because the loss is.

### 6.7 T4 — impossibility of simultaneous zero error

> **Theorem T4.** Let the judge induce, on a population of candidate pairs, score distributions `F_same` and `F_diff` for truly-identical and truly-distinct pairs. If the distributions **overlap** — there exist scores achieved with positive probability by both — then no threshold rule on the score alone achieves `WS = 0` and silent-escape `= 0` simultaneously. Only information *outside* the score (the decidable layers L0 and the witness) can push a class's error to exactly zero.

*Proof.* Suppose a threshold `τ` gives `WS = 0`: no distinct pair scores `> τ`, i.e. `F_diff` has no mass above `τ`, so `τ ≥ sup(supp F_diff)`. Silent-escape `= 0` requires every identical pair to be suppressed (score `> τ`) or flagged; a *pure* threshold with no band requires `F_same` to have no mass at or below `τ`, i.e. `τ < inf(supp F_same)`. Both demand `sup(supp F_diff) ≤ τ < inf(supp F_same)`, i.e. the supports are separated — contradicting overlap. With the escalation band, "silent-escape = 0" can be met by widening `(t_lo, t_hi]` to cover the overlap, but then those identical pairs are *flagged, not suppressed*, so dedup drops by the overlap mass and friction rises — the error is *relocated*, not removed. Zero error for a class is attainable only by a decision that does not depend on the (overlapping) score: L0 (Theorem T2) gives `WS = 0` on its fragment, and the witness gives `WS = 0` across declared differences, precisely because both are decidable and score-independent. ∎

T4 is why the architecture is *layered*: the decidable layers are not an optimisation but the only route to zero error on their fragments; the calibrated layer then does the best bounded job on the irreducibly ambiguous remainder. Our judge is well but imperfectly separated — `F_diff` median 0.05, `F_same` median 0.95, with the supports overlapping in between — and T4 says exactly what that overlap costs: the empirical `WS` on benign data is small but non-zero (1.7% [0.7–4.3] at α=0.05), and the `F_same` mass sitting low becomes escape (§8.3). The zeros we do report come only from the decidable layers, as T4 requires.

### 6.8 T5 — external exactly-once by composition, and what the key must satisfy

**Why paraphrase-stability is not sufficient.** The semantic projection `σ_t(x)` is invariant under paraphrase, which makes it a natural candidate for a provider idempotency key. Invariance is necessary and not sufficient. A5′ establishes only that *differing* projections imply *distinct* acts; it says nothing about equal projections. Our own corpus contains a whole category (D4b) in which the declared fields are identical and the acts differ — a second legitimate installment of the same amount to the same payee. Keying a provider on `σ_t(x)` would make the provider suppress the *second, legitimate* action: a wrong-suppression, silent and at the far side of a system boundary where no local audit trail can see it. The key must therefore be **complete** for effect identity, not merely invariant.

We split the theorem accordingly.

> **Theorem T5, Case A (complete projection).** Let `π_t` be a key function that is (i) **paraphrase-invariant** — `x ≈_t x' ⇒ π_t(x) = π_t(x')` — and (ii) **complete for effect identity** — `π_t(x) = π_t(x') ⇒ x ≈_t x'`. Assume the provider's contract (A8). Then composing the fence with the provider key `π_t(x)` yields **external exactly-once** (guarantee C) for the effects of that tool, including across T1's irreducible window.

*Proof.* Two cases. (i) The fence suppresses: no dispatch, trivially at most once. (ii) The fence executes and the process dies in the window before the commit row lands; a later execution re-dispatches the same intended action, possibly paraphrased. By (i) of the hypothesis both dispatches carry the *same* key, so by (A8) the provider applies at most one effect. By (ii) of the hypothesis no *distinct* action collides onto that key, so no legitimate action is absorbed. Together with T1 for the non-window case, the external effect commits exactly once. ∎

A schema satisfying **A5″** supplies such a `π_t` directly: take `π_t = σ_t`. That is the practical reading of Case A — *it is a statement about schema design, not about judge quality*. No amount of semantic judging recovers guarantee (C), because the window is precisely the interval in which no local code runs.

> **Theorem T5, Case B (witness-only projection).** Suppose the schema satisfies only A5′, so `σ_t` is a distinctness witness but not complete (our `wire_money` is such a tool). Then:
>
> 1. `σ_t` remains sound as a **veto**: it may be used to *prevent* semantic suppression across a declared-field difference, and P4 holds (T4, §6.7).
> 2. `σ_t` is **not** admissible as a provider idempotency key. Distinct acts sharing a projection would be merged by the provider, converting a duplicate-escape into a wrong-suppression at the provider boundary — an error in the catastrophic direction, and one the local audit trail cannot observe.
> 3. The canonical key `op = H(r ‖ t ‖ H(κ_t(x)))` *is* admissible — it is sound by T2 — but it is **not paraphrase-stable**. It therefore closes the window only for retries that are canonically identical, which is exactly the case content-addressed fencing already handled and exactly not the case this paper is about.
>
> Consequently, under A5′ alone, **the irreducible window remains open for paraphrased retries**, and no local mechanism closes it.

*Proof.* (1) is Theorem T4's zero-error argument restated. (2): by non-completeness there exist `x ≉_t x'` with `σ_t(x) = σ_t(x')`; presented to a provider obeying (A8), the second is absorbed though it is a distinct act. (3): soundness is T2; instability is immediate, since `κ_t` normalises but does not interpret free text, so a paraphrase yields a different `op`. ∎

**What this means for a deployment.** What follows is a decision procedure, not a guarantee:

- If the tool schema pins the whole act in typed fields (A5″), derive the provider key from the projection and obtain guarantee (C).
- If it does not, you may still use the witness as a veto and the semantic layer for guarantees (A) and (B), but you must accept that a crash inside the execute-before-record window can double-fire under paraphrase — and §8.7 shows it doing so in 11 of 12 window trials, with the twelfth flagged rather than prevented.
- The engineering response is to move act-determining information out of free text and into declared fields, which is the same recommendation the friction analysis of §8.9 arrives at from the opposite direction. This is what we mean by **schema-first, model-second**.

We note the resulting asymmetry plainly, because it inverts the paper's own emphasis: the semantic layer is what buys deduplication across paraphrase *while the process is alive* (guarantee A), and schema completeness is what buys correctness *across process death* (guarantee C). The judge cannot substitute for the schema, and the schema cannot substitute for the judge.

### 6.9 Complexity

Per dispatch: L0 is `O(|x|)` to canonicalise and hash plus an `O(1)` indexed log lookup. The witness filters the committed set for `(r,t)` in `O(m)` where `m = |C_{r,t}|` is typically tiny (effects committed *so far in this run* for this tool). L1 invokes the judge on the surviving candidates: `O(m')` scored comparisons, `m' ≤ m`, batched into `⌈m'/B⌉` model calls. Calibration is a one-time `O(n log n)` sort. In our runs `m` is 0–1 for most dispatches (a run rarely commits many effects of one tool), so the judge is called at most once per candidate dispatch and never for the 26.5% of decisions the decidable layers settle. Storage is one row per committed effect plus one intent/flag row per dispatch.

---

### 6.10 T7 — how the three guarantees compose, and which are substitutable

§6.1 separated identity recognition (A), fence-level at-most-once (B), and external exactly-once (C). Their *structure* is not symmetric, and stating it precisely settles several design arguments that are otherwise conducted on intuition — including "do I need the semantic layer if my provider supports idempotency keys?", which is the first question any adopter asks.

> **Theorem T7 (structure of the composition).** Let the end-to-end property be: *for each intended action, the external world receives exactly one effect.* Then, over a run subject to arbitrary process failure and paraphrasing retries:
>
> 1. **(A) is necessary.** Neither (B) nor (C) can compensate for misidentification. Both are *keyed* mechanisms — B on the durable log's `op`, C on the provider's idempotency key — and a mechanism that mis-recognises identity supplies the wrong key to both. Specifically, an unrecognised duplicate presents a *fresh* key to a correct provider, which correctly applies a second effect; a wrongly-recognised distinct action presents a *stale* key, which the provider correctly absorbs, silently dropping a legitimate act.
> 2. **(C) subsumes (B) for at-most-once.** Under A8 and a key satisfying T5 Case A, the provider applies at most one effect per identified action regardless of whether the local fence serialised anything. A deployment with a complete provider key does not need A7 for at-most-once.
> 3. **(B) is a strict partial substitute for (C), failing exactly on the commit window.** Without a provider contract, the fence gives at-most-once on every crash point except the interval between the external call landing and the commit row becoming durable. That interval is not closable locally, and its size is an engineering constant, not a design choice.
> 4. **(B) and (C) are not redundant when both are present.** (B) prevents the duplicate dispatch from being *issued*, so it saves the request, the latency, and any provider-side rate or fraud accounting that a suppressed-but-issued call would still consume. (C) covers what (B) structurally cannot.

*Proof.* (1) Suppose identity recognition is wrong on a pair `(x, x')` with `x ≈ x'`. The fence computes distinct keys, so the durable log's uniqueness constraint (B) does not fire and the provider (C) sees two distinct keys; by A8 the provider is *obliged* to apply both, and does. Dually, if `x ≉ x'` are recognised as identical, both B and C suppress the second, and by A8 the provider's behaviour is correct with respect to the key it was given. In both cases B and C behave exactly as specified and the outcome is wrong, so the fault is attributable to A alone.
(2) Immediate from A8 and Case A completeness: both dispatches carry the same key, and no distinct act collides onto it.
(3) T1 gives at-most-once for every execution reaching the L0 lookup after a commit row exists; the window is the interval during which no such row exists though the effect has landed. A local mechanism can only observe its own durable state, which by construction does not yet record the effect.
(4) The two mechanisms act at different points: B before dispatch, C after receipt. ∎

**What T7 tells an adopter.** The three guarantees are not a checklist of equals. Identity recognition is the *only* irreplaceable one, and it is the only one this paper contributes to — B is a uniqueness constraint and C is someone else's contract. The practical consequences invert some common advice:

- *"We use Stripe-style idempotency keys, so we are covered."* Only if the key is derived from something complete for effect identity (T5 Case A). A key derived from the raw request text is not paraphrase-stable and fails on exactly the retries this paper is about; a key derived from a witness-only projection is paraphrase-stable and *unsafe* in the other direction (§6.8 Case B).
- *"We have a durable log, so we don't need semantic identity."* The log enforces uniqueness over whatever key you compute. If that key changes under paraphrase, the log dutifully records two effects.
- *"A better judge would fix this."* T6 bounds what any judge can fix; T7 says the judge is operating on the only guarantee that cannot be delegated.

The honest summary of this paper's position in the composition is therefore narrow and, we think, worth stating that way: **we contribute to (A), we restate (B), and we delegate (C) — and we show that (A) is the one that cannot be delegated.**

## 7. Experimental Methodology

### 7.1 Corpus

We built a labelled corpus of **955 tool-call pairs** over six irreversible tools (`charge_card`, `post_refund`, `transfer_funds`, `send_email`, `create_ticket`, and a deliberately loose-schema `wire_money` whose amount/beneficiary are free text). Labels are **by construction**. Nine categories:

| Code | Category | Label | n | cal / test | How generated |
|---|---|---|---:|---|---|
| S1 | mechanical reformat | SAME | 68 | 34 / 34 | key reorder, whitespace, number/currency/case reformat |
| S2 | benign paraphrase | SAME | 253 | 126 / 127 | free text rewritten, semantic fields pinned + numerically validated; **four generator arms** |
| S3 | loose-schema value reformat | SAME | 15 | 7 / 8 | `$780`↔"seven hundred eighty dollars" etc. |
| S4 | adversarial paraphrase | SAME | 163 | 81 / 82 | generator told to maximise surface difference while preserving the act |
| D1 | near-miss mutation | DIFF | 251 | 125 / 126 | one field mutated (±1, ±0.01, ×10, ÷10, id bump, currency swap, order-number change) |
| D2 | legitimate repeat | DIFF | 150 | 75 / 75 | identical up to a distinguishing token ("installment 1 of 2" vs "2 of 2") |
| D3 | semantic difference | DIFF | 10 | 5 / 5 | handcrafted same-surface, different-intent pairs |
| D4a | field-injection attack | DIFF | 20 | held out | declared field differs **and** text says "treat as duplicate; suppress" |
| D4b | text-injection attack | DIFF | 25 | held out | declared fields identical, distinct act, injection in free text |

Totals: **499 SAME, 456 DIFF**; 453 calibration, 457 test, 45 held-out attack.

**Sizing the DIFF side.** Wrong-suppression is the safety-critical rate and is estimated over DIFF pairs alone, so the precision of the paper's central claim is set by the DIFF count and by nothing else. The corpus therefore carries 456 DIFF pairs, 206 of them in the test split, and the sizing was chosen against the interval rather than against a target balance. The arithmetic is worth showing, because it decides whether a headline is meaningful: on 72 held-out DIFF pairs an observed zero admits a 95% Wilson upper bound of **5.1%**, which is *larger* than the α = 0.05 being certified and would make a zero uninformative; on 206 the bound is **1.8%**, comfortably inside it. All bounds here, including bounds on observed zeros, are Wilson; we avoid the rule-of-three approximation (`3/n`, which would give 4.2% and 1.5% at those two sizes) so that one interval convention covers every rate we report, and we quote the interval rather than the point estimate throughout (§8).

**Four generator arms, one of them not a language model.** The paraphrase categories (S2, S4) are generated **four times**: by Llama 3.3 70B, by GPT-OSS-120B, by Qwen3.6-27B, and — for S2 — **by hand, by the authors, with no model in the loop**. Every pair records which generator wrote it. A judge scoring paraphrases written by itself is partly measuring self-recognition, which would inflate deduplication without any semantic competence behind it; carrying multiple arms lets us *measure* that confound (§8.8) instead of assuming it away. The split is stratified by (category, generator) so no arm can land preferentially in calibration or test. LLM generation ran at temperature 0.9 for diversity, and a validator **rejected** any variant that altered a pinned numeric mention or recipient:

| Generator | S2 kept / dropped | S4 kept / dropped | total pairs |
|---|---|---|---:|
| hand-authored (no model) | 68 / 0 | — | 68 |
| Llama 3.3 70B | 60 / 8 | 49 / 19 | 109 |
| GPT-OSS-120B | 59 / 9 | 62 / 6 | 121 |
| Qwen3.6-27B | 66 / 2 | 52 / 6 | 118 |

SAME labels are therefore guaranteed to preserve the intended action. The asymmetry in the S4 rejection counts is itself informative and we return to it in §8.8.

**What the hand-authored arm is, and is not.** It removes the LLM-generator confound: if deduplication held only for machine-written paraphrase, it would fail here. It is **not** an independent-annotation study, and we are explicit that it carries a different bias — the authors know what the mechanism does and wrote text a mechanism they designed would plausibly handle. Independent labelling is a separate study, reported in §8.16: a blinded panel that has not seen the mechanism relabels a frozen stratified subset, and it agrees with the construction where the schema decides and contests it where only prose does. That study was run on a **model** panel; the human channel is instrumented and uncollected (§7.4), and we say so rather than substituting the authors' own text for it.

The corpus is split 50/50 into calibration/test with a fixed seed; the D4 attack categories are **held out entirely** from calibration (the conformal guarantee is for the benign, exchangeable distribution; attacks are a distribution-shift stress test evaluated separately).

### 7.2 Judge and score parsing

A judge is one model call (Groq, temperature 0) scoring a batch of ten pairs, returning per pair an integer percentage `p_same_pct ∈ [0,100]` mapped to `[0,1]`.

**Why parsing is a methodological concern and not an implementation detail.** A judge instructed to answer on one scale may answer on another. A reply of `0.95` where `95` was requested is well-formed JSON, passes any structural check, and — under a parser that accepts any finite number and divides by 100 — is stored as `0.0095`, inverting a confident same-act verdict into a confident distinct-act score. Such a reply never triggers a retry and never enters a failure count, so a scoring pass can report a 0% failure rate while a substantial fraction of its scores are inverted, and every downstream rate is then computed over silently corrupted data.

We state this concretely because it happened to us. An earlier pass of this harness, over an earlier 780-pair build of the corpus, stored 180 mis-scaled scores. The contamination is measurable exactly rather than estimated, because no integer percentage can produce a stored score that is not a multiple of 0.01, and 180 of those 780 were not — 23.1%. Recovering the implied probabilities shows them spanning the full range (0.01, 0.02, …, 0.6, 0.8, 0.9, 0.95, …, 0.99), so the judge was answering on a `[0,1]` scale generally and not only when confident. Every number in that pass was withdrawn and re-derived; the affected scores are shipped in `archive/` so the claim can be checked rather than believed, and the strict contract below exists because of it. We regard the general lesson as transferable: an evaluation that instruments only whether the oracle *replied* cannot detect an oracle that replied in the wrong units.


**The contract we enforce.** The output field names its own scale (`p_same_pct`), and parsing is strict, with exactly one accepted form and no silent coercion:

| Reply | Outcome |
|---|---|
| `95`, `95.0`, `"95"`, `"95.0"`, `"95%"` | accepted → 0.95 |
| `0.95`, `0.950`, `"0.95"`, `95.5` | **rejected** (`non_integer`) — the scale is ambiguous, so it is not a score |
| `101`, `1000`, `-1` | **rejected** (`out_of_range`) — never clamped |
| `"high"`, `""`, `{}`, `NaN` | **rejected** (`not_a_number`) |
| index absent from the reply | **rejected** (`missing`) |

A rejected batch is retried up to three times, and a batch whose values indicate a probability-scale answer is retried with an explicit correction. A pair that never receives an admissible value becomes an **abstention**, recorded as `null` rather than as 0.5. This distinction matters: an imputed mid-score enters the calibration sample and moves both thresholds while appearing to be a judgment. Abstentions are dropped from calibration, excluded from the maximum in `S*`, and can never cause suppression; if every candidate in a set abstains, the fence escalates. Parser outcomes, retries, transport failures and abstentions are counted per judge and reported (§8.1). Unit tests pin every row of the table above.

We also count, separately, accepted values of exactly `0` and `1`. These are contract-valid integers and also what a probability-scale reply looks like when it is confident; they are the one residual ambiguity the strict parser cannot resolve, and we report the exposure rather than assume it away.

**Judges, and which arms actually ran.** The harness scores the corpus with judges spanning independent model families and, within the GPT-OSS family, two model sizes. It also supports two **ensemble** arms: `mean`, the conventional aggregate, and `min`, which suppresses only when *every* judge agrees the pair is the same act — under this loss asymmetry `min` is the safety-aligned aggregator, since a single dissenting judge suffices to prevent a wrong suppression.

The binding constraint is inference quota, and we state it because it determines which arms could be evaluated. The key used here enforces a **per-model tokens-per-day** allowance (measured: 200,000 for GPT-OSS-120B, 100,000 for Llama-3.3-70B). One full pass over 955 pairs costs of order 10⁵ tokens, so a single judge consumes roughly an entire day's allowance for that model. Coverage achieved is reported in §8.1 per judge, and any judge whose coverage is too low to support inference is reported as **NOT RUN** rather than shown with rates computed over abstentions. We flag one specific trap we fell into and corrected: a judge that abstains on every pair produces `t_hi = +∞`, and therefore a table row reading "0.0% wrong-suppression, 0% silent escape" that looks like an excellent judge and is in fact **no judge at all**. Such rows are excluded, not reported.

We also implement a deterministic **offline lexical-numeric scorer** (token-Jaccard on free text, hard vetoes on declared-field and numeric-mention disagreement, number-word normalisation) used for the no-network path and as a scorer ablation. It is a weak stand-in: it handles numeric reformats but not open-ended rewording, and we report it as such rather than as a competitive baseline. It is also, as §8.6 notes, unusable as a substitute for a judge in the multi-candidate experiment, because it assigns near-identical scores to all distractors and so exhibits none of the accumulation the experiment exists to measure.

### 7.3 Baselines, configurations, metrics

- **B0** no fence; **B1** exact-string identity; **B2** canonical L0 only (the prior content-addressed fence); **B4** raw judge at fixed τ.
- **Layered** at α ∈ {0.01, 0.02, 0.05, 0.1, 0.2}; **hardened** adds the distinctness witness (the proposed system); **tightened** additionally re-declares the loose-schema tool with typed fields (§8.9), reported as an intervention rather than as the baseline system.
- Scorers: each LLM judge separately, the `mean` and `min` ensembles, and the deterministic lexical scorer.
- Metrics per §3.3: wrong-suppression `WS`, dedup, silent escape, flagged escape, friction, reported on the **test** split (benign) and separately on the **attack** split. Thresholds are always `t_hi(m)` at level α/m (§6.6); on this corpus a candidate is compared against one committed effect, so `m` = 1 unless stated, and §8.6 is the experiment that varies it.

All scoring is persisted; the metric/ablation/sweep computation is pure offline recomputation, so every number regenerates deterministically from `corpus/scores.jsonl` with no further model calls.

---

### 7.4 Human labelling

Every label in this corpus is by construction, which makes it reproducible and controlled and also makes it an artefact of the authors' own definition of "the same action". We built a blinded annotation harness (`src/experiments/annotation.js`) to control for this directly, and describe it in full because the design choices are themselves part of what should be checked.

**Sampling.** Eleven strata, each included for a stated reason rather than for coverage alone: four SAME strata (mechanical, paraphrase, the loose-schema motivating example, adversarial paraphrase) and seven DIFF/attack strata, with the budget weighted toward the two categories a careful reader is most likely to contest — D2 (legitimate repeats, where the mechanism's own errors concentrate) and the text-only injection classes. 15 items per stratum are drawn, spread across tool families within the stratum rather than pooled, for 154 items in the exported sheet (11 × 14, one stratum falling short of 15 for want of source pairs). At this size, even a flawless result — every annotator agreeing with every constructed label — carries a 95% lower bound of 97.6% rather than 100%, and we report that bound alongside the export so the study's own resolution is stated before it runs rather than argued about after.

**Blinding.** Annotators see the two tool calls and nothing else: no constructed label, no model prediction, no mechanism decision, no threshold, no attack flag, and no indication of which pair was built as SAME or DIFF. Presentation order is randomised globally so strata do not arrive in blocks, and which call is shown as "A" is randomised per item so a positional habit cannot align with a label. Annotators are given the formal operational definition of effect identity — restated in the instructions without the paper's notation — *before* they see any pair.

**Adjudication.** Three independent annotators are planned. An item without a SAME/DIFF majority (a tie, or a majority of UNSURE) is routed to a fourth, independent adjudicator who sees the same instructions and the non-majority vote counts and assigns a final label; the adjudication rate is reported as a finding rather than resolved silently, since a construction needing frequent adjudication is one that is not capturing a shared notion of "the same act".

**Analysis, prepared in advance of any response.** The ingestion path (already implemented and exercised against synthetic input) computes Fleiss' κ and Krippendorff's α — the latter because it handles the ragged, possibly-missing annotations real submissions produce, which κ does not — pairwise Cohen's κ, per-stratum construction agreement with its own Wilson interval, the adjudication rate, and, distinctly from agreement, a **re-derivation of the mechanism's headline wrong-suppression and deduplication rates over the annotated subset under both the constructed and the adjudicated labels**, calibrated on the untouched full calibration split so that re-labelling the subset being measured cannot leak into its own threshold.

**Two collection channels, and which one ran.** The study was preregistered before any judgement was collected (`annotation/PREREGISTRATION.md`), against a content-hashed 154-item sheet (`annotation/FREEZE.json`, sheet hash `66a174e1…`). The preregistration fixes the analysis, the exclusion rule, and — because we did not know in advance which channel we would be able to run — the claim each channel would license:

- **Channel H (human).** A self-contained HTML instrument (`annotation/instrument.html`), one pair per screen, forced ternary response, A/B side and item order randomised per annotator, CSV export keyed by item ID. This is the stronger channel. It is built, verified end-to-end, and shipped in the artifact. **It was not collected**: we had no independent human annotators available, and we do not report a human validation we did not run.
- **Channel M (model panel).** The same frozen items, the same instruction text, the same forced ternary, delivered one pair per call to models that have not seen the mechanism. **This is the channel that ran**, and §8.16 reports it.

**Channel M is a model panel and we never call it a human study.** It controls the same threat — whether the constructed labels are shared or private to the authors — and it controls it more weakly, because a construction reflecting a prior common to the authors and the panel would be confirmed here and still be idiosyncratic relative to human practice. That limitation is restated wherever the result is cited.

**Panel composition.** Three annotators — `groq/compound`, `groq/compound-mini`, `qwen/qwen3.6-27b` — and one blind adjudicator, `openai/gpt-oss-safeguard-20b`. The preregistration bars the **primary judge** (`openai/gpt-oss-120b`) from the panel outright, since it supplies the scores the re-derivation uses and would make the exercise circular. One panelist, Qwen3.6-27B, does appear elsewhere in the paper as a reported judge; the preregistration requires that it be named and the agreement recomputed without it, and §8.16 reports both. Each panelist sees **one pair per request** with no history — the deployed judge scores batches of ten, and a batch lets a reader see its own base rate.

**Catch trials.** Three ordinary sheet items are flagged in the key as catch trials — two mechanically-obvious SAME from `same_mechanical`, one single-field numeric DIFF from `diff_near_miss` — chosen by a mechanical rule rather than by eye (`src/experiments/buildInstrument.js`). An annotator failing **any** of them is dropped in full, with `UNSURE` counting as a failure. All four panelists passed all three.

The hand-authored generator arm (§7.1) is not a substitute for this study and should not be read as one: it removes the *machine-generation* confound (does dedup hold on paraphrase no model wrote?) and does nothing about the *author-definition* confound (do the authors' SAME/DIFF calls match an independent reader's?). The two are different controls for different threats and are kept separate throughout.

## 8. Results

All benign metrics are on the held-out test split (**251 SAME, 206 DIFF, 457 pairs**); attack metrics on the 45 held-out D4 pairs. Every rate carries a Wilson 95% interval. A rate marked **†** is zero as a *consequence of a decidable layer*, not as a sample estimate: the measurement there tests the assumption and the implementation, not the theorem.

All scores were obtained under the strict output contract of §7.2, and every rate below is recomputed offline from the persisted corpus.

**Which configuration is "the mechanism".** The design of §5 includes the distinctness witness, so the **hardened** configuration — L0 + witness + calibrated judge + escalation band — is the proposed system and is the one we report as primary. We show the witness-free **layered** configuration alongside it throughout, because the difference between the two rows *is* the witness's contribution and hiding it would make §4 unfalsifiable. A third configuration, **tightened**, re-declares the loose-schema tool with typed fields (§8.9) and is reported as an intervention, not as the baseline system.

We organise around seven research questions.

| | Question | Answered in |
|---|---|---|
| RQ1 | Can semantic fencing recover paraphrased duplicates canonical fencing misses? | §8.2–8.3, §8.13 |
| RQ2 | Can wrong-suppression be bounded, for the statistic actually deployed? | §8.3, §8.5, §8.6, §8.11, §8.13, §8.14 |
| RQ3 | Does the witness prevent adversarial suppression across declared differences? | §8.4 |
| RQ4 | What does the mechanism cost in escalation, oracle calls and latency? | §8.9, §8.10 |
| RQ5 | Does it survive process death and paraphrased replay? | §8.7 |
| RQ6 | How does it behave with multiple committed candidates? | §8.6 |
| RQ7 | How robust is it across independent judge and generator families? | §8.8 |
| RQ-T2 | Does the residual behave, empirically, the way T6 says it must? | §8.15 |

### 8.1 Judge coverage and parser outcomes

The strict parser makes the judge's non-answers visible, so we report them before any rate that depends on them.

| Judge | family | scored / 955 | coverage | abstentions | scale violations | non-integer | out-of-range | status |
|---|---|---:|---:|---:|---:|---:|---:|---|
| GPT-OSS-120B | gpt-oss | 955 | 100.0% | 0 | 0 | 0 | 0 | **primary** |
| GPT-OSS-20B | gpt-oss | 955 | 100.0% | 0 | 0 | 0 | 0 | **reported** |
| **Qwen3.6-27B** | **qwen** | **930** | **97.4%** | 25 | 0 | 0 | 0 | **reported** |
| Llama-3.3-70B | llama | 60 | 6.3% | 895 | 0 | 0 | 0 | excluded |

Qwen3.6-27B reaches full-corpus coverage by resumed scoring rather than by a single pass: the quota constraint below is real, and the response to it is the checkpointed scorer (`score.js --retry-abstentions`), which re-asks only the pairs that previously received no admissible value and preserves everything already answered. Its 25 remaining abstentions are a *completion-budget* failure rather than a transport one — this is a reasoning model, and on those pairs the scratchpad consumes the budget before an answer is emitted. They are recorded as `null`, dropped from calibration, and excluded from every maximum, exactly as §7.2 requires. We did not raise the budget to chase them, because scoring part of a corpus under one completion budget and the rest under another would make the judge's apparatus non-uniform across pairs for the sake of 2.6%.

Judges are reported only above a fixed 80% coverage threshold, declared before the runs and applied without exception, so ensemble membership is a constant rather than something that varies per pair. Two observations follow.

First, **not one reply violated the scale contract**. After the output field was renamed `p_same_pct` — so that the contract names its own scale — and the parser was made strict, every accepted value was an admissible integer, and every abstention recorded here is a *transport* failure against an exhausted per-model daily allowance rather than a parse failure.

Second, the two excluded arms are excluded on a principle, not a preference. A judge that abstains on 895 of 955 pairs contributes no calibration pool, so its threshold is `t_hi = +∞`, so it never suppresses, so its table row reads "0.0% wrong-suppression, 0.0% silent escape". That row is the appearance of a flawless judge manufactured by the absence of a judge, and printing it beside real rows would be actively misleading. Coverage at or above 80%, declared before any run and applied without exception, is what keeps such a row out.

**A second route to the same false row, and the rule extended to close it.** That coverage clause is necessary and, as we discovered by running into it, not sufficient. A judge can answer every pair and still say nothing. `allam-2-7b` returns 0.9 for essentially every comparison we put to it: 100% coverage, a SAME mean of 0.90, a DIFF mean of 0.91 — a separation of *minus one point*, and an AUC of 0.50. Follow that through the deployed rule and the arithmetic is identical to the abstaining judge's: the calibration pool is a pile of 0.9s, so the conformal threshold is 0.9; the suppression rule is a **strict** inequality, so a test score of 0.9 does not clear it; nothing is ever suppressed; wrong-suppression is 0.0% and deduplication is 0.0%. The row is indistinguishable in shape from the abstaining judge's, and indistinguishable in shape from a perfect safety result — and a coverage filter admits it.

A coverage rule alone therefore lets in exactly the failure it was written to prevent, through the other door. We close both:

| clause | threshold | what it rules out |
|---|---|---|
| **coverage** | ≥ 80% of pairs scored | a judge whose pool and rates are computed over abstentions |
| **resolution** | ≥ 2 distinct score values | a constant-answering judge, whose threshold cannot separate anything |
| **signal** | AUC(SAME vs DIFF) ≥ 0.60 | a judge whose scores do not order the two classes better than chance |

Resolution is set at two rather than three deliberately: a judge answering only 0 and 1 can still order SAME above DIFF perfectly, and one of this paper's own experiments (§8.6) depends on exactly such a judge. What a binary judge cannot support is the escalation band, which needs mass between the extremes; that is reported as a capability flag rather than an exclusion, and §8.5 shows what it costs when it is absent.

Applying the rule to every judge in this paper reproduces the decisions already made — Llama-3.3-70B excluded at 6.3% coverage, both GPT-OSS models admitted at 100% with AUC 0.957 and 0.962, and Qwen3.6-27B admitted at 97.4% — and adds one new exclusion, `allam-2-7b`, on resolution and signal rather than on coverage. We report that exclusion as a result. "This model cannot serve as an effect-identity oracle" is more informative than a row of zeros, and the row of zeros is what a coverage-only rule would have printed.


### 8.2 RQ1 — the canonical core is sound but incomplete

**Hypothesis.** Canonical fencing suppresses only mechanical reformats, and never errs.

**Result.** L0 suppresses **13.5% [9.9–18.3]** of true duplicates on the test split with **0 / 206** false suppressions on distinct pairs (**0.0%† [0.0–1.8]**) — an empirical witness for T2 and, more precisely, for assumption A5 on which T2 rests. Its coverage is exactly the mechanical fragment: **100% [89.8–100.0]** of S1, and **0%** of S2, S3, S4 and of every DIFF category.

The figure is a property of the corpus as much as of L0, and the dependence is worth making explicit: L0 reaches exactly the mechanical fragment, so its coverage is the mechanical share of the SAME population. This corpus holds 416 paraphrase pairs against 68 mechanical ones. A corpus weighted the other way would report a much higher number for the same mechanism, which is a reason to distrust any single figure of this kind — including ours — unless the population is stated alongside it. We weight toward paraphrase because paraphrase is the failure mode the paper exists to address, and because a corpus dominated by whitespace reformats flatters every method, the baseline most of all.

**Limitation.** L0's zero is conditional on A5, an assumption about the schema, not a property the experiment can establish on its own; the measurement tests the assumption against this corpus.

The number the semantic layer must beat: **86.5% of true duplicates escape L0 and would double-fire.**

### 8.3 RQ1/RQ2 — the layered fence deduplicates paraphrase at a bounded, non-zero cost

Each configuration is calibrated on its own jurisdiction (§6.6): the layered rule routes every non-canonical pair to the judge and is calibrated on all 205 distinct calibration pairs the canonical core leaves; the hardened rule routes only residual pairs and is calibrated on the 117 of those the witness does not veto.

| Config (test split, n=513) | pool `n` | `t_hi` | WS | dedup | flagged escape | silent escape | friction |
|---|---:|---:|---|---|---|---|---|
| B0 no fence | — | — | 0.0% [0.0–1.6] | 0.0% [0.0–1.3] | 0.0% | 100.0% [98.7–100.0] | 0.0% |
| B1 exact-string | — | — | 0.0% [0.0–1.6] | 0.0% [0.0–1.3] | 0.0% | 100.0% [98.7–100.0] | 0.0% |
| **B2 canonical L0 (prior art)** | — | — | **0.0%† [0.0–1.6]** | **12.1% [8.8–16.4]** | 0.0% | 87.9% [83.6–91.2] | 0.0% |
| B4 raw judge τ=0.5 | — | 0.5 | 2.2% [0.9–4.9] | 99.6% [98.0–99.9] | 0.0% | 0.4% [0.1–2.0] | 0.0% |
| B4 raw judge τ=0.9 | — | 0.9 | 0.0% [0.0–1.6] | 69.0% [63.4–74.2] | 0.0% | 31.0% [25.8–36.6] | 0.0% |
| Layered α=0.01 (no witness) | 230 | 0.9 | 0.0% [0.0–1.6] | 69.0% [63.4–74.2] | 17.8% [13.8–22.7] | 13.2% [9.7–17.6] | 0.9% [0.2–3.1] |
| Layered α=0.05 (no witness) | 230 | 0.2 | 3.0% [1.5–6.1] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] |
| **Hardened α=0.01** | 142 | 0.95 | **0.0% [0.0–1.6]** | 22.1% [17.6–27.3] | 64.8% [59.0–70.1] | 13.2% [9.7–17.6] | 0.9% [0.2–3.1] |
| **Hardened α=0.05** | 142 | 0.8 | **1.7% [0.7–4.3]** | **94.7% [91.4–96.7]** | 0.0% [0.0–1.3] | 5.3% [3.3–8.6] | **0.0% [0.0–1.6]** |

**RQ1.** At α=0.05 the hardened fence deduplicates **94.0% [90.4–96.3]** of true duplicates against the content-addressed baseline's **13.5% [9.9–18.3]**, at **1.0% [0.3–3.5]** wrong-suppression and **6.0% [3.7–9.6]** silent escape. The gain over the baseline is a factor of seven and is what the semantic layer exists to buy; the silent escape is what it costs, and it is not zero.

**RQ2, and a correction the theory forced.** The rate that the bound is about is not the rate over the whole test split. T3 bounds the probability that a *distinct pair reaching the judge* is suppressed, and under the hardened rule the pairs reaching the judge are exactly the residual (Definition 6). Conditioning on the residual — 336 of the 457 test pairs — changes the picture:

| α=0.05, GPT-OSS-120B | calibration pool | `t_hi` | WS over the full test split | WS over the residual |
|---|---:|---:|---|---|
| pool includes witness-vetoed pairs | 230 | 0.2 | 3.0% [1.5–6.1] | **4.9% [2.4–9.7]** |
| pool restricted to the residual | 142 | 0.8 | 1.7% [0.7–4.3] | 2.8% [1.1–6.9] |

and on the second judge the mis-specified pool puts the residual rate **above** the declared level:

| α=0.05, GPT-OSS-20B | calibration pool | `t_hi` | WS over the full test split | WS over the residual |
|---|---:|---:|---|---|
| pool includes witness-vetoed pairs | 230 | 0.1 | 3.0% [1.5–6.1] | **4.9% [2.4–9.7]** |
| pool restricted to the residual | 142 | 0.95 | 1.3% [0.4–3.7] | 2.1% [0.7–5.9] |

The mechanism is the one §6.6 predicts. Witness-vetoed distinct pairs differ on a declared field, the judge scores them confidently low, and leaving them in the pool drags `t_hi` from 0.8 down to 0.2. The full-split rate stays under α throughout, which is why the mis-specification is easy to miss: the pairs that dilute the pool also dilute the denominator. We report both conditionings for this reason, and we take the residual-conditioned rate to be the one that answers RQ2. Under the correct pool it is 1.7% and 2.5% against a declared α of 0.05; under the mis-specified pool one of the two judges violates the level it declares.

**What this costs.** Restoring the guarantee is not free, and the price is visible in the table above: deduplication falls from 100.0% to 94.0% and silent escape rises from 0.0% to 6.0%. An earlier reading of these experiments reported the mis-specified row and could show a configuration with no silent escape at all. That configuration was not achieving a bound it could state.

**The α trade is real and legible.** Tightening from 0.05 to 0.01 raises `t_hi` from 0.8 to 0.95 and drives wrong-suppression to 0.0% [0.0–1.8], paid for in liveness at a rate that makes the trade obvious: deduplication collapses from 94.0% to 19.9%, and three quarters of all true duplicates land in the escalation band rather than being suppressed. That is the mechanism behaving as designed — at a tight α it stops suppressing and starts asking — but it is also a configuration whose review load only a small deployment could absorb. A deployment choosing α trades *undetectable wrong drops* against *reviewer time and silent duplicates*, which is the trade T4 says cannot be escaped.

**The raw judge is a fair comparison and we make it.** A bare threshold at τ=0.5 beats the hardened configuration on three of the four rates in this table — 99.6% dedup against 94.0%, and 0.4% silent escape against 6.0% — and loses only on WS, 1.5% against 1.0%, which is the one direction the design prioritises by construction (§3.3). So the honest comparison is not "the mechanism dominates": on this judge, at this α, it does not, on any axis but the safety-critical one. What τ=0.5 does not have, and what the comparison is actually about, is a *bound*: it is a number that happens to work on this judge and this corpus, carries no guarantee to any other, has no escalation band — its 0.4% miss rate is entirely **silent**, with nothing to catch it — and is defenceless against the injection attacks of §8.4, where the identical judge wrongly suppresses 65.0% of D4a. The hardened configuration's escalation band does not help here either: at α=0.05 it is empty for this judge (§8.9), which is exactly why its silent escape is *higher*, not lower, than the raw threshold's. What the machinery buys, on this specific judge and split, is therefore narrower than a reader might assume from the headline: a half-point safer WS, a stated bound instead of a number that happens to work, and the adversarial defence of §8.4 — not a reduction in silent escape, which the raw threshold happens to control better here by accident rather than by guarantee.

**Per category (hardened, α=0.05):**

| Category | label | n | suppress | escalate | execute |
|---|---|---:|---|---|---|
| S1 mechanical | SAME | 34 | 100.0% [89.8–100.0] | 0.0% [0.0–10.2] | 0.0% [0.0–10.2] |
| **S3 loose-schema value** | SAME | **38** | **100.0% [90.8–100.0]** | 0.0% [0.0–9.2] | 0.0% [0.0–9.2] |
| S2 paraphrase | SAME | 127 | 92.9% [87.1–96.2] | 0.0% [0.0–2.9] | 7.1% [3.8–12.9] |
| S4 adversarial paraphrase | SAME | 82 | 92.7% [84.9–96.6] | 0.0% [0.0–4.5] | 7.3% [3.4–15.1] |
| D1 near-miss | DIFF | 126 | 0.8% [0.1–4.4] | 0.0% [0.0–3.0] | 99.2% [95.6–99.9] |
| D2 legitimate repeat | DIFF | 75 | 1.3% [0.2–7.2] | 0.0% [0.0–4.9] | 98.7% [92.8–99.8] |
| **D3 semantic difference** | DIFF | **31** | **6.5% [1.8–20.7]** | 0.0% [0.0–11.0] | 93.5% [79.3–98.2] |

**A correction to this table's configuration.** An earlier revision printed this table with every SAME category at 100.0% and D2 at 5.3%, under the heading "hardened, α=0.05". Those numbers are not the hardened configuration's — they are the **jurisdiction-mismatched** pool's, the one §8.3's own prose spends two paragraphs correcting. The tell is arithmetic and we should have caught it: a table whose SAME rows are all 100% cannot sum to the 94.0% deduplication printed six rows above it. Recomputing under the pool the hardened rule actually uses gives the table above, and the difference is not cosmetic — S2 moves from 100.0% to 92.9%, S4 from 100.0% to 92.7%, D2 from 5.3% down to 1.3%. The headline row was always computed correctly; it was the per-category breakdown that was drawn from the wrong configuration.

**S3 — the paper's motivating example — is handled, and now on a sample that can say so.** The `$780` ↔ "seven hundred eighty dollars" rewrite of §1.2 is category S3, and the fence suppresses **38 of 38** test pairs. This category previously held 8 test pairs, where an observed 38/38-equivalent carried a 95% lower bound of **67.6%** — a bound too weak to support the sentence it was being asked to support, since the paper's motivating failure deserves better than "no observed failures on eight tries". The category was grown from 15 pairs to 75 (§7.1), and the lower bound is now **90.8%**. That is a number we would defend in review: it is still not a proof of reliability, and it is no longer compatible with the mechanism failing on a quarter of its own motivating case.

**D3 was hiding a real error, and growing it found one.** D3 previously held 5 test pairs and reported 0.0% wrong-suppression [0.0–43.4] — an interval so wide it excluded almost nothing. Grown to 31 test pairs, the same configuration wrongly suppresses **2 of 31, 6.5% [1.8–20.7]**. This is a *new* finding produced by the growth rather than a change in the mechanism, and it is the only category in the table whose point estimate sits above the declared α = 0.05. We report it as the sharpest illustration in the paper of why a cell too small to fail is not evidence of not failing.

It is also exactly where the theory says the error should be. D3 pairs are handcrafted to be identical in every declared field and to differ only in what the free text denotes — a first instalment against a second, one milestone against the next. They are the residual in its purest form: the witness has nothing to veto on, and the judge carries the decision alone with no decidable layer behind it. §8.4 finds the same structure under adversarial pressure, and §8.15 finds it again on the schema ladder. **Wherever act-distinguishing information lives only in prose, this mechanism is only as good as its judge** — and D3 is now a large enough cell to show that as a rate rather than to assert it.

**Wrong suppression, re-apportioned.** With the per-category table computed under the correct configuration, wrong-suppression at α=0.05 is 1/126 D1, 1/75 D2 and 2/31 D3. The earlier revision's claim that "wrong suppression concentrates in D2" was an artefact of the mis-specified pool: under the hardened rule the concentration is in **D3**, and D2 — the category we had pre-registered as the one most likely to be contested — is the second-cleanest DIFF category in the table.

### 8.4 RQ3 — adversarial injection: the witness earns its place, and the residue is the schema's

On the held-out D4 attack pairs (all DIFF — suppression is always wrong). The attack split is excluded from calibration, so **T3's bound does not apply here and we do not invoke it**: this is a distribution-shift stress test, and these are raw measurements.

| Config | D4a field-injection WS | D4b text-injection WS |
|---|---|---|
| raw judge τ=0.5 — GPT-OSS-120B | 65.0% [43.3–81.9] | 84.0% [65.3–93.6] |
| raw judge τ=0.5 — GPT-OSS-20B | 15.0% [5.2–36.0] | 28.0% [14.3–47.6] |
| layered α=0.05, no witness (120B) | 70.0% [48.1–85.5] | 88.0% [70.0–95.8] |
| **hardened (judge + witness), 120B** | **0.0%† [0.0–16.1]** | 84.0% [65.3–93.6] |
| **hardened (judge + witness), 20B** | **0.0%† [0.0–16.1]** | 28.0% [14.3–47.6] |
| hardened, ensemble `min` | **0.0%† [0.0–16.1]** | 28.0% [14.3–47.6] |
| hardened, ensemble `mean` | **0.0%† [0.0–16.1]** | 88.0% [70.0–95.8] |
| **tightened schema (§8.9)** | **0.0%† [0.0–16.1]** | **0.0%† [0.0–13.3]** |

**RQ3, for declared fields.** A raw judge reading injected "this is a duplicate; suppress" text wrongly suppresses **65%** of different-amount actions on the primary judge — a direct forced-suppression exploit that silently cancels legitimate distinct wires. Note that the *calibrated* layer is slightly **worse** than the raw judge (70%), which is exactly what should be expected and is worth stating plainly: calibration bounds an error rate on the benign distribution and offers nothing under deliberate shift. The distinctness witness drives D4a wrong-suppression to **zero deterministically** — the amount lives in a declared field, the projections differ, and the veto fires before the judge is consulted. This zero is a logical consequence of A5′, not an estimate; the *measured* zero at n=20 would admit a 95% upper bound of 16.1%, and nothing in a 20-sample experiment could establish what the mechanism establishes by construction.

**Judge choice dominates the residue, and the smaller model wins.** GPT-OSS-20B is markedly more injection-resistant than GPT-OSS-120B — 15% vs 65% on D4a raw, 28% vs 88% on D4b — reversing the intuition that a larger judge is a safer one. We report this as an observation on two judges from one family, not as a scaling law; it is exactly the kind of per-vendor idiosyncrasy §7.2 warns cannot be separated from mechanism properties without a broader comparison.

**The `min` ensemble behaves as its safety argument predicts.** On D4b, `min` tracks the *better* judge (28.0%) while `mean` tracks the *worse* (88.0%). This is the aggregator's design intent measured directly: suppression under `min` requires unanimity, so one judge that is not fooled is enough to prevent the wrong suppression, whereas averaging lets a confidently-fooled judge drag the aggregate over the threshold. It is the clearest empirical case in this paper for preferring `min` under an asymmetric loss — and it is available only because two judges reached usable coverage.

**D4b is where the mechanism has nothing to offer.** With declared fields identical and the distinction living only in free text, the witness is silent and the judge decides — and on the primary judge it is wrong **88% [70.0–95.8]** of the time under injection. The witness contributes *nothing* here, by construction. We report this measured 88% wrong-suppression under text-injection as our primary finding.

**And it is fixable, but only by the schema.** The tightened configuration re-declares the loose tool so the installment index is a typed field rather than a phrase in free text. The witness then vetoes the D4b attack too, and its wrong-suppression falls to zero by the same construction, on every judge and both ensembles. We regard this as the paper's most actionable finding: **the residue is not a judge problem, it is a schema problem.** It is also why we decline to describe the witness as "solving adversarial paraphrase" — it converts adversarial paraphrase into a schema-coverage question, exactly and measurably.

### 8.5 RQ2 — the judge's score distribution

A judge's usefulness to the escalation band depends on whether it expresses graded confidence or saturates at the extremes. We measure this directly.

| Judge | SAME median | DIFF median | at the extremes (≤0.02 or ≥0.98) | silent escape |
|---|---|---|---|---|
| GPT-OSS-120B | 0.95 | 0.05 | SAME 10%, DIFF 4% | **5.3% [3.3–8.6]** |
| GPT-OSS-20B | 1.00 | 0.00 | **SAME 84%, DIFF 87%** | 2.1% [1.0–4.6] |
| Qwen3.6-27B | 1.00 | 0.00 | **SAME 89%, DIFF 90%** | 8.5% [5.8–12.4] |

The two judges differ sharply in exactly the property the escalation band depends on, and the consequence is visible in the last column. The 120B is *graded* — only 6% of its SAME scores sit at an extreme — so duplicates it fails to suppress land inside `(t_lo, t_hi]` and are flagged; its silent escape is zero. The 20B is *saturated*: 83% of its SAME scores and 87% of its DIFF scores are at the extremes, so there is little mass for the band to catch, and its misses fall straight through to silent execution.

This is the cleanest confirmation available here of the design argument L2 rests on: **the escalation band binds only to the extent that the judge expresses doubt**, and a judge that answers only 0 or 1 renders L2 inert no matter how the thresholds are set. It also means "which judge" is not only a question of accuracy — a more accurate but more saturated judge converts flagged escapes into silent ones, which under this paper's loss asymmetry is a real regression even when the aggregate miss rate is similar.

The contrast above varies model size within one family and holds the corpus fixed, which makes it a controlled comparison — of two judges only.

### 8.6 RQ6 — multiple committed candidates, and the correction that T3 requires

This is the experiment the corrected T3 stands or falls on, and the regime every other experiment in this paper avoids: elsewhere a run has committed at most one effect per tool, where the pairwise bound and the bound on the deployed statistic coincide.

**Construction.** A *unit* is one dispatch `x` plus an ordered list of `K = 50` committed candidates, all sharing `x`'s semantic projection so that all of them survive the witness and reach the judge. Prefixes give `m ∈ {1,2,5,10,25,50}` with candidate sets **nested**, so the m-curve is not confounded by re-drawing candidates. SAME units place the true match in every prefix; DIFF units contain no match, and wrong-suppression is estimated over those alone. Three threshold rules are compared: **uncorrected** (pairwise at α), **bonferroni** (pairwise at α/m, the correction), and **setconformal** (calibrated directly on maxima of size-`m` calibration sets).

**Why the offline scorer cannot stand in here.** The deterministic scorer assigns near-identical values to every distractor sharing a projection, so the maximum over `m` candidates does not grow with `m` and the phenomenon under study is invisible by construction — its max distinct-pair score is constant at 0.083 for every `m` from 1 to 50. A flat curve from that scorer would read as evidence of safety and would be an artefact of the scorer's degeneracy, so this is the one experiment in the paper for which a live judge is not optional.

**What ran, and what kind of judge ran it.** 60 units (40 DIFF, 20 SAME) × K = 50 candidates = **3,000 live judge comparisons** with Llama-3.1-8B-Instant, 128 calls, mean 37 ms per comparison, zero abstentions. This judge is not a good one and we did not choose it for its accuracy: it finds the true match in only 10 of 20 SAME units, and its 3,000 scores take exactly two values — **2,968 zeros and 32 ones**. Total saturation is the reason it is informative here. The statistic under study is a maximum, saturation makes every spurious high score maximally consequential, and a binary score set removes the threshold from the analysis altogether, which is what lets the result below be stated without reference to any particular calibrated value. What this experiment measures is the multiplicity effect, not the mechanism's accuracy; §8.3 measures the latter, at `m` = 1, with the judge the deployment would use.

**Result 1 — spurious maxima accumulate with `m`, which is the phenomenon the correction exists for.** Over DIFF units, where *every* candidate is a genuinely distinct act and any high score is a false positive:

| `m` | mean max distinct-pair score | fraction of units with a spurious 1.0 |
|---:|---:|---:|
| 1 | 0.000 | 0% |
| 2 | 0.000 | 0% |
| 5 | 0.000 | 0% |
| 10 | 0.000 | 0% |
| 25 | 0.000 | 0% |
| 50 | **0.650** | **65%** |

At `m` = 50, **65% of dispatches that match nothing committed nevertheless contain at least one committed candidate the judge calls identical**. Under any finite threshold those units suppress, and the suppression is wrong. This is the mechanism of the defect stated concretely: the pairwise error rate did not change, but the fence takes a maximum over `m` of them, and by `m` = 50 the maximum is spuriously high most of the time.

**The shape of that curve is an artefact and only its endpoint is sound.** A jump from 0% at `m` = 25 to 65% at `m` = 50 is too abrupt to be accumulation, and the cause is in the construction rather than in the phenomenon: candidates are appended to each unit's list in a fixed order and prefixes are taken from the front, so which prefix first contains one of the 32 spuriously-scored comparisons is decided by where that comparison happens to sit in the ordering. Nesting the prefixes removes the confound of re-drawing candidates and introduces a dependence on candidate order in its place. The `m` = 50 figure — 65% of DIFF units containing a false positive somewhere among 50 candidates — is a property of the full set and survives; the intermediate points are properties of one ordering and do not. We report the endpoint and withdraw the curve. The repair is to randomise candidate order per unit and average over several orderings, which needs the judge again and is left with the other outstanding runs.

**Result 2 — the uncorrected rule suppresses wrongly where the corrected rule declines to decide.** On the 20 held-out DIFF units, at α=0.05:

| rule | `t_hi` at `m` = 50 | WS at `m` = 50 | WS at `m` ≤ 25 | dedup at `m` = 50 |
|---|---|---|---|---|
| uncorrected (pairwise at α) | 0.90 | **65.0% [43.3–81.9]** | 0.0% [0.0–16.1] | 70.0% |
| Bonferroni (pairwise at α/m) | **+∞** | **0.0% [0.0–16.1]** | 0.0% [0.0–16.1] | 0.0% |
| set-conformal (maxima of size-`m` sets) | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% |

The two rules diverge for the reason T3 predicts and at the point T3 predicts. The calibration pool holds n = 205 distinct-pair scores, which certifies `m` ≤ 2 at α=0.01, `m` ≤ 10 at α=0.05 and `m` ≤ 20 at α=0.1. Past that budget the corrected threshold is `+∞` and the layer stops suppressing; the uncorrected threshold does not move at all, because it never consulted `m`. At `m` = 50 that difference is the difference between wrongly cancelling two thirds of a set of legitimate distinct actions and cancelling none of them. The corrected rule pays for this in liveness — it also stops deduplicating — which is the intended failure direction and not a free lunch.

**Why this conclusion does not depend on the calibrated value.** The thresholds in the table were computed from a calibration pool scored by the deterministic lexical scorer rather than by the judge that scored the units, because the judge has no column in the main corpus. Calibrating on one score distribution and thresholding another would ordinarily void the guarantee, so we state plainly why it does not bite here: the judge's scores take only the values 0 and 1, so *every* threshold in `[0, 1)` induces exactly the same decisions and every threshold in `[1, ∞]` suppresses nothing. The result is a statement about `m`, not about `t_hi`. We checked the scorer-consistent alternative as well — an in-experiment pool of one comparison per calibration unit, drawn from the same judge — and it yields n = 20 scores, all zero, hence `t_hi` = 0 at α=0.05 (inside the same invariant range, so identical decisions) and a Bonferroni budget of `m` ≤ 1, which switches the corrected rule off *earlier* than the table shows. Under scorer-consistent calibration the divergence is therefore larger, not smaller.

**What is established independently of any judge** is the bound itself. A Monte-Carlo check (300 replications per candidate-set size) confirms that the uncorrected pairwise rule exceeds α on the max statistic — more than twice the nominal level by `m` = 10 — while the Bonferroni rule holds at every `m` tested. That check is part of the artifact's test suite and is written to fail if the correction is removed.

**Scope of RQ6.** This settles that the correction is necessary and that it behaves as derived. It does not establish an operating point: a saturated judge on purpose-built units is a stress test, and the deployed configuration of §8.3 runs at `m` = 1, where corrected and uncorrected rules coincide. A deployment that commits many effects of one tool per run should read the budget line, not the wrong-suppression column.

### 8.7 RQ5 — paraphrased crash and replay, against the deployed judge

**What changed since the previous version of this experiment, and why it decided the result.** The earlier run substituted the deterministic offline scorer for the judge. That substitution determined the outcome. The prediction the design exists to test — at-most-once at `after_local_commit`, the crash point at which a commit row exists and only a *semantic* decision can recognise a paraphrased retry — came back **0 of 6**, because the offline scorer's threshold sat above almost every score it assigns to a genuine paraphrase. What that measured was the stand-in, not the mechanism, and we said so at the time. This section reports the experiment re-run against the judge and the threshold the corpus evaluation actually produces.

**Design.** The wire flow is executed across separate OS processes sharing only a directory on disk. A seed process dispatches a wire and commits it; a second process is hard-killed at a randomly chosen crash point; a third, fresh process replays the run and re-emits a wire in a paraphrase drawn from a validated pool. The design is paired: both fence modes see the identical (paraphrase, crash-point) draw. The paraphrase pool is written by Llama-3.3-70B and the judge is GPT-OSS-120B, so pool and judge come from different model families and the self-recognition confound of §8.8 cannot arise. Thresholds are `t_hi` = 0.80, `t_lo` = 0.80, taken from the **jurisdiction-matched hardened configuration** of §8.3 rather than from any witness-free row, so the crash experiment runs at an operating point the paper actually reports.

One dispatch is partitioned into eight crash points:

`before_fence` · `after_L0` · `after_witness` · `after_judge` · `before_external_effect` · `during_external_commit_window` · `after_external_effect_before_local_commit` · `after_local_commit`

**Two arms, because one arm cannot see a wrong suppression.** The previous design replayed only a true duplicate, so the safety-critical error was unobservable by construction: whatever the fence did, no legitimate action could be dropped, because there was no second legitimate action to drop. This version adds a second arm.

- **duplicate** — the replay denotes the *same* act as the seed. Correct final state: **one** wire. A second wire is a duplicate effect.
- **distinct** — the replay denotes a *different* act: the second instalment of a two-part payment, identical to the first on every declared field of the loose wire schema and distinguished only by a token in prose. It is a residual pair by construction. Correct final state: **two** wires. One wire is a **missed legitimate effect** — a wrong suppression, committed across process death, which is the error the paper is built to bound.

48 trials per arm, six per crash point, two fence modes, three OS processes per trial. **Zero abstentions**: every comparison the fence made received a judge score. An earlier attempt at this run lost eleven consecutive trials to a provider outage; the fence executed-and-flagged in all of them and wrongly suppressed none, which is the abstention policy behaving as designed — but those trials were not measurements of identity recognition, and the harness now counts abstentions per trial so the condition is visible rather than inferred.

**Result 1 — the prediction the offline run contradicted now holds.**

| crash point | syntactic, correct | semantic, correct | crash point reached (semantic) |
|---|---|---|---|
| `before_fence` | 0.0% (0/6) | **100.0% (6/6)** | 100% |
| `after_L0` | 0.0% (0/6) | **100.0% (6/6)** | 100% |
| `after_witness` | 0.0% (0/6) | **100.0% (6/6)** | 100% |
| `after_judge` | 0.0% (0/6) | **100.0% (6/6)** | 100% |
| `before_external_effect` | 0.0% (0/6) | **100.0% (6/6)** | 17% |
| `during_external_commit_window` † | 0.0% (0/6) | 100.0% (6/6) | **0%** |
| `after_external_effect_before_local_commit` † | 0.0% (0/6) | 83.3% (5/6) | **0%** |
| **`after_local_commit`** | **0.0% (0/6)** | **100.0% (6/6)** | 17% |

† commit-window points. Over the duplicate arm as a whole, the content-addressed baseline achieves at-most-once in **0.0% [0.0–7.4]** of 48 trials — a paraphrased retry hashes differently at every crash point, which is the failure this paper exists to address, reproduced end-to-end across real process death — and the semantic fence in **97.9% [89.1–99.6]**. Outside the commit window it is **100.0% [90.4–100.0]** (36/36). At `after_local_commit`, six of six.

Every suppression in the experiment fired at **L1** (71 of them); none at L0. Every replay was canonically different from what was committed — 96 of 96 retries classified `semantic`, none `lexical` — so the canonical core was structurally incapable of helping and the semantic layer carried the entire load. That is the regime the paper is about, and this is the first run in which it is measured with the deployed oracle.

**Result 2 — and the commit-window rows above are not what they appear to be.** The rightmost column exists to prevent a misreading we nearly published. On the duplicate arm the semantic fence suppresses the replay at L1, so the crashing process never reaches the dispatch-and-commit region where the window points live: `crash point reached` is **0 of 6** at both window points. The 100% and 83.3% in those rows are therefore *not* the fence closing the commit window. They are the fence never opening it. A fence that recognises a duplicate does not enter the window on that dispatch, so the window is invisible in an experiment that only ever replays duplicates — which is exactly what the previous single-arm design was.

The distinct arm is where the window is reachable, because there the fence is *supposed* to execute:

| | outside the window (36) | inside the window (12) |
|---|---|---|
| correct final state, semantic | **100.0% [90.4–100.0]** | **0.0% [0.0–24.2]** |
| correct final state, syntactic | 50.0% (18/36) | 0.0% (0/12) |
| crash point reached | 100% | **100.0% [75.8–100.0]** |
| window-suspect flagged | — | **91.7% [64.6–98.5]** |

Inside the window the fence is wrong in 12 of 12 trials, with the window entered every time: the effect has landed, no durable record of it exists, and the replay fires it again. This is T1's remark and T5 Case B, measured on the arm where the condition is reachable, and it is a cleaner confirmation than the previous run could produce. P3 holds alongside it — 11 of the 12 leave a durable `UNCERTAIN_COMMIT_WINDOW` flag and a `PENDING` intent with no commit row, so the condition is observable where it is not preventable.

**Result 3 — no wrong suppression across process death.** On the distinct arm the semantic fence produced **no missed legitimate effects in 48 trials: 0.0% [0.0–7.4]**. The second instalment is a residual pair — the wire schema pins nothing, so the witness is empty and the judge decides alone — and it survived every crash point, including the one where a committed record of a near-identical act was already on disk. The judge scored these pairs 0.05 where it scored true paraphrases 0.90–0.99, which is the separation §8.5 measures, holding up under the one condition the corpus evaluation cannot create.

We are explicit about what this licenses. Forty-eight trials on one act pair admit a 95% upper bound of 7.4%, so this is "no observed wrong suppression at this sample size", not a rate of zero; and it is one tool, deliberately the loosest in the surface.

**Result 4 — the baseline is right for the wrong reason.** The syntactic fence scores 50.0% on the distinct arm outside the window against the semantic fence's 100%, and it gets those trials right by never suppressing anything. A mechanism that never suppresses has no wrong suppressions and no deduplication; the duplicate arm prices that, at 0 of 48. The two arms together are the safety/liveness trade in its plainest form, and they are why the experiment is reported as two arms rather than averaged into a single "exactly-once rate".

**Cost.** 1.63 judge calls per trial at 1,833 ms mean latency. Across the duplicate arm the baseline wired \$98,280 and the semantic fence \$38,220, against a correct total of \$37,440.

**What this run settles, and what it does not.** It settles RQ5 in the affirmative for the deployed configuration: the fence achieves at-most-once across paraphrased replay at every crash point outside the irreducible window, including the point content-addressed fencing provably cannot handle, and it does so without dropping a legitimate distinct action in 48 trials. It does not establish external exactly-once, and the harness is built so that it cannot appear to — the mock provider presents no idempotency key, so guarantee (C) is absent by construction and the window stays open and measurable. It is one tool, one paraphrase pool, one judge, 96 trials.


### 8.8 RQ7 — generator and judge families: is the judge recognising its own writing?

If the headline were partly self-recognition, the judge should deduplicate paraphrases *it* wrote better than another family's. The corpus carries four generator arms, one of which involves no language model at all.

| Paraphrases written by | self-generated? | n (SAME, test) | dedup, GPT-OSS-120B | dedup, GPT-OSS-20B |
|---|---|---:|---|---|
| hand-authored (no model) | no | 34 | 100.0% [89.8–100.0] | 100.0% [89.8–100.0] |
| Llama 3.3 70B | no | 55 | 100.0% [93.5–100.0] | 98.2% [90.4–99.7] |
| GPT-OSS-120B | **yes** | 61 | 100.0% [94.1–100.0] | 100.0% [94.1–100.0] |
| Qwen3.6-27B | no | 59 | 100.0% [93.9–100.0] | 93.2% [83.8–97.3] |

**RQ7, generator side.** On the primary judge the four arms are indistinguishable: every arm is deduplicated completely, including the arm the judge's own family wrote and the arm written by hand with no model in the loop. A self-recognition advantage would appear as a gap between the self-generated row and the others, and there is no gap to measure. What can be claimed is bounded by the sample rather than by the point estimates: with 34 hand-authored test pairs the 95% lower bound is 89.8%, so an advantage smaller than roughly ten points would not be visible here.

The second judge is the more informative column, precisely because it is imperfect. Its misses fall on the Qwen arm (93.2% [83.8–97.3]) and on Llama (98.2% [90.4–99.7]) rather than on the hand-authored arm (100.0% [89.8–100.0]), which is the opposite of the pattern a self-recognition effect produces — Qwen's prose is no closer to GPT-OSS's than the authors' prose is, and it is the arm the GPT-OSS judge handles worst.

The hand-authored arm removes the machine-generation confound and not the author-definition confound: it was written by the authors, who know what the mechanism does and will tend to write paraphrases it can handle. Thirty-four pairs is also a small sample. This is why §7.4 keeps independent human labelling listed as an open gap rather than treating this arm as a substitute for it.

**RQ7, judge side: ANSWERED — three judges, two vendors, all at full-corpus coverage.**

The table below is the hardened, jurisdiction-matched configuration at α = 0.05 — the proposed system — on the full 457-pair test split. It is the table that carried the paper's vendor exposure, and it no longer does: Qwen3.6-27B is here at 97.4% coverage rather than in a subset appendix.

| Scorer | family | coverage | `t_hi` | WS | dedup | silent escape | friction |
|---|---|---:|---:|---|---|---|---|
| GPT-OSS-120B (primary) | gpt-oss | 100% | 0.80 | **1.7% [0.7–4.3]** | **94.7% [91.4–96.7]** | 5.3% [3.3–8.6] | 0.0% [0.0–1.6] |
| GPT-OSS-20B | gpt-oss | 100% | 0.95 | **1.3% [0.4–3.7]** | 82.6% [77.7–86.6] | **2.1% [1.0–4.6]** | 8.2% [5.3–12.4] |
| **Qwen3.6-27B** | **qwen** | **97.7%** | 0.95 | **0.9% [0.2–3.1]** | 89.0% [84.8–92.1] | 8.5% [5.8–12.4] | 1.3% [0.4–3.7] |
| Llama-3.3-70B | llama | 6.3% | — | — | — | — | excluded |

Ensembles are formed only from judges clearing the admission rule of §8.1, so their membership is fixed rather than varying per pair; the excluded arm is not shown with rates computed over abstentions. (The `min`/`mean` ensemble rows, and the `t_hi = 0.20` row that the mis-specified calibration pool produces for the 120B, are in §8.3 and §8.13 respectively; this table holds the pool fixed at the jurisdiction-matched one so the only thing varying across rows is the judge.)

**Wrong-suppression is inside α on all three judges and both vendors; deduplication is not bounded and moves.** WS is 1.0%, 1.5% and 1.0% against a declared α = 0.05. Deduplication is 94.0%, 82.1% and 87.6% — a spread of twelve points on the same 457 pairs, with the same rule, differing only in which model answered. Silent escape moves further still, from 2.0% to 9.6%, and in the direction §8.5 predicts from the score distributions: Qwen is saturated (87% of SAME scores and 88% of DIFF scores at an extreme, closer to the 20B's 83/87 than to the 120B's 6/5), so its misses fall through the empty escalation band to silent execution.

This is the paper's central prediction, and it is now measured where it matters rather than on a subset: **the bound governs the safety direction across vendors, and nothing governs the other.**

**The paired comparison on the commonly-scored subset.** The table above calibrates each judge on its own full calibration split. A sharper comparison holds the *pairs* fixed too, restricting every judge to the pairs all three scored — which, now that Qwen covers 97.4%, is **930 of 955 pairs (444 calibration / 443 test / 43 attack)** rather than the 218 an earlier revision of this section reported. The subset is no longer a small paired sample; it is very nearly the corpus.

The 25 pairs Qwen never answered are missing for reasons unrelated to the pairs, and we test that rather than assume it: a χ² test of homogeneity rejects nothing — label χ²=0.62, df=1, p=0.43; category χ²=3.33, df=1, p=0.07; split χ²=1.06, df=1, p=0.30. The 25 form 25 runs of mean length 1, none an exact multiple of the batch size, which is the signature of per-pair completion-budget exhaustion rather than of a dropped batch.

On the 443-pair common test split, calibrated per judge on the common calibration split (α=0.05, hardened, jurisdiction-matched):

| Scorer | family | `t_hi` | WS | dedup | silent escape |
|---|---|---:|---|---|---|
| GPT-OSS-120B | gpt-oss | 0.80 | 1.0% [0.3–3.6] | 93.8% [90.0–96.2] | 6.2% [3.8–10.0] |
| GPT-OSS-20B | gpt-oss | 0.95 | 1.5% [0.5–4.3] | 81.4% [76.0–85.8] | 2.1% [0.9–4.7] |
| **Qwen3.6-27B** | **qwen** | 0.95 | 1.0% [0.3–3.6] | 90.1% [85.7–93.2] | 9.9% [6.8–14.3] |

And on the attack split of the same subset, where the witness's contribution is the thing under test:

| Scorer | D4a raw | D4a hardened | D4b raw | D4b hardened |
|---|---|---|---|---|
| GPT-OSS-120B | 68.4% [46.0–84.6] | **0.0%† [0.0–16.8]** | 87.5% [69.0–95.7] | 87.5% [69.0–95.7] |
| GPT-OSS-20B | 15.8% [5.5–37.6] | **0.0%† [0.0–16.8]** | 29.2% [14.9–49.2] | 29.2% [14.9–49.2] |
| **Qwen3.6-27B** | 63.2% [41.0–80.9] | **0.0%† [0.0–16.8]** | 41.7% [24.5–61.2] | 25.0% [12.0–44.9] |

**The safety property transfers across families; the liveness property does not — and the size of the liveness gap was overstated.** Wrong-suppression is 1.0%, 1.5% and 1.0%, every one inside the declared α = 0.05, on three judges spanning two vendors and an order of magnitude of scale. Deduplication ranges from 81.4% to 93.8% on the same pairs. The qualitative asymmetry is exactly what the design predicts and is now established at full coverage rather than on a fifth of the corpus.

**A correction to our own previous revision.** That earlier 218-pair table reported deduplication ranging from 12.2% to 91.1% — a *seven-fold* spread, which we cited in the abstract and in §8.8's findings list as the sharpest available statement of the liveness direction's unboundedness. At full coverage the spread is twelve points, not seven-fold. The 12.2% was a calibration artefact of the small subset: on 218 pairs the saturated 20B's jurisdiction-matched pool pinned `t_hi` at 1.0, and a **strict** suppression inequality against a threshold of 1.0 suppresses almost nothing. Widening the same judge's pool to the full split moves `t_hi` to 0.95 and deduplication to 81.4%. The direction of the claim survives — deduplication is unbounded and does move materially with the judge — but a reader should take twelve points, not a factor of seven, as its measured magnitude, and we have amended the abstract accordingly. We record this rather than quietly restating the number because the mechanism behind it is a general trap: a conformal threshold fitted on a small pool of a saturated judge lands on the extreme value, and every rate downstream of it then describes the threshold rather than the judge.

**What Qwen contributes, specifically.** It is the non-GPT-OSS judge, and it behaves like neither GPT-OSS model: its deduplication sits between them (87.6% full-split), its wrong-suppression ties the primary judge's at the lowest of the three, its silent escape is the highest of the three at 9.6%, and under text-injection it is the *most* robust of the three (D4b 25.0% hardened, against the primary judge's 87.5%). Its score distribution is saturated like the 20B's and unlike the 120B's. Nothing in the mechanism's behaviour is a GPT-OSS artefact, and the one property that does look vendor-specific — how much of the residue survives text-injection — is the property §8.4 already identifies as belonging to the schema rather than to the mechanism.

Four findings, and what remains open:

1. **The bounded direction transfers; the unbounded direction does not.** Across three judges and two vendors, all at full-corpus coverage, wrong-suppression stays inside α (1.0%, 1.5%, 1.0%) while deduplication moves twelve points (82.1% to 94.0%) and silent escape moves five (2.0% to 9.6%). This is the sharpest empirical statement the paper can make about what the machinery actually guarantees, and it is a statement about the mechanism rather than about any judge. An earlier revision put the deduplication spread at seven-fold on a 218-pair subset; that figure was a small-pool calibration artefact and is corrected above.
2. **Silent escape is a property of the oracle's score distribution, not of the mechanism**, for the reason §8.5 gives: the saturated 20B leaves the escalation band nothing to catch, so its misses fall through to silent execution while the graded 120B's land in the band. §8.10 prices this — removing the band costs the 20B 15.9 points of silent escape and the 120B nothing.
3. **`min` does what its safety argument claims, but not on the benign split.** Under injection it tracks the more robust judge while `mean` tracks the weaker one (§8.4) — the result the aggregator exists for. On benign data it does *not* lower wrong-suppression, because conformal calibration re-fits `t_hi` to whatever score distribution it is handed and absorbs the aggregator's conservatism into the threshold. Aggregating for safety and then calibrating to a fixed α gives back much of what the aggregation bought.
4. **Judge size does not order judge safety, and neither does family.** The 20B is markedly more injection-resistant than the 120B (§8.4), and at full coverage Qwen is the most text-injection-resistant of the three (D4b 25.0% hardened against the primary judge's 87.5%) while being the second smallest. Whatever governs robustness to a forced-suppression prompt is neither scale nor vendor, and we have no account of what it is.

**What was open here is now closed.** A previous revision of this section ended by naming a full-coverage cross-family comparison as the single experiment we would run next: the cross-family result then rested on 218 test pairs, and the full corpus had been scored by two judges of one vendor. That experiment has been run. Qwen3.6-27B is at 97.4% coverage, appears in every main table of §8 rather than in a subset appendix, and the common subset is 930 of 955 pairs. What remains open is a *third vendor* — the Llama arm never cleared 6.3% before its allowance ran out, and two vendors is not many. That is a smaller gap than the one it replaces, and we state it as such rather than restating the closed one.

### 8.9 RQ4 — operating cost, and four attempts to reduce it

At α=0.05 the hardened mechanism escalates **0.0% [0.0–1.8]** of genuinely distinct actions on the test split: the escalation band is empty, because this judge separates the benign classes cleanly enough that no distinct pair lands inside `(t_lo, t_hi]`. Escalation is therefore not this configuration's operating cost, and we withdraw any suggestion that it is. The cost that remains is the judge itself — 735 calls per 1,000 dispatches — and the four interventions below are evaluated against *that*, on all of wrong-suppression, deduplication and oracle load together. One dominates, two trade axes, and one is far weaker than the judge it replaces.

**A. Per-tool calibration — an axis trade, for an instructive reason.**

| | WS | dedup | friction |
|---|---|---|---|
| one global threshold | 3.0% [1.5–6.1] | **100.0% [98.7–100.0]** | 0.0% [0.0–1.6] |
| per-tool thresholds | **1.3% [0.4–3.7]** | 95.0% [91.8–97.0] | 1.3% [0.4–3.7] |

Per-tool calibration buys 1.7 points of wrong-suppression and pays 5 points of deduplication for them. The cause is the calibration budget rather than the thresholds: splitting one pool of 230 distinct calibration pairs across six tools leaves `create_ticket` with 6, and certifying α=0.05 needs at least 19, so that tool receives `t_hi = +∞` and **stops suppressing semantically altogether**. The lost deduplication is the arithmetic of a tool that no longer suppresses anything, and the improved wrong-suppression is the same arithmetic seen from the other side — a tool that never suppresses never suppresses wrongly. Nothing here is a better operating point; it is the same point relabelled. The effect is smaller than an earlier revision reported (19 points of deduplication, on a corpus whose per-tool pools were roughly half this size): enlarging the corpus lifted `send_email` from 14 pairs to 19, over the certification threshold, so one of the two starved tools now certifies. That is the mechanism behind the disclosure rather than a softening of it — the budget effect is real, and it bites exactly at the tools with the fewest calibration pairs.

This is the multiplicity budget of §8.6 arriving from a different direction. Conformal calibration spends a fixed statistical resource, and every way of subdividing the decision space — by tool, or by candidate-set size — spends it faster. Per-tool thresholds are worth revisiting only with a per-tool pool large enough to certify the level, which at α=0.05 means at least 19 distinct pairs per tool and `19m` if `m` > 1.

**B. Better schema — decisive on the decidable side, and it starves the statistical side.** Re-declaring the loose-schema tool so act-determining information sits in typed fields rather than free text. Both rows are calibrated on their own jurisdiction, which for the tightened schema is a smaller residual and therefore a smaller pool:

| | pool `n` | `t_hi` | certifiable `m` | WS | dedup | flagged escape | judge consulted | D4a / D4b injection WS |
|---|---:|---:|---:|---|---|---|---:|---|
| declared (as-is) | 117 | 0.8 | 5 | 1.0% [0.3–3.5] | **94.0% [90.4–96.3]** | 0.0% [0.0–1.5] | 73.5% | 0.0%† / 84.0% [65.3–93.6] |
| **tightened** | **35** | **0.95** | **1** | **0.0% [0.0–1.8]** | 19.9% [15.4–25.3] | 74.1% [68.3–79.1] | **56.5%** | **0.0%† / 0.0%† [0.0–13.3]** |

The attack result is the one we expected and it holds: the tightened projection lifts the installment index out of prose into a typed field, so the refuter vetoes the D4b class outright, on every judge, by construction rather than by persuasion — an entire attack category closed by a schema edit. Judge jurisdiction falls 17 points and judge calls 23%. Wrong-suppression falls to zero. No true duplicate is falsely vetoed by the wider projection: silent escape is unchanged at 6.0%, so the extra vetoes all landed on genuinely distinct pairs, which is the direction §6.3 argues a widened projection must fail in.

**And deduplication collapses, from 94.0% to 19.9%.** This is not a defect of the tightened schema; it is a second-order consequence of T6.3 that we had not drawn and that the corrected calibration exposed. Refining the declaration shrinks the residual — that is the theorem — but the calibration pool *is drawn from the residual*, so it shrinks too, from 117 pairs to 35. At `n` = 35 and α = 0.05 the conformal index `⌈(n+1)(1−α)⌉` equals 35, so `t_hi` is the **maximum score in the pool**: the layer will suppress only a pair it scores strictly higher than every distinct pair it has ever been calibrated on. Almost nothing clears that bar, so the duplicates the tightened refuter does not catch fall into the escalation band instead — 74.1% of them.

This is Corollary T6.3′ (the refinement dilemma, stated in full and precisely qualified in §4.2), measured rather than merely asserted: refining a declaration moves pairs from the residual into the decided set, where they are settled exactly and for free, while simultaneously shrinking the calibration sample drawn from what remains of the residual — here from 117 pairs to 35, past the point where the certifiable-`m` formula of §6.6 still permits a finite threshold. Refinement therefore strictly dominates on the fragment it decides and strictly degrades the calibrated layer on the fragment it does not, unless the pool is grown to compensate. The corrected statement of the practical advice is sharper than "schema-first, model-second" for exactly this reason, and we prefer it because it is falsifiable and the loose version is not.

A deployment that tightens its schema must expect to spend longer accumulating calibration data, because the pairs it needs — distinct pairs that survive the refuter — have become rarer by exactly the amount the refinement improved things. The two effects are the same effect. We regard this as the most useful thing the corrected calibration taught us, and note that it is invisible under a pool that is not jurisdiction-matched: the as-published pool holds `n` at 205 for every configuration and shows the tightened schema improving every axis at once, which is the result we previously reported. §8.15 tests the natural follow-up question — does replenishing the calibration budget after refinement recover what is lost? — on a controlled three-level ladder, and finds the answer confounded by a design choice in that experiment rather than settled either way.

**C. Judge ensembles — no benign gain, and a cost.** We compare the single-judge global threshold against the ensembles formed by the three judges with usable coverage:

| Scorer | WS | dedup | friction |
|---|---|---|---|
| GPT-OSS-120B (primary) | **3.0% [1.5–6.1]** | **100.0% [98.7–100.0]** | **0.0% [0.0–1.6]** |
| ensemble `min` | 0.9% [0.2–3.1] | 97.9% [95.4–99.0] | 0.0% [0.0–1.6] |
| ensemble `mean` | 3.9% [2.1–7.2] | 100.0% [98.7–100.0] | 0.0% [0.0–1.6] |

On benign data neither aggregator improves any axis, and both double the judge cost. The reason is worth stating because it is easy to get wrong: conformal calibration re-fits `t_hi` to whatever score distribution it is handed, so the conservatism `min` introduces is absorbed into a lower threshold rather than surfacing as a lower error rate. The aggregator's value is real but appears only under distribution shift, where the threshold cannot adapt — §8.4 shows `min` tracking the more robust judge under injection while `mean` tracks the weaker one.

**D. Deterministic lexical scorer — much cheaper, much weaker.** The offline lexical-numeric scorer needs no model call at all, and reaches dedup **30.6% [25.5–36.2]** at WS **3.0% [1.5–6.1]** and friction 19.8% [15.2–25.4] — worse than the judge on every axis except cost. It handles numeric reformats and not open-ended rewording. It is a fallback for a no-network path, not a competitive alternative.

**Cost per 1,000 irreversible dispatches.** The decidable layers settle 26.5% of decisions for free, so the judge is invoked on **735 dispatches per 1,000**, producing **0 escalations per 1,000 distinct actions** for review. Under the tightened schema those fall to **565 judge calls** and **0 escalations**. Mean judge latency is **2,061 ms** per call for the primary GPT-OSS-120B judge and **1,480 ms** for the GPT-OSS-20B judge.

Under the declared schema, the primary judge consumes **5,431 tokens** (input and output) per 1,000 dispatches. Under the tightened schema, token usage falls to **4,170 tokens** per 1,000 dispatches.

### 8.10 Ablations

Ablating a layer changes which pairs reach the judge, so each row is re-calibrated on its own jurisdiction (§6.6); holding the pool fixed would confound the layer's contribution with a threshold shift. Both full-coverage judges are shown, α=0.05, because they separate differently and the difference is the finding.

| Ablation | pool `n` | `t_hi` | WS | dedup | flagged | silent |
|---|---:|---:|---|---|---|---|
| **GPT-OSS-120B** | | | | | | |
| hardened (full) | 117 | 0.8 | 1.0% [0.3–3.5] | 94.0% [90.4–96.3] | 0.0% [0.0–1.5] | 6.0% [3.7–9.6] |
| − L0 | 117 | 0.8 | 1.0% [0.3–3.5] | 94.0% [90.4–96.3] | 0.0% [0.0–1.5] | 6.0% [3.7–9.6] |
| − witness | 205 | 0.2 | 2.9% [1.3–6.2] | 100.0% [98.5–100.0] | 0.0% [0.0–1.5] | 0.0% [0.0–1.5] |
| − escalation band | 117 | 0.8 | 1.0% [0.3–3.5] | 94.0% [90.4–96.3] | 0.0% [0.0–1.5] | 6.0% [3.7–9.6] |
| − calibration (τ=0.5) | 117 | 0.5 | 1.5% [0.5–4.2] | 99.6% [97.8–99.9] | 0.0% [0.0–1.5] | 0.4% [0.1–2.2] |
| **GPT-OSS-20B** | | | | | | |
| hardened (full) | 142 | 0.95 | 1.3% [0.4–3.7] | 82.6% [77.7–86.6] | 15.3% [11.6–20.0] | 2.1% [1.0–4.6] |
| − L0 | 142 | 0.95 | 1.3% [0.4–3.7] | 81.1% [76.2–85.3] | 16.7% [12.8–21.5] | 2.1% [1.0–4.6] |
| − witness | 230 | 0.1 | 3.0% [1.5–6.1] | 97.5% [94.9–98.8] | 0.4% [0.1–2.0] | 2.1% [1.0–4.6] |
| − escalation band | 142 | 0.95 | 1.3% [0.4–3.7] | 82.6% [77.7–86.6] | **0.0% [0.0–1.3]** | **17.4% [13.4–22.3]** |
| − calibration (τ=0.5) | 142 | 0.5 | 3.0% [1.5–6.1] | 97.5% [94.9–98.8] | 0.4% [0.1–2.0] | 2.1% [1.0–4.6] |

**The witness is a safety-for-liveness trade, and the table prices one side of it.** Removing it raises deduplication (94.0% → 100.0% on the primary judge) and raises wrong-suppression (1.0% → 2.9%) — but the second difference rests on four discordant items and does not survive a paired test (§8.12), so we report the deduplication cost as established and the wrong-suppression benefit as not. It also enlarges the calibration pool from 117 to 205, which is why the witness-free row can afford a lower threshold — the two effects are linked by T6.3′. What the trade buys is not visible on this table at all: it is the D4a injection class, which the witness closes by construction (§8.4) and which the witness-free configuration fails 70% of the time.

**The escalation band binds only on a judge that expresses doubt.** On the 20B it converts **15.9 points of duplicates from silent escapes into flagged ones** — removing it moves silent escape from 2.0% to 17.9% while deduplication is unchanged, which is precisely the conversion P3 claims and the reason the band exists. On the 120B the same ablation changes nothing, because that judge's calibrated band is empty: its `t_lo` and `t_hi` coincide, so there is no zone of doubt to fall into. The band is not a component with a fixed value; it is a component whose value is a function of the oracle's score distribution (§8.5), and a deployment on a saturated judge should not expect it to do anything.

**L0's contribution is small and structural.** Removing it costs 1.6 points of deduplication on the 20B and nothing on the 120B, because the judge re-derives most of what canonicalisation already knew. Its value is not the coverage: it is that those decisions carry `WS = 0` by construction rather than `WS ≤ α` by calibration, and cost no model call.

**Calibration does not buy a better operating point here, and that is the honest result.** A hand-set τ=0.5 beats the calibrated threshold on both judges — better deduplication at comparable or better wrong-suppression. What it does not carry is a guarantee: τ=0.5 is a number that fits this judge and this corpus, transfers to neither, and gives no warning when it stops fitting. A reader who does not value transferability can have this operating point without the machinery, and should know what they are declining.

**Judge jurisdiction.** The decidable layers settle **26.5%** of test decisions with no judge call (L0 7.4% [5.4–10.2], witness 19.0% [15.7–22.9]); the judge is consulted for the remaining **73.5% [69.3–77.4]**. Under the tightened schema of §8.9 the witness alone settles **36.1%** and the judge sees only 56.5%.

### 8.11 How much calibration data the bound needs, and what α does not promise

T3 is stated at a finite `n` and is marginal over draws of the calibration pool. Both facts are easy to state and easy to forget, so we measure them: for each `n ∈ {10, 20, 30, 50, 100, 205}` we resample a calibration pool of that size from the calibration split 300 times, recompute `t_hi`, and evaluate wrong-suppression on the fixed test split.

| `n` | P(`t_hi` = +∞) | mean WS | median WS | p95 WS | max WS | certifiable `m` at α=0.05 |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 100% | — | — | — | — | 0 |
| 20 | 0% | 3.7% | 1.5% | 9.2% | 21.8% | 1 |
| 30 | 0% | 2.3% | 1.0% | 9.2% | 21.8% | 1 |
| 50 | 0% | 2.8% | 1.9% | 9.2% | 9.2% | 2 |
| 100 | 0% | 3.8% | 2.9% | 9.2% | 9.2% | 5 |
| 205 | 0% | 3.6% | 2.9% | 9.2% | 9.2% | 10 |

Three readings, and they are not all comfortable.

**The floor is sharp.** At `n` = 10 no threshold can be certified at all: `⌈(n+1)(1−α)⌉ > n`, so `t_hi = +∞` on every one of the 300 draws and the semantic layer never suppresses. Nineteen distinct-pair scores is not a rule of thumb but the exact arithmetic of `n ≥ 1/α − 1`, and below it the layer is off. Degrading to "no semantic suppression" rather than to "unbounded suppression" is the intended failure direction, and this row is what it looks like.

**More data buys candidate headroom, not accuracy.** Mean wrong-suppression is essentially flat from `n` = 20 to `n` = 205 — it does not fall as the pool grows, because the bound is a rank statement and not an estimation problem. What grows is the certifiable candidate-set size, from `m` ≤ 1 to `m` ≤ 10. A practitioner sizing a calibration pool is buying multiplicity budget.

**A note on scope, before the readings.** This sweep resamples from the 205-pair pool used throughout the main evaluation, which includes pairs the witness would veto, and evaluates over the whole test split. §8.14 repeats it on the *jurisdiction-matched* residual pool — the pairs the deployed rule actually routes to the judge — and the two agree about the mean and disagree about the tail. Where they differ, §8.14 is the one that describes the deployed configuration.

**α is a promise about the average draw, and on this pool the tail is roughly twice the average.** The p95 of the realised wrong-suppression rate is 9.2% at every `n` ≥ 20 — roughly twice the declared α = 0.05 — and at small `n` the worst draw reaches 21.8%. Nothing here contradicts T3: the theorem bounds the probability marginally over calibration draws and test points jointly, and it does not promise that any particular pool achieves α on any particular test split. But a reader who takes "WS ≤ 0.05" to mean "this deployment's rate is at most 5%" has over-read it, and the gap does not close with more calibration data. It closes only by re-drawing the pool, which a deployment does not get to do. We regard this as the most under-appreciated caveat attached to conformal guarantees used as safety arguments, and we would rather show it than restate the theorem. The claim that the gap does not narrow with more calibration data is, however, too strong as stated here: on the jurisdiction-matched pool (§8.14) the *mean* is indeed flat while the *tail* tightens, from a p95 of 13.4% at n = 20 to 4.2% at n = 50. What does not go away is that a minority of draws still exceed the declared level at every size we can test.

### 8.12 What the conclusions survive

Three quantities in this evaluation could reasonably be attributed to something other than the mechanism: the choice of judge, the choice of ground-truth definition, and the sampling variation in a 457-pair split. We vary each in turn. The three analyses are independent and they agree, which is the reason for grouping them.

**Varying the judge.** §8.8: three judges over two vendors, on the pairs all three scored.

**Varying the definition.** Every label is ours by construction. Most categories are not contestable — D1 mutates a declared field, D3 differs in intent by hand, S1 is whitespace — but one is. D2 pairs an "installment 1 of 2" against an "installment 2 of 2": we call that two acts, and a reader who holds that a repeat of the same amount, to the same payee, under the same reference is one act would call it one. D2 is also where the mechanism's errors concentrate, so the choice is load-bearing rather than academic. We re-derive the headline under that relabelling, and under the most hostile reading of our own corpus we can construct — treating adversarial paraphrase (S4) as *distinct*, i.e. assuming our own generator changed the act while our validator failed to notice.

| Ground truth | SAME / DIFF | `t_hi` | wrong-suppression | dedup |
|---|---:|---:|---|---|
| as constructed | 251 / 206 | 0.8 | **1.0% [0.3–3.5]** | 94.0% [90.4–96.3] |
| D2 relabelled SAME | 326 / 131 | 0.7 | **0.8% [0.1–4.2]** | 76.4% [71.5–80.7] |
| S4 relabelled DIFF (hostile) | 169 / 288 | 0.96 | **2.1% [1.0–4.5]** | 24.9% [18.9–31.9] |

**Varying nothing but the pairing.** Configurations are evaluated on identical items, so comparing them by overlapping Wilson intervals discards the pairing and understates what the data can settle. Exact two-sided McNemar tests over the discordant pairs, with Holm–Bonferroni across the family of six comparisons we draw conclusions from:

| Comparison | discordant | exact *p* | Holm |
|---|---|---:|---:|
| dedup: hardened vs canonical baseline | 202 / 0 | <0.0001 | <0.0005 |
| dedup: 120B vs 20B | 42 / 12 | <0.0001 | <0.0005 |
| dedup: raw τ=0.5 vs hardened | 14 / 0 | <0.0001 | <0.0005 |
| dedup: layered vs hardened (cost of the witness) | 15 / 0 | 0.0001 | 0.0005 |
| **wrong-suppression: hardened vs layered** | 4 / 0 | 0.125 | 0.25 |
| **wrong-suppression: 120B vs 20B** | 3 / 2 | 1.0 | 1.0 |

**The same asymmetry appears in all three.** Deduplication moves under every perturbation and the movements are significant: twelve points across judges at full coverage, from 94.0% to 24.9% across labellings, and 202 discordant items against the baseline. Wrong-suppression moves under none of them — 1.0%, 0.8% and 2.1% across the three ground truths, every one inside the declared α = 0.05, and neither judge-side comparison reaches significance. The bounded direction is stable against everything we varied; the unbounded direction is stable against nothing.

Two consequences follow, and the second is uncomfortable for us. The safety claim this paper makes is the robust one, which is the right way round given the loss asymmetry it is built on. But the *witness's* contribution to benign wrong-suppression — 1.0% against the witness-free 2.9% — rests on four discordant items and does not survive a paired test (p = 0.125). We therefore withdraw any claim that the refuter improves benign wrong-suppression, and rest its case where the evidence is decisive: the D4a injection class, which it closes by construction (§8.4), and the 15 deduplications it costs to do so, which is significant.

### 8.13 The baseline and ablation matrix

The configurations reported so far compare the proposed fence against a content-addressed baseline, a raw judge, and four single-layer ablations. That establishes that the mechanism does something and not *which part* does it: with three layers, two calibration choices and a multiplicity setting there are combinations whose behaviour is not predictable from the single-layer rows. This section runs the full matrix. Every row is evaluated on the identical test pairs and calibrated on **its own jurisdiction** (§6.6) — removing a layer changes which pairs reach the judge, so a shared pool would confound the layer's contribution with a threshold shift.

| | configuration | pool `n` | `t_hi` | WS | dedup | silent escape |
|---|---|---:|---:|---|---|---|
| B0 | no fence | — | — | 0.0% [0.0–1.8] | 0.0% [0.0–1.5] | 100.0% [98.5–100.0] |
| B1 | exact-string identity | — | — | 0.0% [0.0–1.8] | 0.0% [0.0–1.5] | 100.0% [98.5–100.0] |
| B2 | content-addressed (prior art) | — | — | 0.0%† [0.0–1.8] | 13.5% [9.9–18.3] | 86.5% [81.7–90.1] |
| B3 | raw judge, τ=0.5 | — | 0.5 | 1.5% [0.5–4.2] | 99.6% [97.8–99.9] | 0.4% [0.1–2.2] |
| B4 | calibrated judge alone | 205 | 0.2 | 2.9% [1.3–6.2] | 100.0% [98.5–100.0] | 0.0% [0.0–1.5] |
| B5 | certifier + judge | 205 | 0.2 | 2.9% [1.3–6.2] | 100.0% [98.5–100.0] | 0.0% [0.0–1.5] |
| B6 | refuter + judge | 117 | 0.8 | 1.0% [0.3–3.5] | 94.0% [90.4–96.3] | 6.0% [3.7–9.6] |
| B7 | certifier + refuter, no judge | — | — | 0.0%† [0.0–1.8] | 13.5% [9.9–18.3] | 86.5% [81.7–90.1] |
| **B8** | **full system (proposed)** | **117** | **0.8** | **1.0% [0.3–3.5]** | **94.0% [90.4–96.3]** | **6.0% [3.7–9.6]** |
| B9 | full, no escalation band | 117 | 0.8 | 1.0% [0.3–3.5] | 94.0% [90.4–96.3] | 6.0% [3.7–9.6] |
| B10 | full, hand-set τ=0.5 | 117 | 0.5 | 1.5% [0.5–4.2] | 99.6% [97.8–99.9] | 0.4% [0.1–2.2] |
| B11 | full, naive pairwise, `m`=5 | 117 | 0.8 | 1.0% [0.3–3.5] | 94.0% [90.4–96.3] | 6.0% [3.7–9.6] |
| B12 | full, corrected max-over-`m`, `m`=5 | 117 | 0.95 | 0.0% [0.0–1.8] | 19.9% [15.4–25.3] | 6.0% [3.7–9.6] |

Paired exact McNemar tests over discordant items, Holm-corrected **within family** — liveness and safety are different questions and pooling them would dilute both:

| family | comparison | discordant | exact *p* | Holm |
|---|---|---|---:|---:|
| dedup | B8 vs B2 content-addressed | 202 / 0 | 3.1e-61 | 2.5e-60 * |
| dedup | B8 vs B7 decidable-only | 202 / 0 | 3.1e-61 | 2.5e-60 * |
| dedup | B8 vs B5 certifier+judge | 0 / 15 | 6.1e-5 | 3.7e-4 * |
| dedup | B8 vs B4 calibrated judge alone | 0 / 15 | 6.1e-5 | 3.7e-4 * |
| dedup | B8 vs B3 raw judge | 0 / 14 | 1.2e-4 | 4.9e-4 * |
| dedup | B8 vs B10 hand-set τ | 0 / 14 | 1.2e-4 | 4.9e-4 * |
| dedup | B8 vs B6 refuter+judge | 0 / 0 | 1.00 | 1.00 |
| dedup | B8 vs B9 no band | 0 / 0 | 1.00 | 1.00 |
| **WS** | **B8 vs every comparator** | ≤ 4 / 0 | ≥ 0.125 | ≥ 0.625 |

Four things follow, and two of them are uncomfortable.

**The certifier contributes nothing to the outcome here, and its value is not the outcome.** B6 (refuter + judge, no certifier) and B8 (full) are *identical on every test item*: zero discordant pairs. On this corpus, with this judge, the judge re-derives everything canonicalisation already knew. The certifier's contribution is not a rate — it is that the decisions it settles carry `WS = 0` **by construction under A5** rather than `WS ≤ α` by calibration, and that they cost no model call. A reader who values only the rate should remove L0; a reader who wants a fragment whose correctness does not depend on an oracle should keep it. The matrix makes the choice explicit instead of implying the layer earns its place empirically. It does not, on this corpus.

**The escalation band is inert on this judge, and that is a property of the oracle.** B9 equals B8 exactly, because the primary judge's calibrated band is empty (`t_lo` = `t_hi` = 0.8). §8.10 shows the same ablation converting 15.9 points of silent escape into flagged escape on the more saturated 20B. The band is not a component with a fixed value; it is a component whose value is a function of the score distribution it is handed.

**None of the wrong-suppression comparisons is significant.** Every WS comparison in the matrix rests on at most four discordant items and none survives Holm correction. The full system's 1.0% against the calibrated-judge-alone 2.9% is a difference of four items out of 206. We therefore claim **no** benign wrong-suppression advantage for any configuration over any other, and rest the mechanism's safety case where the evidence is decisive: on the D4a injection class, which the refuter closes by construction (§8.4), and on the bound itself, which is a statement about a rule rather than a difference between two rates.

**The multiplicity correction has a visible price on the main corpus.** B11 and B12 are the *same rule* at `m` = 1, and printing the identical row is the point: the defect is invisible until a run has committed more than one effect per tool. At `m` = 5 the corrected threshold rises from 0.80 to 0.95 and deduplication falls from 94.0% to 19.9%, with the difference going into the escalation band rather than into silent execution. The two rows differ on only two DIFF items (p = 0.5), so the correction's *safety* benefit is not demonstrable on this corpus at this `m`; §8.6 is where it is demonstrable, at `m` = 50, and the Monte-Carlo of §8.14 is where it is demonstrable independently of any corpus.


### 8.14 A statistical audit of the calibrated layer

A calibration bug does not announce itself. It produces a threshold that is confidently derived and quietly invalid, and every rate downstream of it looks entirely normal. We therefore audit the *construction* rather than only the outcome, in a script that fails the build (`src/experiments/conformalAudit.js`). All fifteen checks pass on the corpus as shipped; three of them are worth reporting in the paper rather than leaving in the artifact.

**The correction is validated independently of any corpus.** Drawing calibration and test scores from one continuous distribution makes every comparison exchangeable by construction, so any exceedance is the multiplicity effect and nothing else. Over 2,000 replications at `n` = 200, α = 0.05:

| `m` | uncorrected pairwise rule | Bonferroni-corrected rule |
|---:|---:|---:|
| 1 | 5.0% | 5.0% |
| 2 | 11.2% | 5.7% |
| 5 | 22.9% | 4.5% |
| 10 | 38.3% | 3.7% |
| 25 | 70.3% | 0.0% |
| 50 | 89.0% | 0.0% |

The uncorrected rule reaches nearly nine times its declared level by `m` = 50; the corrected rule holds at every `m`, and switches off entirely (0.0%) once the budget `m > α(n+1)` is exceeded, which is the intended failure direction. The test asserting that the *uncorrected* rule violates the level is part of the artifact's suite: if it ever passes, the correction is untested.

**What α promises, measured on the jurisdiction-matched pool.** T3 bounds the suppression probability *marginally* over draws of the calibration pool and the test point jointly. It does not promise that the rate realised on a particular deployment's pool is at most α. Resampling the residual calibration pool 300 times per size and evaluating on the fixed residual test pairs:

| pool `n` | mean realised WS | median | p95 | max | share of draws exceeding α | certifiable `m` |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | — (`t_hi` = +∞ on every draw) | — | — | — | — | 0 |
| 20 | 3.1% | 1.7% | 13.4% | 13.4% | 15.7% | 1 |
| 30 | 1.8% | 0.8% | 7.6% | 13.4% | 7.0% | 1 |
| 50 | 2.0% | 1.7% | 4.2% | 13.4% | 1.7% | 2 |
| 100 | 2.5% | 2.5% | 4.2% | 7.6% | 3.0% | 5 |

This **refines a claim made in an earlier version of this analysis**, which resampled from the wider, jurisdiction-mismatched pool and reported a p95 of roughly twice α at every size, with the gap not closing as data grew. On the pool the deployed rule actually uses, two things separate that were previously conflated. The **mean** realised rate is flat in `n` — the bound is a rank statement, not an estimation problem, so more data does not make the judge more accurate, and the earlier reading is correct about the average. The **tail** is not flat: the p95 falls from 13.4% at `n` = 20 to 4.2% at `n` = 50, and the share of draws exceeding α falls from 15.7% to around 3%. More calibration data buys two distinct things — multiplicity budget, and a tighter distribution of realised rates across draws — and it buys neither semantic accuracy nor a per-deployment guarantee. Roughly one draw in thirty still exceeds the declared level at `n` = 100, and a deployment does not get to redraw its pool.

**A provenance disclosure, and the split that closes it.** Calibration and test splits share no pair id, and the audit asserts it. They do share underlying *seed acts*: **425 of 513 test pairs (82.8%)** derive from a seed act that also appears somewhere in the calibration split. Exchangeability is a condition on scores rather than on provenance, so this is not automatically a violation — but it is a route by which a judge could score a test pair optimistically because it saw a sibling phrasing during calibration.

An earlier revision of this paragraph ended "we have not built one". We have now built one. `src/experiments/seedSplit.js` partitions the 219 distinct **seed acts** first and lets every pair follow its seed, so no seed appears on both sides and leakage is **0.0% by construction** rather than by assumption. Because whole seeds move together and seeds are unequally productive, a single seed split is a coin flip; we therefore report the distribution over **200 seed-level splits** rather than one draw.

| judge | pair-split WS (as shipped) | seed-split WS: mean | median | p95 | draws exceeding α |
|---|---|---:|---:|---:|---:|
| GPT-OSS-120B | 1.7% [0.7–4.3] | **2.7%** | 2.8% | 5.2% | **10.5%** |
| GPT-OSS-20B | 1.3% [0.4–3.7] | **2.2%** | 1.7% | 4.2% | 1.0% |
| Qwen3.6-27B | 0.9% [0.2–3.1] | **1.8%** | 1.3% | 5.7% | **11.0%** |

| judge | pair-split dedup | seed-split dedup: mean | median | p05 |
|---|---|---:|---:|---:|
| GPT-OSS-120B | 94.7% [91.4–96.7] | 96.0% | 98.4% | 88.1% |
| GPT-OSS-20B | 82.6% [77.7–86.6] | 85.7% | 83.5% | 79.5% |
| Qwen3.6-27B | 89.0% [84.8–92.1] | 89.2% | 88.6% | 86.3% |

**It moves, and it moves in the direction that costs us.** Removing seed-level leakage raises mean wrong-suppression on **every** judge — 1.7→2.7%, 1.3→2.2%, 0.9→1.8% — a consistent factor of roughly 1.5 to 2. The shipped pair-level split was therefore mildly **optimistic** about the safety-critical rate, which is what the disclosure was worried about, and we now have the size of it rather than an assurance. Deduplication does not degrade at all; if anything it rises slightly.

**The tail is the part a practitioner should read.** On the primary judge, **10.5% of seed-level splits realise a wrong-suppression rate above the declared α = 0.05**, and on Qwen 11.0%. That is not a contradiction of T3 — the bound is marginal over draws of the calibration pool and the test point jointly, exactly as §8.14's resampling study says, and a deployment does not get to redraw its pool — but it is the same lesson arriving through a second door, and it is sharper here because the draws differ in *provenance* rather than only in sampling. Two sources are mixed in that tail and we separate them plainly: the **mean** shift is attributable to leakage removal, while the **spread** is inflated by seed-level splitting itself, since whole blocks of correlated pairs move together and the effective sample is smaller than the pair count suggests. We do not claim to have decomposed the two.

**What we conclude.** The headline survives seed-level splitting in the qualitative sense that matters — mean wrong-suppression stays inside α on all three judges, and deduplication is unaffected — and it survives with a materially worse constant than the pair-level split reports. A reader who wants one number for the safety rate under the strictest available split should take **2.7% mean, 5.2% at the 95th percentile** on the primary judge, not 1.7%. We have amended nothing in §8.3, because §8.3 reports the pair-level split it says it reports; this is the robustness check beside it, which is where a result this size belongs.

**What the audit does not certify.** It checks the construction of the bound, not the truth of A6. Exchangeability between calibration and deployment is an assumption about the world that no offline check can establish, and §8.4 is the case where it visibly fails.

### 8.15 RQ2/T6 — the schema-richness ladder: monotonicity confirmed, the refinement-budget question confounded by which attribute stays in prose

§8.9 tested T6's monotonicity at exactly two points — one tool, re-declared once. This section reports a three-level ladder built to test it as a trend, plus a second experiment aimed at the question §8.9 raised and could not answer: is the refinement dilemma (Corollary T6.3′) a shortage of calibration data or an intrinsic property of the residual that survives refinement?

**Design.** One act family — a vendor payment fully described by seven attributes (payer, payee, amount, currency, invoice, instalment index, cost centre) — is declared three ways. **L1** types nothing; one prose instruction carries the whole act. **L2** types payer, payee, amount and currency; invoice and instalment stay in prose. **L3** adds invoice and instalment; only the cost centre remains untyped at every level, by design — a ladder whose top rung types everything would make the residual vanish by construction rather than by evidence. Every one of eight abstract acts is rendered at all three levels, so the comparison is paired item-by-item, and every distinct-act mutation is tagged with the level at which the design predicts the schema starts pinning it. 570 pairs were generated and scored by the primary judge with zero abstentions.

**Result 1 — T6 monotonicity holds as a trend, and the implementation matches its own design.**

| level | typed attributes | certifier | refuter | residual | judge jurisdiction | pool `n` |
|---|---:|---|---|---|---|---:|
| L1 (loose) | 0 | 0.0% [0.0–3.6] | 0.0% [0.0–3.6] | **100.0% [96.4–100.0]** | 100.0% [96.4–100.0] | 32 |
| L2 (moderate) | 4 | 0.0% [0.0–3.6] | 58.8% [49.1–67.9] | **41.2% [32.1–50.9]** | 41.2% [32.1–50.9] | 12 |
| L3 (strict) | 6 | 0.0% [0.0–3.6] | 80.4% [71.6–86.9] | **19.6% [13.1–28.4]** | 19.6% [13.1–28.4] | 4 |

The residual shrinks at every step (100.0% → 41.2% → 19.6%), and judge jurisdiction shrinks with it exactly, because on this construction the two are the same quantity by definition (Definition 6). A per-class check confirms the refuter fires exactly where the design says it should — every mutation tagged "decided from L2" is vetoed at L2 and L3 and not at L1, and likewise for the L3-only classes — so this is not merely a correlation the data happens to produce; the mechanism is doing what T6 says it must. The certifier stays at zero throughout by construction (no two renderings at any level are byte-identical after the prose is reworded), which is the expected shape for a ladder built to isolate the refuter's contribution.

**Result 2 — the fixed-versus-replenished comparison is confounded, and we report why rather than force a reading.** The plan was to separate two explanations for the deduplication collapse §8.9 found (94.0% → 19.9%): a shortage of calibration data, or an intrinsically harder residual. Every level's natural pool is small (32, 12, 4), so a replenishment pool of pairs residual at every level — differing only in cost centre, the one attribute no rung types — was built to top every level up to a common `n` = 52.

Deduplication is 0.0% at every level under **both** conditions, fixed and replenished alike. That is not the result we predicted, and it does not, on inspection, answer the question the experiment was built to ask — because the reason is not calibration budget. At L1 the natural pool's top scores are `[0.97, 0.98, 0.99, 1, 1]`; the conformal index for `n` = 32 at α = 0.05 lands on the pool's own maximum, and a strict inequality against a score of 1.0 can never be exceeded. Breaking that pool down by mutation class shows why: seven of the eight distinct-act categories score reliably low (medians ≤ 0.1, correctly recognised as distinct), and two do not — **cent-level amount changes** (`[0.15, 0.95, 0.95, 0.97, 0.98, 0.99, 1, 1]`, the same near-miss the main corpus's generator comments flag as "the hardest and most dangerous"), and **cost-centre changes** (`[0.1, 0.9, 0.95, 0.95, 0.95, 0.98, 1, 1]`). The replenishment pool is drawn entirely from the second of these two categories, and its own top ten scores are `[1, 1, 1, 1, 1, 1, 1, 1, 1, 1]` — the judge treats "same payment, different internal cost-centre allocation" as the same act essentially without exception. Adding more of it does not add headroom; it adds more mass at the ceiling the pool already had.

**What this shows, stated as precisely as the result allows.** The experiment does not distinguish "budget-limited" from "intrinsically harder" for this ladder, because the two candidate explanations were confounded by a third: the specific attribute chosen to stay in prose at every level (cost centre) turned out to be one the judge does not treat as act-determining, independent of how much of it the pool contains. That is itself informative, in a way the original plan was not designed to surface. A fixed-versus-replenished comparison only isolates the calibration-budget question if the replenishment source matches the *difficulty* of the residual under test, not merely its label; drawing replenishment from a category the oracle already resolves confidently is not a stress test of the calibrated layer, it is a stress test of nothing. Whether "different cost centre, same wire" is in fact one act or two is also a legitimate question on its own terms — arguably closer to the D2 category of §8.12 (a contested construction choice) than to a clean DIFF — and we did not adjudicate it before running the experiment, which is the design mistake here rather than a flaw in the mechanism under test.

**What we do not conclude.** We do not conclude that replenishment cannot recover deduplication after schema refinement; this experiment could not test that, and does not claim to. We do not revise T6.3′, which concerns the *pool size* effect and is unaffected by this result. We do conclude that the monotonicity claim (T6.3) is now supported as a three-point trend with a passing per-class design check, which it was not before this round, and that a repeat of the refinement-budget experiment needs a replenishment source whose per-item difficulty is checked against the natural pool before the comparison is run — a design correction we record here rather than in a rewritten "clean" result.





---

### 8.16 Independent validation of the ground truth: a blinded model panel

This is the control §7.4 specifies, run and reported. It was **preregistered before any judgement was collected**, against a sheet frozen and content-hashed per item, and the analysis below is the analysis registered — no statistic here was chosen after seeing a response.

**What ran, and what did not.** The human channel (Channel H) was not collected; the instrument is shipped and unrun, and we claim nothing from it. What ran is **Channel M, a blinded panel of three models** — `groq/compound`, `groq/compound-mini`, `qwen/qwen3.6-27b` — with `openai/gpt-oss-safeguard-20b` as a blind adjudicator, each shown one pair per request with the operational definition and nothing else: no constructed label, no model prediction, no mechanism decision, no threshold, no attack flag. The primary judge is barred from the panel. **This is not a human study and nothing below should be read as one.**

**Reliability.** 116 of 154 items were answered by all three annotators; the shortfall is one panelist's non-response on long pairs, not a dropped annotator, and all four passed all three catch trials.

| statistic | value |
|---|---|
| Krippendorff's α (ternary, nominal) | **0.828** |
| Fleiss' κ | 0.827 |
| pairwise Cohen's κ | 0.862, 0.812, 0.811 |
| adjudication rate | **0.0% [0.0–3.2]** |
| `UNSURE` rate | 0.0% |
| overall construction agreement | **87.9% [80.8–92.7]** |

No item failed to reach a majority, so the adjudicator was never invoked — which is itself the finding the preregistration asked for: a construction needing frequent adjudication is one that is not capturing a shared notion of "the same act", and this one needed none.

**Per stratum — and this is where the result lives.**

| stratum | constructed | n | agreement | contested? |
|---|---|---:|---|---|
| `same_mechanical` | SAME | 12 | 100.0% [75.8–100.0] | no |
| `same_paraphrase` | SAME | 10 | 100.0% [72.2–100.0] | no |
| **`same_loose_value`** (the motivating example) | SAME | 11 | **100.0% [74.1–100.0]** | no |
| `same_adversarial` | SAME | 12 | 100.0% [75.8–100.0] | no |
| `attack_field` | DIFF | 12 | 100.0% [75.8–100.0] | no |
| `attack_encoding` | DIFF | 11 | 100.0% [74.1–100.0] | no |
| `misdeclared` | DIFF | 3 | 100.0% [43.9–100.0] | no |
| `diff_near_miss` | DIFF | 14 | 92.9% [68.5–98.7] | no |
| `diff_semantic` | DIFF | 8 | 87.5% [52.9–97.8] | no |
| **`diff_text_only`** (D2) | DIFF | 12 | **50.0% [25.4–74.6]** | **YES** |
| **`attack_text`** | DIFF | 11 | **45.5% [21.3–72.0]** | **YES** |

Two strata are **contested** under the preregistered rule (agreement Wilson upper bound below 0.80), and one of them is the stratum the preregistration named in advance as the most likely to be contested. **D2 is contested. We said it would be, and it is, and we are reporting it rather than resolving it by author fiat.**

**Every disagreement is in the residual.** There are 14 label flips, and their distribution is the paper's own thesis arriving from an unexpected direction:

| category | flips | what distinguishes the acts there |
|---|---:|---|
| `D2_legit_repeat` | 6 | a distinguishing token in free text |
| `A7_mimicry_prose_only` | 3 | prose only |
| `A2_prose_only_injection` | 3 | prose only |
| `D3_semantic_diff` | 1 | prose only |
| `D1_near_miss` | 1 | a declared field |

**Thirteen of fourteen flips fall in categories where act-distinguishing information lives only in prose.** Not one falls in a category the certifier or the refuter decides. This is the strongest evidence in the paper for T6, and it arrives as a fact about *readers* rather than about oracles: the residual is not merely where the mechanism errs and where a judge is unbounded — it is where **independent readers do not agree what the right answer is**. A pair whose distinguishing information is not in the declaration is not simply hard to classify; its ground truth is contested. T6 says the residual is a function of the declared schema alone, independent of the oracle. This panel is not an oracle in T6's sense, and it lands in the same place anyway.

**The re-derivation, and the preregistered rule it triggers.** Wrong-suppression and deduplication recomputed over the annotated subset, threshold taken from the untouched full calibration split so that relabelling cannot leak into its own threshold:

| labelling | WS | dedup |
|---|---|---|
| constructed | 9.9% [4.9–19.0] | 77.8% [63.7–87.5] |
| panel-adjudicated | **10.5% [4.9–21.1]** | 61.0% [48.3–72.4] |

The preregistration fixed this rule in advance: *if the adjudicated WS point estimate exceeds both the constructed WS point estimate and the declared α = 0.05, the safety claim is reported as not surviving independent relabelling, and the abstract is amended.* Both conditions hold — 10.5% > 9.9% and 10.5% > 0.05. **We report accordingly: on this stratified subset, under independent relabelling, the safety claim does not survive.** The abstract has been amended to say so.

What that does and does not mean must both be stated, and neither swallows the other:

- It is **not** an estimate of deployment wrong-suppression. The subset is deliberately adversarial — seven of eleven strata are DIFF or attack, including both injection classes — so it is far harder than the test split by construction. The same mechanism under the *constructed* labels scores 9.9% here against 1.7% on the full test split (§8.3). The subset was built to concentrate difficulty, and it did.
- The movement attributable to relabelling is therefore **0.6 points**, on intervals that overlap almost entirely ([4.9–19.0] against [4.9–21.1]).
- But the rule was written in advance precisely so that we could not, on seeing a number we disliked, start reasoning about why it should not count. It triggered. We report it as triggered, and a reader who thinks the 0.6-point movement is the more informative quantity now has both numbers and can say so.

**Deduplication moves much further than safety does** — 77.8% to 61.0%, a 17-point drop against wrong-suppression's 0.6-point rise. That is the same asymmetry §8.8 finds across judges and §8.14 finds across splits, appearing a third time under a third kind of perturbation: relabel the ground truth and the liveness direction moves freely while the safety direction barely stirs.

**Sensitivity to the overlapping panelist.** One annotator, Qwen3.6-27B, is also a reported judge in §8.8. Dropping it entirely and recomputing on the remaining two: Krippendorff's α rises to **0.863** and construction agreement to **91.7% [84.9–95.6]** on 108 items. Agreement is therefore *not* being propped up by a panelist that shares the evaluation's own machinery — removing it makes the construction look better, not worse.

**What this study cannot do**, stated once more where the numbers are: it validates 154 items and not 1,066; at this size even a flawless result carries a 95% lower bound of 97.6%; and being a model panel, it cannot detect a notion of "the same act" shared between the authors and the panel but idiosyncratic relative to human practice. Channel H remains the stronger control, remains built, and remains uncollected.

## 9. Discussion

The results above are best read as a set of boundaries rather than a set of scores: each of the following says where the mechanism stops, why the theory predicts it stops there, and what experiment would move the boundary. Several are places where the design fails, and we take those to be part of the contribution rather than a caveat attached to it, since a mechanism whose failure region is unmapped cannot be deployed against an asymmetric loss.

**Wrong-suppression is small but not zero, and cannot be driven to zero by this design.** At α=0.05 the mechanism silently drops **1.0% [0.3–3.5]** of genuinely distinct actions, or **1.7% [0.5–5.9]** of the residual pairs the bound is about. T4 says this is not a tuning failure: once the SAME and DIFF score distributions overlap, no threshold on the score achieves zero wrong-suppression and zero silent escape at once. The only zeros in this paper come from decidable layers. A deployment that cannot tolerate *any* silent drop of a distinct irreversible action should not enable semantic suppression at all — it should run L0 plus the witness, take the 13.5% deduplication, and escalate the rest.

**Every wrong suppression lands where the schema is silent.** On the benign split the fence wrongly suppresses two pairs out of 206, one in D1 and one in D2, and both are residual: agreeing on every declared field, distinguished only by a token in prose. Under injection, the same structural gap gives **84.0% [65.3–93.6]** wrong-suppression on D4b. Attack and benign failures coincide on one cause, which is some evidence that the cause is the schema's rather than the attacker's — and §8.9 shows the tightened schema closing both. We can measure this and cannot force tool authors to adopt it.

**The irreducible window is real, we measured it, and no local mechanism closes it.** T1's remark predicts a re-fire when the process dies between the provider call landing and the commit row being written, and §8.7 reproduces it across the two window crash points, in 11 of 12 trials, with the twelfth flagged rather than prevented. T5 Case A closes it only by composition with a provider whose idempotency key is *complete* for effect identity — which, as §6.8 now states explicitly, the distinctness witness alone does not supply. A deployment on a witness-only schema (A5′ without A5″) inherits this window no matter how good its judge is.

**The conformal bound rests on exchangeability, and the attack split violates it deliberately.** T3 is distribution-free in the score but not assumption-free: it needs calibration and test distinct-pair scores to be exchangeable, conditional on candidate-set size. Prompt injection is a deliberate distribution shift, so **the guarantee does not apply to §8.4 and we do not claim it there** — visibly so, since the calibrated layer is slightly *worse* than the raw judge on D4a (70% vs 65%). Group-conditional and shift-robust conformal constructions are the natural next step.

**The multiplicity correction is conservative, and its budget binds.** The union bound is tight only when at most one candidate can score high. Its price is that semantic suppression switches off entirely once `m > α(n+1)`. The budget is set by the pool the deploying configuration can actually gather, which by §6.6 is its own jurisdiction: the witness-free rule calibrates on 205 pairs and certifies `m` ≤ 10, the hardened rule on 117 and certifies `m` ≤ 5, and the tightened rule on 35 and certifies `m` ≤ 1. Supporting `m` = 50 at α = 0.05 would need 999 pairs in whichever of those pools applies. This is a hard property of the calibration budget rather than a knob, and a run that commits many effects per tool will silently lose deduplication unless its calibration set is sized for it.

**Judge coverage is uneven, and the cross-family evidence spans two vendors.** Four judges were scheduled; three reached full-corpus coverage — GPT-OSS-120B and GPT-OSS-20B at 100%, Qwen3.6-27B at 97.4% after a resumed pass — while per-model daily allowances halted the Llama arm at 6.3% (§8.1). Every main table in §8 is therefore three judges over two vendors, and wrong-suppression stays inside α on all of them while deduplication moves twelve points (§8.8). What is not established is a *third* vendor: two is enough to separate a mechanism property from a single vendor's idiosyncrasy, and not enough to call the result general. One methodological trap is worth naming because we expect it to be common: a judge that abstains on most pairs yields `t_hi = +∞` and produces a table row reading "0% wrong-suppression, 0% silent escape" — a perfect-looking judge that is in fact no judge at all. Rates computed over abstentions are not results, and we exclude such rows rather than print them.

**Output-contract enforcement is part of the method.** A judge that answers on an unexpected scale produces well-formed, silently wrong scores, and a harness that instruments only the rate at which the judge *fails to answer* will not detect it (§7.2). We regard strict parsing, explicit abstention, and reporting parser outcomes beside the rates that depend on them as methodological requirements for any evaluation of this kind, not as implementation hygiene.


**Labels are ours.** Every label is by construction, which makes the corpus controlled and reproducible and also makes it an artefact of the authors' definition of "the same action". The hand-authored generator arm removes the machine-generation confound (§8.8) and not this one. Until independent labelling is carried out (§7.4), agreement between the construction and a careful reader is assumed rather than measured.

**Scope of the evidence.** 955 pairs over six tools, adversarially seeded, **not drawn from production traffic**; a fault-injection harness rather than a fleet; a single-node durable log (a file; the production analogue is SQLite/Postgres with a UNIQUE constraint). The claims are about *properties* — bounded identity recognition, at-most-once fence commitment, measured behaviour across paraphrased process death — not about scale.

**Assumptions are adoption obligations.** A5, A5′ and A5″ are contracts the schema author signs; A7 is the scheduler's; A8 is a third party's. A misdeclared policy voids the corresponding guarantee, and none of them is inferred or verified automatically. Inferring and *verifying* effect-class and field policies from documentation, traces and probes — under the brutal loss asymmetry that calling an effect-determining field `text` is the dangerous error — is the natural next problem.

**Judge cost and latency.** 735 judge calls and 5,431 judge tokens per 1,000 irreversible dispatches, at 2,061 ms mean latency on the critical path of a judged dispatch. The decidable layers settle 26.5% of decisions without a model call, and the tightened schema raises that to 43.5%. A fence on a hot path must budget for this, and an adversary can try to force judging by evading L0.


### 9.1 Generalisation: bounded-oracle decisions under asymmetric loss

Effect identity is one instance of a shape that recurs throughout agent safety: **a binary decision, with sharply asymmetric consequences, that no decidable procedure settles in general, and for which the only available general-purpose decider is a stochastic model.** Authorization ("is this action within what the user approved?"), tool selection ("is this the tool the plan intended?"), content release ("does this message disclose something it should not?"), and escalation ("does this need a human?") all have it. The mechanism in this paper is, we think, less interesting as a fence than as a worked example of a recipe for that shape.

We state the recipe, then state which parts of it this paper's evidence supports.

**The recipe.** Given a decision `P(x)` with a safety-critical direction and a fallible oracle `O`:

1. **Find the decidable certifier.** Identify a sound sufficient condition for `P` — a relation `C ⊆ P` computable without the oracle. Decisions it settles are exact and free. (Here: canonical equality under a declared normalisation.)
2. **Find the decidable refuter.** Dually, identify a sound sufficient condition for `¬P`. This is the step most often skipped, and it is where adversarial robustness comes from, because a refuter that fires *before* the oracle is consulted cannot be argued with by anything the oracle reads. (Here: the projection witness.)
3. **Name the residual.** `Res = ¬(C ∪ D)` is a function of the declaration alone (T6). It is the only region where errors are possible, the only region the oracle should ever see, and the quantity to attack when the error rate is unacceptable.
4. **Calibrate the oracle on the residual, in the safety-critical direction only.** Two things must match the deployment, and both are easy to get wrong. Calibrate **the statistic actually deployed** rather than a convenient proxy: if the rule aggregates several oracle calls, the aggregation belongs inside the calibrated object (T3). And calibrate on **the population actually routed to the oracle**, which is the residual and not every undecided pair: a pool holding pairs the refuter would have vetoed is easier than deployment, depresses the threshold, and breaks the guarantee in the unsafe direction (§6.6, §8.3). Both are corrections this paper had to make to itself, and neither announced itself in a rate measured over the whole population.
5. **Make the undecided band auditable, not silent.** Reserve a middle region that acts conservatively *and* leaves a durable record, so that residual errors are recoverable rather than invisible.
6. **Report the budget.** Calibration spends a finite statistical resource; subdividing the decision space (per tool, per candidate-set size, per group) spends it faster. State the budget as an engineering requirement (`n ≥ m/α − 1` here) rather than discovering it as an unexplained loss of coverage in production.

**What this paper's evidence supports, and what it does not.** Steps 1–3 rest on T2, T6 and the measured jurisdiction split — 26.5% of decisions settled without a model call, 43.5% under a tightened schema. Step 4 rests on T3, its Monte-Carlo validation, and the nested-candidate experiment in which the uncorrected rule wrongly suppresses 65.0% of held-out distinct units at `m` = 50 and the corrected rule suppresses none (§8.6). Step 5 is the weakest link in the chain here: on the primary judge at α=0.05 the escalation band is *empty*, because the benign score distributions separate cleanly, so the band's value is visible only at α=0.01, where it converts 8.8% of duplicates from silent escapes into flagged ones. We report that as the band's measured contribution and decline to claim more. Step 6 rests on two independent measurements of one budget phenomenon — the multiplicity limit (`m` ≤ 10 at α = 0.05, n = 205) and the per-tool split (−19 points of deduplication when one pool is divided six ways).

**What we have not shown** is that the recipe transfers. We have one instance, one tool surface, and one loss asymmetry. The claim that certifier/refuter/residual is the right decomposition for *authorization* or *content release* is a conjecture this paper motivates and does not test, and we would regard an attempt to apply it elsewhere as the most valuable follow-on to this work — more valuable, we think, than tightening any number in §8. The transferable content is the decomposition and the discipline it imposes: **never let a model decide what a declaration already settles, never let it decide unboundedly what the declaration does not, and never let its failures be silent.**

**A structural prediction, offered so it can be falsified.** If T6 is the right way to see this, then across all such decisions the same pattern should hold: interventions on the *oracle* trade one error direction against the other, while interventions on the *declaration* dominate. We observe exactly that here — every judge-side change we tried (α, per-tool thresholds, ensembles, a cheaper scorer) traded axes, while the single schema change improved all of them at once. One instance is not evidence of a law. But it is a sharp enough prediction that a counterexample would be informative, and we would rather state it than leave the result looking like a lucky ablation.

---


### 9.2 An apparatus we built and did not score, and why that is a cut rather than a result

An earlier revision of this section described two further apparatuses — an extended fourteen-tool surface (`corpus/pairs-v2ext.jsonl`, 1,043 pairs) and an eleven-class adversarial matrix (`src/experiments/attackMatrix.js`) — in full methodological detail, without a number from either, on the argument that a reader deciding whether to trust the paper's account of its own gaps should be able to see that the apparatus exists.

We now think that was the wrong call, and we have cut it. A described-but-unscored apparatus occupies the space of a result while carrying none of the obligations of one: it cannot be checked, cannot be wrong, and quietly borrows credibility from the sections around it. The apparatus remains in the artifact and is documented there. What it does not have is a place in the body of the paper, because it has no findings.

The cost of scoring it is a measurement rather than an excuse. At the fourteen-tool surface's prompt sizes, the primary judge scores roughly one pair per 57 seconds of wall clock — the tool manifest is long, and this is a reasoning model budgeted accordingly — so the 1,043-pair corpus is of order fifteen hours for a *single* judge, and §8.1's admission rule would want a second before any rate from it entered a table. That is a real experiment for a later paper and not a gap in this one.

It is listed once in §9.3 and nowhere else.

### 9.3 Future work

Three of these are execution rather than research, and we list them first because a reader is entitled to know which gaps are ideas and which are quota.

- **A third judge vendor at full coverage.** The full-coverage cross-family comparison this list previously named is done: Qwen3.6-27B now sits at 97.4% in every main table (§8.8), and the claim that wrong-suppression is bounded while deduplication is not is measured across vendors rather than on a subset. What is missing is a *third* vendor, and what is missing for it is inference allowance rather than method. The endpoints have moved under us since these runs: the two Llama models used for the v1 generator arms and for §8.6 are no longer reachable on this key at all, which is itself a reproducibility hazard worth naming — an evaluation whose oracle is a third-party endpoint has a shelf life, and ours has already partly expired.
- **A human-annotation study** (§7.4): the harness is complete rather than merely planned — 154 blinded items spread across 11 strata and every tool family, a formal majority-plus-adjudication procedure, Fleiss' κ, Krippendorff's α, and a re-derivation of the mechanism's headline rates under human labels, all implemented in `src/experiments/annotation.js`. What remains is exclusively the collection of independent responses, not method. This is the one item on this list that is genuinely open research rather than engineering, since it is the only proposed control on the fact that the labels are the authors' own operationalisation.
- **Tightening the multiplicity correction.** Bonferroni is valid under arbitrary dependence and pays for it: semantic suppression switches off entirely once `m > α(n+1)`. Direct set-conformal calibration is implemented but needs `≥19m` calibration pairs per `m`; a step-down procedure, or a bound exploiting the observed dependence among candidate scores, would extend the usable range of `m` without inflating the calibration budget.
- **Calibrated-uncertainty judges** so that false negatives surface as flagged escapes rather than silent ones, and an ensemble treatment that widens the score distribution enough for the escalation band to bind.
- **Effect-class and field-policy inference with verification** — learning A5/A5′ declarations from docs/traces/probes under the brutal loss asymmetry (calling an irreversible field `text` is the dangerous error).
- **Group-conditional and adversarial conformal bounds** — extending T3 from marginal to per-tool coverage, and to bounds that hold under the bounded distribution shift an injection adversary can induce.
- **Distributed semantic ledger** preserving T1's uniqueness and T3's calibration under sharding and partition.
- **Formal mechanisation** of T1–T5 in a proof assistant, and model-checking the concurrent commit path with the witness.
- **Compensation on flagged escape** — when a duplicate is flagged rather than prevented, synthesising and firing a compensating action to reverse it, closing the loop from *detect* to *repair*.

## 10. Threats to validity

**Construct validity — does the corpus measure effect identity?** Labels are assigned by construction: a pair is SAME because a generator was instructed to preserve the act and a validator confirmed that every numeric mention survived, and DIFF because a declared field was mutated or a distinguishing token inserted. This makes the ground truth an operationalisation of the authors' definition of "the same action" rather than an independent one. The construction is conservative in one direction — a validator that rejects any variant altering a pinned value cannot admit a false SAME — and unguarded in the other, since a mutation the authors consider act-changing might not be. The hand-authored generator arm (§7.1) removes the machine-generation confound and not this one; independent labelling (§7.4) is the appropriate control and is not carried out here. What we do instead is bound the exposure: §8.12 re-derives the headline under the one contestable category (D2) relabelled, and under the most hostile reading of our own corpus we can construct, and finds wrong-suppression stable at 1.0%, 0.8% and 2.1% while deduplication moves from 94.0% to 24.9%. The safety conclusion does not depend on our definition of the same action. The liveness conclusion does.

**Internal validity — could the results be produced by something other than the mechanism?** Three confounds are controlled and two are not. Generator/judge circularity is controlled by four generator arms including one with no model in the loop (§8.8). Calibration/test **item** leakage is controlled by a fixed 50/50 split stratified on (category, generator), with the attack categories held out of calibration entirely, and this is enforced as a build assertion (§12). Ordering effects in the crash design are controlled by pairing both fence modes on an identical draw. What is *not* fully controlled is, first, judge-family effect: two judges reached usable coverage and both are GPT-OSS, so any property reported here may be an idiosyncrasy of one vendor's models rather than of the mechanism (§8.8 gets part of the way on a smaller cross-family subset). Second, and disclosed here for the first time: while no *pair* appears on both sides of the split, **86.4% of test pairs share an underlying seed act with some calibration pair** (§8.14). Exchangeability is a condition on the judge's *scores*, not on provenance, so shared ancestry does not automatically violate A6 — but it is a channel through which a judge that scored one phrasing of a seed during calibration could score a sibling phrasing optimistically at test time, and we have not ruled it out.

**External validity — do these results transfer?** The corpus is six tools, adversarially seeded, and not drawn from production traffic; the distribution of paraphrases an agent actually emits under a given prompt and temperature is unknown to us and is not sampled here. The tool surface is deliberately unfavourable in one respect — the wire tool carries its act in free text — and favourable in another, since five of six tools have typed fields that make the refuter effective. A deployment whose tools are uniformly loose should expect results closer to our D2 and D4b cells than to our headline.

**Statistical conclusion validity — are the intervals doing the work claimed?** Every rate carries a Wilson interval, and rates that are zero by construction are marked † and distinguished from zeros that are sample estimates. Several cells that carry qualitative weight are nonetheless small: S3, the motivating example, is 8 test pairs; D3 is 5; the D4a attack cell is 20; the crash/replay arms of §8.7 are 48 trials each. A 100% on 8 pairs admits a lower bound of 67.6%, and a 0% on 48 admits an upper bound of 7.4%; we quote both. The conformal guarantee is marginal over calibration draws. The resampling sweep of §8.11, over the jurisdiction-mismatched pool used throughout the main tables, shows the p95 realised rate at roughly twice the declared α at every size tested; the refinement in §8.14, over the pool the deployed rule actually uses, separates a flat mean from a tail that tightens with more data (p95 13.4% → 4.2% from n=20 to n=50) but does not close (roughly one draw in thirty still exceeds α at n=100). Either way, a declared α must not be read as the rate obtained on any particular pool.

**Reproducibility.** All scoring is persisted and the metric computation is pure offline recomputation, so the tables regenerate deterministically from the stored corpus without further model calls. The live-judge numbers themselves depend on third-party inference endpoints whose availability and quota shaped which arms could be evaluated (§8.1), and on model versions we do not control.


## 11. Limitations and non-claims

Reviewers and adopters should be able to find the boundary of the claim without reading the proofs. It is this.

**We do NOT claim:**

1. **Universal semantic equivalence.** We do not decide, in general, whether two natural-language descriptions denote the same act. We decide it soundly on the fragment a schema pins, and with a bounded error rate on the residue, under an exchangeability assumption that adversarial input violates.
2. **Zero wrong-suppression.** The mechanism silently drops distinct actions at a non-zero rate. The only zeros we report come from decidable layers (L0, the witness) and are marked †; every scorer-dependent rate carries an interval.
3. **Local exactly-once across the external commit window.** We claim at-most-once *commitment by the fence* (T1, guarantee B) and bounded *identity recognition* (T3, guarantee A). We explicitly do **not** claim that the external effect happens once when the process dies between the provider call and the local commit row. That window is not closable locally; we measure ourselves failing in it (§8.7).
4. **Robustness to arbitrary free-text distinctions.** Where two calls agree on every declared field and differ only in prose, the decision rests entirely on the judge, and under injection it is wrong most of the time (§8.4). The witness offers nothing there, by construction.
5. **Production-scale validation.** The evidence is a purpose-built corpus and a fault-injection harness, not production traffic, not a fleet, and not a longitudinal deployment.
6. **Immunity to a compromised or careless tool schema.** A5/A5′/A5″ are obligations the tool author signs. A field mis-declared `text` that determines the effect voids the witness; a field mis-declared `id` that does not determine the effect breaks L0 soundness. We do not infer or verify these declarations.
7. **That an LLM judge is intrinsically trustworthy.** The design assumes the opposite. The judge is treated as an uncalibrated, manipulable oracle whose aggregate error is bounded by calibration and whose jurisdiction is deliberately restricted.
8. **A third judge vendor.** §8.8 compares three judges over two vendors at full-corpus coverage (97.4–100%), on 930 of 955 jointly scored pairs, after a homogeneity test that finds the 25 missing scores unrelated to the pairs. Two vendors is not generality across vendors, and the Llama arm never became usable at all.
9. **That the fence achieves at-most-once across paraphrased replay *inside the commit window*, or at scale, or on tools other than the one tested.** Outside the window this claim is now supported rather than outstanding: against the deployed judge the fence is correct in 36 of 36 trials outside the window and 6 of 6 at `after_local_commit`, and drops no legitimate distinct action in 48 trials (§8.7). What we do **not** claim is anything inside the window, where it is wrong in 12 of 12 trials on the arm that reaches it; nor any rate below the 7.4% upper bound that 48 trials admit; nor transfer beyond one tool, one paraphrase pool and one judge. The earlier version of this experiment used a deterministic offline scorer and contradicted the prediction at 0 of 6; that run measured the stand-in, and it is superseded rather than averaged in.
10. **An operating point for the multi-candidate regime.** §8.6 establishes that the multiplicity correction is necessary and behaves as derived, on a judge whose scores are saturated at 0 and 1 and on purpose-built units. It does not measure what a deployed judge does at large `m`, and the deployed configuration of §8.3 runs at `m` = 1.

**What IS guaranteed**, precisely:

- **(A) Identity recognition.** L0 suppression is *sound* under A5 — canonical equality implies identity, so its wrong-suppression is zero, not small (T2). The witness veto is sound under A5′ — a declared-field difference blocks suppression regardless of any judge output (P4). On the remaining fragment, for a candidate distinct from all `m` committed candidates, `P(SUPPRESS) ≤ α` where α is chosen by the deployment, distribution-free and finite-sample, **for the max-over-candidates statistic the fence actually thresholds** (T3) — subject to A6 (exchangeability, conditional on `m`) and to a calibration budget that forces `t_hi = +∞`, and hence *no semantic suppression at all*, once `m > α(n+1)`.
- **(B) Fence-level at-most-once.** For dispatches the fence recognises as identical and that are serialised per identity (A7), at most one commit row exists and at most one effect is dispatched by the fence (T1). Without A7, the weaker property holds: at most one commit row, with concurrent duplicates made *observable* as COMMIT_CONFLICT rather than prevented.
- **(C) External exactly-once.** Obtained only by composition with a provider whose idempotency contract (A8) is keyed on a projection that is both paraphrase-invariant **and** complete for effect identity (A5″) — T5 Case A. Under a witness-only projection (A5′ alone) this guarantee is **not** available, and §6.8 Case B says why using the projection as a key would be actively unsafe.
- **(P3) Audit.** Any duplicate the semantic layer suspects but does not suppress is executed **and durably flagged**; any crash inside the commit window leaves a durable PENDING intent with no commit row. Neither is silent, even when neither is prevented.

## 12. Reproducibility and artifact

Artifact: `research/effect-identity/`. Zero runtime dependencies, Node ≥ 20.11.

`npm test` runs the unit suite with no network: canonicalisation identity-invariance, the **strict score parser** (every row of §7.2's accept/reject table, including the `0.95` case that caused the original defect), the conformal bound in simulation, **the assertion that the *uncorrected* pairwise threshold violates the bound on the max statistic** (if that test ever passes, the correction is untested), threshold monotonicity in `m`, `m = 0`, insufficient-calibration behaviour, fence layers, witness veto, abstention handling, crash-hook reachability, Wilson-interval boundaries, reasoning-scratchpad stripping, and paraphrase-validator soundness.

```
node src/corpus/generate.js
node src/experiments/score.js --judges openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.6-27b,llama-3.3-70b-versatile
node src/experiments/run.js
node src/experiments/multiCandidate.js --judge llama-3.1-8b-instant --K 50 --units-diff 40 --units-same 20
node src/experiments/crashReplay.js --trials 48 --judge openai/gpt-oss-20b --pool-generator llama-3.1-8b-instant
node src/experiments/annotation.js --export
node src/experiments/residualCalibration.js
node src/experiments/crossFamily.js
node src/experiments/sensitivity.js
node src/experiments/report.js > results/REPORT.md

# the validation round (§8.7, §8.13–8.15) — additive, does not touch the frozen v1 files above
node src/experiments/crashReplayV2.js --trials 48 --arms duplicate,distinct --judge openai/gpt-oss-120b
node src/experiments/baselineMatrix.js --corpus v1
node src/experiments/attackMatrix.js --corpus v1
node src/experiments/conformalAudit.js --corpus v1
node src/corpus/generateV2.js --offline --only ladder
node src/experiments/runToCompletion.js --pairs corpus/ladder.jsonl --out corpus/scores-ladder.jsonl --judges openai/gpt-oss-120b --retry-abstentions
node src/experiments/schemaLadder.js

node src/experiments/verify.js
node src/experiments/checkPaper.js
```

`generate.js` rebuilds the corpus: one S2/S4 arm per `--generator` (default: every configured model family) plus the hand-authored arm, which requires no key and is therefore the one SAME arm that survives `--offline`. `score.js` scores every pair with each judge at `--batch` pairs per call; it is **resumable at batch granularity** (partial scores live in `results/partial-<judge>.json`), `--retry-abstentions` re-attempts pairs left unscored by an earlier pass, `--persist-only` rebuilds `corpus/scores.jsonl` from the partials with no model calls, and `--fresh` discards them. `run.js` recomputes every table in §8 offline from the persisted scores. `multiCandidate.js` builds and scores the nested candidate-set units of §8.6. `crashReplay.js` runs the randomised multi-process experiment across the eight crash points against the deterministic offline scorer (the run superseded by §8.7); `--pool-generator` selects the model that writes the paraphrase pool, which **must differ from `--judge`** to avoid the self-recognition confound. `residualCalibration.js` recomputes every configuration against a pool matched to its own jurisdiction (§6.6) and is what produces the primary results of §8.3, the ablations of §8.10 and the schema comparison of §8.9. `crossFamily.js` runs the homogeneity tests and the three-judge comparison of §8.8. `sensitivity.js` runs the relabelling and the paired McNemar tests of §8.12. `report.js` renders every reported number with its interval and basis into one digest, from which the paper's tables are transcribed. `checkPaper.js` closes the loop in the other direction: it extracts every `NN.N% [lo–hi]` interval from the manuscript and fails unless each one matches a rate actually present in `results/`. At the time of writing it checks 284 quoted intervals (97 distinct) against 5,536 computed rates and reports no unmatched interval. A transcription slip, or a figure left behind by a re-run, is therefore a build failure rather than something a reader has to catch.

**The validation round added twelve files, listed here so the artifact and the paper describe the same thing.** `crashWorkerV2.js` / `crashReplayV2.js` run the crash/replay experiment of §8.7 against the live judge on two arms (`--arms duplicate,distinct`), reading thresholds from `residual_calibration.json` rather than a hand-set fallback. `evaluate.js` is the shared decision core every post-hoc analysis now calls through — one implementation of "certifier, then refuter, then calibrated judge, then band" parameterised by which layers are switched on, so an ablation and the full system cannot silently diverge in how they compute a decision. `baselineMatrix.js` produces the 15-configuration table of §8.13; `attackMatrix.js` produces the per-class decomposition of §8.4 and is written to run over any corpus version via `--corpus v1|v2ext|union`. `conformalAudit.js` runs the fifteen checks and the two resampling studies of §8.14. `schemaLadder.js` runs the monotonicity and refinement-budget experiments of §8.15 over `corpus/ladder.jsonl`. `judgeAdmission.js` implements the coverage/resolution/signal rule of §8.1 and is imported by every script above rather than reimplemented. `scoreV2.js` is the scorer for any corpus other than the frozen `pairs.jsonl` (`--pairs`, `--out`, `--judges`); `runToCompletion.js` wraps it with a process-level watchdog so a stalled batch is killed and resumed rather than silently blocking a background pass, which the original `score.js` does not need because its corpus is smaller and its coverage is already complete; `mergeScores.js` combines per-judge partial files scored in separate processes (necessary because judges differ by an order of magnitude in throughput) into one `scores-*.jsonl`. `verify.js` (below) and `repro.config.json` are new; `annotation.js` gained the adjudication round, Krippendorff's α, and the mechanism re-derivation described in §7.4 and is otherwise unchanged in interface.

**On score parsing (§7.2).** The judge parser rejects every non-integer, rejects out-of-range values rather than clamping them, records abstentions as `null` rather than imputing 0.5, and counts each rejection class. Superseded corpora and results from earlier iterations of this artifact are retained under `archive/` with a description of the defect that motivated the strict contract, so the difference remains auditable.

**On quota, and why it shapes what ran.** Groq enforces a **per-model tokens-per-day** allowance (measured on the key used here: 200,000 for GPT-OSS-120B, 100,000 for Llama-3.3-70B) as well as a per-minute one. A full pass over 955 pairs costs of order 10⁵ tokens, so one judge consumes roughly one model's daily allowance. Two client behaviours follow and both were defects we had to fix: an allowance breach returns **HTTP 413**, not 429, so it must be treated as transient and waited out rather than thrown; and the server states its own wait in forms including `412ms`, `7.66s` and `4m18.5s`, which must be parsed as written. Scoring therefore checkpoints per batch and honours server-specified delays, and re-invoking `score.js` (or `scoreV2.js`, or the watchdog-wrapped `runToCompletion.js`) always makes forward progress. §8.1 reports the coverage each judge actually achieved.

**Reproducibility configuration and verification.** `repro.config.json` records, in one machine-readable place, every seed, split method, prompt, threshold construction, model identifier and judge-admission parameter this paper depends on, separately for each corpus version, so that "what exactly produced this number" is a file lookup rather than an archaeology exercise. `verify.js` checks eleven assertion classes against the data as shipped — split separation, score validity, abstention handling, jurisdiction-matched calibration pools, and multiplicity budgets among them — and fails on any violation; it is the mechanical form of §10's threats-to-validity discussion, run against the artifact rather than argued in prose.

Raw outputs: `results/experiments.json`, `results/residual_calibration.json`, `results/cross_family.json`, `results/sensitivity.json`, `results/multi_candidate.json`, `results/crash_replay.json`, `results/crash_replay_v2.json`, `results/baseline_matrix_v1.json`, `results/attack_matrix_v1.json`, `results/conformal_audit_v1.json`, `results/schema_ladder.json`, `results/judge_meta.json`, `results/human_annotation.json`, `results/REPORT.md`.

---

## 13. Conclusion

Every mechanism that prevents an agent from doing an irreversible thing twice rests on an answer to "is this the same act?", and almost none of them says what that answer is. Journals answer it by position, tokens by client convention, content-addressed fences by a hash, and the recent proposals for agent checkpoint-restore by asking a model. The first three are total by fiat and break the moment an actor re-synthesises its own arguments; the fourth is honest about the problem and explicit that it does not bound the model's error.

We argued that the question has a structure. Any procedure deciding effect identity decomposes into a **certifier** (a decidable proof of sameness, licensing suppression), a **refuter** (its dual, a decidable proof of difference, licensing execution), and the **residual** they do not cover. The decomposition is not a design preference: T4 says a score-threshold rule cannot reach zero error on overlapping distributions, so the only route to a zero on any fragment is a decision that does not consult the score — which is exactly what a certifier and a refuter are.

The residual is where the theory earns its place. It is determined by the **declared schema alone** (T6): no oracle moves a pair out of it, every non-provable error lies inside it, and refining the declaration shrinks it. From this the paper's most useful practical statement follows as a corollary rather than an opinion — *oracle quality trades one error direction against the other; schema quality removes both* — and we then watched it happen, with every judge-side intervention we tried trading axes and the single schema change improving all of them at once. The composition result (T7) sharpens where this matters: of the three guarantees that "exactly-once" conflates, a provider contract can subsume local commitment, but nothing substitutes for identity recognition, because every keyed mechanism downstream is keyed on its answer. Identity is the part that cannot be delegated, which is why it deserved a theory rather than a heuristic.

The instantiation shows the theory is not vacuous: 94.0% of paraphrased duplicates deduplicated at 1.0% wrong-suppression against a content-addressed baseline's 13.5%; an entire adversarial class closed *by construction* rather than by persuasion; and deduplication no better on paraphrases written by the judge's own family than on paraphrases written by hand, which is the result we most wanted to fail and did not. The evaluation's most stable finding is an asymmetry rather than a rate. Deduplication moved under every perturbation we applied — twelve points across three judges at full coverage, four-fold across defensible relabellings of the ground truth — while wrong-suppression stayed inside the declared level under all of them. That is what a bound on one direction and nothing on the other should look like from the outside, and it is the strongest evidence we have that the machinery is doing what it claims rather than fitting one corpus.

It also shows where the theory bites back, twice at our own expense. Because all non-provable error lies in the residual, the oracle must be calibrated on the residual — the pairs the deployed rule actually routes to it — and our own evaluation had not been. And because the calibration pool is drawn from the residual, refining a schema starves the pool at the same rate it shrinks the residual, so the intervention the theory recommends most strongly also degrades the layer it does not replace. Neither is visible without taking the residual seriously as an object; both were found by doing so. Alongside them the older lessons stand: text-only distinctions are pure residual and fail most of the time under injection; wrong-suppression is non-zero and provably must be; inside the execute-before-record window no local mechanism helps; the bound must be calibrated on the deployed statistic rather than a pairwise proxy; and a projection that is only a refuter must never be promoted into a provider key.

Several claims in earlier revisions of this manuscript did not survive the evidence we later collected, and we corrected them rather than restating them. They are gathered in **§14 (Errata)** rather than argued here, because a conclusion should say what the paper establishes, and a reader tracking what we got wrong deserves one place to find it rather than a running commentary.

What is not yet settled is named rather than hidden. Independent **human** validation of the ground truth is specified, instrumented, and **uncollected**; what we ran instead is a blinded **model panel** (§8.16), which is a weaker control and is never described as the stronger one. That panel agrees with the construction where the schema decides and **contests it where only prose does** — which is the residual, and which is the paper's own prediction arriving as a fact about readers rather than about oracles. Under its relabelling our preregistered test declares the safety claim not to survive on that subset, and we report it as triggered. Under seed-level splitting, wrong-suppression is roughly 1.5x what the shipped split reports. Each remaining gap is a stated gap with a stated apparatus, not a promise.

The unit of exactly-once for agents is not the hash of the request, and it is not the opinion of a model. It is the identity of the act — proved where the declaration is willing to say, refuted where it is willing to deny, and bounded by calibration only in the gap between. The size of that gap is a property of the schema, and shrinking it is engineering that no amount of model scale will do for you.


---

## 14. Errata from prior revisions

This manuscript has been revised against evidence collected after earlier drafts were written. Where a number or a claim changed, it is corrected in place in the relevant section **and** recorded here, so a reader comparing revisions can see what moved and why without reconstructing it from the body. Nothing in this section hedges a current claim; every current claim stands on its own in §8.

**E1 — "Deduplication varies seven-fold across judges" (abstract, §8.8, §8.14, conclusion).** Withdrawn; the measured spread is twelve points. The seven-fold figure came from a 218-pair common subset on which the saturated GPT-OSS-20B's jurisdiction-matched pool pinned `t_hi` at 1.0; a **strict** suppression inequality against a threshold of 1.0 suppresses almost nothing, so its deduplication read 12.2%. At full coverage the same judge reads 82.6%. The qualitative claim — deduplication is unbounded and moves materially with the judge — is unaffected. *General lesson:* a conformal threshold fitted on a small pool of a saturated judge lands on the extreme value, and every rate downstream then describes the threshold rather than the judge.

**E2 — §8.3's per-category table was printed under the wrong configuration.** It was headed "hardened, α=0.05" and computed under the **jurisdiction-mismatched** pool that §8.3's own prose spends two paragraphs correcting. The error was self-evident and we missed it: a table whose SAME rows all read 100% cannot sum to the 94.0% deduplication printed six rows above it. Corrected, S2 moves 100.0%→92.9%, S4 100.0%→92.7%, D2 5.3%→1.3%. The headline row was always computed correctly.

**E3 — "Wrong suppression concentrates in D2."** Withdrawn as a consequence of E2. Under the correct configuration the concentration is in **D3**, and D2 is the second-cleanest DIFF category in the table.

**E4 — D3's and S3's cells were too small to support the claims resting on them.** S3, the paper's *motivating example*, carried 8 test pairs and a 95% lower bound of 67.6%. D3 carried 5, reporting 0.0% wrong-suppression with an upper bound of 43.4%. Both were grown (§7.1). S3's bound is now 90.8%. D3's rate is now **6.5% [1.8–20.7]** — the enlarged cell found a real error the small one had hidden. *General lesson:* a cell too small to fail is not evidence of not failing.

**E5 — Per-tool calibration's cost was reported as 19 points of deduplication.** Now 5 points. Enlarging the corpus lifted `send_email`'s per-tool pool from 14 pairs to 19, over the threshold at which α = 0.05 can be certified at all, so one of the two starved tools now certifies. The budget effect is real and unchanged in kind; its magnitude was a function of corpus size.

**E6 — The crash/replay experiment's first version measured a deterministic stand-in rather than the deployed judge**, and on the sharpest prediction the design makes it returned 0 of 6 where the theory says 6 of 6. Re-run against the deployed judge with a second arm added — the original could not observe a wrong suppression even in principle — it agrees with the theory outside the commit window and disagrees inside it, precisely where T1's remark says it must (§8.7).

**E7 — An earlier resampling study claimed the realised wrong-suppression rate reaches roughly twice α at the 95th percentile at every pool size.** Refined rather than restated: that study resampled the jurisdiction-*mismatched* pool. On the pool the deployed rule uses, the **mean** realised rate is flat in `n` as claimed, but the **tail** is not — p95 falls from 13.4% at `n`=20 to 4.2% at `n`=50 (§8.14).

**E8 — An earlier draft reported a judge parser that had silently stored 180 mis-scaled scores** out of 780, inverting confident same-act verdicts into confident distinct-act ones while reporting a 0% failure rate. Every number in that pass was withdrawn and re-derived; the affected scores ship in `archive/` (§7.2).

**E9 — Two apparatuses were described in §9.2 in full methodological detail without a number from either.** Cut. A described-but-unscored apparatus occupies the space of a result while carrying none of the obligations of one. They now appear once in §9.3 as future work.

**E10 — An artifact assertion was both over-broad and untested.** `verify.js` asserted that no abstention may result in a SUPPRESS decision. No admitted judge had ever abstained, so the assertion had never run; raising Qwen to full coverage ran it and it failed on 13 pairs — all decidable L0 certifier suppressions, which are correct precisely *because* they do not depend on the judge having answered. The assertion now checks what §7.2 actually promises, that no abstention reaches the semantic layer, and is strictly tighter in both directions.

**E11 — The seed-leakage disclosure ended "we have not built one."** Built (§8.14). Under seed-level splitting, mean wrong-suppression rises on every judge — 1.7→2.7%, 1.3→2.2%, 0.9→1.8% — so the shipped pair-level split was mildly optimistic about the safety-critical rate.


---

## References

References [1]-[17] are discussed individually in §2. References [18]-[121] are cited for coverage of a research area and are characterised thematically in §2.7 rather than individually.



1. Vovk, V., Gammerman, A., Shafer, G. **Algorithmic Learning in a Random World.** Springer, 2005.
2. Angelopoulos, A. N., Bates, S. **A Gentle Introduction to Conformal Prediction and Distribution-Free Uncertainty Quantification.** arXiv:2107.07511, 2021. Published in *Foundations and Trends in Machine Learning* 16(4):494–591, 2023.
3. Ren, A. Z., Dixit, A., Bodrova, A., Singh, S., Tu, S., Brown, N., Xu, P., Takayama, L., Xia, F., Varley, J., Xu, Z., Sadigh, D., Zeng, A., Majumdar, A. **Robots That Ask For Help: Uncertainty Alignment for Large Language Model Planners** (KnowNo). *Conference on Robot Learning (CoRL)*, 2023.
4. Mohammadi, B., Potamitis, N., Klein, L., Arora, A., Bindschaedler, L. **Atomix: Timely, Transactional Tool Use for Reliable Agentic Workflows.** arXiv:2602.14849, 2026.
5. Mansoor, I. K., Phadke, A., Rana, P. **Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures.** arXiv:2608.02645, 2026.
6. Lyu, H., Zhang, D., Wu, M., Wei, X., Chen, H. **CoAgent: Concurrency Control for Multi-Agent Systems.** arXiv:2606.15376, 2026.
7. Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., Cao, Y. **ReAct: Synergizing Reasoning and Acting in Language Models.** *ICLR*, 2023.
8. Zheng, L., Chiang, W.-L., Sheng, Y., Zhuang, S., Wu, Z., Zhuang, Y., Lin, Z., Li, Z., Li, D., Xing, E. P., Zhang, H., Gonzalez, J. E., Stoica, I. **Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.** *NeurIPS Datasets and Benchmarks*, 2023.
9. Yuan, T., He, Z., Dong, L., Wang, Y., Zhao, R., Xia, T., Xu, L., Zhou, B., Li, F., Zhang, Z., Wang, R., Liu, G. **R-Judge: Benchmarking Safety Risk Awareness for LLM Agents.** *Findings of EMNLP*, 2024. arXiv:2401.10019.
10. Karimi, H., Meyappan, V., Samavi, R. **LLMs Uncertainty Quantification via Adaptive Conformal Semantic Entropy** (ACSE). arXiv:2605.04295, 2026.
11. Stripe. **Idempotent Requests (`Idempotency-Key`).** Stripe API documentation. Accessed 2026.
12. Temporal Technologies. **Durable Execution.** Technical documentation. Accessed 2026. Restate. **Durable Execution for Distributed Applications.** Technical documentation. Accessed 2026.
13. Fang, X., Tong, K., Liu, J., Ning, T., He, Y. **SemHash-LLM: A Multi-Granularity Semantic Hashing Framework for Document Deduplication.** arXiv:2607.01601, 2026.
14. Zheng, Y., Yang, Y., Zhang, W., Quinn, A. **ACRFence: Preventing Semantic Rollback Attacks in Agent Checkpoint-Restore.** arXiv:2603.20625, 2026.
15. Xu, J., Fan, L., Wang, Z., Li, X., Liu, H. **Beyond Single-Use Tokens: Durable Authorization State for Replay-Resistant LLM Agent Actions** (CapLease). arXiv:2608.01710, 2026.
16. Balakrishnan, M., Bharambe, A., Testuggine, D., Geraghty, D., Mao, D., Venkat, V., Mironov, I., Baradi, R., Aiyer, G., Dudin, V. **LogAct: Enabling Agentic Reliability via Shared Logs.** arXiv:2604.07988, 2026.
17. Yin, Z. **Safety Invariants for Agents Orchestrating Irreversible State Transitions: A Four-Dimensional Formalism Evaluated on Public Ledgers.** arXiv:2608.00783, 2026.


**Durable execution, transactional agents, and recovery.**

18. Mozafari, B. **BEGIN AI TRANSACTION: Semantic Isolation for Durable AI Workflows.** arXiv:2608.05412, 2026.
19. **Verified Detection and Prevention of Concurrency Anomalies in Multi-Agent Large Language Model Systems.** arXiv:2606.17182, 2026.
20. **Resume Means Resume: A Machine-Checked Conformance Contract for Checkpoint, Interrupt, and Resume Semantics in Workflow Persistence Layers.** arXiv:2608.03836, 2026.
21. **Distributed Speculative Execution for Resilient Cloud Applications.** arXiv:2412.13314, 2024.
22. Zhai, H., Li, X., Wang, Y. **Revisable by Design: A Theory of Streaming LLM Agent Execution.** arXiv:2604.23283, 2026.
23. Parmar, N. **Separating Intelligence from Execution: A Workflow Engine for the Model Context Protocol.** arXiv:2605.00827, 2026.
24. Fareed, M. **Cost-Aware Speculative Execution for LLM-Agent Workflows: An Integrated Five-Dimension Method.** arXiv:2606.07846, 2026.
25. Li, R., et al. **Generator-Assistant Stepwise Rollback Framework for Large Language Model Agent.** arXiv:2503.02519, 2025.
26. Yu, K., et al. **The Hidden Footprint: Making Storage a First-Class Metric for LLM Agent Evaluation.** arXiv:2607.11149, 2026.
27. Zhu, L., et al. **AriadneMem: Threading the Maze of Lifelong Memory for LLM Agents.** arXiv:2603.03290, 2026.

**Agent authorization, autonomy bounds, and governance.**

28. Zuvic, M. **Capability Gates Are Not Authorization: Confused-Deputy Failures in LLM Agent Frameworks.** arXiv:2606.28679, 2026.
29. Ao, X., Fang, J., Xu, W. **RecSys Factory: Bounding LLM Agent Autonomy to Decision Points in the Industrial Recommender Lifecycle.** arXiv:2608.11241, 2026.
30. Shlomov, S., et al. **Governance by Construction for Generalist Agents.** arXiv:2605.20874, 2026.
31. Sterling, A. **Provably Auditable and Safe LLM Agents from Human-Authored Ontologies.** arXiv:2606.04903, 2026.
32. Fatouros, G., et al. **An Organization-Scoped LLM Agent Runtime Architecture for Regulated Cybersecurity Operations.** arXiv:2605.30604, 2026.
33. Turan, N. **Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human.** arXiv:2606.08919, 2026.
34. Lin, Y., et al. **DreamGuard: Efficient Runtime Guardrail for LLM Agents via Risk-Aware World Model.** arXiv:2608.05695, 2026.
35. He, G., Demartini, G., Gadiraju, U. **Plan-Then-Execute: An Empirical Study of User Trust and Team Performance When Using LLM Agents.** arXiv:2502.01390, 2025.
36. Lin, C., Kao, H. **FROAV: A Framework for RAG Observation and Agent Verification.** arXiv:2601.07504, 2026.

**Tool calling, tool selection, and the tool supply chain.**

37. Lumer, E., et al. **ScaleMCP: Dynamic and Auto-Synchronizing Model Context Protocol Tools for LLM Agents.** arXiv:2505.06416, 2025.
38. Bai, Y., et al. **SkillDAG: Self-Evolving Typed Skill Graphs for LLM Skill Selection at Scale.** arXiv:2606.03056, 2026.
39. Chen, W. **Looking Is Not Picking: An Attention-Segment Account of Tool-Selection Failures in LLM Agents.** arXiv:2606.16364, 2026.
40. Kim, S., et al. **Evaluating Tool Cloning in Agentic-AI Ecosystems.** arXiv:2605.09817, 2026.
41. Jia, R., et al. **Skills Are Not Islands: Measuring Dependency and Risk in Agent Skill Supply Chains.** arXiv:2607.01136, 2026.
42. Lin, J., et al. **Mining Workflow Graphs for Black-Box Boundary Testing of Conversational LLM Agents.** arXiv:2607.06873, 2026.

**Prompt injection: attacks.**

43. Beurer-Kellner, L., et al. **Design Patterns for Securing LLM Agents against Prompt Injections.** arXiv:2506.08837, 2025.
44. Xie, T., et al. **What If Prompt Injection Never Left? Rethinking Agent Security through Cross-Session Stored Prompt Injection.** arXiv:2606.04425, 2026.
45. Liu, Z., et al. **PINA: Prompt Injection Attack against Navigation Agents.** arXiv:2601.13612, 2026.
46. Nagaraja, A., Bagari, S., Bahsi, H. **When Prompts Control Robots: Prompt Injection Attacks in Multi-Agent Robotic Systems.** arXiv:2608.00747, 2026.
47. Hofer, M., Debenedetti, E., Tramèr, F. **Assessing Automated Prompt Injection Attacks in Agentic Environments.** arXiv:2606.10525, 2026.
48. Syros, G., et al. **MUZZLE: Adaptive Agentic Red-Teaming of Web Agents Against Indirect Prompt Injection Attacks.** arXiv:2602.09222, 2026.
49. He, K., et al. **PI-Hunter: Automated Red-Teaming for Exposing and Localizing Prompt Injections.** arXiv:2606.12737, 2026.
50. Wang, Y., Yin, H., Geng, R., Jia, J. **Agent Against Agent: An Agentic System for Automatic Prompt Injection Red Teaming.** arXiv:2608.05108, 2026.
51. Korgul, A., et al. **It's a TRAP! Task-Redirecting Agent Persuasion Benchmark for Web Agents.** arXiv:2512.23128, 2025.
52. Isbarov, J., Kantarcioglu, M. **Bypassing AI Control Protocols via Agent-as-a-Proxy Attacks.** arXiv:2602.05066, 2026.
53. Liu, S., et al. **When Compression Becomes an Attack Surface: Black-Box Attacks on Prompt-Compressed LLM Agents.** arXiv:2510.22963, 2025.
54. Yang, J., Na, H., Choi, D. **An Empirical Study of Privacy Leakage Chains via Prompt Injection in Black-Box Chatbot Environments.** arXiv:2605.18133, 2026.
55. Crawford, D., McClure, T. **Investigating Detection and Obfuscation of Prompt Injection Attacks Against Software Reverse Engineering AI Agents.** arXiv:2605.30677, 2026.
56. Lee, J., et al. **T-MAP: Red-Teaming LLM Agents with Trajectory-aware Evolutionary Search.** arXiv:2603.22341, 2026.
57. Cohen, A. **In-Browser LLM-Guided Fuzzing for Real-Time Prompt Injection Testing in Agentic AI Browsers.** arXiv:2510.13543, 2025.

**Prompt injection: defences, detection, and benchmarks.**

58. Shi, T., et al. **PromptArmor: Simple yet Effective Prompt Injection Defenses.** arXiv:2507.15219, 2025.
59. Cao, Y., et al. **WARD: Adversarially Robust Defense of Web Agents Against Prompt Injections.** arXiv:2605.15030, 2026.
60. Zhang, K., et al. **BrowseSafe: Understanding and Preventing Prompt Injection Within AI Browser Agents.** arXiv:2511.20597, 2025.
61. Chen, H., et al. **WebAgentGuard: A Reasoning-Driven Guard Model for Detecting Prompt Injection Attacks in Web Agents.** arXiv:2604.12284, 2026.
62. Wang, J., Zou, Y., Geng, R., Jia, J. **AgentWatcher: A Rule-based Prompt Injection Monitor.** arXiv:2604.01194, 2026.
63. Hu, Z., et al. **Twin Agent: Context Residual Compression for Privilege Separated Agents.** arXiv:2607.19595, 2026.
64. Wang, Z., Nagaraja, A., Zhang, Y., Bahsi, H., Patil, S., Liu, X. **To Protect the LLM Agent Against the Prompt Injection Attack with Polymorphic Prompt.** arXiv:2506.05739, 2025.
65. Hossain, M., et al. **A Multi-Agent LLM Defense Pipeline Against Prompt Injection Attacks.** arXiv:2509.14285, 2025.
66. Gosmar, D., Dahl, D., Gosmar, E. **Prompt Injection Detection and Mitigation via AI Multi-Agent NLP Frameworks.** arXiv:2503.11517, 2025.
67. Liu, H., et al. **WAInjectBench: Benchmarking Prompt Injection Detections for Web Agents.** arXiv:2510.01354, 2025.
68. Wang, R., et al. **Who Pays the Price? Stakeholder-Centric Prompt Injection Benchmarking for Real-world Web Agents.** arXiv:2606.13385, 2026.
69. Addagada, S. **Semalith v1.4: A Calibrated 184M Safety Classifier Achieving State-of-the-Art Prompt-Injection Detection at 44x Fewer Parameters than Llama-Guard-3-8B.** arXiv:2607.22545, 2026.

**LLM-as-judge: bias, reliability, and manipulability.**

70. Ye, J., et al. **Justice or Prejudice? Quantifying Biases in LLM-as-a-Judge.** arXiv:2410.02736, 2024.
71. Chen, G., et al. **Humans or LLMs as the Judge? A Study on Judgement Biases.** arXiv:2402.10669, 2024.
72. Norman, D., Rivera, A., Hughes, J. **Reliability without Validity: A Systematic, Large-Scale Evaluation of LLM-as-a-Judge Models Across Agreement, Consistency, and Bias.** arXiv:2606.19544, 2026.
73. Li, D., et al. **Preference Leakage: A Contamination Problem in LLM-as-a-judge.** arXiv:2502.01534, 2025.
74. Li, Q., et al. **Evaluating Scoring Bias in LLM-as-a-Judge.** arXiv:2506.22316, 2025.
75. Xu, Y., et al. **Am I More Pointwise or Pairwise? Revealing Position Bias in Rubric-Based LLM-as-a-Judge.** arXiv:2602.02219, 2026.
76. Ma, Y., et al. **Judging with Many Minds: Do More Perspectives Mean Less Prejudice? On Bias Amplifications and Resistance in Multi-Agent Based LLM-as-Judge.** arXiv:2505.19477, 2025.
77. Hwang, Y., et al. **Can You Trick the Grader? Adversarial Persuasion of LLM Judges.** arXiv:2508.07805, 2025.
78. Wei, Z., Liu, Y., Erichson, N. B. **Emoji Attack: Enhancing Jailbreak Attacks Against Judge LLM Detection.** arXiv:2411.01077, 2024.
79. Liu, G., et al. **Assistant-Guided Mitigation of Teacher Preference Bias in LLM-as-a-Judge.** arXiv:2505.19176, 2025.
80. Zhou, H., et al. **Mitigating the Bias of Large Language Model Evaluation.** arXiv:2409.16788, 2024.
81. Soumik, M. **Judging the Judges: A Systematic Evaluation of Bias Mitigation Strategies in LLM-as-a-Judge Pipelines.** arXiv:2604.23178, 2026.
82. Zhao, W., Esmaeili, A., Fard, F. **Bias in the Loop: Auditing LLM-as-a-Judge for Software Engineering.** arXiv:2604.16790, 2026.
83. Zhu, L., Wang, X., Wang, X. **JudgeLM: Fine-tuned Large Language Models are Scalable Judges.** arXiv:2310.17631, 2023.
84. Wang, P., et al. **Direct Judgement Preference Optimization.** arXiv:2409.14664, 2024.
85. Zhang, Q., et al. **RevisEval: Improving LLM-as-a-Judge via Response-Adapted References.** arXiv:2410.05193, 2024.
86. Zhang, T., et al. **Quantifying and Auditing LLM Evaluation via Positive–Unlabeled Learning.** arXiv:2606.19057, 2026.
87. Zhang, W., et al. **AURA: Adaptive Uncertainty-aware Refinement for LLM-as-a-Judge Auditing.** arXiv:2606.19714, 2026.
88. Ho, X., et al. **Reassessing Extractive QA Datasets at Scale: LLM-as-a-Judge and In-Depth Analyses.** arXiv:2504.11972, 2025.
89. D'Souza, J., et al. **YESciEval: Robust LLM-as-a-Judge for Scientific Question Answering.** arXiv:2505.14279, 2025.
90. Wang, L., et al. **Understanding LLM Evaluator Behavior: A Structured Multi-Evaluator Framework for Merchant Risk Assessment.** arXiv:2602.05110, 2026.

**Conformal prediction and selective prediction for language models.**

91. Quach, V., et al. **Conformal Language Modeling.** arXiv:2306.10193, 2023.
92. Mohri, C., Hashimoto, T. **Language Models with Conformal Factuality Guarantees.** arXiv:2402.10978, 2024.
93. Campos, M., et al. **Conformal Prediction for Natural Language Processing: A Survey.** arXiv:2405.01976, 2024.
94. Kumar, B., et al. **Conformal Prediction with Large Language Models for Multi-Choice Question Answering.** arXiv:2305.18404, 2023.
95. Abbasi Yadkori, Y., et al. **Mitigating LLM Hallucinations via Conformal Abstention.** arXiv:2405.01563, 2024.
96. Rubin-Toles, M., et al. **Conformal Language Model Reasoning with Coherent Factuality.** arXiv:2505.17126, 2025.
97. Sheng, S., et al. **Analyzing Uncertainty of LLM-as-a-Judge: Interval Evaluations with Conformal Prediction.** arXiv:2509.18658, 2025.
98. Ulmer, D., et al. **Non-Exchangeable Conformal Language Generation with Nearest Neighbors.** arXiv:2402.00707, 2024.
99. Lin, Z., et al. **Domain-Shift-Aware Conformal Prediction for Large Language Models.** arXiv:2510.05566, 2025.
100. Wang, X., et al. **Conformal Prediction Adaptive to Unknown Subpopulation Shifts.** arXiv:2506.05583, 2025.
101. Kiyani, S., et al. **Length Optimization in Conformal Prediction.** arXiv:2406.18814, 2024.
102. Liu, R., Wu, Z. S. **Multi-group Uncertainty Quantification for Long-form Text Generation.** arXiv:2407.21057, 2024.
103. Rubashevskii, A., et al. **Adaptive Conformal Prediction for Improving Factuality of Generations by Large Language Models.** arXiv:2604.13991, 2026.
104. Si, S., et al. **Conformal Constrained Policy Optimization for Cost-Effective LLM Agents.** arXiv:2511.11828, 2025.
105. Chakraborty, S., et al. **Principled Context Engineering for RAG: Statistical Guarantees via Conformal Prediction.** arXiv:2511.17908, 2025.
106. Chan, K., et al. **Conformal Information Pursuit for Interactively Guiding Large Language Models.** arXiv:2507.03279, 2025.
107. Zhu, X., et al. **Reliably Bounding False Positives: A Zero-Shot Machine-Generated Text Detection Framework via Multiscaled Conformal Prediction.** arXiv:2505.05084, 2025.
108. Xu, B., Lu, Y. **TECP: Token-Entropy Conformal Prediction for LLMs.** arXiv:2509.00461, 2025.
109. Zeng, Y., et al. **Empirical Bayes Conformal Prediction for Vision and Language Models.** arXiv:2605.23189, 2026.
110. Vellore, A., Jha, S. **Uncertainty-Aware Transformers: Conformal Prediction for Language Models.** arXiv:2604.08885, 2026.
111. Tursunbadalov, D., Tursunbadalov, Z. **A Quiet Failure in Calibrated Virtual Screening: Marginal Conformal Prediction Under-Covers the Minority Class.** arXiv:2607.06605, 2026.
112. Ravfogel, S., et al. **Conformal Nucleus Sampling.** arXiv:2305.02633, 2023.
113. Kotla, S., Kotla, R. **Conformal Prediction Sets for Next-Token Prediction in Large Language Models.** arXiv:2512.22682, 2025.
114. Zhou, Y., et al. **Adaptive Stopping for Multi-Turn LLM Reasoning.** arXiv:2604.01413, 2026.
115. Oh, S., et al. **Uncertainty Quantification in LLM Agents: Foundations, Emerging Challenges, and Opportunities.** arXiv:2602.05073, 2026.
116. Kaur, R., et al. **Addressing Uncertainty in LLMs to Enhance Reliability in Generative AI.** arXiv:2411.02381, 2024.
117. Kumar, S., et al. **VLM Judges Can Rank but Cannot Score: Task-Dependent Uncertainty in Multimodal Evaluation.** arXiv:2604.25235, 2026.

**Semantic equivalence, paraphrase, and deduplication.**

118. Zhou, C., et al. **Paraphrase Identification with Deep Learning: A Review of Datasets and Methods.** arXiv:2212.06933, 2022.
119. Dou, Y., Jiang, C., Xu, W. **Improving Large-scale Paraphrase Acquisition and Generation.** arXiv:2210.03235, 2022.
120. Yu, X., et al. **Learning Semantic Textual Similarity via Topic-informed Discrete Latent Variables.** arXiv:2211.03616, 2022.
121. Yanaka, H., Mineshima, K. **Compositional Evaluation on Japanese Textual Entailment and Similarity.** arXiv:2208.04826, 2022.

*Venue note.* Entries dated 2026 are preprints and should be re-checked for published versions at camera-ready. Reference [12] groups two vendor documentation sources; a camera-ready version should cite the specific pages relied upon. Where an author list is abbreviated to "et al." the arXiv record lists more than three authors; full lists are in the cited records.

---

## Appendix A — The two error modes, side by side

| | judged SAME | judged DIFF |
|---|---|---|
| **truly SAME** | correct suppression (dedup) | duplicate-escape — *loud* if flagged (ESCALATE), *silent* if EXECUTE |
| **truly DIFF** | **wrong-suppression** — silent, catastrophic, bounded ≤ α | correct execution |

The entire design is an argument about the bottom-left cell: make it decidably empty where possible (L0, witness), and provably rare (≤ α) where not.
