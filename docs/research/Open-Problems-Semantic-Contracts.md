# Open Problems in Semantic Contracts for Agent Systems

*Sivaguru R. M. — AgentRuntime Project — July 2026*

Companion artifact: `Semantic-Contracts-Literature-Review.xlsx` (90 papers, 10 clusters, per-paper analysis of research question / core idea / assumptions / evaluation / limitations / what remains unsolved).

---

## 0. Working definition

A **semantic contract** is a machine-usable statement about what an agent action *means in the world*, not just how to invoke it. Concretely it covers some subset of:

- **Preconditions** — when the action is appropriate (state, authority, consent);
- **Effects** — what it changes, with an **effect class** (idempotent / reversible / compensable / irreversible);
- **Identity** — what counts as *the same* action twice;
- **Postconditions / claims** — what the result asserts and how to check it;
- **Risk / severity** — what a violation costs;
- **Scope** — which principal's policy governs it, for how long.

This subsumes what the literature separately calls tool contracts (Contract2Tool), behavioral contracts (arXiv 2602.22302), observation contracts (ContractBench), delegation contracts (arXiv 2603.18043), safety policies (AgentSpec, Conseca, VeriGuard), capabilities (CaMeL, PORTICO), and effect taxonomies (Atomix, Revisable-by-Design).

**The one-sentence state of the art (July 2026):** *enforcement of a given contract is a crowded, rapidly maturing area; the origin, uncertainty, identity, evolution, and composition of the contract itself are nearly untouched.* Every enforcement system in the corpus — AgentSpec, ShieldAgent, CaMeL, Progent, VeriGuard, PORTICO, Agent Behavioral Contracts — assumes the contract is *given*: hand-written, extracted from documents, or guessed by an LLM. AuthBench then shows experimentally that LLM-guessed contracts fail on both sides (insufficient *and* over-broad). That asymmetry — mature enforcement, absent origins — is where the open problems live.

A cautionary precedent frames everything below: **OWL-S (2004)** tried manually-authored semantic contracts for web services (inputs/outputs/preconditions/effects) and died of authoring cost. MCP is re-running that experiment with even weaker semantics (free-text tool descriptions). Any proposal that assumes humans will write rich semantic contracts at ecosystem scale has already failed once.

---

## 1. The open problems

Grouped in seven families, A–G. Each problem states: the question, why it is hard, the closest existing work, and what remains missing. Problems only — no solutions.

### Family A — Contract origin (inference)

**P1. Black-box semantic contract inference.**
Can a tool's preconditions, effects, and risk class be inferred from *observed behavior alone* — no documentation, no source code?
*Why hard:* tools are effectful (observation perturbs the world), non-resettable, and their state is only partially visible through return values.
*Closest:* Contract2Tool infers contracts but requires docs+schemas and mocked traces on a synthetic registry; AgentBound generates policies from *source code* (white-box, 80.9% accuracy); Daikon and active automata learning (L*) assume deterministic, resettable subjects.
*Missing:* any inference result on real, black-box, effectful tool ecosystems.

**P2. Safe active probing of effectful systems.**
When is an inference engine *allowed to experiment* on a live tool to refine a contract, given that a probe may itself be an irreversible effect?
*Why hard:* the exploration/safety circularity — you need the contract to know whether probing is safe, and you need probes to learn the contract.
*Closest:* model learning's membership queries assume harmless queries; ToolEmu sidesteps by emulating tools with an LLM (fidelity unknown).
*Missing:* a theory of experimental design under irreversibility budgets; sandboxed-probe transfer guarantees (does behavior in a sandbox predict production behavior?).

**P3. Uncertainty-calibrated contracts.**
What is the right representation of *confidence* in an inferred contract clause, and how should an enforcement point act under contract uncertainty?
*Why hard:* clause-level uncertainty interacts with asymmetric loss — wrongly *suppressing* a legitimate action and wrongly *permitting* an irreversible one have wildly different costs.
*Closest:* Contract2Tool reports point-estimate F1 only (authors confirm no uncertainty model); KnowNo gives conformal guarantees for *action selection*; ACSE for *text acceptance*. Nobody attaches calibrated uncertainty to a contract clause.
*Missing:* clause-level credible sets; decision rules with one-sided error control for irreversible effects.

**P4. Convergence and sample complexity of passive inference.**
From production traces (biased, sparse, success-skewed), when does an inferred contract *stabilize*, and what parts of a contract are unlearnable passively?
*Why hard:* production traffic never exercises the precondition boundary — you observe what agents *did*, rarely what would have *failed*; the negative space is invisible.
*Closest:* Daikon's "likely invariants" degrade exactly this way (test-suite bias); AuthBench's golden-permission baseline (replaying observed traces as policy) achieves only 77–82% task success — direct evidence that observed behavior under-determines the contract.
*Missing:* a learnability characterization separating trace-learnable clauses from probe-requiring clauses from human-only clauses.

**P5. Inference and checking of natural-language clauses.**
What does it mean to infer or verify a contract clause whose predicate is semantic ("the refund matches policy", "the message is not misleading") and whose only checker is a stochastic judge?
*Why hard:* the checker itself has unknown error; R-Judge and the severity-scale paper both document systematic judge blind spots (escalation chains).
*Closest:* τ-bench treats NL policy as a monolithic prompt; PolicyGuard reasons over policy in context with no guarantees.
*Missing:* semantics for "clause C holds with judge J of measured reliability r" — contract satisfaction relative to an imperfect oracle.

### Family B — Semantics and guarantees

**P6. A unified satisfaction semantics.**
The field now has at least four incompatible notions of an agent "satisfying" a spec: (p, δ, k)-probabilistic satisfaction (Agent Behavioral Contracts), stochastic assume-guarantee contracts (Nuzzo et al.), conformal coverage (KnowNo/ACSE/PASC), and per-trajectory pass^k reliability (τ-bench). None define refinement or entailment between them.
*Missing:* a metatheory in the Benveniste sense — when does one stochastic semantic contract refine another; what algebraic laws survive.

**P7. Guarantees under agent-controlled control flow.**
Every compositional guarantee in the corpus (PASC's joint conformal coverage, proof-carrying perturbation budgets) assumes a *fixed* pipeline. Agents choose their pipeline at runtime.
*Missing:* coverage/composition results where the composition structure is itself a random variable chosen by the system being certified.

**P8. Monitorability under partial observability of effects.**
Which contract clauses are runtime-checkable at all, when the "state" is a remote system observed only through tool return values — and a returned `200 OK` may or may not mean the email actually sent?
*Why hard:* the classic monitorability hierarchy (safety vs co-safety) presumes you observe the trace; agents observe a lossy projection of it.
*Closest:* Causal Past Logic restricts guards to causally visible events (the right instinct, distributed-systems flavored); my own fence's "irreducible commit window" is a special case — the effect fired but its confirmation was lost.
*Missing:* a monitorability classification for effect clauses under lossy observation; reconciliation semantics for the unobservable window.

**P9. The verifier-trust regress.**
Deterministic checkers cannot read semantics; semantic checkers (LLM judges) have no soundness story; adding a judge to check the judge regresses.
*Closest:* Agentic Model Checking's "agents propose, solvers verify" keeps soundness in the solver — but only where a solver exists (BMC-amenable properties).
*Missing:* a characterization of which contract clauses admit deterministic verification, which admit solver-backed verification, and which are irreducibly judged — and what composite guarantee the mixture yields.

### Family C — Contract evolution

**P10. Attribution of violation-rate change.**
When contract violations rise, three causes are indistinguishable from the violation stream alone: the *tool* changed (provider silently altered semantics), the *agent* changed (model update, prompt drift), or the *tasks* changed (distribution shift).
*Closest:* Agent Drift's ASI measures agent-side drift but is simulation-only and has no reference spec; API-drift tooling diffs *schemas*, not semantics.
*Missing:* causal attribution of contract-violation drift; any real-world longitudinal dataset.

**P11. Benign adaptation vs. violation.**
Without a reference contract, drift metrics cannot distinguish an agent getting *better* from an agent going *rogue* (Agent Drift explicitly treats all deviation as bad). With a reference contract, the dual problem appears: how is the contract itself amended without laundering violations into the spec?
*Missing:* an amendment semantics — who may relax a clause, on what evidence, with what audit trail.

**P12. Contract versioning and migration.**
When a contract changes, what happens to in-flight runs bound to the old version, cached effect-suppressions keyed to old identities, and policies learned against old semantics?
*Why hard:* this is schema migration where the "rows" are live autonomous processes with partially fired irreversible effects.
*Closest:* nothing. The problem is unnamed in the literature.

**P13. Measuring semantic drift in the wild.**
How often do real tool ecosystems (MCP registries) silently change behavior under a stable description?
*Closest:* Parasites-in-the-Toolchain crawls the MCP ecosystem for *attacks*; SoK-Agentic-Skills states that "environment evolution silently invalidates skill assumptions" but measures nothing.
*Missing:* the measurement study itself — repeated behavioral crawls, semantic diffing, base rates. (Nobody knows if semantic drift is a monthly or an hourly phenomenon.)

### Family D — Composition and multi-agent contracts

**P14. A contract algebra for agent chains.**
Assume-guarantee theory gives composition, conjunction, quotient with algebraic laws (Benveniste et al.; computational in Pacti). Does any of it survive when components are stochastic, specifications are partly natural language, and the composition is chosen at runtime?
*Missing:* even a negative result would be publishable — *which* AG laws break, and why.

**P15. Behavioral attestation of declared capabilities.**
A2A Agent Cards, MCP tool descriptions, and skill manifests are all *self-declared* contracts. The Provenance Paradox paper proves routing on self-reports selects the worst delegates, and fixes it with attested *identity* — but nobody attests *semantics* (that the tool/agent actually does what its card says).
*Missing:* description-vs-behavior conformance checking as a continuous, adversarially robust service. Named as the key gap by MCPTox, the MCP SoK, and the threat-modeling paper — shipped by no one.

**P16. Commitments for LLM agents.**
Twenty years of social-commitment theory (Singh et al.: create/discharge/delegate/assign, objective compliance) formalized exactly what A2A-era delegation needs, and none of it has been bridged: what does commitment *discharge* mean when the debtor is stochastic and discharge conditions are judged by an imperfect oracle (P5)?
*Missing:* the bridge paper; runtime commitment tracking over agent protocols.

**P17. Multi-principal contract conflict.**
A deployed agent simultaneously serves the user's intent, the organization's policy, the tool provider's ToS, and the platform's rules. These conflict.
*Closest:* τ-bench and ST-WebAgentBench each encode a *single* policy source; ContractBench shows constraints attached to *artifacts* add a fourth party.
*Missing:* conflict-detection and precedence semantics; even a taxonomy of real cross-principal conflicts.

**P18. Incentives meet enforcement.**
Algorithmic contract theory (Dütting et al.) designs *payment* contracts for strategic agents; runtime enforcement designs *capability* contracts for fallible ones. Agent marketplaces need both at once: a delegate that is both strategic (may misreport) and fallible (may fail honestly).
*Missing:* any model connecting incentive compatibility with behavioral enforceability.

### Family E — Effect identity and irreversibility

**P19. Semantic effect identity.**
When are two syntactically different tool calls *the same effect*? A non-deterministic agent that retries after a crash may re-emit the charge with reordered JSON keys (solved by canonicalization), or with `"New York"` for `"NYC"`, or split into two calls — and syntactic hashing then **fails open** (double-charge). Conversely, two genuinely distinct $20 charges may canonicalize identically and **fail closed** (wrongly suppressed).
*Why hard:* it is a semantic-equivalence judgment with *asymmetric, safety-critical* loss, embedded in an adversarial setting (an injected agent may deliberately paraphrase to escape deduplication).
*Closest:* industry idempotency keys are syntactic and manually threaded; Atomix derives keys per adapter ("file path + hash") and holds them **in memory** — its authors state "crash safety requires durable key storage (future work)" and do not address divergent replay paths; semantic-equivalence work on tool calls exists only for *grading model outputs*, never as a dedup primitive; my own fence ships durable content-addressed identity (`SHA-256(runId ‖ tool ‖ canonicalise(input))`) and documents the semantic gap explicitly (§8, "identity assumptions").
*Missing:* a definition of effect identity between syntactic equality and semantic equivalence; decidable/checkable fragments; calibrated equivalence with one-sided error control; adversarial robustness.

**P20. Learned and verified effect classification.**
Every effect-aware system assumes the idempotent/reversible/compensable/irreversible labels are *given* — Atomix by adapters, Revisable-by-Design as a theory input, the severity scale as a rubric dimension, my registry by hand. Misclassification is the single assumption that voids every guarantee downstream (fence, transactions, severity, revision theory all inherit it).
*Missing:* inference of effect classes from evidence (docs, traces, probes) with verification, and a treatment of the brutal loss asymmetry: calling an irreversible tool "idempotent" is catastrophic; the reverse merely costs latency.

**P21. Compensation synthesis.**
Given an effect, derive its compensating action automatically — including *partial* compensation ("cancel with fee") and compensation under concurrent interleaving.
*Closest:* RAC executes LIFO compensation but the compensation mapping is supplied; sagas assume it authored; Revisable-by-Design proves conflicting compensable actions impose unavoidable cost but doesn't construct compensators.
*Missing:* synthesis, verification that a candidate compensator actually compensates, and semantics for compensation debt when synthesis fails.

**P22. Durable exactly-once under non-deterministic replay, at scale.**
Positional durable execution (Temporal et al.) requires determinism agents violate; content-addressed identity (my fence) restores exactly-once on a single durable store; Atomix names durable keys as future work.
*Missing beyond single-node:* sharded/distributed effect ledgers preserving the uniqueness guarantee under partitions; formal mechanization of the at-most-once theorem; and the composition question — what end-to-end guarantee holds when only *some* providers offer idempotency keys to close the irreducible commit window.

### Family F — Enforcement and intervention semantics

**P23. Safe interruption of in-flight effects.**
Orseau–Armstrong safe interruptibility is about *learning incentives*; the practical question for tool agents is different: what does ABORT *mean* halfway through a multi-effect plan where two of five effects have fired, one is irreversible?
*Closest:* Atomix's abort suppresses unreleased effects and compensates reversible ones — within one transaction, labels given; ACRFence shows restore-points are themselves an attack surface.
*Missing:* interruption semantics spanning epistemic rollback (Shepherd) and world-state obligations; what the intervener *owes* after an abort.

**P24. The enforcement-utility frontier.**
Every enforcement mechanism pays in utility: CaMeL solves 77% with provable security; PORTICO's tighter exposure raised blocked proposals 67→84; PolicyGuard halves blocking to gain adherence. These are point measurements.
*Missing:* the frontier itself — a severity-priced theory of *how much* enforcement a given risk level warrants (binary block vs. warn vs. gate-on-human), and mechanisms that sit on the frontier rather than at its corners.

**P25. Contract-carrying artifacts.**
Constraints that attach to *data* (presigned URLs, tokens, consent scopes) must survive transit through agent memory, summarization, and re-planning. ContractBench shows every frontier model violates them (best: 77.8%); no system *enforces* them.
*Missing:* propagation semantics (this is information-flow labeling where labels are obligations, not taints) through lossy, paraphrasing memory.

### Family G — Evaluation and meta-problems

**P26. A benchmark for contract inference.**
Contract2Tool evaluated on a private synthetic registry with gold contracts. There is no public benchmark of real tools + ground-truth contracts + traces on which inference methods can compete.
*Missing:* the benchmark, and with it the field's ability to measure progress on Family A at all.

**P27. Effect-grounded evaluation.**
Agent-safety benchmarks measurably disagree (taxonomy-consistency paper), and most score *judge opinions of transcripts*. τ-bench's DB-state comparison and my fence's committed-effects ledger point at the alternative: score *what actually happened in the world*, severity-weighted (L0–L6).
*Missing:* effect-ledger-grounded, severity-weighted compliance metrics adopted across benchmarks; construct validation of "agent safety" itself.

**P28. The specification dividend.**
MAST's empirical result is that *specification issues* are the largest failure class in multi-agent systems. Nobody has run the intervention: hold the system constant, add contracts of increasing strength, and measure how much end-to-end failure is actually recovered — versus how much failure migrates into the contracts themselves.
*Missing:* the controlled study separating "contracts help" (assumed everywhere) from "contracts help *this much*, at *this authoring/inference cost*".

---

## 2. Ranking

Scoring each problem family against the four questions — *Has someone solved it? Is it scientifically interesting? Does it require new ideas? Can my infrastructure answer it?* — where "my infrastructure" = the agent-fence durable effect ledger + intent log, the 8-stage supervised runtime over one run-keyed store, the event-sourced execution engine with deterministic replay sandbox, the jailed code-execute subprocess, the RBAC/tenant permission layer, and the two-process crash/replay harness.

| # | Problem | Unsolved? | Interesting? | New ideas needed? | My infra answers it? | Verdict |
|---|---------|-----------|--------------|-------------------|----------------------|---------|
| P19/P20/P22 | Semantic effect identity + learned effect classes + durable exactly-once | ✅ untouched (Atomix defers it in print) | ✅ identity under paraphrase, asymmetric loss, adversarial | ✅ calibrated equivalence w/ one-sided error; decidable fragments | ✅✅ the fence *is* the apparatus | **KEEP — #1** |
| P1/P3/P4 | Black-box contract inference w/ uncertainty + convergence | ⚠️ Contract2Tool adjacent; its gaps are exactly these | ✅ | ✅ uncertainty semantics, learnability split | ✅ event store = traces; sandbox = safe probes; fence = enforcement loop | **KEEP — #2** |
| P10/P11/P13 | Contract evolution / drift attribution / wild measurement | ✅ unmeasured | ✅ | ⚠️ partly measurement, not theory | ⚠️ needs months of repeated crawls; my store only covers my own traffic | **KEEP — #3** |
| P15 | Behavioral attestation of declared capabilities | ✅ named by 3 papers, shipped by none | ✅ | ⚠️ largely P1+P13 recombined | ⚠️ needs ecosystem position/scale | fold into #2/#3 |
| AuthBench-style capability synthesis (advisor Option C) | ⚠️ 4 papers in 6 months (MiniScope, SkillScope, AgentWarden, AuthBench) | ✅ | ⚠️ AuthBench already showed the core tension (sufficiency vs tightness) | ⚠️ RBAC+audit fit, but the guarantee story collapses (see kill) | **KILL** |
| P6/P14 | Unified satisfaction semantics; AG algebra for agents | ✅ | ✅✅ | ✅✅ | ❌ pure theory; infra irrelevant; high risk alone | defer (theory section of #1/#2) |
| P21/P23 | Compensation synthesis; interruption semantics | ✅ | ✅ | ✅ | ⚠️ fence scoped compensation out deliberately | defer |
| P5/P9 | NL clauses; verifier-trust regress | ✅ | ✅✅ | ✅✅ hard | ⚠️ | defer — field-shaping but treacherous |
| P26/P27/P28 | Benchmarks, effect-grounded eval, spec dividend | ✅ | ⚠️ meta | ⚠️ | ✅ | do *inside* whichever direction wins, not as the contribution |
| P7/P8/P12/P16/P17/P18/P24/P25 | remainder | mostly ✅ | mixed | mixed | mixed | catalogued, not pursued |

---

## 3. Kill attempts on the top three

Playing the hostile reviewer against each survivor.

### Candidate #1 — Semantic effect identity (P19/P20/P22)

*"This is just idempotency keys."* — No: keys are syntactic, manually threaded, endpoint-local; the problem is *deriving* identity for arbitrary tools under paraphrase, adversarial rewording, and crash-replay, with one-sided error control. Stripe's key answers "did I see this token"; this asks "is this *the same act*". The distinction is exactly why Atomix's authors deferred it.
*"The semantic-equivalence part will just be an LLM judge, so no guarantees."* — This is the serious attack. Survival requires the layered design: a decidable canonical core (provably safe), a calibrated statistical layer with a *conformal one-sided bound on wrong-suppression*, and an escalation layer (treat-as-new + flag) — with the claim scoped to the calibrated bound, not to oracle equivalence. If the paper claims "we detect semantic duplicates," it dies; if it claims "wrong-suppression ≤ α with duplicates surfaced for reconciliation," it survives.
*"Niche systems problem, wrong venue."* — τ-bench's pass^k, AgentDojo's replays, and every retry loop in production hit it; double-charge is the canonical agent-failure story; and the identity question generalizes (it is the ground layer of contract inference: an effect clause is meaningless without effect identity). Venue: systems-security (fits) or SoSP/OSDI-flavored (fits).
*"Evaluation will be toy."* — The existing two-process crash/replay harness plus paraphrase/adversarial-retry corpora over AgentDojo/τ-bench tools gives a real, adversarial, reproducible evaluation with a measurable counterfactual ($120 vs $240). **Survives.**

### Candidate #2 — Uncertainty-calibrated black-box contract inference (P1/P3/P4)

*"Contract2Tool exists; you're an increment."* — The delta is defensible (black-box, real traces, uncertainty, convergence, enforcement coupling — each absent there and named in their own future work), but the *area* is visibly heating: a June 2026 paper already landed, and by submission time there may be three more. Novelty risk is timing risk.
*"Daikon warmed over with an LLM."* — Must be answered with the learnability split (P4) and the calibrated-decision layer (P3), which are genuinely new; without them the attack lands.
*"Your traces are your own runtime's traffic — external validity."* — Real weakness; needs MCP-ecosystem tools and a public benchmark (P26) to be credible, which is a lot of scope. **Survives, wounded** — strong second, and composes with #1 (effect identity/class is the first clause to infer).

### Candidate #3 — Contract evolution (P10/P11/P13)

*"Where's your longitudinal data?"* — Fatal today. The measurement study needs months of repeated behavioral crawls before the first result exists; my infrastructure observes my own runs, not providers' semantic drift.
*"Measurement without a method contribution."* — Could be a fine IMC-style paper *after* the data exists, and P11's amendment semantics is real theory — but both are calendar-gated and infra-orthogonal. **Survives as science, killed as the *current* choice.** Right move: start the crawler as a background instrument now; write nothing yet.

### Killed outright: advisor's Option C (capability synthesis) — the reasoning

Not because it's crowded (it is: MiniScope, SkillScope, AgentWarden, AuthBench within six months) but because AuthBench's own data breaks the thesis: policies replayed from *observed safe behavior* (their golden baseline) achieve only 77–82% task success — observed behavior **under-determines** the needed capability set. So behavior-derived synthesis must generalize beyond traces; generalization reintroduces the LLM guesswork AuthBench just proved fails both ways ("authorization attractor"); and the sound fallback ("grant exactly what was observed") measurably breaks utility. The sufficiency–tightness tension is the *finding of their paper*, not a gap it left. What survives of Option C is precisely its effect-flavored core — which is P20, and P20 belongs to Candidate #1.

---

## 4. The ONE direction

**Semantic effect identity: when are two actions by a non-deterministic agent the same action — and how do we make irreversible effects exactly-once under that definition?** (P19 + P20 + P22, with P26/P27-style evaluation built in.)

Why this one, in five lines:

1. **Unsolved, in writing.** Atomix (Feb 2026), the nearest system, states its dedup keys are in-memory, that "crash safety requires durable key storage (future work)", and offers no mechanism for divergent replay paths. Industry patterns are syntactic and manual. The semantic-equivalence literature grades model outputs; it has never been a safety primitive.
2. **Scientifically interesting.** It is a semantics problem (identity under paraphrase), a statistics problem (calibrated equivalence with asymmetric, one-sided loss), a security problem (adversarial paraphrase to escape dedup), and a systems problem (durable, distributed uniqueness) — genuinely cross-cutting rather than incremental.
3. **Requires new ideas.** Neither pure canonicalization (too weak: paraphrase escapes) nor pure LLM equivalence (no guarantee: wrong suppression is a silent wrong answer) works; the interesting object is the layered identity with provable core + conformally bounded statistical layer + auditable escalation, and the learned effect-class labels (P20) that gate it.
4. **My infrastructure is the apparatus, not a convenience.** The durable content-addressed fence, intent/commit ledger, two-process crash/replay harness, replay sandbox for counterfactual probes, and the run-keyed store for evidence are already built and tested — the exact instruments the experiments need, and the existing draft paper (`docs/AgentRuntime-Research-Paper.md`) already proves the syntactic-identity base case and names the semantic gap in §8.
5. **It is upstream of everything else here.** Effect identity is the ground truth layer of contract inference (#2 composes with it), the unit of account for evolution (#3 diffs it), and the thing severity scales and compensation logic silently presuppose. Winning this ground makes the later papers easier; losing it makes them unfounded.

**Research question, stated once:**
> *Define and enforce effect identity for non-deterministic agents: a layered identity relation — decidable canonical core, calibrated semantic layer with a distribution-free bound on wrong-suppression, auditable escalation — such that irreversible actions commit exactly once across crash, retry, and divergent replay, even when the retry paraphrases the action; with effect-class labels inferred and verified rather than assumed.*

What I would *not* do (unchanged from the brief): no new proxy, dashboard, CLI, runtime, or visualization. The next artifact is a paraphrase/adversarial-retry corpus and a theorem, not a feature.

---

## 5. Method note (honesty about depth)

Corpus: 90 papers/artifacts (spreadsheet), assembled July 12, 2026 via ~20 targeted searches across ten clusters. Depth is uneven and recorded per-row: ~8 papers read at full-text level (Contract2Tool, Atomix, AuthBench, Agent Contracts, PORTICO, ContractBench, AgentWarden, Agent Drift), ~25 at fetched-abstract level with targeted extraction, the classical foundations (Daikon, L*, Benveniste, Meyer, OWL-S, commitments, KnowNo, semantic entropy, the 2023–2024 benchmark canon) from prior close study, and the remainder from abstracts and secondary snippets. Post-January-2026 papers were all fetched rather than recalled. Claims load-bearing for the ranking (Atomix's in-memory keys and future-work statement; Contract2Tool's four absences; AuthBench's golden-baseline 77–82%) were verified against the papers' own text.
