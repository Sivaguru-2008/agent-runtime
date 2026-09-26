#!/usr/bin/env node
/**
 * Build references.bib for the AIJ manuscript from RESOLVED metadata only.
 *
 *   node docs/research/aij/tools/make-bib.mjs
 *
 * arXiv entries take their authors, title and year from the DataCite record of
 * the arXiv DOI (10.48550/arXiv.<id>), fetched by tools/reference-audit.mjs into
 * audit/reference-audit-datacite.json, or fetched here for ids not in that file.
 * Entries with a publisher DOI were checked against Crossref (audit/crossref-
 * checks.txt). Books and documentation pages were checked against Open Library
 * and by HTTP status. Nothing below is typed from memory without one of those
 * checks, and an id that does not resolve aborts the build.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const audit = JSON.parse(readFileSync(resolve(root, "audit", "reference-audit-datacite.json"), "utf8"));
const byArxiv = new Map(audit.rows.filter((r) => r.arxiv && r.apiTitle).map((r) => [r.arxiv, r]));

// Keys → arXiv ids (preprints cited as preprints).
const ARXIV = {
  atomix2026: "2602.14849", mansoor2026verified: "2608.02645", lyu2026coagent: "2606.15376",
  fang2026semhash: "2607.01601", zheng2026acrfence: "2603.20625", xu2026caplease: "2608.01710",
  balakrishnan2026logact: "2604.07988", yin2026invariants: "2608.00783", mozafari2026transaction: "2608.05412",
  resume2026contract: "2608.03836", zuvic2026confused: "2606.28679", turan2026oversight: "2606.08919",
  beurerkellner2025patterns: "2506.08837", ye2024justice: "2410.02736", chen2024humans: "2402.10669",
  li2025leakage: "2502.01534", hwang2025persuasion: "2508.07805",
  sheng2025judgeconformal: "2509.18658", ulmer2024nonexchangeable: "2402.00707",
  lin2025domainshift: "2510.05566", tursunbadalov2026minority: "2607.06605", yao2024taubench: "2406.12045",
  angelopoulos2021ltt: "2110.01052",
};
// Published versions whose arXiv id is also recorded (venue added by hand from the proceedings).
const ARXIV_PUBLISHED = {
  ren2023knowno: { id: "2307.01928", type: "inproceedings", booktitle: "Proceedings of the 7th Conference on Robot Learning (CoRL)", series: "PMLR", volume: "229", year: 2023 },
  yao2023react: { id: "2210.03629", type: "inproceedings", booktitle: "International Conference on Learning Representations (ICLR)", year: 2023 },
  zheng2023judge: { id: "2306.05685", type: "inproceedings", booktitle: "Advances in Neural Information Processing Systems 36 (NeurIPS), Datasets and Benchmarks Track", year: 2023 },
  yuan2024rjudge: { id: "2401.10019", type: "inproceedings", booktitle: "Findings of the Association for Computational Linguistics: EMNLP 2024", year: 2024 },
  schick2023toolformer: { id: "2302.04761", type: "inproceedings", booktitle: "Advances in Neural Information Processing Systems 36 (NeurIPS)", year: 2023 },
  debenedetti2024agentdojo: { id: "2406.13352", type: "inproceedings", booktitle: "Advances in Neural Information Processing Systems 37 (NeurIPS), Datasets and Benchmarks Track", year: 2024 },
  ruan2024toolemu: { id: "2309.15817", type: "inproceedings", booktitle: "International Conference on Learning Representations (ICLR)", year: 2024 },
  angelopoulos2024crc: { id: "2208.02814", type: "inproceedings", booktitle: "International Conference on Learning Representations (ICLR)", year: 2024 },
  // Published version confirmed on OpenReview (ICLR 2024 poster, forum pzUhfQ74c5), 2026-09-26.
  quach2023clm: { id: "2306.10193", type: "inproceedings", booktitle: "International Conference on Learning Representations (ICLR)", year: 2024 },
  gill2025meancache: { id: "2403.02694", type: "inproceedings", booktitle: "Proceedings of the IEEE International Parallel and Distributed Processing Symposium (IPDPS)", year: 2025, doi: "10.1109/IPDPS64566.2025.00117" },
};

// Crossref-verified (DOI resolved; metadata as registered) and other checked sources.
const FIXED = String.raw`
@book{vovk2005alrw,
  author = {Vovk, Vladimir and Gammerman, Alexander and Shafer, Glenn},
  title = {{Algorithmic Learning in a Random World}},
  publisher = {Springer}, address = {New York}, year = {2005}
}
@article{angelopoulos2023gentle,
  author = {Angelopoulos, Anastasios N. and Bates, Stephen},
  title = {{Conformal Prediction: A Gentle Introduction}},
  journal = {Foundations and Trends in Machine Learning}, volume = {16}, number = {4}, pages = {494--591}, year = {2023},
  doi = {10.1561/2200000101}
}
@article{lei2018distribution,
  author = {Lei, Jing and G'Sell, Max and Rinaldo, Alessandro and Tibshirani, Ryan J. and Wasserman, Larry},
  title = {{Distribution-Free Predictive Inference for Regression}},
  journal = {Journal of the American Statistical Association}, volume = {113}, number = {523}, pages = {1094--1111}, year = {2018},
  doi = {10.1080/01621459.2017.1307116}
}
@article{bates2023outliers,
  author = {Bates, Stephen and Cand{\`e}s, Emmanuel and Lei, Lihua and Romano, Yaniv and Sesia, Matteo},
  title = {{Testing for Outliers with Conformal p-values}},
  journal = {The Annals of Statistics}, volume = {51}, number = {1}, year = {2023},
  doi = {10.1214/22-AOS2244}
}
@article{birrell1984rpc,
  author = {Birrell, Andrew D. and Nelson, Bruce Jay},
  title = {{Implementing Remote Procedure Calls}},
  journal = {ACM Transactions on Computer Systems}, volume = {2}, number = {1}, pages = {39--59}, year = {1984},
  doi = {10.1145/2080.357392}
}
@article{elmagarmid2007duplicate,
  author = {Elmagarmid, Ahmed K. and Ipeirotis, Panagiotis G. and Verykios, Vassilios S.},
  title = {{Duplicate Record Detection: A Survey}},
  journal = {IEEE Transactions on Knowledge and Data Engineering}, volume = {19}, number = {1}, pages = {1--16}, year = {2007},
  doi = {10.1109/TKDE.2007.250581}
}
@inproceedings{garcia1987sagas,
  author = {Garcia-Molina, Hector and Salem, Kenneth},
  title = {{Sagas}},
  booktitle = {Proceedings of the 1987 ACM SIGMOD International Conference on Management of Data}, pages = {249--259}, year = {1987},
  doi = {10.1145/38713.38742}
}
@article{carbone2017flink,
  author = {Carbone, Paris and Ewen, Stephan and F{\'o}ra, Gyula and Haridi, Seif and Richter, Stefan and Tzoumas, Kostas},
  title = {{State Management in Apache Flink: Consistent Stateful Distributed Stream Processing}},
  journal = {Proceedings of the VLDB Endowment}, volume = {10}, number = {12}, pages = {1718--1729}, year = {2017},
  doi = {10.14778/3137765.3137777}
}
@inproceedings{buneman2001provenance,
  author = {Buneman, Peter and Khanna, Sanjeev and Tan, Wang-Chiew},
  title = {{Why and Where: A Characterization of Data Provenance}},
  booktitle = {Database Theory -- ICDT 2001}, series = {Lecture Notes in Computer Science}, volume = {1973}, pages = {316--330}, publisher = {Springer}, year = {2001},
  doi = {10.1007/3-540-44503-X_20}
}
@inproceedings{pezoa2016jsonschema,
  author = {Pezoa, Felipe and Reutter, Juan L. and Suarez, Fernando and Ugarte, Mart{\'\i}n and Vrgo{\v{c}}, Domagoj},
  title = {{Foundations of JSON Schema}},
  booktitle = {Proceedings of the 25th International Conference on World Wide Web (WWW)}, pages = {263--273}, year = {2016},
  doi = {10.1145/2872427.2883029}
}
@inproceedings{greshake2023injection,
  author = {Greshake, Kai and Abdelnabi, Sahar and Mishra, Shailesh and Endres, Christoph and Holz, Thorsten and Fritz, Mario},
  title = {{Not What You've Signed Up For: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection}},
  booktitle = {Proceedings of the 16th ACM Workshop on Artificial Intelligence and Security (AISec)}, pages = {79--90}, year = {2023},
  doi = {10.1145/3605764.3623985}
}
@inproceedings{cer2017sts,
  author = {Cer, Daniel and Diab, Mona and Agirre, Eneko and Lopez-Gazpio, I{\~n}igo and Specia, Lucia},
  title = {{SemEval-2017 Task 1: Semantic Textual Similarity Multilingual and Crosslingual Focused Evaluation}},
  booktitle = {Proceedings of the 11th International Workshop on Semantic Evaluation (SemEval-2017)}, pages = {1--14}, year = {2017},
  doi = {10.18653/v1/S17-2001}
}
@article{wilson1927,
  author = {Wilson, Edwin B.},
  title = {{Probable Inference, the Law of Succession, and Statistical Inference}},
  journal = {Journal of the American Statistical Association}, volume = {22}, number = {158}, pages = {209--212}, year = {1927},
  doi = {10.1080/01621459.1927.10502953}
}
@article{mcnemar1947,
  author = {McNemar, Quinn},
  title = {{Note on the Sampling Error of the Difference Between Correlated Proportions or Percentages}},
  journal = {Psychometrika}, volume = {12}, number = {2}, pages = {153--157}, year = {1947},
  doi = {10.1007/BF02295996}
}
@article{holm1979,
  author = {Holm, Sture},
  title = {{A Simple Sequentially Rejective Multiple Test Procedure}},
  journal = {Scandinavian Journal of Statistics}, volume = {6}, number = {2}, pages = {65--70}, year = {1979}
}
@article{cohen1960,
  author = {Cohen, Jacob},
  title = {{A Coefficient of Agreement for Nominal Scales}},
  journal = {Educational and Psychological Measurement}, volume = {20}, number = {1}, pages = {37--46}, year = {1960},
  doi = {10.1177/001316446002000104}
}
@article{fleiss1971,
  author = {Fleiss, Joseph L.},
  title = {{Measuring Nominal Scale Agreement Among Many Raters}},
  journal = {Psychological Bulletin}, volume = {76}, number = {5}, pages = {378--382}, year = {1971},
  doi = {10.1037/h0031619}
}
@article{krippendorff2004,
  author = {Krippendorff, Klaus},
  title = {{Reliability in Content Analysis: Some Common Misconceptions and Recommendations}},
  journal = {Human Communication Research}, volume = {30}, number = {3}, pages = {411--433}, year = {2004},
  doi = {10.1111/j.1468-2958.2004.tb00738.x}
}
@book{kleppmann2017ddia,
  author = {Kleppmann, Martin},
  title = {{Designing Data-Intensive Applications}},
  publisher = {O'Reilly Media}, year = {2017}, isbn = {9781449373320}
}
@book{gray1993transaction,
  author = {Gray, Jim and Reuter, Andreas},
  title = {{Transaction Processing: Concepts and Techniques}},
  publisher = {Morgan Kaufmann}, year = {1993}, isbn = {9781558601901}
}
@inproceedings{mohri2024factuality,
  author = {Mohri, Christopher and Hashimoto, Tatsunori},
  title = {{Language Models with Conformal Factuality Guarantees}},
  booktitle = {Proceedings of the 41st International Conference on Machine Learning (ICML)}, series = {Proceedings of Machine Learning Research},
  volume = {235}, pages = {36029--36047}, publisher = {PMLR}, year = {2024},
  url = {https://proceedings.mlr.press/v235/mohri24a.html}
}
@inproceedings{wang2023fair,
  author = {Wang, Peiyi and Li, Lei and Chen, Liang and Cai, Zefan and Zhu, Dawei and Lin, Binghuai and Cao, Yunbo and Kong, Lingpeng and Liu, Qi and Liu, Tianyu and Sui, Zhifang},
  title = {{Large Language Models are not Fair Evaluators}},
  booktitle = {Proceedings of the 62nd Annual Meeting of the Association for Computational Linguistics (Volume 1: Long Papers)},
  pages = {9440--9450}, address = {Bangkok, Thailand}, publisher = {Association for Computational Linguistics}, year = {2024},
  doi = {10.18653/v1/2024.acl-long.511}
}
@misc{stripe2026idempotency,
  author = {{Stripe}},
  title = {{Idempotent Requests}},
  howpublished = {API documentation, \url{https://docs.stripe.com/api/idempotent_requests}},
  note = {Accessed 14 September 2026}, year = {2026}
}
@misc{temporal2026docs,
  author = {{Temporal Technologies}},
  title = {{Temporal Documentation: Durable Execution}},
  howpublished = {\url{https://docs.temporal.io/}},
  note = {Accessed 14 September 2026}, year = {2026}
}
@misc{restate2026docs,
  author = {{Restate}},
  title = {{Restate Documentation}},
  howpublished = {\url{https://docs.restate.dev/}},
  note = {Accessed 14 September 2026}, year = {2026}
}
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function datacite(id) {
  if (byArxiv.has(id)) {
    const r = byArxiv.get(id);
    return { title: r.apiTitle, authors: r.apiAuthors, year: r.apiYear };
  }
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`https://api.datacite.org/dois/10.48550/arXiv.${id}`).catch(() => null);
    if (res?.ok) {
      const at = (await res.json()).data.attributes;
      return { title: at.titles[0].title, authors: at.creators.map((c) => c.name), year: at.publicationYear };
    }
    await sleep(1500 * 2 ** a);
  }
  throw new Error(`arXiv:${id} did not resolve — refusing to write an unverified entry`);
}
const texEsc = (s) => s.replace(/\\/g, "\\textbackslash{}").replace(/([&%#_])/g, "\\$1")
  .replace(/\$τ\$/g, "$\\tau$").replace(/τ/g, "$\\tau$").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  .replace(/–|—/g, "--").replace(/é/g, "{\\'e}").replace(/è/g, "{\\`e}").replace(/ö/g, '{\\"o}').replace(/ü/g, '{\\"u}')
  .replace(/á/g, "{\\'a}").replace(/í/g, "{\\'\\i}").replace(/ó/g, "{\\'o}").replace(/ć/g, "{\\'c}").replace(/č/g, "{\\v{c}}")
  .replace(/š/g, "{\\v{s}}").replace(/ñ/g, "{\\~n}").replace(/ç/g, "{\\c{c}}").replace(/ø/g, "{\\o}").replace(/å/g, "{\\aa}")
  .replace(/ä/g, '{\\"a}').replace(/ë/g, '{\\"e}').replace(/ï/g, '{\\"\\i}').replace(/à/g, "{\\`a}").replace(/ř/g, "{\\v{r}}")
  .replace(/ł/g, "{\\l}").replace(/ń/g, "{\\'n}").replace(/ś/g, "{\\'s}").replace(/ž/g, "{\\v{z}}").replace(/ı/g, "{\\i}")
  .replace(/ţ/g, "{\\c{t}}").replace(/ş/g, "{\\c{s}}").replace(/ì/g, "{\\`\\i}").replace(/ò/g, "{\\`o}").replace(/ù/g, "{\\`u}")
  .replace(/ô/g, "{\\^o}").replace(/ê/g, "{\\^e}").replace(/â/g, "{\\^a}").replace(/î/g, "{\\^\\i}").replace(/û/g, "{\\^u}")
  .replace(/ú/g, "{\\'u}").replace(/ý/g, "{\\'y}").replace(/ã/g, "{\\~a}").replace(/õ/g, "{\\~o}").replace(/ğ/g, "{\\u{g}}")
  .replace(/ő/g, "{\\H{o}}").replace(/ű/g, "{\\H{u}}").replace(/ß/g, "{\\ss}");
const authorsBib = (names) => names.map((n) => texEsc(n)).join(" and ");

const out = ["% GENERATED by tools/make-bib.mjs from resolved metadata. Do not edit by hand.", ""];
for (const [key, id] of Object.entries(ARXIV)) {
  const m = await datacite(id);
  out.push(`@misc{${key},\n  author = {${authorsBib(m.authors)}},\n  title = {{${texEsc(m.title)}}},\n  year = {${m.year}},\n  note = {Preprint, arXiv:${id}},\n  doi = {10.48550/arXiv.${id}}\n}`);
}
for (const [key, p] of Object.entries(ARXIV_PUBLISHED)) {
  const m = await datacite(p.id);
  const extra = [p.series ? `  series = {${p.series}},` : null, p.volume ? `  volume = {${p.volume}},` : null, p.doi ? `  doi = {${p.doi}},` : null].filter(Boolean).join("\n");
  out.push(`@${p.type}{${key},\n  author = {${authorsBib(m.authors)}},\n  title = {{${texEsc(m.title)}}},\n  booktitle = {${p.booktitle}},\n${extra ? extra + "\n" : ""}  year = {${p.year}},\n  note = {arXiv:${p.id}}\n}`);
}
out.push(FIXED.trim());
const target = resolve(root, "references.bib");
writeFileSync(target, out.join("\n\n") + "\n");
const nonAscii = [...readFileSync(target, "utf8").matchAll(/[^\x00-\x7F]/g)].map((m) => m[0]);
console.log(`wrote ${target}: ${Object.keys(ARXIV).length + Object.keys(ARXIV_PUBLISHED).length} resolved arXiv entries + fixed entries`);
if (nonAscii.length) { console.error(`non-ASCII left in bib: ${[...new Set(nonAscii)].join(" ")}`); process.exit(1); }
