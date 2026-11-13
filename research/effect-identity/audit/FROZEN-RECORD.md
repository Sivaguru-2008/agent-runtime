# FROZEN SCIENTIFIC RECORD — mechanically extracted
Extracted: 2026-08-18T02:55:50.306Z
Corpus built: 2026-08-15T10:07:37.040Z   seed 20260712
Experiments run: 2026-08-17T12:35:28.826Z

## Corpus
- S1_mechanical: n=68 (cal 34 / test 34 / attack 0) label=SAME
- S3_loose_value: n=15 (cal 7 / test 8 / attack 0) label=SAME
- D1_near_miss: n=251 (cal 125 / test 126 / attack 0) label=DIFF
- D2_legit_repeat: n=150 (cal 75 / test 75 / attack 0) label=DIFF
- D3_semantic_diff: n=10 (cal 5 / test 5 / attack 0) label=DIFF
- D4a_field_injection: n=20 (cal 0 / test 0 / attack 20) label=DIFF
- D4b_text_injection: n=25 (cal 0 / test 0 / attack 25) label=DIFF
- S2_paraphrase: n=253 (cal 126 / test 127 / attack 0) label=SAME
- S4_adversarial: n=163 (cal 81 / test 82 / attack 0) label=SAME
- generators: handwritten-authors, llama-3.3-70b-versatile, openai/gpt-oss-120b, qwen/qwen3.6-27b
  - handwritten-authors: S2 68/68 kept, S4 0/0 kept
  - llama-3.3-70b-versatile: S2 60/68 kept, S4 49/68 kept
  - openai/gpt-oss-120b: S2 59/68 kept, S4 62/68 kept
  - qwen/qwen3.6-27b: S2 66/68 kept, S4 52/58 kept

## Judge coverage (experiments.json) — abstention rate, so coverage = 1 - value
- llama_3_3_70b_versatile: abstained 895/955 → coverage 6.3%
- openai_gpt_oss_120b: abstained 0/955 → coverage 100.0%
- openai_gpt_oss_20b: abstained 0/955 → coverage 100.0%
- qwen_qwen3_6_27b: abstained 485/955 → coverage 49.2%
- ensemble_min: abstained 0/955 → coverage 100.0%
- ensemble_mean: abstained 0/955 → coverage 100.0%
- primary scorer: openai_gpt_oss_120b

## Jurisdiction-matched configurations (residual_calibration.json) — PRIMARY TABLE
- openai_gpt_oss_120b_a0.01_asPublished: nCalDiff=205 tHi=0.85 tLo=0.8 certifiableM=2
    full-split : WS 0.5% [0.1–2.7] (1/206) | dedup 85.3% [80.3–89.1] (214/251) | silent 6.0% [3.7–9.6] (15/251) | flagged 8.8% [5.9–12.9] (22/251) | friction 0.5% [0.1–2.7] (1/206)
    residual   : WS 0.8% [0.1–4.6] (1/119) | dedup 82.9% [77.4–87.4] (180/217) | silent 6.9% [4.2–11.1] (15/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 84.0% [65.3–93.6] (21/25)
- openai_gpt_oss_120b_a0.01_residualOnly: nCalDiff=117 tHi=0.95 tLo=0.8 certifiableM=1
    full-split : WS 0.0% [0.0–1.8] (0/206) | dedup 19.9% [15.4–25.3] (50/251) | silent 6.0% [3.7–9.6] (15/251) | flagged 74.1% [68.3–79.1] (186/251) | friction 1.0% [0.3–3.5] (2/206)
    residual   : WS 0.0% [0.0–3.1] (0/119) | dedup 7.4% [4.6–11.6] (16/217) | silent 6.9% [4.2–11.1] (15/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 40.0% [23.4–59.3] (10/25)
- openai_gpt_oss_120b_a0.05_asPublished: nCalDiff=205 tHi=0.2 tLo=0.2 certifiableM=10
    full-split : WS 2.4% [1.0–5.6] (5/206) | dedup 100.0% [98.5–100.0] (251/251) | silent 0.0% [0.0–1.5] (0/251) | flagged 0.0% [0.0–1.5] (0/251) | friction 0.0% [0.0–1.8] (0/206)
    residual   : WS 4.2% [1.8–9.5] (5/119) | dedup 100.0% [98.3–100.0] (217/217) | silent 0.0% [0.0–1.7] (0/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 88.0% [70.0–95.8] (22/25)
- openai_gpt_oss_120b_a0.05_residualOnly: nCalDiff=117 tHi=0.8 tLo=0.8 certifiableM=5
    full-split : WS 1.0% [0.3–3.5] (2/206) | dedup 94.0% [90.4–96.3] (236/251) | silent 6.0% [3.7–9.6] (15/251) | flagged 0.0% [0.0–1.5] (0/251) | friction 0.0% [0.0–1.8] (0/206)
    residual   : WS 1.7% [0.5–5.9] (2/119) | dedup 93.1% [88.9–95.8] (202/217) | silent 6.9% [4.2–11.1] (15/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 84.0% [65.3–93.6] (21/25)
- openai_gpt_oss_20b_a0.01_asPublished: nCalDiff=205 tHi=1 tLo=0 certifiableM=2
    full-split : WS 0.0% [0.0–1.8] (0/206) | dedup 13.5% [9.9–18.3] (34/251) | silent 2.0% [0.9–4.6] (5/251) | flagged 84.5% [79.5–88.4] (212/251) | friction 8.7% [5.6–13.4] (18/206)
    residual   : WS 0.0% [0.0–3.1] (0/119) | dedup 0.0% [0.0–1.7] (0/217) | silent 2.3% [1.0–5.3] (5/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 0.0% [0.0–13.3] (0/25)
- openai_gpt_oss_20b_a0.01_residualOnly: nCalDiff=117 tHi=1 tLo=0 certifiableM=1
    full-split : WS 0.0% [0.0–1.8] (0/206) | dedup 13.5% [9.9–18.3] (34/251) | silent 2.0% [0.9–4.6] (5/251) | flagged 84.5% [79.5–88.4] (212/251) | friction 8.7% [5.6–13.4] (18/206)
    residual   : WS 0.0% [0.0–3.1] (0/119) | dedup 0.0% [0.0–1.7] (0/217) | silent 2.3% [1.0–5.3] (5/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 0.0% [0.0–13.3] (0/25)
- openai_gpt_oss_20b_a0.05_asPublished: nCalDiff=205 tHi=0.1 tLo=0 certifiableM=10
    full-split : WS 2.9% [1.3–6.2] (6/206) | dedup 97.6% [94.9–98.9] (245/251) | silent 2.0% [0.9–4.6] (5/251) | flagged 0.4% [0.1–2.2] (1/251) | friction 5.8% [3.4–9.9] (12/206)
    residual   : WS 5.0% [2.3–10.6] (6/119) | dedup 97.2% [94.1–98.7] (211/217) | silent 2.3% [1.0–5.3] (5/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 28.0% [14.3–47.6] (7/25)
- openai_gpt_oss_20b_a0.05_residualOnly: nCalDiff=117 tHi=0.95 tLo=0 certifiableM=5
    full-split : WS 1.5% [0.5–4.2] (3/206) | dedup 82.1% [76.9–86.3] (206/251) | silent 2.0% [0.9–4.6] (5/251) | flagged 15.9% [11.9–21.0] (40/251) | friction 7.3% [4.5–11.7] (15/206)
    residual   : WS 2.5% [0.9–7.2] (3/119) | dedup 79.3% [73.4–84.1] (172/217) | silent 2.3% [1.0–5.3] (5/217)
    attacks    : D4a 0.0% [0.0–16.1] (0/20) | D4b 28.0% [14.3–47.6] (7/25)

## Ablations (jurisdiction-matched)
- openai_gpt_oss_120b_a0.01_hardened: nCalDiff=117 tHi=0.95 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.01_minusL0: nCalDiff=117 tHi=0.95 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.01_minusWitness: nCalDiff=205 tHi=0.85 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.01_minusBand: nCalDiff=117 tHi=0.95 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.01_minusCalibration: nCalDiff=117 tHi=0.5 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.05_hardened: nCalDiff=117 tHi=0.8 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.05_minusL0: nCalDiff=117 tHi=0.8 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.05_minusWitness: nCalDiff=205 tHi=0.2 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.05_minusBand: nCalDiff=117 tHi=0.8 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_120b_a0.05_minusCalibration: nCalDiff=117 tHi=0.5 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.01_hardened: nCalDiff=117 tHi=1 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.01_minusL0: nCalDiff=117 tHi=1 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.01_minusWitness: nCalDiff=205 tHi=1 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.01_minusBand: nCalDiff=117 tHi=1 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.01_minusCalibration: nCalDiff=117 tHi=0.5 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.05_hardened: nCalDiff=117 tHi=0.95 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.05_minusL0: nCalDiff=117 tHi=0.95 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.05_minusWitness: nCalDiff=205 tHi=0.1 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.05_minusBand: nCalDiff=117 tHi=0.95 | WS — | dedup — | silent — | flagged —
- openai_gpt_oss_20b_a0.05_minusCalibration: nCalDiff=117 tHi=0.5 | WS — | dedup — | silent — | flagged —

## Jurisdiction conditioning (§8.3 correction)
{
 "test": {
  "n": 457,
  "certifier": {
   "value": 0.07439824945295405,
   "successes": 34,
   "n": 457,
   "basis": "measured",
   "ci95": {
    "lo": 0.05372588068028822,
    "hi": 0.10216603712706007
   }
  },
  "refuter": {
   "value": 0.19037199124726478,
   "successes": 87,
   "n": 457,
   "basis": "measured",
   "ci95": {
    "lo": 0.15701615832954263,
    "hi": 0.22888978701616325
   }
  },
  "residual": {
   "value": 0.7352297592997812,
   "successes": 336,
   "n": 457,
   "basis": "measured",
   "ci95": {
    "lo": 0.6929385604433594,
    "hi": 0.7735993256014223
   }
  }
 },
 "testSame": {
  "n": 251,
  "certifier": {
   "value": 0.13545816733067728,
   "successes": 34,
   "n": 251,
   "basis": "measured",
   "ci95": {
    "lo": 0.09858000717317408,
    "hi": 0.18332647363708374
   }
  },
  "refuter": {
   "value": 0,
   "successes": 0,
   "n": 251,
   "basis": "measured",
   "ci95": {
    "lo": 0,
    "hi": 0.015073916302594106
   }
  },
  "residual": {
   "value": 0.8645418326693227,
   "successes": 217,
   "n": 251,
   "basis": "measured",
   "ci95": {
    "lo": 0.8166735263629162,
    "hi": 0.9014199928268259
   }
  }
 },
 "testDiff": {
  "n": 206,
  "certifier": {
   "value": 0,
   "successes": 0,
   "n": 206,
   "basis": "measured",
   "ci95": {
    "lo": 0,
    "hi": 0.018306481675656787
   }
  },
  "refuter": {
   "value": 0.4223300970873786,
   "successes": 87,
   "n": 206,
   "basis": "measured",
   "ci95": {
    "lo": 0.3569073176378995,
    "hi": 0.49059660184569753
   }
  },
  "residual": {
   "value": 0.5776699029126213,
   "successes": 119,
   "n": 206,
   "basis": "measured",
   "ci95": {
    "lo": 0.5094033981543024,
    "hi": 0.6430926823621005
   }
  }
 }
}

## Tightened schema (§8.9 B)
- openai_gpt_oss_120b_a0.01: nCalDiff=35 tHi=null certifiableM=0 judgeJurisdiction=null
    WS — | dedup — | silent — | flagged — | D4a 0.0% [0.0–16.1] (0/20) | D4b 0.0% [0.0–13.3] (0/25)
- openai_gpt_oss_120b_a0.05: nCalDiff=35 tHi=0.95 certifiableM=1 judgeJurisdiction=null
    WS — | dedup — | silent — | flagged — | D4a 0.0% [0.0–16.1] (0/20) | D4b 0.0% [0.0–13.3] (0/25)
- openai_gpt_oss_20b_a0.01: nCalDiff=35 tHi=null certifiableM=0 judgeJurisdiction=null
    WS — | dedup — | silent — | flagged — | D4a 0.0% [0.0–16.1] (0/20) | D4b 0.0% [0.0–13.3] (0/25)
- openai_gpt_oss_20b_a0.05: nCalDiff=35 tHi=1 certifiableM=1 judgeJurisdiction=null
    WS — | dedup — | silent — | flagged — | D4a 0.0% [0.0–16.1] (0/20) | D4b 0.0% [0.0–13.3] (0/25)

## Cross-family (§8.8)
common subset: {"total":470,"cal":230,"test":218,"attack":22}
- openai_gpt_oss_120b: tHi=0.8 WS 0.0% [0.0–3.9] (0/95) dedup 91.1% [84.7–94.9] (112/123) silent 8.9% [5.1–15.3] (11/123)
- openai_gpt_oss_20b: tHi=1 WS 0.0% [0.0–3.9] (0/95) dedup 12.2% [7.5–19.1] (15/123) silent 17.1% [11.4–24.7] (21/123)
- qwen_qwen3_6_27b: tHi=0.95 WS 2.1% [0.6–7.4] (2/95) dedup 91.1% [84.7–94.9] (112/123) silent 8.9% [5.1–15.3] (11/123)
missingness: {"overall":{"covered":470,"n":955,"pct":49.2},"byCategory":{"chi2":4.810231256547283,"df":7,"pHat":0.49214659685863876,"kept":["D1_near_miss","D2_legit_repeat","D4a_field_injection","D4b_text_injection","S1_mechanical","S2_paraphrase","S3_loose_value","S4_adversarial"],"p":0.6831087332325153},"byLabel":{"chi2":0.04198095185611027,"df":1,"pHat":0.49214659685863876,"kept":["DIFF","SAME"],"p":0.8376560858763158},"byTool":{"chi2":4.058973397477331,"df":5,"pHat":0.49214659685863876,"kept":["charge_card","create_ticket","post_refund","send_email","transfer_funds","wire_money"],"p":0.540956876987042},"bySplit":{"chi2":0.8599891200343435,"df":2,"pHat":0.49214659685863876,"kept":["attack","cal","test"],"p":0.6505126334912488},"strataDetail":{"category":[{"key":"D1_near_miss","n":251,"c":120,"pct":47.8},{"key":"D2_legit_repeat","n":150,"c":77,"pct":51.3},{"key":"D3_semantic_diff","n":10,"c":7,"pct":70},{"key":"D4a_field_injection","n":20,"c":10,"pct":50},{"key":"D4b_text_injection","n":25,"c":12,"pct":48},{"key":"S1_mechanical","n":68,"c":30,"pct":44.1},{"key":"S2_paraphrase","n":253,"c":125,"pct":49.4},{"key":"S3_loose_value","n":15,"c":11,"pct":73.3},{"key":"S4_adversarial","n":163,"c":78,"pct":47.9}],"label":[{"key":"DIFF","n":456,"c":226,"pct":49.6},{"key":"SAME","n":499,"c":244,"pct":48.9}]},"missingRunLengths":{"runs":245,"mean":1.98,"histogram":{"1":131,"2":54,"3":31,"4":13,"5":6,"6":5,"7":1,"8":2,"9":2},"multiplesOfTen":0}}
attacks: {"openai_gpt_oss_120b|D4a_field_injection":{"n":10,"rawJudge":{"value":0.7,"successes":7,"n":10,"basis":"measured","ci95":{"lo":0.39677814746114537,"hi":0.8922087325936989}},"hardened":{"value":0,"successes":0,"n":10,"basis":"measured","ci95":{"lo":0,"hi":0.2775327998628892}}},"openai_gpt_oss_120b|D4b_text_injection":{"n":12,"rawJudge":{"value":0.8333333333333334,"successes":10,"n":12,"basis":"measured","ci95":{"lo":0.5519691377470267,"hi":0.9530348578161462}},"hardened":{"value":0.8333333333333334,"successes":10,"n":12,"basis":"measured","ci95":{"lo":0.5519691377470267,"hi":0.9530348578161462}}},"openai_gpt_oss_20b|D4a_field_injection":{"n":10,"rawJudge":{"value":0.1,"successes":1,"n":10,"basis":"measured","ci95":{"lo":0.017876213095072868,"hi":0.4041500267952385}},"hardened":{"value":0,"successes":0,"n":10,"basis":"measured","ci95":{"lo":0,"hi":0.2775327998628892}}},"openai_gpt_oss_20b|D4b_text_injection":{"n":12,"rawJudge":{"value":0.25,"successes":3,"n":12,"basis":"measured","ci95":{"lo":0.08894166839405476,"hi":0.5323053349335656}},"hardened":{"value":0,"successes":0,"n":12,"basis":"measured","ci95":{"lo":0,"hi":0.24249400665524085}}},"qwen_qwen3_6_27b|D4a_field_injection":{"n":10,"rawJudge":{"value":0.6,"successes":6,"n":10,"basis":"measured","ci95":{"lo":0.31267376973365824,"hi":0.8318196702937638}},"hardened":{"value":0,"successes":0,"n":10,"basis":"measured","ci95":{"lo":0,"hi":0.2775327998628892}}},"qwen_qwen3_6_27b|D4b_text_injection":{"n":12,"rawJudge":{"value":0.4166666666666667,"successes":5,"n":12,"basis":"measured","ci95":{"lo":0.19326031365875668,"hi":0.6804886874504503}},"hardened":{"value":0.25,"successes":3,"n":12,"basis":"measured","ci95":{"lo":0.08894166839405476,"hi":0.5323053349335656}}}}

## Sensitivity / paired tests (§8.12)
{
 "asConstructed": {
  "tHi": 0.8,
  "nCalDiff": 117,
  "nSame": 251,
  "nDiff": 206,
  "wrongSuppression": {
   "value": 0.009708737864077669,
   "successes": 2,
   "n": 206,
   "basis": "measured",
   "ci95": {
    "lo": 0.0026665364740969914,
    "hi": 0.034701955266110154
   }
  },
  "dedup": {
   "value": 0.9402390438247012,
   "successes": 236,
   "n": 251,
   "basis": "measured",
   "ci95": {
    "lo": 0.9037527034962298,
    "hi": 0.9634531311536774
   }
  },
  "silentEscape": {
   "value": 0.05976095617529881,
   "successes": 15,
   "n": 251,
   "basis": "measured",
   "ci95": {
    "lo": 0.03654686884632264,
    "hi": 0.0962472965037702
   }
  },
  "friction": {
   "value": 0,
   "successes": 0,
   "n": 206,
   "basis": "measured",
   "ci95": {
    "lo": 0,
    "hi": 0.018306481675656787
   }
  }
 },
 "d2AsSame": {
  "tHi": 0.7,
  "nCalDiff": 42,
  "nSame": 326,
  "nDiff": 131,
  "wrongSuppression": {
   "value": 0.007633587786259542,
   "successes": 1,
   "n": 131,
   "basis": "measured",
   "ci95": {
    "lo": 0.0013487890456915057,
    "hi": 0.04197215150021155
   }
  },
  "dedup": {
   "value": 0.7638036809815951,
   "successes": 249,
   "n": 326,
   "basis": "measured",
   "ci95": {
    "lo": 0.7147907640454069,
    "hi": 0.8066718823270776
   }
  },
  "silentEscape": {
   "value": 0.15644171779141106,
   "successes": 51,
   "n": 326,
   "basis": "measured",
   "ci95": {
    "lo": 0.1210353692328788,
    "hi": 0.19985048665411828
   }
  },
  "friction": {
   "value": 0.06870229007633588,
   "successes": 9,
   "n": 131,
   "basis": "measured",
   "ci95": {
    "lo": 0.0365625456507617,
    "hi": 0.1254162627344092
   }
  }
 },
 "s4AsDiff": {
  "tHi": 0.96,
  "nCalDiff": 198,
  "nSame": 169,
  "nDiff": 288,
  "wrongSuppression": {
   "value": 0.020833333333333332,
   "successes": 6,
   "n": 288,
   "basis": "measured",
   "ci95": {
    "lo": 0.009582242431984241,
    "hi": 0.044698800723118104
   }
  },
  "dedup": {
   "value": 0.2485207100591716,
   "successes": 42,
   "n": 169,
   "basis": "measured",
   "ci95": {
    "lo": 0.1894415239332854,
    "hi": 0.3187783176489414
   }
  },
  "silentEscape": {
   "value": 0.05325443786982249,
   "successes": 9,
   "n": 169,
   "basis": "measured",
   "ci95": {
    "lo": 0.028267147079055317,
    "hi": 0.09809986561407683
   }
  },
  "friction": {
   "value": 0.25,
   "successes": 72,
   "n": 288,
   "basis": "measured",
   "ci95": {
    "lo": 0.20350256640962516,
    "hi": 0.30307884741042823
   }
  }
 }
}
{
 "dedup: hardened vs canonical baseline": {
  "hardened": 202,
  "baselineL0": 0,
  "b": 202,
  "c": 0,
  "n": 202,
  "p": 0,
  "holmAdjusted": 0
 },
 "dedup: layered vs hardened": {
  "layered": 15,
  "hardened": 0,
  "b": 15,
  "c": 0,
  "n": 15,
  "p": 0.0001,
  "holmAdjusted": 0.0005
 },
 "wrong-suppression: hardened vs layered": {
  "hardened": 4,
  "layered": 0,
  "b": 4,
  "c": 0,
  "n": 4,
  "p": 0.125,
  "holmAdjusted": 0.25
 },
 "dedup: hardened vs raw tau=0.5": {
  "hardened": 0,
  "rawTau05": 14,
  "b": 0,
  "c": 14,
  "n": 14,
  "p": 0.0001,
  "holmAdjusted": 0.0005
 },
 "dedup: 120B vs 20B (hardened)": {
  "hardened": 42,
  "hardened20B": 12,
  "b": 42,
  "c": 12,
  "n": 54,
  "p": 0.0001,
  "holmAdjusted": 0.0005
 },
 "wrong-suppression: 120B vs 20B (hardened)": {
  "hardened": 3,
  "hardened20B": 2,
  "b": 3,
  "c": 2,
  "n": 5,
  "p": 1,
  "holmAdjusted": 1
 }
}

## Multi-candidate (§8.6)
judge=llama-3.1-8b-instant K=50 diffUnits=40 sameUnits=20 testDiff=20
calibration: {"corpusDiffN":205,"corpusSameN":248,"inExperimentDiffN":20,"tLo":0.5499999999999999,"maxCertifiableM":{"0.01":2,"0.05":10,"0.1":20},"requiredNForM":{"1":{"0.01":99,"0.05":19,"0.1":9},"2":{"0.01":199,"0.05":39,"0.1":19},"5":{"0.01":499,"0.05":99,"0.1":49},"10":{"0.01":999,"0.05":199,"0.1":99},"25":{"0.01":2499,"0.05":499,"0.1":249},"50":{"0.01":4999,"0.05":999,"0.1":499}}}
- m=1: {"uncorrected":{"tHi":0.91,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"su
- m=2: {"uncorrected":{"tHi":0.91,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"su
- m=5: {"uncorrected":{"tHi":0.91,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"su
- m=10: {"uncorrected":{"tHi":0.91,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"s
- m=25: {"uncorrected":{"tHi":0.91,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"s
- m=50: {"uncorrected":{"tHi":0.91,"wrongSuppression":{"value":0.65,"successes":13,"n":20,"basis":"measured","ci95":{"lo":0.43285427668523624,"hi":0.818808175898918}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.7,"successes":14,"n":20,"basis":"measured","ci95":{"lo":0.4810271816464765,"hi":0.8545227551323956}},"flaggedE
- m=1: {"uncorrected":{"tHi":0.9,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"suc
- m=2: {"uncorrected":{"tHi":0.9,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"suc
- m=5: {"uncorrected":{"tHi":0.9,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"suc
- m=10: {"uncorrected":{"tHi":0.9,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"su
- m=25: {"uncorrected":{"tHi":0.9,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":{"value":0,"su
- m=50: {"uncorrected":{"tHi":0.9,"wrongSuppression":{"value":0.65,"successes":13,"n":20,"basis":"measured","ci95":{"lo":0.43285427668523624,"hi":0.818808175898918}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.7,"successes":14,"n":20,"basis":"measured","ci95":{"lo":0.4810271816464765,"hi":0.8545227551323956}},"flaggedEs
- m=1: {"uncorrected":{"tHi":0.8928571428571429,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":
- m=2: {"uncorrected":{"tHi":0.8928571428571429,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":
- m=5: {"uncorrected":{"tHi":0.8928571428571429,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape":
- m=10: {"uncorrected":{"tHi":0.8928571428571429,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape"
- m=25: {"uncorrected":{"tHi":0.8928571428571429,"wrongSuppression":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.5,"successes":10,"n":20,"basis":"measured","ci95":{"lo":0.2992980081982123,"hi":0.7007019918017877}},"flaggedEscape"
- m=50: {"uncorrected":{"tHi":0.8928571428571429,"wrongSuppression":{"value":0.65,"successes":13,"n":20,"basis":"measured","ci95":{"lo":0.43285427668523624,"hi":0.818808175898918}},"friction":{"value":0,"successes":0,"n":20,"basis":"measured","ci95":{"lo":0,"hi":0.16112515805281938}},"dedup":{"value":0.7,"successes":14,"n":20,"basis":"measured","ci95":{"lo":0.4810271816464765,"hi":0.85452275513239
maxScoreGrowth: [{"m":1,"n":20,"meanMaxScore":0,"medianMaxScore":0,"p90MaxScore":0,"maxMaxScore":0},{"m":2,"n":20,"meanMaxScore":0,"medianMaxScore":0,"p90MaxScore":0,"maxMaxScore":0},{"m":5,"n":20,"meanMaxScore":0,"medianMaxScore":0,"p90MaxScore":0,"maxMaxScore":0},{"m":10,"n":20,"meanMaxScore":0,"medianMaxScore":0,"p90MaxScore":0,"maxMaxScore":0},{"m":25,"n":20,"meanMaxScore":0,"medianMaxScore":0,"p90MaxScore":0,"maxMaxScore":0},{"m":50,"n":20,"meanMaxScore":0.65,"medianMaxScore":1,"p90MaxScore":1,"maxMaxScore":1}]

## Crash/replay (§8.7) — AS PUBLISHED
live=false judge=lexical-offline trials=48 crossFamily=false thresholds={"tHi":0.9,"tLo":0.5499999999999999,"source":"layered_lexical_alpha_0.05","judge":"llama-3.3-70b-versatile"}
- syntactic: all 0.0% [0.0–7.4] (0/48) | outside-window 0.0% [0.0–9.6] (0/36) | inside-window 0.0% [0.0–24.2] (0/12) | windowFlagged 0.0% [0.0–24.2] (0/12) | totalWired $98280
- semantic: all 8.3% [3.3–19.6] (4/48) | outside-window 8.3% [2.9–21.8] (3/36) | inside-window 8.3% [1.5–35.4] (1/12) | windowFlagged 66.7% [39.1–86.2] (8/12) | totalWired $81900
  - before_fence: syn once 0.0% [0.0–39.0] (0/6) | sem once 16.7% [3.0–56.4] (1/6) | sem suppressed 16.7% [3.0–56.4] (1/6)
  - after_L0: syn once 0.0% [0.0–39.0] (0/6) | sem once 16.7% [3.0–56.4] (1/6) | sem suppressed 16.7% [3.0–56.4] (1/6)
  - after_witness: syn once 0.0% [0.0–39.0] (0/6) | sem once 16.7% [3.0–56.4] (1/6) | sem suppressed 16.7% [3.0–56.4] (1/6)
  - after_judge: syn once 0.0% [0.0–39.0] (0/6) | sem once 0.0% [0.0–39.0] (0/6) | sem suppressed 0.0% [0.0–39.0] (0/6)
  - before_external_effect: syn once 0.0% [0.0–39.0] (0/6) | sem once 0.0% [0.0–39.0] (0/6) | sem suppressed 0.0% [0.0–39.0] (0/6)
  - during_external_commit_window [WINDOW]: syn once 0.0% [0.0–39.0] (0/6) | sem once 0.0% [0.0–39.0] (0/6) | sem suppressed 33.3% [9.7–70.0] (2/6)
  - after_external_effect_before_local_commit [WINDOW]: syn once 0.0% [0.0–39.0] (0/6) | sem once 16.7% [3.0–56.4] (1/6) | sem suppressed 33.3% [9.7–70.0] (2/6)
  - after_local_commit: syn once 0.0% [0.0–39.0] (0/6) | sem once 0.0% [0.0–39.0] (0/6) | sem suppressed 16.7% [3.0–56.4] (1/6)

## Cost (§8.9)
{
 "judge": "openai_gpt_oss_120b",
 "judgeMeta": {
  "calls": 4,
  "batchSize": 10,
  "inputTokens": 4345,
  "outputTokens": 2709,
  "meanCallLatencyMs": 2061,
  "tokensPerComparison": 7.386387434554974,
  "batchedLatencyMsPerComparison": 206.1
 },
 "declaredWitness": {
  "fractionJudged": 0.7352297592997812,
  "judgeCallsPer1000": 735,
  "judgeTokensPer1000": 5431,
  "addedLatencyMsPerJudgedDispatch": 2061,
  "escalationsPer1000DistinctActions": 0,
  "usdPer1000AtRate": {
   "$0.1/Mtok": 0.0005,
   "$0.5/Mtok": 0.0027,
   "$1/Mtok": 0.0054
  }
 },
 "tightenedWitness": {
  "fractionJudged": 0.5645514223194749,
  "judgeCallsPer1000": 565,
  "judgeTokensPer1000": 4170,
  "addedLatencyMsPerJudgedDispatch": 2061,
  "escalationsPer1000DistinctActions": 0,
  "usdPer1000AtRate": {
   "$0.1/Mtok": 0.0004,
   "$0.5/Mtok": 0.0021,
   "$1/Mtok": 0.0042
  }
 },
 "note": "Escalations are the human cost and are counted per 1000 GENUINELY DISTINCT actions (the population that gets escalated); judge calls are per 1000 dispatches."
}