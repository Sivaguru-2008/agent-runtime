# Cover letter — *Artificial Intelligence* (Elsevier)

To the Editors-in-Chief, *Artificial Intelligence*

**Submission:** "Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate Suppression" (Regular Paper)

Dear Editors,

An autonomous agent that retries an irreversible action — a payment, a message, a record — re-synthesises its arguments, so the retry and the original can denote one act while sharing no surface token. Deciding whether they do is a decision under uncertainty with an irreversible, asymmetric loss: a missed duplicate is costly but visible, while suppressing a distinct act is silent. The only general-purpose decider is a stochastic language-model oracle, and its input can be written by an adversary. The manuscript studies what can be guaranteed in that setting.

**Contributions.** (i) Effect identity formalised as reasoning under uncertainty with asymmetric loss. (ii) A certifier/refuter/residual decomposition: sound decidable relations settle what the declared schema pins, every error lies in a schema-determined residual, and only the residual goes to the oracle. (iii) Jurisdiction matching as a necessary condition for validity: a multiplicity-corrected conformal bound on the statistic the mechanism actually deploys, a demonstration that a calibration pool drawn from outside the jurisdiction hides its own violation, and the observation that the standard bound is exactly attained. (iv) The refinement dilemma: refining the schema, or demanding validity per kind of difference, spends the same calibration budget; this is stated exactly and measured. (v) An evaluation designed around these boundaries (two decision instances, three judges, injection, class-conditional validity, crash and replay).

**What is not new.** Canonicalisation, typed validation, LLM judging, split-conformal calibration and the Bonferroni correction are all known, and the tightness result records that a classically sharp bound is attained rather than proving a new inequality. The contribution is the decomposition, the conditions under which the composition is valid, and the evaluation.

**Disclosures.** The labels are constructed by the author. A human relabelling study was preregistered but not collected; a blinded panel of language models was run instead and is reported only as model-panel evidence. Its preregistered safety test triggered, and the manuscript reports the trigger together with two defects in the computation. A targeted human follow-up and a multi-candidate experiment on an admitted judge are prepared and released but not run, and no result from either is claimed. Other negative results are reported in full: prose-only injection succeeds 84% of the time on the primary judge, 10.5% of seed-level splits exceed α, and one category of distinct pairs is wrongly suppressed above α under the marginal bound.

**Artifact.** Corpus, judge scores, annotation materials and all analysis code accompany the submission; a single build regenerates every table and fails if any quoted interval does not match a computed rate.

**Declarations.** The work is not under consideration elsewhere. I develop AgentRuntime, a project containing a content-addressed fence of the kind used as the baseline; this is declared. Use of generative AI is declared in the manuscript. No human subjects took part.

Yours sincerely,

Sivaguru R. M.
[POSTAL ADDRESS — to be completed by the author]
sivagurumurugan1@gmail.com
