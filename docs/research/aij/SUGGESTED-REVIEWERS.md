# Suggested reviewers (draft, for the author to confirm)

Each person below is listed for one paper whose title, authors and venue were
checked on 2026-09-26 against Crossref, arXiv or Semantic Scholar (the same
records used for the bibliography). **Current affiliations and e-mail addresses
were not verified** — look them up on the person's current web page before
entering them in the submission system.

Conflict check: none of these people appears as a co-author on any work by the
author that I could find, and none is at the author's institution (the author
is an independent researcher in Chennai). The author should confirm there is no
personal or professional relationship before submitting.

| # | Name | Area | Verified relevant paper | Why for this manuscript |
|---|---|---|---|---|
| 1 | Anastasios N. Angelopoulos | conformal prediction | Angelopoulos & Bates, "Conformal Prediction: A Gentle Introduction", *Foundations and Trends in Machine Learning* 16(4):494–591, 2023, doi:10.1561/2200000101 | Theorem 1, jurisdiction-matched calibration, class-conditional (Mondrian) corollary |
| 2 | Ruodu Wang | multiple testing under arbitrary dependence | Vovk & Wang, "Combining p-values via averaging", *Biometrika* 107(4):791–808, 2020, doi:10.1093/biomet/asaa027; Vovk, Wang & Wang, "Admissible ways of merging p-values under arbitrary dependence", *Ann. Statist.* 50(1), 2022, doi:10.1214/21-AOS2109 | Theorem 2 / Corollary 2 (the Bonferroni bound attained by the deployed statistic) |
| 3 | Allen Z. Ren | calibrated decision-making by LLM agents | Ren et al., "Robots That Ask For Help: Uncertainty Alignment for Large Language Model Planners", CoRL 2023 (PMLR 229), arXiv:2307.01928 | conformal control decisions for LLM agents; asymmetric-loss framing |
| 4 | Yangjun Ruan | LLM-agent reliability and risk | Ruan et al., "Identifying the Risks of LM Agents with an LM-Emulated Sandbox", ICLR 2024, arXiv:2309.15817 | irreversible agent actions, LM-as-evaluator of agent actions |
| 5 | Edoardo Debenedetti | prompt injection against agents | Debenedetti et al., "AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents", NeurIPS 2024 Datasets & Benchmarks, arXiv:2406.13352 | threat model, typed-field refuter, prose-only injection results |

Alternates, verified the same way: Kai Greshake (Greshake et al., "Not What
You've Signed Up For…", AISec 2023, doi:10.1145/3605764.3623985) for prompt
injection; Christopher Mohri (Mohri & Hashimoto, "Language Models with
Conformal Factuality Guarantees", ICML 2024, PMLR 235) for conformal methods on
language models. Tatsunori Hashimoto co-authored papers with both Ruan and
Mohri; suggest at most one of the three.

The previous cover letter suggested Stephen Bates, Peter Alvaro and Florian
Tramèr. They were removed from the cover letter (AIJ collects suggestions in the
submission system), not because of a conflict; the rationale given for Bates
cited a "Theorem 3" that does not exist in the manuscript. Bates co-authored the
Angelopoulos reference above, so suggest at most one of the two.
