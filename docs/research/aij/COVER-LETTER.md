# Cover Letter: Artificial Intelligence (AIJ), Elsevier

**Date:** September 27, 2026  
**To:** The Editors-in-Chief, *Artificial Intelligence* (Elsevier)  
**From:** Sivaguru R. M., Independent Researcher, AgentRuntime Project  
**Email:** sivagurumurugan1@gmail.com  

**Manuscript Title:** *Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate Suppression*  
**Article Type:** Original Research Paper  

Dear Editors-in-Chief,

I am pleased to submit our research manuscript entitled **“Effect Identity for LLM Agents: Schema-Determined Limits on Duplicate Suppression”** for consideration for publication as a regular research paper in *Artificial Intelligence*.

### Overview and Fit for *Artificial Intelligence*
Autonomous language-model agents are increasingly tasked with executing irreversible real-world tool operations—such as charging credit cards, executing bank transfers, sending non-retractable messages, and creating persistent database records. When an agent crashes, times out, or retries after interruption, re-prompting samples fresh completions that re-synthesises tool arguments. Consequently, two requests denoting the identical intended real-world act frequently share no common surface string. Syntactic and content-addressed idempotency keys fail silently, while unconstrained LLM judgements inherit severe vulnerabilities to prompt steering, hallucinatory drift, and bias.

This work addresses effect identity as a problem of **reasoning under uncertainty with asymmetric loss**. Suppressing a distinct act (*wrong suppression*) is silent and irrecoverable; executing an unintended duplicate is visible and auditable. We develop a formal and empirical framework that characterizes how far an agent runtime can safely suppress duplicates:

1. **Structural Decomposition and Jurisdiction Matching (C1–C2):** We prove that any sound effect-identity mechanism decomposes into a decidable *certifier* (proving equivalence under declared normalisations), a decidable *refuter* (proving difference via pinned typed fields), and a schema-determined *residual* that alone requires an LLM judge. Crucially, we formalise the *jurisdiction-matching condition*: calibration pools must be sampled strictly from the residual jurisdiction, as drawing pairs from the full input distribution masks severe operational error violations.
2. **The Schema Refinement Dilemma (C4):** We identify and formalise an intrinsic structural trade-off: refining tool declarations or demanding per-class validity strengthens deterministic guarantees and shrinks the residual, but simultaneously contracts the available calibration population and reduces the certifiable candidate budget ($m$).
3. **Multiplicity-Corrected Statistical Validity (C3):** We construct a split-conformal calibration mechanism for the deployed maximum statistic over surviving candidate effects under asymmetric loss ($\alpha=0.05$), proving finite-sample marginal error control and showing that under scale-free decision rules the Bonferroni bound is attained in the worst case.
4. **Empirical and Adversarial Boundaries (C5):** We test the framework across 1,066 constructed pairs, three models across two model families, adversarial injections, and OS-level crash/replay across process death. We explicitly disclose and analyze all boundary results: an 84.0\% prose-only injection vulnerability, a 6.5\% D3 class rate under marginal calibration, 10.5\% seed-split exceedance, and a triggered preregistered label panel rule; and we report a targeted Channel~H human annotation follow-up (100.0\% agreement on contested strata, $\kappa=0.731$) demonstrating that contested boundaries were an artifact of language-model reasoning rather than human usage.
5. **Execution Semantics and At-Most-Once Guarantees:** We formalise the distinction between (A) identity recognition, (B) fence-level at-most-once commitment across process death, and (C) external provider exactly-once execution, demonstrating why local runtimes cannot provide (C) without provider-level invariant idempotency keys.

### Declarations and Research Artifact
- **Originality:** This manuscript is original, has not been published previously, and is not currently under consideration for publication elsewhere.
- **Reproducibility:** A complete, self-contained research artifact accompanies the submission. Every quoted numerical interval and headline assertion is verified against computed offline data via automated audit tools (`checkPaper.js`, `check-claims.mjs`, `verify.js`). All code, data, and scripts will be permanently archived with a DOI upon acceptance.
- **Ethics and AI Disclosure:** All generative AI assistance during drafting, code review, and metadata verification is fully disclosed in the manuscript's declarations in compliance with Elsevier's policy.

Thank you for your time and consideration of our work. We look forward to the reviewers' feedback.

Sincerely,  
**Sivaguru R. M.**  
Independent Researcher, AgentRuntime Project  
Chennai, Tamil Nadu, India  
