# Results digest

Generated 2026-08-16T12:28:49.440Z. Primary judge: `openai_gpt_oss_120b`.
Corpus: 955 pairs (cal 453, test 457, attack 45).
Candidate-set size in this file: m = 1. Every corpus pair is one candidate against one dispatch (m = 1), so the multiplicity-corrected threshold coincides with the pairwise one here. The m > 1 behaviour is measured in multiCandidate.js.

## Corpus composition

| category | label | total | cal | test | attack |
|---|---|---:|---:|---:|---:|
| S1_mechanical | SAME | 68 | 34 | 34 | 0 |
| S3_loose_value | SAME | 15 | 7 | 8 | 0 |
| D1_near_miss | DIFF | 251 | 125 | 126 | 0 |
| D2_legit_repeat | DIFF | 150 | 75 | 75 | 0 |
| D3_semantic_diff | DIFF | 10 | 5 | 5 | 0 |
| D4a_field_injection | DIFF | 20 | 0 | 0 | 20 |
| D4b_text_injection | DIFF | 25 | 0 | 0 | 25 |
| S2_paraphrase | SAME | 253 | 126 | 127 | 0 |
| S4_adversarial | SAME | 163 | 81 | 82 | 0 |

Totals: 955 pairs, 499 SAME, 456 DIFF.

| generator arm | pairs | cal | test | S2 kept/dropped | S4 kept/dropped | transport drops |
|---|---:|---:|---:|---|---|---:|
| handwritten-authors | 68 | 34 | 34 | 68/0 | 0/0 | 0 |
| llama-3.3-70b-versatile | 109 | 54 | 55 | 60/8 | 49/19 | 0 |
| openai/gpt-oss-120b | 121 | 60 | 61 | 59/9 | 62/6 | 0 |
| qwen/qwen3.6-27b | 118 | 59 | 59 | 66/2 | 52/6 | 0 |

## Judge integrity (the strict parser)

Abstention rates (a pair the judge never returned an admissible score for):

| scorer | all | cal | test | attack |
|---|---|---|---|---|
| llama_3_3_70b_versatile | 93.7% [92.0–95.1] | 93.4% [90.7–95.3] | 94.1% [91.5–95.9] | 93.3% [82.1–97.7] |
| openai_gpt_oss_120b | 3.7% [2.6–5.1] | 3.1% [1.8–5.1] | 4.2% [2.7–6.4] | 4.4% [1.2–14.8] |
| openai_gpt_oss_20b | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.8] | 0.0% [0.0–7.9] |
| qwen_qwen3_6_27b | 88.5% [86.3–90.4] | 88.7% [85.5–91.3] | 88.0% [84.7–90.6] | 91.1% [79.3–96.5] |
| ensemble_min | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.8] | 0.0% [0.0–7.9] |
| ensemble_mean | 0.0% [0.0–0.4] | 0.0% [0.0–0.8] | 0.0% [0.0–0.8] | 0.0% [0.0–7.9] |

## RQ1 — the canonical core (L0)

- SAME caught by L0 (test): **13.5% [9.9–18.3]**
- DIFF wrongly caught by L0 (test): **0.0%† [0.0–1.8]** — basis `provable-under-A5`
- escaping L0 and therefore requiring the semantic layer: 86.5% of true duplicates

Per category (L0 coverage on the test split):

| category | L0 hit rate |
|---|---|
| S1_mechanical | 100.0% [89.8–100.0] |
| S3_loose_value | 0.0% [0.0–32.4] |
| D1_near_miss | 0.0% [0.0–3.0] |
| D2_legit_repeat | 0.0% [0.0–4.9] |
| D3_semantic_diff | 0.0% [0.0–43.4] |
| S2_paraphrase | 0.0% [0.0–2.9] |
| S4_adversarial | 0.0% [0.0–4.5] |

## RQ2/RQ4 — main configurations (judge `openai_gpt_oss_120b`, test split)

| config | t_hi | t_lo | WS | dedup | flagged escape | silent escape | friction |
|---|---|---|---|---|---|---|---|
| B0 no fence | — | — | 0.0% [0.0–1.8] | 0.0% [0.0–1.5] | 0.0% [0.0–1.5] | 100.0% [98.5–100.0] | 0.0% [0.0–1.8] |
| B1 exact string | — | — | 0.0% [0.0–1.8] | 0.0% [0.0–1.5] | 0.0% [0.0–1.5] | 100.0% [98.5–100.0] | 0.0% [0.0–1.8] |
| B2 canonical L0 (prior art) | — | — | 0.0%† [0.0–1.8] | 13.5% [9.9–18.3] | 0.0% [0.0–1.5] | 86.5% [81.7–90.1] | 0.0% [0.0–1.8] |
| B4 raw judge τ=0.5 | — | — | 1.5% [0.5–4.2] | 95.6% [92.3–97.5] | 0.0% [0.0–1.5] | 4.4% [2.5–7.7] | 0.0% [0.0–1.8] |
| B4 raw judge τ=0.9 | — | — | 0.0% [0.0–1.8] | 62.2% [56.0–67.9] | 0.0% [0.0–1.5] | 37.8% [32.1–44.0] | 0.0% [0.0–1.8] |
| layered α=0.01 | 0.850 | 0.800 | 0.5% [0.1–2.7] | 82.1% [76.9–86.3] | 12.0% [8.5–16.5] | 6.0% [3.7–9.6] | 4.9% [2.7–8.7] |
| hardened α=0.01 | 0.850 | 0.800 | 0.5% [0.1–2.7] | 82.1% [76.9–86.3] | 12.0% [8.5–16.5] | 6.0% [3.7–9.6] | 2.9% [1.3–6.2] |
| tightened α=0.01 | 0.850 | 0.800 | 0.5% [0.1–2.7] | 82.1% [76.9–86.3] | 12.0% [8.5–16.5] | 6.0% [3.7–9.6] | 1.5% [0.5–4.2] |
| layered α=0.05 | 0.200 | 0.200 | 2.9% [1.3–6.2] | 96.8% [93.8–98.4] | 3.2% [1.6–6.2] | 0.0% [0.0–1.5] | 4.4% [2.3–8.1] |
| hardened α=0.05 | 0.200 | 0.200 | 2.4% [1.0–5.6] | 96.8% [93.8–98.4] | 3.2% [1.6–6.2] | 0.0% [0.0–1.5] | 2.4% [1.0–5.6] |
| tightened α=0.05 | 0.200 | 0.200 | 1.9% [0.8–4.9] | 96.8% [93.8–98.4] | 3.2% [1.6–6.2] | 0.0% [0.0–1.5] | 1.5% [0.5–4.2] |

`layered` = L0 + calibrated judge, no witness. `hardened` = + declared-field witness (the proposed system). `tightened` = + witness widened to numbers mentioned in free text.

Per-category decisions, hardened α=0.05:

| category | label | n | suppress | escalate | execute |
|---|---|---:|---|---|---|
| S1_mechanical | SAME | 34 | 100.0% [89.8–100.0] | 0.0% [0.0–10.2] | 0.0% [0.0–10.2] |
| S3_loose_value | SAME | 8 | 100.0% [67.6–100.0] | 0.0% [0.0–32.4] | 0.0% [0.0–32.4] |
| D1_near_miss | DIFF | 126 | 0.8% [0.1–4.4] | 0.8% [0.1–4.4] | 98.4% [94.4–99.6] |
| D2_legit_repeat | DIFF | 75 | 5.3% [2.1–12.9] | 5.3% [2.1–12.9] | 89.3% [80.3–94.5] |
| D3_semantic_diff | DIFF | 5 | 0.0% [0.0–43.4] | 0.0% [0.0–43.4] | 100.0% [56.6–100.0] |
| S2_paraphrase | SAME | 127 | 97.6% [93.3–99.2] | 2.4% [0.8–6.7] | 0.0% [0.0–2.9] |
| S4_adversarial | SAME | 82 | 93.9% [86.5–97.4] | 6.1% [2.6–13.5] | 0.0% [0.0–4.5] |

## RQ7 — judges and ensembles (hardened, α=0.05)

| scorer | t_hi | WS | dedup | silent escape | flagged escape | friction | abstention |
|---|---|---|---|---|---|---|---|
| llama_3_3_70b_versatile | +∞ | 0.0% [0.0–1.8] | 13.5% [9.9–18.3] | 0.0% [0.0–1.5] | 86.5% [81.7–90.1] | 54.9% [48.0–61.5] | 94.1% [91.5–95.9] |
| openai_gpt_oss_120b | 0.200 | 2.4% [1.0–5.6] | 96.8% [93.8–98.4] | 0.0% [0.0–1.5] | 3.2% [1.6–6.2] | 2.4% [1.0–5.6] | 4.2% [2.7–6.4] |
| openai_gpt_oss_20b | 0.100 | 2.9% [1.3–6.2] | 97.6% [94.9–98.9] | 2.0% [0.9–4.6] | 0.4% [0.1–2.2] | 5.8% [3.4–9.9] | 0.0% [0.0–0.8] |
| qwen_qwen3_6_27b | 0.950 | 0.0% [0.0–1.8] | 21.1% [16.5–26.6] | 3.2% [1.6–6.2] | 75.7% [70.0–80.6] | 51.9% [45.1–58.7] | 88.0% [84.7–90.6] |
| ensemble_min | 0.050 | 2.9% [1.3–6.2] | 98.0% [95.4–99.1] | 2.0% [0.9–4.6] | 0.0% [0.0–1.5] | 4.9% [2.7–8.7] | 0.0% [0.0–0.8] |
| ensemble_mean | 0.400 | 3.4% [1.7–6.8] | 99.6% [97.8–99.9] | 0.4% [0.1–2.2] | 0.0% [0.0–1.5] | 0.0% [0.0–1.8] | 0.0% [0.0–0.8] |
| lexical | 0.900 | 3.4% [1.7–6.8] | 22.7% [18.0–28.3] | 3.6% [1.9–6.7] | 73.7% [67.9–78.8] | 16.5% [12.1–22.2] | n/a |

`ensemble_min` suppresses only when EVERY judge scores above threshold — the safety-aligned aggregator under this loss asymmetry.

## RQ7 — cross-generator (self-recognition check, hardened α=0.05)

| judge | paraphrases written by | self-family? | model-written? | n SAME (test) | dedup |
|---|---|---|---|---:|---|
| llama_3_3_70b_versatile | handwritten-authors | false | false | 34 | 0.0% [0.0–10.2] |
| llama_3_3_70b_versatile | llama-3.3-70b-versatile | true | true | 55 | 0.0% [0.0–6.5] |
| llama_3_3_70b_versatile | openai/gpt-oss-120b | false | true | 61 | 0.0% [0.0–5.9] |
| llama_3_3_70b_versatile | qwen/qwen3.6-27b | false | true | 59 | 0.0% [0.0–6.1] |
| openai_gpt_oss_120b | handwritten-authors | false | false | 34 | 94.1% [80.9–98.4] |
| openai_gpt_oss_120b | llama-3.3-70b-versatile | false | true | 55 | 98.2% [90.4–99.7] |
| openai_gpt_oss_120b | openai/gpt-oss-120b | true | true | 61 | 95.1% [86.5–98.3] |
| openai_gpt_oss_120b | qwen/qwen3.6-27b | false | true | 59 | 96.6% [88.5–99.1] |
| openai_gpt_oss_20b | handwritten-authors | false | false | 34 | 100.0% [89.8–100.0] |
| openai_gpt_oss_20b | llama-3.3-70b-versatile | false | true | 55 | 98.2% [90.4–99.7] |
| openai_gpt_oss_20b | openai/gpt-oss-120b | true | true | 61 | 100.0% [94.1–100.0] |
| openai_gpt_oss_20b | qwen/qwen3.6-27b | false | true | 59 | 93.2% [83.8–97.3] |
| qwen_qwen3_6_27b | handwritten-authors | false | false | 34 | 5.9% [1.6–19.1] |
| qwen_qwen3_6_27b | llama-3.3-70b-versatile | false | true | 55 | 10.9% [5.1–21.8] |
| qwen_qwen3_6_27b | openai/gpt-oss-120b | false | true | 61 | 6.6% [2.6–15.7] |
| qwen_qwen3_6_27b | qwen/qwen3.6-27b | true | true | 59 | 8.5% [3.7–18.4] |
| ensemble_min | handwritten-authors | n/a | false | 34 | 100.0% [89.8–100.0] |
| ensemble_min | llama-3.3-70b-versatile | n/a | true | 55 | 98.2% [90.4–99.7] |
| ensemble_min | openai/gpt-oss-120b | n/a | true | 61 | 100.0% [94.1–100.0] |
| ensemble_min | qwen/qwen3.6-27b | n/a | true | 59 | 94.9% [86.1–98.3] |
| ensemble_mean | handwritten-authors | n/a | false | 34 | 100.0% [89.8–100.0] |
| ensemble_mean | llama-3.3-70b-versatile | n/a | true | 55 | 100.0% [93.5–100.0] |
| ensemble_mean | openai/gpt-oss-120b | n/a | true | 61 | 100.0% [94.1–100.0] |
| ensemble_mean | qwen/qwen3.6-27b | n/a | true | 59 | 98.3% [91.0–99.7] |

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
| rawJudge_qwen_qwen3_6_27b | 0.0% [0.0–16.1] | 8.0% [2.2–25.0] |
| layered_qwen_qwen3_6_27b | 0.0% [0.0–16.1] | 8.0% [2.2–25.0] |
| hardened_qwen_qwen3_6_27b | 0.0%† [0.0–16.1] | 8.0% [2.2–25.0] |
| tightened_qwen_qwen3_6_27b | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_ensemble_min | 15.0% [5.2–36.0] | 24.0% [11.5–43.4] |
| layered_ensemble_min | 15.0% [5.2–36.0] | 28.0% [14.3–47.6] |
| hardened_ensemble_min | 0.0%† [0.0–16.1] | 28.0% [14.3–47.6] |
| tightened_ensemble_min | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_ensemble_mean | 15.0% [5.2–36.0] | 32.0% [17.2–51.6] |
| layered_ensemble_mean | 30.0% [14.5–51.9] | 88.0% [70.0–95.8] |
| hardened_ensemble_mean | 0.0%† [0.0–16.1] | 88.0% [70.0–95.8] |
| tightened_ensemble_mean | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |
| rawJudge_lexical | 0.0% [0.0–16.1] | 0.0% [0.0–13.3] |
| layered_lexical | 0.0% [0.0–16.1] | 0.0% [0.0–13.3] |
| hardened_lexical | 0.0%† [0.0–16.1] | 0.0% [0.0–13.3] |
| tightened_lexical | 0.0%† [0.0–16.1] | 0.0%† [0.0–13.3] |

† = zero as a logical consequence of a decidable layer, not a sample estimate.

## Ablations (judge `openai_gpt_oss_120b`, α=0.05, witness-free so each line isolates one component)

| ablation | WS | dedup | flagged | silent | friction |
|---|---|---|---|---|---|
| noL0 | 2.9% [1.3–6.2] | 96.0% [92.8–97.8] | 4.0% [2.2–7.2] | 0.0% [0.0–1.5] | 4.4% [2.3–8.1] |
| noEscalation | 2.9% [1.3–6.2] | 96.8% [93.8–98.4] | 0.0% [0.0–1.5] | 3.2% [1.6–6.2] | 0.0% [0.0–1.8] |
| noCalibration | 1.5% [0.5–4.2] | 96.4% [93.3–98.1] | 3.6% [1.9–6.7] | 0.0% [0.0–1.5] | 4.9% [2.7–8.7] |

Judge jurisdiction: L0 settles 7.4% [5.4–10.2], the declared-field witness 19.0% [15.7–22.9], leaving 73.5% [69.3–77.4] for the judge. With the tightened witness: 36.1% [31.8–40.6] settled, 56.5% [51.9–60.9] judged.

## RQ4 — friction reduction A: per-tool calibration

| scorer / α | per-tool WS | per-tool friction | per-tool dedup | global WS | global friction | global dedup |
|---|---|---|---|---|---|---|
| llama_3_3_70b_versatile_alpha_0.01 | 0.0% [0.0–1.8] | 54.9% [48.0–61.5] | 13.5% [9.9–18.3] | 0.0% [0.0–1.8] | 54.9% [48.0–61.5] | 13.5% [9.9–18.3] |
| llama_3_3_70b_versatile_alpha_0.05 | 0.0% [0.0–1.8] | 54.9% [48.0–61.5] | 13.5% [9.9–18.3] | 0.0% [0.0–1.8] | 54.9% [48.0–61.5] | 13.5% [9.9–18.3] |
| openai_gpt_oss_120b_alpha_0.01 | 0.0% [0.0–1.8] | 4.4% [2.3–8.1] | 13.5% [9.9–18.3] | 0.5% [0.1–2.7] | 2.9% [1.3–6.2] | 82.1% [76.9–86.3] |
| openai_gpt_oss_120b_alpha_0.05 | 1.5% [0.5–4.2] | 3.4% [1.7–6.8] | 78.1% [72.6–82.8] | 2.4% [1.0–5.6] | 2.4% [1.0–5.6] | 96.8% [93.8–98.4] |
| openai_gpt_oss_20b_alpha_0.01 | 0.0% [0.0–1.8] | 6.3% [3.7–10.5] | 13.5% [9.9–18.3] | 0.0% [0.0–1.8] | 8.7% [5.6–13.4] | 13.5% [9.9–18.3] |
| openai_gpt_oss_20b_alpha_0.05 | 1.9% [0.8–4.9] | 4.4% [2.3–8.1] | 61.4% [55.2–67.2] | 2.9% [1.3–6.2] | 5.8% [3.4–9.9] | 97.6% [94.9–98.9] |
| qwen_qwen3_6_27b_alpha_0.01 | 0.0% [0.0–1.8] | 52.9% [46.1–59.6] | 13.5% [9.9–18.3] | 0.0% [0.0–1.8] | 51.9% [45.1–58.7] | 13.5% [9.9–18.3] |
| qwen_qwen3_6_27b_alpha_0.05 | 0.0% [0.0–1.8] | 52.9% [46.1–59.6] | 13.5% [9.9–18.3] | 0.0% [0.0–1.8] | 51.9% [45.1–58.7] | 21.1% [16.5–26.6] |
| ensemble_min_alpha_0.01 | 0.0% [0.0–1.8] | 5.3% [3.0–9.3] | 13.5% [9.9–18.3] | 0.5% [0.1–2.7] | 7.3% [4.5–11.7] | 84.5% [79.5–88.4] |
| ensemble_min_alpha_0.05 | 1.9% [0.8–4.9] | 3.9% [2.0–7.5] | 80.5% [75.1–84.9] | 2.9% [1.3–6.2] | 4.9% [2.7–8.7] | 98.0% [95.4–99.1] |
| ensemble_mean_alpha_0.01 | 0.0% [0.0–1.8] | 3.4% [1.7–6.8] | 13.5% [9.9–18.3] | 0.5% [0.1–2.7] | 2.4% [1.0–5.6] | 94.0% [90.4–96.3] |
| ensemble_mean_alpha_0.05 | 2.9% [1.3–6.2] | 1.0% [0.3–3.5] | 81.7% [76.4–86.0] | 3.4% [1.7–6.8] | 0.0% [0.0–1.8] | 99.6% [97.8–99.9] |

Per-tool thresholds (openai_gpt_oss_120b_alpha_0.05):

| tool | t_hi | t_lo | n cal DIFF | n cal SAME |
|---|---|---|---:|---:|
| charge_card | 0.200 | 0.200 | 68 | 63 |
| create_ticket | +∞ | 0.800 | 4 | 22 |
| post_refund | 0.850 | 0.850 | 40 | 37 |
| send_email | +∞ | 0.700 | 14 | 27 |
| transfer_funds | 0.150 | 0.100 | 47 | 23 |
| wire_money | 0.800 | 0.800 | 26 | 35 |

## Calibration-size sweep (α=0.05, 300 resamples)

| n | P(t_hi=+∞) | mean WS | median WS | p95 WS | max WS | certifies m ≤ |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 100.0% | 0.00% | 0.00% | 0.00% | 0.00% | 0 |
| 20 | 0.0% | 3.69% | 1.46% | 9.22% | 20.87% | 1 |
| 30 | 0.0% | 2.58% | 0.97% | 9.22% | 9.22% | 1 |
| 50 | 0.0% | 2.64% | 1.46% | 9.22% | 9.22% | 2 |
| 100 | 0.0% | 3.64% | 2.91% | 9.22% | 9.22% | 5 |
| 199 | 0.0% | 3.52% | 2.91% | 9.22% | 9.22% | 10 |

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
| openai_gpt_oss_120b | 0.950 | 0.900 | 5.5% | 0.050 | 0.400 | 4.8% |
| openai_gpt_oss_20b | 1.000 | 1.000 | 82.6% | 0.000 | 0.050 | 87.3% |
| qwen_qwen3_6_27b | 1.000 | 1.000 | 78.7% | 0.000 | 0.050 | 88.9% |
| ensemble_min | 0.950 | 0.900 | 11.1% | 0.000 | 0.050 | 85.3% |
| ensemble_mean | 0.975 | 0.950 | 10.2% | 0.025 | 0.400 | 6.6% |
| lexical | 0.830 | 0.800 | 0.7% | 0.109 | 0.893 | 43.9% |

## RQ4 — cost per 1000 irreversible actions

| witness | fraction judged | judge calls / 1000 dispatches | judge tokens / 1000 | added latency per judged dispatch | escalations / 1000 distinct actions |
|---|---|---:|---:|---:|---:|
| declaredWitness | 73.5% | 735 | null | null ms | 24 |
| tightenedWitness | 56.5% | 565 | null | null ms | 15 |

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

**PENDING.** annotation sheet exported, but no responses-*.csv present — no human labels exist
A blinded, stratified sheet of 100 items is exported and waiting: {"same_paraphrase":20,"same_adversarial":20,"diff_near_miss":20,"diff_text_only":20,"attack_injection":20}.
No human labels exist. Nothing in the paper may be attributed to human annotation.

