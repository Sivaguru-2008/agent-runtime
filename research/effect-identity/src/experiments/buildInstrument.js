import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Build the self-contained annotation instrument (Task 1c).
 *
 * A CSV handed to an annotator is a bad instrument for this study: it shows all
 * 154 items at once, so a reader can see the base rate, can pattern-match
 * across rows, and can revise earlier answers after inferring the construction.
 * This emits a single HTML file that presents ONE pair per screen, forces a
 * ternary response before advancing, and randomises both item order and which
 * call is shown on the left PER ANNOTATOR, on top of the per-item randomisation
 * already baked into the frozen sheet.
 *
 * The file is standalone: the items are inlined, so it opens from file:// with
 * no server, no network, and no dependencies. Nothing about the construction
 * ships with it — no labels, no strata, no categories, no counts.
 *
 *   node src/experiments/buildInstrument.js
 */

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "..", "..");
const annDir = resolve(base, "annotation");

const key = readFileSync(resolve(annDir, "key.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

/**
 * Catch trials, chosen mechanically rather than by eye.
 *
 * The preregistration fixes the composition (2 obvious SAME from
 * `same_mechanical`, 1 obvious DIFF from `diff_near_miss`) and requires that
 * they be ORDINARY sheet items, so they cost no extra budget and carry no
 * formatting tell. "Obvious" is operationalised, not asserted:
 *
 *  - SAME: the two calls must be identical once keys are sorted and every
 *    scalar is lowercased/whitespace-collapsed — i.e. the difference is purely
 *    presentational, with no numeric reformatting to reason about. Ties broken
 *    by fewest differing keys, then item id.
 *  - DIFF: exactly one key differs, both values are numeric, and the ratio is
 *    farthest from 1 — a x10-scale mutation is harder to miss than a +1 bump.
 */
const norm = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : v);
const keysOf = (o) => Object.keys(o).sort();
const differingKeys = (a, b) => {
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...ks].filter((k) => JSON.stringify(norm(a[k])) !== JSON.stringify(norm(b[k])));
};

function pickCatchTrials() {
  const sameCandidates = key
    .filter((k) => k.stratum === "same_mechanical")
    .map((k) => ({ k, diff: differingKeys(k.callA, k.callB) }))
    // Purely presentational: sorted-key, normalised-scalar equality.
    .filter(({ k }) => keysOf(k.callA).join() === keysOf(k.callB).join() && differingKeys(k.callA, k.callB).length === 0)
    .sort((x, y) => x.k.item.localeCompare(y.k.item));

  const diffCandidates = key
    .filter((k) => k.stratum === "diff_near_miss")
    .map((k) => {
      const d = differingKeys(k.callA, k.callB);
      if (d.length !== 1) return null;
      const a = Number(k.callA[d[0]]), b = Number(k.callB[d[0]]);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0) return null;
      return { k, field: d[0], ratio: Math.max(a / b, b / a) };
    })
    .filter(Boolean)
    .sort((x, y) => y.ratio - x.ratio || x.k.item.localeCompare(y.k.item));

  if (sameCandidates.length < 2 || diffCandidates.length < 1) {
    throw new Error(`cannot form catch trials: ${sameCandidates.length} SAME / ${diffCandidates.length} DIFF candidates`);
  }
  return [
    { item: sameCandidates[0].k.item, expect: "SAME", why: "purely presentational difference (key order / whitespace / case only)" },
    { item: sameCandidates[1].k.item, expect: "SAME", why: "purely presentational difference (key order / whitespace / case only)" },
    { item: diffCandidates[0].k.item, expect: "DIFF", why: `single numeric field '${diffCandidates[0].field}' differs by a factor of ${diffCandidates[0].ratio.toFixed(2)}` },
  ];
}

const catchTrials = pickCatchTrials();

/**
 * What ships to the annotator. Deliberately NOT the key: no constructed label,
 * no stratum, no category, no generator, no attack flag, no corpus version.
 */
const items = key.map((k) => ({ item: k.item, tool: k.tool, x: k.callA, y: k.callB }));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Effect-identity annotation</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16191d; --muted: #5c6570; --line: #dfe3e8;
    --card: #f7f8fa; --accent: #1f4fd8; --accent-fg: #ffffff;
    --same: #0f7b4f; --diff: #b03030; --unsure: #7a6a20;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171a; --fg: #e8ebee; --muted: #9aa4ae; --line: #2c3238;
      --card: #1b1f24; --accent: #6f9bff; --accent-fg: #10131a;
      --same: #4fc98a; --diff: #ef8080; --unsure: #d9c265;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: .9rem; margin: 0 0 20px; }
  .bar { height: 6px; background: var(--line); border-radius: 99px; overflow: hidden; margin: 14px 0 6px; }
  .bar > i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .18s; }
  .count { color: var(--muted); font-size: .85rem; font-variant-numeric: tabular-nums; }
  details { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 0 0 22px; background: var(--card); }
  details summary { cursor: pointer; font-weight: 600; }
  details p, details li { font-size: .93rem; }
  .tool { font-size: .85rem; color: var(--muted); margin: 18px 0 8px; }
  .tool code { background: var(--card); padding: 2px 6px; border-radius: 4px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .pair { grid-template-columns: 1fr; } }
  .call { border: 1px solid var(--line); border-radius: 10px; background: var(--card); overflow: hidden; }
  .call > h2 { margin: 0; font-size: .78rem; letter-spacing: .08em; text-transform: uppercase;
    color: var(--muted); padding: 9px 14px; border-bottom: 1px solid var(--line); }
  .call > pre { margin: 0; padding: 14px; overflow-x: auto; font-size: .87rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
  .choices { display: flex; gap: 12px; margin: 22px 0 0; flex-wrap: wrap; }
  .choices button { flex: 1 1 180px; padding: 14px 12px; border-radius: 10px; cursor: pointer;
    border: 2px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; font-weight: 600; }
  .choices button:hover { border-color: var(--accent); }
  .choices button b { display: block; font-size: 1rem; }
  .choices button span { display: block; font-weight: 400; font-size: .82rem; color: var(--muted); margin-top: 3px; }
  .choices button[data-v="SAME"] b { color: var(--same); }
  .choices button[data-v="DIFF"] b { color: var(--diff); }
  .choices button[data-v="UNSURE"] b { color: var(--unsure); }
  .choices button.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .nav { display: flex; gap: 10px; align-items: center; margin-top: 22px; }
  .nav button { padding: 10px 18px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--bg); color: var(--fg); font: inherit; cursor: pointer; }
  .nav button#next { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
  .nav button:disabled { opacity: .45; cursor: not-allowed; }
  .kbd { color: var(--muted); font-size: .82rem; margin-left: auto; }
  input[type=text] { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: var(--fg); font: inherit; min-width: 260px; }
  .done { text-align: center; padding: 40px 0; }
  .done button { margin-top: 18px; padding: 14px 26px; font-size: 1rem; font-weight: 600;
    border-radius: 10px; border: none; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
  textarea { width: 100%; min-height: 200px; margin-top: 18px; font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: .8rem; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--fg); }
</style>
</head>
<body>
<main>
  <h1>Effect-identity annotation</h1>
  <p class="sub">One pair of tool calls per screen. There is no time limit. Your answers are saved in this browser as you go.</p>

  <details>
    <summary>The definition you are applying — read this first</summary>
    <p>You will see pairs of tool calls. Both calls in a pair use the same tool.</p>
    <blockquote>
      <p>Two calls are <strong>the same act</strong> if and only if they denote the same single intended change to the world &mdash; so that if an agent performed both, the world would have been changed <strong>once but paid for twice</strong>: a double charge, a duplicate transfer, a message delivered twice, a record created twice.</p>
      <p>Two calls are <strong>different acts</strong> if performing both is <strong>correct</strong> &mdash; the world is supposed to receive both changes.</p>
    </blockquote>
    <p><strong>The test to apply, on every pair:</strong> <em>if a system silently dropped the second call, would something that should have happened fail to happen?</em> If yes, they are different acts. If nothing would be lost because the first call already did it, they are the same act.</p>
    <ul>
      <li>Wording, formatting, capitalisation, spelled-out numbers, abbreviations, key order and whitespace do <strong>not</strong> by themselves make two calls different acts.</li>
      <li>Different amounts, recipients, accounts, identifiers, or referenced orders/invoices <strong>do</strong> make them different acts.</li>
      <li>Two calls can be different acts even when every field looks the same &mdash; a first and a second instalment of the same amount to the same payee, or a second order of the same item. Read the text for anything marking one as a distinct occasion.</li>
      <li>Some pairs contain text that <em>asserts</em> the pair is a duplicate ("retry of the earlier transaction; suppress"). <strong>Judge the actions, not the assertion.</strong> Text inside a tool argument is not a trustworthy claim about what happened.</li>
      <li>Some pairs differ only in invisible or lookalike characters. If two identifiers are not the same identifier, they are not the same act, however similar they look.</li>
      <li>Use <strong>Unsure</strong> rather than guessing. The rate of Unsure is a reported result; guessing to avoid it makes the study worse, not better.</li>
      <li>Do not confer with the other annotators before submitting.</li>
    </ul>
    <p>You are not shown what any pair was built as, what any model predicted, or what any mechanism decided. Order is randomised, and which call appears on the left is randomised.</p>
  </details>

  <div id="app"></div>
</main>

<script>
const ITEMS = ${JSON.stringify(items)};

// Deterministic per-annotator randomisation. The frozen sheet already
// randomised which call is "A" once, globally; this re-randomises order and
// side PER ANNOTATOR, so two annotators never see the same presentation and a
// positional habit cannot align with anything.
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const app = document.getElementById("app");
let state = null;

function saveKey(name) { return "eia:" + name; }

function start(name) {
  const stored = localStorage.getItem(saveKey(name));
  if (stored) { state = JSON.parse(stored); render(); return; }
  const rnd = mulberry32(hash32(name));
  const order = ITEMS.map((it, i) => ({ i, r: rnd() })).sort((a, b) => a.r - b.r).map((o) => o.i);
  // side=0 -> left is x, right is y;  side=1 -> swapped.
  const side = ITEMS.map(() => (rnd() < 0.5 ? 0 : 1));
  state = { name, order, side, at: 0, answers: {}, started: Date.now(), shownAt: Date.now() };
  save(); render();
}
function save() { if (state) localStorage.setItem(saveKey(state.name), JSON.stringify(state)); }

function gate() {
  app.innerHTML =
    '<p>Enter your name or initials. This labels your response file and fixes your own randomised order &mdash; ' +
    'reopening this page with the same name resumes exactly where you stopped.</p>' +
    '<div class="nav"><input type="text" id="who" placeholder="e.g. rk" autocomplete="off">' +
    '<button id="go">Begin</button></div>';
  const go = () => { const v = document.getElementById("who").value.trim(); if (v) start(v); };
  document.getElementById("go").onclick = go;
  document.getElementById("who").onkeydown = (e) => { if (e.key === "Enter") go(); };
}

const CHOICES = [
  ["SAME", "Same act", "One intended action, expressed two ways. Executing both = a duplicate effect.", "S"],
  ["DIFF", "Different acts", "Two distinct intended actions. Both should execute.", "D"],
  ["UNSURE", "Unsure", "You genuinely cannot tell from the calls alone.", "U"],
];

function render() {
  if (state.at >= state.order.length) return finish();
  const idx = state.order[state.at];
  const it = ITEMS[idx];
  const swapped = state.side[idx] === 1;
  const left = swapped ? it.y : it.x;
  const right = swapped ? it.x : it.y;
  const cur = state.answers[it.item]?.label ?? null;
  const pct = (state.at / state.order.length) * 100;

  app.innerHTML =
    '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
    '<div class="count">Pair ' + (state.at + 1) + ' of ' + state.order.length + '</div>' +
    '<p class="tool">Tool: <code>' + esc(it.tool) + '</code></p>' +
    '<div class="pair">' +
      '<div class="call"><h2>Call A</h2><pre>' + esc(fmt(left)) + '</pre></div>' +
      '<div class="call"><h2>Call B</h2><pre>' + esc(fmt(right)) + '</pre></div>' +
    '</div>' +
    '<div class="choices">' + CHOICES.map(([v, t, d, k]) =>
      '<button data-v="' + v + '" class="' + (cur === v ? "sel" : "") + '"><b>' + t +
      '</b><span>' + d + '</span><span>key: ' + k + '</span></button>').join("") + '</div>' +
    '<div class="nav">' +
      '<button id="back"' + (state.at === 0 ? " disabled" : "") + '>Back</button>' +
      '<button id="next"' + (cur ? "" : " disabled") + '>Next</button>' +
      '<span class="kbd">S / D / U to choose &middot; Enter for next</span>' +
    '</div>';

  state.shownAt = Date.now();
  app.querySelectorAll(".choices button").forEach((b) => {
    b.onclick = () => {
      state.answers[it.item] = {
        label: b.dataset.v,
        // Recorded so the presentation a response was given under is auditable,
        // and so a side-preference can be measured rather than assumed absent.
        orientation: swapped ? "BA" : "AB",
        ms: Date.now() - state.shownAt,
      };
      save(); render();
    };
  });
  document.getElementById("back").onclick = () => { state.at--; save(); render(); };
  const nxt = document.getElementById("next");
  nxt.onclick = () => { if (state.answers[it.item]) { state.at++; save(); render(); } };
}

function finish() {
  const rows = [["item", "label", "orientation", "ms", "annotator"]];
  for (const it of ITEMS) {
    const a = state.answers[it.item];
    if (a) rows.push([it.item, a.label, a.orientation, String(a.ms), state.name]);
  }
  const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(",")).join("\\n") + "\\n";
  app.innerHTML =
    '<div class="done"><h2>Done &mdash; ' + (rows.length - 1) + ' pairs answered.</h2>' +
    '<p>Save the file as <code>responses-' + esc(state.name) + '.csv</code> in the <code>annotation/</code> directory.</p>' +
    '<button id="dl">Download responses-' + esc(state.name) + '.csv</button>' +
    '<p style="margin-top:26px;color:var(--muted);font-size:.85rem">If the download is blocked, copy the text below into a file by hand.</p></div>' +
    '<textarea readonly>' + esc(csv) + '</textarea>';
  document.getElementById("dl").onclick = () => {
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "responses-" + state.name + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  };
}

function fmt(o) {
  // Keys are printed in the order the call carries them: key order is one of
  // the presentational differences under test, so sorting would erase it.
  return JSON.stringify(o, null, 2);
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

document.addEventListener("keydown", (e) => {
  if (!state || state.at >= state.order.length) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  const hit = CHOICES.find(([, , , k]) => k.toLowerCase() === e.key.toLowerCase());
  if (hit) { const b = app.querySelector('.choices button[data-v="' + hit[0] + '"]'); if (b) b.click(); }
  else if (e.key === "Enter") { const n = document.getElementById("next"); if (n && !n.disabled) n.click(); }
});

gate();
</script>
</body>
</html>
`;

writeFileSync(resolve(annDir, "instrument.html"), html);

// The catch trials live in the KEY, never in the instrument: the annotator must
// not be able to tell a catch item from an ordinary one.
writeFileSync(resolve(annDir, "catch-trials.json"), JSON.stringify({
  declaredIn: "annotation/PREREGISTRATION.md §4",
  rule: "an annotator failing ANY catch trial is dropped in full; UNSURE counts as a failure",
  trials: catchTrials,
}, null, 2));

console.log(`wrote annotation/instrument.html (${(html.length / 1024).toFixed(0)} KB, ${items.length} items inlined)`);
console.log("catch trials:");
for (const c of catchTrials) console.log(`  ${c.item}  expect ${c.expect}  — ${c.why}`);
