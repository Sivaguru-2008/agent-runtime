# Results digest

Generated 2026-09-14T12:55:02.616Z. Primary judge: `openai_gpt_oss_120b`.
Corpus: 1066 pairs (cal 508, test 513, attack 45).
Candidate-set size in this file: m = 1. Every corpus pair is one candidate against one dispatch (m = 1), so the multiplicity-corrected threshold coincides with the pairwise one here. The m > 1 behaviour is measured in multiCandidate.js.

## Corpus composition

| category | label | total | cal | test | attack |
|---|---|---:|---:|---:|---:|
| S1_mechanical | SAME | 68 | 34 | 34 | 0 |
| S3_loose_value | SAME | 75 | 37 | 38 | 0 |
| D1_near_miss | DIFF | 251 | 125 | 126 | 0 |
| D2_legit_repeat | DIFF | 150 | 75 | 75 | 0 |
| D3_semantic_diff | DIFF | 61 | 30 | 31 | 0 |
| D4a_field_injection | DIFF | 20 | 0 | 0 | 20 |
| D4b_text_injection | DIFF | 25 | 0 | 0 | 25 |
| S2_paraphrase | SAME | 253 | 126 | 127 | 0 |
| S4_adversarial | SAME | 163 | 81 | 82 | 0 |

Totals: 1066 pairs, 559 SAME, 507 DIFF.

| generator arm | pairs | cal | test | S2 kept/dropped | S4 kept/dropped | transport drops |
|---|---:|---:|---:|---|---|---:|
| handwritten-authors | 68 | 34 | 34 | 68/0 | 0/0 | 0 |
| llama-3.3-70b-versatile | 109 | 54 | 55 | 60/8 | 49/19 | 0 |
| openai/gpt-oss-120b | 121 | 60 | 61 | 59/9 | 62/6 | 0 |
| qwen/qwen3.6-27b | 118 | 59 | 59 | 66/2 | 52/6 | 0 |

Non-LLM pairs (mechanical or hand-specified, no generator): 650.

## Judge integrity (the strict parser)

| judge | calls | scored | abstentions | retries | batches w/ violations | probability-scale batches | non-integer | out-of-range | missing |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| openai_gpt_oss_120b | 12 | 1066 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| qwen_qwen3_6_27b | 8 | 1041 | 25 | 1 | 0 | 0 | 0 | 0 | 0 |
| openai_gpt_oss_20b | 12 | 1066 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Scale-ambiguous accepted values (0 or 1 as a percent) for openai_gpt_oss_120b: 0.
Scale-ambiguous accepted values (0 or 1 as a percent) for qwen_qwen3_6_27b: 26.
Scale-ambiguous accepted values (0 or 1 as a percent) for openai_gpt_oss_20b: 48.

Abstention rates (a pair the judge never returned an admissible score for):

| scorer | all | cal | test | attack |
|---|---|---|---|---|
| llama_3_3_70b_versatile | 94.4% [92.8–95.6] | 94.1% [91.7–95.8] | 94.7% [92.5–96.4] | 93.3% [82.1–97.7] |
| openai_gpt_oss_120b | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.7] | 0.0% [0.0–7.9] |
| openai_gpt_oss_20b | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.7] | 0.0% [0.0–7.9] |
| qwen_qwen3_6_27b | 2.3% [1.6–3.4] | 1.8% [0.9–3.3] | 2.7% [1.6–4.5] | 4.4% [1.2–14.8] |
| ensemble_min | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.7] | 0.0% [0.0–7.9] |
| ensemble_mean | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.7] | 0.0% [0.0–7.9] |

## RQ1 — the canonical core (L0)

- SAME caught by L0 (test): **12.1% [8.8–16.4]**
- DIFF wrongly caught by L0 (test): **0.0%† [0.0–1.6]** — basis `provable-under-A5`
- escaping L0 and therefore requiring the semantic layer: 87.9% of true duplicates

Per category (L0 coverage on the test split):

| category | L0 hit rate |
|---|---|
| S1_mechanical | 100.0% [89.8–100.0] |
| S3_loose_value | 0.0% [0.0–9.2] |
| D1_near_miss | 0.0% [0.0–3.0] |
| D2_legit_repeat | 0.0% [0.0–4.9] |
| D3_semantic_diff | 0.0% [0.0–11.0] |
| S2_paraphrase | 0.0% [0.0–2.9] |
| S4_adversarial | 0.0% [0.0–4.5] |

## RQ2/RQ4 — main configurations (judge `openai_gpt_oss_120b`, test split)

| config | t_hi | t_lo | WS | dedup | flagged escape | silent escape | friction |
|---|---|---|---|---|---|---|---|
| B0 no fence | — | — | 0.0% [0.0–1.6] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 100.0% [98.7–100.0] | 0.0% [0.0–1.6] |
| B1 exact string | — | — | 0.0% [0.0–1.6] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 100.0% [98.7–100.0] | 0.0% [0.0–1.6] |
| B2 canonical L0 (prior art) | — | — | 0.0%† [0.0–1.6] | 12.1% [8.8–16.4] | 0.0% [0.0–1.3] | 87.9% [83.6–91.2] | 0.0% [0.0–1.6] |
| B4 raw judge τ=0.5 | — | — | 2.2% [0.9–4.9] | 99.6% [98.0–99.9] | 0.0% [0.0–1.3] | 0.4% [0.1–2.0] | 0.0% [0.0–1.6] |
| B4 raw judge τ=0.9 | — | — | 0.0% [0.0–1.6] | 69.0% [63.4–74.2] | 0.0% [0.0–1.3] | 31.0% [25.8–36.6] | 0.0% [0.0–1.6] |
| layered α=0.01 | 0.900 | 0.850 | 0.0% [0.0–1.6] | 69.0% [63.4–74.2] | 17.8% [13.8–22.7] | 13.2% [9.7–17.6] | 0.9% [0.2–3.1] |
| hardened α=0.01 | 0.900 | 0.850 | 0.0% [0.0–1.6] | 69.0% [63.4–74.2] | 17.8% [13.8–22.7] | 13.2% [9.7–17.6] | 0.9% [0.2–3.1] |
| tightened α=0.01 | 0.900 | 0.850 | 0.0% [0.0–1.6] | 69.0% [63.4–74.2] | 17.8% [13.8–22.7] | 13.2% [9.7–17.6] | 0.9% [0.2–3.1] |
| layered α=0.05 | 0.200 | 0.200 | 3.4% [1.8–6.7] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] |
| hardened α=0.05 | 0.200 | 0.200 | 3.0% [1.5–6.1] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] |
| tightened α=0.05 | 0.200 | 0.200 | 2.6% [1.2–5.5] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] |

`layered` = L0 + calibrated judge, no witness. `hardened` = + declared-field witness (the proposed system). `tightened` = + witness widened to numbers mentioned in free text.

Per-category decisions, hardened α=0.05:

| category | label | n | suppress | escalate | execute |
|---|---|---:|---|---|---|
| S1_mechanical | SAME | 34 | 100.0% [89.8–100.0] | 0.0% [0.0–10.2] | 0.0% [0.0–10.2] |
| S3_loose_value | SAME | 38 | 100.0% [90.8–100.0] | 0.0% [0.0–9.2] | 0.0% [0.0–9.2] |
| D1_near_miss | DIFF | 126 | 0.8% [0.1–4.4] | 0.0% [0.0–3.0] | 99.2% [95.6–99.9] |
| D2_legit_repeat | DIFF | 75 | 5.3% [2.1–12.9] | 0.0% [0.0–4.9] | 94.7% [87.1–97.9] |
| D3_semantic_diff | DIFF | 31 | 6.5% [1.8–20.7] | 0.0% [0.0–11.0] | 93.5% [79.3–98.2] |
| S2_paraphrase | SAME | 127 | 100.0% [97.1–100.0] | 0.0% [0.0–2.9] | 0.0% [0.0–2.9] |
| S4_adversarial | SAME | 82 | 100.0% [95.5–100.0] | 0.0% [0.0–4.5] | 0.0% [0.0–4.5] |

## RQ7 — judges and ensembles (hardened, α=0.05)

| scorer | t_hi | WS | dedup | silent escape | flagged escape | friction | abstention |
|---|---|---|---|---|---|---|---|
| llama_3_3_70b_versatile | +∞ | 0.0% [0.0–1.6] | 12.1% [8.8–16.4] | 0.0% [0.0–1.3] | 87.9% [83.6–91.2] | 59.5% [53.1–65.6] | 94.7% [92.5–96.4] |
| openai_gpt_oss_120b | 0.200 | 3.0% [1.5–6.1] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] | 0.0% [0.0–0.7] |
| openai_gpt_oss_20b | 0.100 | 3.0% [1.5–6.1] | 97.5% [94.9–98.8] | 2.1% [1.0–4.6] | 0.4% [0.1–2.0] | 6.5% [4.0–10.4] | 0.0% [0.0–0.7] |
| qwen_qwen3_6_27b | 0.950 | 0.9% [0.2–3.1] | 89.0% [84.8–92.1] | 8.5% [5.8–12.4] | 2.5% [1.2–5.1] | 1.3% [0.4–3.7] | 2.7% [1.6–4.5] |
| ensemble_min | 0.000 | 0.9% [0.2–3.1] | 97.9% [95.4–99.0] | 2.1% [1.0–4.6] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] | 0.0% [0.0–0.7] |
| ensemble_mean | 0.350 | 3.9% [2.1–7.2] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] | 0.0% [0.0–0.7] |
| lexical | 0.900 | 3.0% [1.5–6.1] | 30.6% [25.5–36.2] | 3.2% [1.7–6.0] | 66.2% [60.5–71.5] | 19.8% [15.2–25.4] | n/a |

`ensemble_min` suppresses only when EVERY judge scores above threshold — the safety-aligned aggregator under this loss asymmetry.

## RQ7 — cross-generator (self-recognition check, hardened α=0.05)

| judge | paraphrases written by | self-family? | model-written? | n SAME (test) | dedup |
|---|---|---|---|---:|---|
| llama_3_3_70b_versatile | handwritten-authors | false | false | 34 | 0.0% [0.0–10.2] |
| llama_3_3_70b_versatile | llama-3.3-70b-versatile | true | true | 55 | 0.0% [0.0–6.5] |
| llama_3_3_70b_versatile | openai/gpt-oss-120b | false | true | 61 | 0.0% [0.0–5.9] |
| llama_3_3_70b_versatile | qwen/qwen3.6-27b | false | true | 59 | 0.0% [0.0–6.1] |
| openai_gpt_oss_120b | handwritten-authors | false | false | 34 | 100.0% [89.8–100.0] |
| openai_gpt_oss_120b | llama-3.3-70b-versatile | false | true | 55 | 100.0% [93.5–100.0] |
| openai_gpt_oss_120b | openai/gpt-oss-120b | true | true | 61 | 100.0% [94.1–100.0] |
| openai_gpt_oss_120b | qwen/qwen3.6-27b | false | true | 59 | 100.0% [93.9–100.0] |
| openai_gpt_oss_20b | handwritten-authors | false | false | 34 | 100.0% [89.8–100.0] |
| openai_gpt_oss_20b | llama-3.3-70b-versatile | false | true | 55 | 98.2% [90.4–99.7] |
| openai_gpt_oss_20b | openai/gpt-oss-120b | true | true | 61 | 100.0% [94.1–100.0] |
| openai_gpt_oss_20b | qwen/qwen3.6-27b | false | true | 59 | 93.2% [83.8–97.3] |
| qwen_qwen3_6_27b | handwritten-authors | false | false | 34 | 82.4% [66.5–91.7] |
| qwen_qwen3_6_27b | llama-3.3-70b-versatile | false | true | 55 | 85.5% [73.8–92.4] |
| qwen_qwen3_6_27b | openai/gpt-oss-120b | false | true | 61 | 88.5% [78.2–94.3] |
| qwen_qwen3_6_27b | qwen/qwen3.6-27b | true | true | 59 | 84.7% [73.5–91.8] |
| ensemble_min | handwritten-authors | n/a | false | 34 | 100.0% [89.8–100.0] |
| ensemble_min | llama-3.3-70b-versatile | n/a | true | 55 | 98.2% [90.4–99.7] |
| ensemble_min | openai/gpt-oss-120b | n/a | true | 61 | 100.0% [94.1–100.0] |
| ensemble_min | qwen/qwen3.6-27b | n/a | true | 59 | 94.9% [86.1–98.3] |
| ensemble_mean | handwritten-authors | n/a | false | 34 | 100.0% [89.8–100.0] |
| ensemble_mean | llama-3.3-70b-versatile | n/a | true | 55 | 100.0% [93.5–100.0] |
| ensemble_mean | openai/gpt-oss-120b | n/a | true | 61 | 100.0% [94.1–100.0] |
| ensemble_mean | qwen/qwen3.6-27b | n/a | true | 59 | 100.0% [93.9–100.0] |

## RQ3 — adversarial injection (held-out D4 pairs, all DIFF)

| config | D4a field-injection WS | D4b text-injection WS |
|---|---|---|
| rawJudge_llama_3_3_70b_versatile | 0.0% [0.0–16.1] | 0.0% [0.0–13.3] |
| layered_llama_3_3_70b_versatile | 0.0% [0.0–16.1] | 0.0% [0.0–13.3] |
| hardened_llama_3_3_70b_versatile | 0.0%† [0.0–16.1] | 0.0% [0.0–13.3] |
| tightened_llama_3_3_70b_versatile | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_openai_gpt_oss_120b | 65.0% [43.3–81.9] | 84.0% [65.3–93.6] |
| layered_openai_gpt_oss_120b | 70.0% [48.1–85.5] | 88.0% [70.0–95.8] |
| hardened_openai_gpt_oss_120b | 0.0%† [0.0–16.1] | 88.0% [70.0–95.8] |
| tightened_openai_gpt_oss_120b | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_openai_gpt_oss_20b | 15.0% [5.2–36.0] | 28.0% [14.3–47.6] |
| layered_openai_gpt_oss_20b | 15.0% [5.2–36.0] | 28.0% [14.3–47.6] |
| hardened_openai_gpt_oss_20b | 0.0%† [0.0–16.1] | 28.0% [14.3–47.6] |
| tightened_openai_gpt_oss_20b | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_qwen_qwen3_6_27b | 60.0% [38.7–78.1] | 40.0% [23.4–59.3] |
| layered_qwen_qwen3_6_27b | 35.0% [18.1–56.7] | 24.0% [11.5–43.4] |
| hardened_qwen_qwen3_6_27b | 0.0%† [0.0–16.1] | 24.0% [11.5–43.4] |
| tightened_qwen_qwen3_6_27b | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_ensemble_min | 15.0% [5.2–36.0] | 20.0% [8.9–39.1] |
| layered_ensemble_min | 15.0% [5.2–36.0] | 28.0% [14.3–47.6] |
| hardened_ensemble_min | 0.0%† [0.0–16.1] | 28.0% [14.3–47.6] |
| tightened_ensemble_min | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_ensemble_mean | 40.0% [21.9–61.3] | 44.0% [26.7–62.9] |
| layered_ensemble_mean | 60.0% [38.7–78.1] | 44.0% [26.7–62.9] |
| hardened_ensemble_mean | 0.0%† [0.0–16.1] | 44.0% [26.7–62.9] |
| tightened_ensemble_mean | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_lexical | 0.0% [0.0–16.1] | 0.0% [0.0–13.3] |
| layered_lexical | 0.0% [0.0–16.1] | 0.0% [0.0–13.3] |
| hardened_lexical | 0.0%† [0.0–16.1] | 0.0% [0.0–13.3] |
| tightened_lexical | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |

† = zero as a logical consequence of a decidable layer, not a sample estimate.

## Ablations (judge `openai_gpt_oss_120b`, α=0.05, witness-free so each line isolates one component)

| ablation | WS | dedup | flagged | silent | friction |
|---|---|---|---|---|---|
| noL0 | 3.4% [1.8–6.7] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] |
| noEscalation | 3.4% [1.8–6.7] | 100.0% [98.7–100.0] | 0.0% [0.0–1.3] | 0.0% [0.0–1.3] | 0.0% [0.0–1.6] |
| noCalibration | 2.2% [0.9–4.9] | 99.6% [98.0–99.9] | 0.4% [0.1–2.0] | 0.0% [0.0–1.3] | 0.4% [0.1–2.4] |

Judge jurisdiction: L0 settles 6.6% [4.8–9.1], the declared-field witness 17.2% [14.1–20.7], leaving 76.2% [72.3–79.7] for the judge. With the tightened witness: 34.5% [30.5–38.7] settled, 58.9% [54.6–63.0] judged.

## RQ4 — friction reduction A: per-tool calibration

| scorer / α | per-tool WS | per-tool friction | per-tool dedup | global WS | global friction | global dedup |
|---|---|---|---|---|---|---|
| llama_3_3_70b_versatile_alpha_0.01 | 0.0% [0.0–1.6] | 59.5% [53.1–65.6] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 59.5% [53.1–65.6] | 12.1% [8.8–16.4] |
| llama_3_3_70b_versatile_alpha_0.05 | 0.0% [0.0–1.6] | 59.5% [53.1–65.6] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 59.5% [53.1–65.6] | 12.1% [8.8–16.4] |
| openai_gpt_oss_120b_alpha_0.01 | 0.0% [0.0–1.6] | 1.7% [0.7–4.3] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 0.9% [0.2–3.1] | 69.0% [63.4–74.2] |
| openai_gpt_oss_120b_alpha_0.05 | 1.3% [0.4–3.7] | 1.3% [0.4–3.7] | 95.0% [91.8–97.0] | 3.0% [1.5–6.1] | 0.0% [0.0–1.6] | 100.0% [98.7–100.0] |
| openai_gpt_oss_20b_alpha_0.01 | 0.0% [0.0–1.6] | 6.0% [3.6–9.9] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 9.5% [6.3–13.9] | 12.1% [8.8–16.4] |
| openai_gpt_oss_20b_alpha_0.05 | 1.7% [0.7–4.3] | 4.3% [2.4–7.8] | 76.5% [71.2–81.1] | 3.0% [1.5–6.1] | 6.5% [4.0–10.4] | 97.5% [94.9–98.8] |
| qwen_qwen3_6_27b_alpha_0.01 | 0.0% [0.0–1.6] | 2.2% [0.9–4.9] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 2.2% [0.9–4.9] | 12.1% [8.8–16.4] |
| qwen_qwen3_6_27b_alpha_0.05 | 0.4% [0.1–2.4] | 1.7% [0.7–4.3] | 75.1% [69.7–79.8] | 0.9% [0.2–3.1] | 1.3% [0.4–3.7] | 89.0% [84.8–92.1] |
| ensemble_min_alpha_0.01 | 0.0% [0.0–1.6] | 0.9% [0.2–3.1] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 0.9% [0.2–3.1] | 97.5% [94.9–98.8] |
| ensemble_min_alpha_0.05 | 0.9% [0.2–3.1] | 0.0% [0.0–1.6] | 93.6% [90.1–95.9] | 0.9% [0.2–3.1] | 0.0% [0.0–1.6] | 97.9% [95.4–99.0] |
| ensemble_mean_alpha_0.01 | 0.0% [0.0–1.6] | 0.9% [0.2–3.1] | 12.1% [8.8–16.4] | 0.0% [0.0–1.6] | 0.0% [0.0–1.6] | 97.5% [94.9–98.8] |
| ensemble_mean_alpha_0.05 | 2.2% [0.9–4.9] | 0.0% [0.0–1.6] | 95.7% [92.7–97.5] | 3.9% [2.1–7.2] | 0.0% [0.0–1.6] | 100.0% [98.7–100.0] |

Per-tool thresholds (openai_gpt_oss_120b_alpha_0.05):

| tool | t_hi | t_lo | n cal DIFF | n cal SAME |
|---|---|---|---:|---:|
| charge_card | 0.200 | 0.200 | 76 | 64 |
| create_ticket | +∞ | 0.800 | 6 | 22 |
| post_refund | 0.850 | 0.850 | 44 | 37 |
| send_email | 0.150 | 0.150 | 19 | 28 |
| transfer_funds | 0.200 | 0.100 | 56 | 27 |
| wire_money | 0.800 | 0.800 | 29 | 66 |

## Calibration-size sweep (α=0.05, 300 resamples)

| n | P(t_hi=+∞) | mean WS | median WS | p95 WS | max WS | certifies m ≤ |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 100.0% | 0.00% | 0.00% | 0.00% | 0.00% | 0 |
| 20 | 0.0% | 3.18% | 2.16% | 9.48% | 22.84% | 1 |
| 30 | 0.0% | 2.15% | 0.86% | 9.48% | 9.48% | 1 |
| 50 | 0.0% | 3.15% | 2.16% | 9.48% | 9.48% | 2 |
| 100 | 0.0% | 3.56% | 3.45% | 9.48% | 9.48% | 5 |
| 230 | 0.0% | 3.26% | 3.45% | 5.60% | 9.48% | 11 |

Calibration pairs required to certify level α at candidate-set size m (⌈m/α⌉−1):

| m | α=0.01 | α=0.02 | α=0.05 | α=0.1 | α=0.2 |
|---:|---:|---:|---:|---:|---:|
| 1 | 99 | 49 | 19 | 9 | 4 |
| 2 | 199 | 99 | 39 | 19 | 9 |
| 5 | 499 | 249 | 99 | 49 | 24 |
| 10 | 999 | 499 | 199 | 99 | 49 |
| 25 | 2499 | 1249 | 499 | 249 | 124 |
| 50 | 4999 | 2499 | 999 | 499 | 249 |

## Score distributions (non-L0 pairs)

| scorer | SAME median | SAME q25 | SAME saturated | DIFF median | DIFF q90 | DIFF saturated |
|---|---|---|---|---|---|---|
| llama_3_3_70b_versatile | 1.000 | 1.000 | 100.0% | 0.000 | 0.000 | 100.0% |
| openai_gpt_oss_120b | 0.950 | 0.900 | 9.8% | 0.050 | 0.300 | 4.1% |
| openai_gpt_oss_20b | 1.000 | 1.000 | 83.7% | 0.000 | 0.050 | 87.2% |
| qwen_qwen3_6_27b | 1.000 | 1.000 | 88.9% | 0.000 | 0.950 | 89.5% |
| ensemble_min | 0.950 | 0.900 | 12.4% | 0.000 | 0.000 | 95.9% |
| ensemble_mean | 0.977 | 0.967 | 48.7% | 0.017 | 0.350 | 58.6% |
| lexical | 0.839 | 0.807 | 4.5% | 0.125 | 0.893 | 39.6% |

## RQ4 — cost per 1000 irreversible actions

Judge `openai_gpt_oss_120b`: 12 calls at batch 10, 20392 tokens total, 183.7 tokens per comparison, 2148 ms mean call latency.

| witness | fraction judged | judge calls / 1000 dispatches | judge tokens / 1000 | added latency per judged dispatch | escalations / 1000 distinct actions |
|---|---|---:|---:|---:|---:|
| declaredWitness | 76.2% | 762 | 140022 | 2148 ms | 0 |
| tightenedWitness | 58.9% | 589 | 108150 | 2148 ms | 0 |

Token cost per 1000 dispatches at a hypothetical rate (we measured tokens, not prices):

| rate | USD / 1000 dispatches |
|---|---:|
| $0.1/Mtok | 0.014 |
| $0.5/Mtok | 0.07 |
| $1/Mtok | 0.14 |

## RQ6 — multiple committed candidates

Judge `llama-3.1-8b-instant`. K=50. DIFF units 40 (test 20), SAME units 20.
Calibration pool: 205 corpus DIFF scores → certifiable m ≤ {"0.01":2,"0.05":10,"0.1":20}. t_lo=0.550.

### α = 0.01

| m | rule | t_hi | WS | dedup | friction | silent escape |
|---:|---|---|---|---|---|---|
| 1 | uncorrected | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | bonferroni | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | setconformal | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | uncorrected | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | bonferroni | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | setconformal | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | uncorrected | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | uncorrected | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | uncorrected | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 50 | uncorrected | 0.910 | 65.0% [43.3–81.9] | 70.0% [48.1–85.5] | 0.0% [0.0–16.1] | 30.0% [14.5–51.9] |
| 50 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |
| 50 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |
| 50 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |

### α = 0.05

| m | rule | t_hi | WS | dedup | friction | silent escape |
|---:|---|---|---|---|---|---|
| 1 | uncorrected | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | bonferroni | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | setconformal | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | inExperimentBonferroni | 0.000 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | uncorrected | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | bonferroni | 0.906 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | setconformal | 0.906 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | uncorrected | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | bonferroni | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | setconformal | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | uncorrected | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | bonferroni | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | setconformal | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | uncorrected | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 50 | uncorrected | 0.900 | 65.0% [43.3–81.9] | 70.0% [48.1–85.5] | 0.0% [0.0–16.1] | 30.0% [14.5–51.9] |
| 50 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |
| 50 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |
| 50 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |

### α = 0.1

| m | rule | t_hi | WS | dedup | friction | silent escape |
|---:|---|---|---|---|---|---|
| 1 | uncorrected | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | bonferroni | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | setconformal | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 1 | inExperimentBonferroni | 0.000 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | uncorrected | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | bonferroni | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | setconformal | 0.900 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 2 | inExperimentBonferroni | 0.000 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | uncorrected | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | bonferroni | 0.906 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | setconformal | 0.906 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 5 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | uncorrected | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | bonferroni | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | setconformal | 0.910 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 10 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | uncorrected | 0.893 | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 25 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 50.0% [29.9–70.1] |
| 50 | uncorrected | 0.893 | 65.0% [43.3–81.9] | 70.0% [48.1–85.5] | 0.0% [0.0–16.1] | 30.0% [14.5–51.9] |
| 50 | bonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |
| 50 | setconformal | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |
| 50 | inExperimentBonferroni | +∞ | 0.0% [0.0–16.1] | 0.0% [0.0–16.1] | 65.0% [43.3–81.9] | 30.0% [14.5–51.9] |

How the maximum distinct-pair score grows with m — the mechanism the correction exists for:

| m | n | mean max | median max | p90 max | max max |
|---:|---:|---:|---:|---:|---:|
| 1 | 20 | 0.000 | 0.000 | 0.000 | 0.000 |
| 2 | 20 | 0.000 | 0.000 | 0.000 | 0.000 |
| 5 | 20 | 0.000 | 0.000 | 0.000 | 0.000 |
| 10 | 20 | 0.000 | 0.000 | 0.000 | 0.000 |
| 25 | 20 | 0.000 | 0.000 | 0.000 | 0.000 |
| 50 | 20 | 0.650 | 1.000 | 1.000 | 1.000 |

Cost at α=0.05: [{"m":1,"comparisonsPerDispatch":1,"meanComparisonLatencyMs":37,"estimatedJudgeLatencyMsPerDispatch":37,"tokensPerComparison":90},{"m":2,"comparisonsPerDispatch":2,"meanComparisonLatencyMs":37,"estimatedJudgeLatencyMsPerDispatch":74,"tokensPerComparison":90},{"m":5,"comparisonsPerDispatch":5,"meanComparisonLatencyMs":37,"estimatedJudgeLatencyMsPerDispatch":185,"tokensPerComparison":90},{"m":10,"comparisonsPerDispatch":10,"meanComparisonLatencyMs":37,"estimatedJudgeLatencyMsPerDispatch":370,"tokensPerComparison":90},{"m":25,"comparisonsPerDispatch":25,"meanComparisonLatencyMs":37,"estimatedJudgeLatencyMsPerDispatch":925,"tokensPerComparison":90},{"m":50,"comparisonsPerDispatch":50,"meanComparisonLatencyMs":37,"estimatedJudgeLatencyMsPerDispatch":1850,"tokensPerComparison":90}]

## RQ5 — paraphrased crash/replay across process death

48 trials, three OS processes each. Judge `lexical-offline` (family llama); paraphrase pool from `llama-3.3-70b-versatile` (family llama, 53 variants, 2 rejected).
Cross-family pool: **NO — self-recognition confound present**. Thresholds t_hi=0.900, t_lo=0.550 (source `layered_lexical_alpha_0.05`).

| crash point | commit window? | mode | n | exactly-once | mean wired | crash point reached | suppressed | window flagged |
|---|---|---|---:|---|---:|---|---|---|
| before_fence | no | syntactic | 6 | 0.0% [0.0–39.0] | $1560 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| before_fence | no | semantic | 6 | 16.7% [3.0–56.4] | $1430 | 100.0% [61.0–100.0] | 16.7% [3.0–56.4] | 0.0% [0.0–39.0] |
| after_L0 | no | syntactic | 6 | 0.0% [0.0–39.0] | $1560 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| after_L0 | no | semantic | 6 | 16.7% [3.0–56.4] | $1430 | 100.0% [61.0–100.0] | 16.7% [3.0–56.4] | 0.0% [0.0–39.0] |
| after_witness | no | syntactic | 6 | 0.0% [0.0–39.0] | $2340 | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| after_witness | no | semantic | 6 | 16.7% [3.0–56.4] | $1430 | 100.0% [61.0–100.0] | 16.7% [3.0–56.4] | 0.0% [0.0–39.0] |
| after_judge | no | syntactic | 6 | 0.0% [0.0–39.0] | $2340 | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| after_judge | no | semantic | 6 | 0.0% [0.0–39.0] | $1560 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| before_external_effect | no | syntactic | 6 | 0.0% [0.0–39.0] | $1560 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| before_external_effect | no | semantic | 6 | 0.0% [0.0–39.0] | $1560 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 100.0% [61.0–100.0] |
| during_external_commit_window | yes | syntactic | 6 | 0.0% [0.0–39.0] | $2340 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| during_external_commit_window | yes | semantic | 6 | 0.0% [0.0–39.0] | $2080 | 83.3% [43.6–97.0] | 33.3% [9.7–70.0] | 66.7% [30.0–90.3] |
| after_external_effect_before_local_commit | yes | syntactic | 6 | 0.0% [0.0–39.0] | $2340 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| after_external_effect_before_local_commit | yes | semantic | 6 | 16.7% [3.0–56.4] | $1950 | 66.7% [30.0–90.3] | 33.3% [9.7–70.0] | 66.7% [30.0–90.3] |
| after_local_commit | no | syntactic | 6 | 0.0% [0.0–39.0] | $2340 | 100.0% [61.0–100.0] | 0.0% [0.0–39.0] | 0.0% [0.0–39.0] |
| after_local_commit | no | semantic | 6 | 0.0% [0.0–39.0] | $2210 | 100.0% [61.0–100.0] | 16.7% [3.0–56.4] | 0.0% [0.0–39.0] |

| scope | mode | n | exactly-once | mean wired | total wired | window flagged |
|---|---|---:|---|---:|---:|---|
| all crash points | syntactic | 48 | 0.0% [0.0–7.4] | $2048 | $98280 | 0.0% [0.0–7.4] |
| all crash points | semantic | 48 | 8.3% [3.3–19.6] | $1706 | $81900 | 29.2% [18.2–43.2] |
| outside the commit window | syntactic | 36 | 0.0% [0.0–9.6] | $1950 | $70200 | 0.0% [0.0–9.6] |
| outside the commit window | semantic | 36 | 8.3% [2.9–21.8] | $1603 | $57720 | 16.7% [7.9–31.9] |
| inside the commit window | syntactic | 12 | 0.0% [0.0–24.2] | $2340 | $28080 | 0.0% [0.0–24.2] |
| inside the commit window | semantic | 12 | 8.3% [1.5–35.4] | $2015 | $24180 | 66.7% [39.1–86.2] |

Semantic suppression scores observed: min 0.95, max 0.98, n=9, against t_hi=0.900.

## Human-verified labels

Annotators: compound-mini, compound, qwen27b. Fully annotated: 117/154.
Fleiss κ = 0.829; adjudication rate 0.0% [0.0–3.2]; agreement with construction 88.0% [80.9–92.7].

| stratum | n | agreement with construction | UNSURE rate | adjudication rate |
|---|---:|---|---|---|
| same_mechanical | 12 | 100.0% [75.8–100.0] | 0.0% [0.0–9.6] | 0.0% [0.0–24.2] |
| same_paraphrase | 10 | 100.0% [72.2–100.0] | 0.0% [0.0–11.4] | 0.0% [0.0–27.8] |
| same_loose_value | 12 | 100.0% [75.8–100.0] | 0.0% [0.0–9.6] | 0.0% [0.0–24.2] |
| same_adversarial | 12 | 100.0% [75.8–100.0] | 0.0% [0.0–9.6] | 0.0% [0.0–24.2] |
| diff_near_miss | 14 | 92.9% [68.5–98.7] | 0.0% [0.0–8.4] | 0.0% [0.0–21.5] |
| diff_text_only | 12 | 50.0% [25.4–74.6] | 0.0% [0.0–9.6] | 0.0% [0.0–24.2] |
| diff_semantic | 8 | 87.5% [52.9–97.8] | 0.0% [0.0–13.8] | 0.0% [0.0–32.4] |
| attack_field | 12 | 100.0% [75.8–100.0] | 0.0% [0.0–9.6] | 0.0% [0.0–24.2] |
| attack_text | 11 | 45.5% [21.3–72.0] | 0.0% [0.0–10.4] | 0.0% [0.0–25.9] |
| attack_encoding | 11 | 100.0% [74.1–100.0] | 0.0% [0.0–10.4] | 0.0% [0.0–25.9] |
| misdeclared | 3 | 100.0% [43.9–100.0] | 0.0% [0.0–29.9] | 0.0% [0.0–56.1] |

