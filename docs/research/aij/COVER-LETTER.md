# Cover Letter for Elsevier Artificial Intelligence Journal (AIJ)

To the Editors-in-Chief  
*Artificial Intelligence* (Elsevier, ISSN 0004-3702)  

September 25, 2026  

**Submission: "Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate Suppression" — Full Length Article**  

Dear Editors,

Please consider the enclosed manuscript for publication in *Artificial Intelligence*.

**The problem.** When an LLM agent retries an irreversible tool call — a payment, a message, a booking — it re-synthesises its arguments. Two requests that denote one real-world act can therefore differ in every surface token, and every classical duplicate-suppression mechanism (journal positions, client-chosen idempotency keys, content-addressed hashes) silently fails, because each answers "are these the same act?" positionally or syntactically. Recent work names this failure in agent checkpoint–restore and in authorisation, and proposes asking a language model whether a re-synthesised call matches a logged one. What is missing is a decision procedure whose safety-critical error is *bounded* rather than inherited from an unconstrained judge.

**What the paper contributes.** We treat effect identity as a decision under asymmetric loss: executing a duplicate is costly but observable, whereas suppressing a distinct act is silent. We show that any identity procedure decomposes into a certifier (a decidable proof of sameness), a refuter (a decidable proof of difference) and a residual that neither settles, and that the residual is determined by the declared tool schema alone. Our fence consults a language model only on the residual, and suppresses only when the maximum judge score over the surviving committed candidates exceeds a one-sided conformal threshold at level $\alpha/m$ — the statistic the algorithm actually thresholds, rather than a single pairwise score. A theorem bounds the probability of wrongly suppressing a distinct act by $\alpha$ under exchangeability, distribution-free and finite-sample, with arbitrary dependence among the $m$ comparisons. A proposition states exactly what this costs: refining the schema shrinks the residual and therefore the calibration pool, moving the threshold to a higher order statistic and shrinking the certifiable candidate budget. We call this the refinement dilemma and decompose it empirically into a pool-size and a pool-composition component.

Empirically, on 1,066 constructed pairs over six irreversible tools and three judges from two model families, the fence deduplicates 94.7% of paraphrased duplicates at 1.7% wrong suppression, against 12.1% for canonical keys; the bounded direction transfers across judges while deduplication does not. A typed-field refuter removes a field-injection attack by construction, and prose-only injection still succeeds 84% of the time — a negative result we report as prominently as the positive ones.

**What the paper does not claim.** We think this matters more than the headline numbers, so we state it here as plainly as in the manuscript:

1. **This is not an exactly-once protocol.** It provides bounded identity recognition and fence-level at-most-once commitment. External exactly-once requires composition with a provider key that is both paraphrase-invariant and complete, and we prove exactly that and no more.
2. **The labels are constructed by the author, and independent human validation was not collected.** A preregistered relabelling study was designed with two channels. The human channel was never run; the complete protocol and instrument ship unrun with the artifact. A blinded panel of language models was run instead and is reported only as model-panel evidence.
3. **That panel's preregistered safety test triggered**, and we report the trigger rather than the favourable reading: re-derived wrong suppression rose from 9.9% to 10.5% under the panel's labels. The manuscript reports the cause we found during this revision — 93 of the 154 annotated items come from an extension corpus whose judge scores were never persisted, so they enter the denominator without being able to enter the numerator — and reports the restricted analysis alongside it.
4. **The bound is marginal, not per-deployment.** Under seed-level resplitting, 10.5% of splits exceed $\alpha$. The manuscript measures this rather than leaving the reader to assume otherwise.
5. **No technique here is new.** Canonicalisation, typed validation, LLM judging, split-conformal calibration and Bonferroni correction are all prior art. The contribution is their combination into a decision procedure for effect identity, and the analysis of what that combination can and cannot guarantee. We make no priority claim.

**Fit with the journal.** The paper is a principled treatment of a problem created by AI systems acting in the world: it formalises a decision, proves what can be proved about it, measures what cannot, and states the boundary between the two in a table that maps every claim to its evidence. It engages the agent systems, LLM-as-judge, conformal prediction and prompt-injection literatures, and it reports its negative results and its own defects, including a scoring defect in an earlier version of this work that inverted a fifth of its judge scores while reporting a 0% failure rate.

**Artifact.** Everything reproduces. The corpus, all judge scores, the annotation materials, every analysis script and every results file accompany the manuscript. The open artifact repository is maintained at `https://github.com/Sivaguru-2008/agent-runtime`, and a permanent Zenodo DOI will be assigned upon publication. A single command regenerates the figures, checks every interval quoted anywhere in the paper against a computed rate (522 intervals across 50 files), runs 61 unit tests and 11 assertion classes over the shipped data, and compiles both documents; the build fails if any quoted number is one the results do not contain.

**Declarations.** This work is not under consideration elsewhere and no version of it has been published. The declaration of competing interests notes that I develop AgentRuntime, a project that contains a content-addressed fence of the kind used as this paper's baseline. Use of generative AI in manuscript preparation is declared in the manuscript. No human subjects took part in this research.

**Suggested Reviewers:**
1. **Stephen Bates** (Massachusetts Institute of Technology / UC Berkeley)  
   *Expertise:* Conformal prediction, distribution-free risk control, multiple testing.  
   *Rationale:* Qualified to assess the validity of Theorem 2, Theorem 3 (Bonferroni / extreme-value corrections), and the conservative treatment of discrete non-conformity ties.
2. **Peter Alvaro** (University of California, Santa Cruz)  
   *Expertise:* Distributed systems reliability, lineage-driven fault injection, idempotence and recovery protocols.  
   *Rationale:* Qualified to evaluate the crash-replay harness, at-most-once fence commitment guarantees, and the formal analysis of the external commit window.
3. **Florian Tramèr** (ETH Zürich)  
   *Expertise:* AI safety, prompt injection vulnerabilities, and adversarial evaluation of LLM systems.  
   *Rationale:* Qualified to scrutinize the adversarial threat model, the typed-field refuter veto, and the schema-refinement trade-off on prompt injections.

Thank you for your consideration.

Yours sincerely,

Sivaguru R. M.  
Independent Research, AgentRuntime Project  
Chennai, Tamil Nadu, India  
sivagurumurugan1@gmail.com  
