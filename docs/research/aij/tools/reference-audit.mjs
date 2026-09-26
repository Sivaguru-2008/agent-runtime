// Reference audit via DataCite (arXiv DOIs are 10.48550/arXiv.<id>).
// Resolves every arXiv id in the manuscript reference list and compares the
// listed title, first-author surname and year with the registered metadata.
import { readFileSync, writeFileSync } from "node:fs";

const SRC = process.argv[2];
const OUT = process.argv[3];
const lines = readFileSync(SRC, "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === "## References");
const end = lines.findIndex((l, i) => i > start && /^## Appendix/.test(l));
const refs = [];
for (const l of lines.slice(start + 1, end > 0 ? end : undefined)) {
  const m = l.match(/^(\d+)\.\s+(.*)$/);
  if (!m) continue;
  const body = m[2];
  const tm = body.match(/\*\*(.+?)\*\*/);
  const title = tm ? tm[1].replace(/\.$/, "").trim() : null;
  const authors = tm ? body.slice(0, body.indexOf("**")).trim().replace(/\.$/, "") : "";
  const ax = body.match(/arXiv:(\d{4}\.\d{4,5})/);
  const years = [...body.matchAll(/\b(?:19|20)\d{2}\b/g)].map((x) => +x[0]);
  refs.push({ num: +m[1], authors, title, arxiv: ax ? ax[1] : null, year: years.length ? years[years.length - 1] : null, raw: body });
}
const norm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const jac = (a, b) => {
  const A = new Set(norm(a).split(" ").filter(Boolean)), B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size && !B.size) return 1;
  let i = 0; for (const t of A) if (B.has(t)) i++;
  return i / (A.size + B.size - i);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let a = 0; a < 6; a++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/vnd.api+json" } });
      if (res.status === 404) return { notFound: true };
      if (res.ok) return await res.json();
      process.stderr.write(`  http ${res.status} ${url}\n`);
    } catch (e) { process.stderr.write(`  ${e.message} ${url}\n`); }
    await sleep(2000 * 2 ** a);
  }
  return { error: true };
}
const rows = [];
for (const r of refs) {
  if (!r.arxiv) { rows.push({ ...r, status: "NO_ARXIV_ID" }); continue; }
  const j = await get(`https://api.datacite.org/dois/10.48550/arXiv.${r.arxiv}`);
  await sleep(250);
  if (j.notFound) { rows.push({ ...r, status: "NOT_FOUND" }); continue; }
  if (j.error || !j.data) { rows.push({ ...r, status: "LOOKUP_FAILED" }); continue; }
  const at = j.data.attributes;
  const apiTitle = (at.titles?.[0]?.title ?? "").replace(/\s+/g, " ").trim();
  const creators = (at.creators ?? []).map((c) => ({ family: c.familyName ?? (c.name ?? "").split(",")[0], name: c.name }));
  const apiYear = at.publicationYear ?? null;
  const sim = jac(r.title, apiTitle);
  const listedFirst = norm((r.authors.split(",")[0] || "")).split(" ")[0] || "";
  const apiFirst = norm(creators[0]?.family ?? "").split(" ").slice(-1)[0] || "";
  const authorOk = !r.authors ? null : (listedFirst && apiFirst ? norm(creators[0]?.family ?? "").includes(listedFirst) || listedFirst.includes(apiFirst) : null);
  const related = (at.relatedIdentifiers ?? []).filter((x) => /doi/i.test(x.relatedIdentifierType ?? "") && !/10\.48550/.test(x.relatedIdentifier ?? "")).map((x) => `${x.relationType}:${x.relatedIdentifier}`);
  rows.push({
    ...r, apiTitle, apiAuthors: creators.map((c) => c.name), nApiAuthors: creators.length, apiYear, related,
    titleSim: +sim.toFixed(2), authorOk, yearOk: r.year && apiYear ? r.year === +apiYear : null,
    status: sim >= 0.8 && authorOk !== false ? "OK" : sim >= 0.5 ? "TITLE_DIFFERS" : "MISMATCH",
  });
}
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: SRC, resolver: "api.datacite.org (10.48550/arXiv.*)", rows }, null, 2));
const tally = {};
for (const r of rows) tally[r.status] = (tally[r.status] || 0) + 1;
console.log("status tally:", JSON.stringify(tally));
for (const r of rows.filter((x) => x.status !== "OK")) {
  console.log(`[${r.num}] ${r.status}${r.arxiv ? ` arXiv:${r.arxiv}` : ""} sim=${r.titleSim ?? "-"} authorOk=${r.authorOk ?? "-"} yearOk=${r.yearOk ?? "-"}`);
  console.log(`    listed: ${r.authors ? r.authors.slice(0, 70) + " | " : ""}${r.title}`);
  if (r.apiTitle) console.log(`    DOI   : ${(r.apiAuthors || []).slice(0, 3).join("; ")} | ${r.apiTitle} (${r.apiYear})`);
}
for (const r of rows.filter((x) => x.status === "OK" && (x.authorOk === false || x.yearOk === false || (x.authors && /et al/.test(x.authors) === false && x.nApiAuthors && x.authors.split(",").length / 2 < x.nApiAuthors - 1)))) {
  console.log(`[${r.num}] OK-title; authorOk=${r.authorOk} yearOk=${r.yearOk} listedAuthors="${r.authors.slice(0, 80)}" api(${r.nApiAuthors})="${(r.apiAuthors || []).slice(0, 4).join("; ")}" apiYear=${r.apiYear}`);
}
for (const r of rows.filter((x) => x.related?.length)) console.log(`[${r.num}] related published version(s): ${r.related.join(", ")}`);
