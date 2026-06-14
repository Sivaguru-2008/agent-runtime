/**
 * The tools the agent can call. These are REAL local functions with
 * deterministic behaviour — not scripted LLM output. Failures (e.g. an empty
 * search result) emerge from the tool's genuine response to the model's genuine
 * request, which is exactly what the runtime is built to catch.
 *
 * `effect` declares the fence classification; `damageIfWrongUSD` is the
 * estimated cost of this effect firing on bad/duplicate data, used by Stage 5
 * (causal attribution) and Stage 7 (pattern economics).
 */
export interface ToolResult {
  ok: boolean;
  data: unknown;
  error?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  effect: "IRREVERSIBLE" | "IDEMPOTENT";
  damageIfWrongUSD: number;
  run(input: Record<string, unknown>): ToolResult;
}

// A small, real knowledge corpus. search_web returns genuine hits for topics it
// knows and an empty array for anything over-specific or unknown.
const CORPUS: Array<{ keywords: string[]; title: string; snippet: string; value?: number }> = [
  { keywords: ["capital", "france"], title: "France — country profile", snippet: "The capital of France is Paris." },
  { keywords: ["capital", "japan"], title: "Japan — country profile", snippet: "The capital of Japan is Tokyo." },
  {
    keywords: ["population", "tokyo"],
    title: "Tokyo demographics",
    snippet: "Greater Tokyo has about 37 million residents.",
    value: 37_000_000,
  },
  {
    keywords: ["speed", "light"],
    title: "Physical constants",
    snippet: "The speed of light is 299,792,458 m/s.",
    value: 299_792_458,
  },
  {
    keywords: ["boiling", "water"],
    title: "Water properties",
    snippet: "Water boils at 100°C at sea level.",
    value: 100,
  },
  {
    keywords: ["revenue", "acme"],
    title: "ACME Corp FY24 summary",
    snippet: "ACME Corp reported $4.2M revenue in FY24.",
    value: 4_200_000,
  },
  {
    keywords: ["refund", "policy"],
    title: "Refund policy",
    snippet: "Refunds are issued within 30 days of purchase.",
  },
];

export const TOOLS: Record<string, ToolDef> = {
  search_web: {
    name: "search_web",
    description: "Search the web for information. Input: { query: string }. Returns an array of results.",
    effect: "IDEMPOTENT",
    damageIfWrongUSD: 0,
    run(input) {
      const query = String(input.query ?? "").toLowerCase().trim();
      if (!query) return { ok: false, data: [], error: "empty query" };
      const terms = query.split(/[^a-z0-9]+/).filter(Boolean);
      const hits = CORPUS.filter((doc) => {
        const matched = doc.keywords.filter((k) => terms.includes(k)).length;
        // Require the query to land most of a document's keywords. Over-specific
        // multi-constraint queries naturally match nothing -> [] (silent failure).
        return matched >= Math.min(2, doc.keywords.length) && terms.length <= 6;
      }).map((d) => ({ title: d.title, snippet: d.snippet, value: d.value }));
      return { ok: true, data: hits };
    },
  },

  extract_data: {
    name: "extract_data",
    description: "Extract a numeric or text value from prior search results. Input: { from: string, field?: string }.",
    effect: "IDEMPOTENT",
    damageIfWrongUSD: 0,
    run(input) {
      const from = String(input.from ?? "");
      const num = from.match(/[\d][\d,\.]*/);
      if (num) return { ok: true, data: { value: num[0].replace(/,/g, "") } };
      if (from.trim()) return { ok: true, data: { value: from.trim().slice(0, 120) } };
      return { ok: false, data: null, error: "nothing to extract" };
    },
  },

  calculate: {
    name: "calculate",
    description: "Evaluate a basic arithmetic expression. Input: { expression: string }.",
    effect: "IDEMPOTENT",
    damageIfWrongUSD: 0,
    run(input) {
      const expr = String(input.expression ?? "");
      if (!/^[\d\s()+\-*/.]+$/.test(expr)) return { ok: false, data: null, error: "unsupported expression" };
      try {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${expr});`)() as number;
        if (!Number.isFinite(result)) return { ok: false, data: null, error: "non-finite result" };
        return { ok: true, data: { result } };
      } catch {
        return { ok: false, data: null, error: "evaluation failed" };
      }
    },
  },

  get_stock_price: {
    name: "get_stock_price",
    description: "Get the latest price for a ticker. Input: { ticker: string }. Real-time, may be unavailable.",
    effect: "IDEMPOTENT",
    damageIfWrongUSD: 0,
    run(input) {
      // No live market here: this tool genuinely cannot answer, which is exactly
      // the ambiguous ground that triggers OVERCONFIDENCE if the model invents one.
      const ticker = String(input.ticker ?? "").toUpperCase();
      if (!ticker) return { ok: false, data: null, error: "no ticker" };
      return { ok: false, data: null, error: `real-time price for ${ticker} unavailable` };
    },
  },

  send_email: {
    name: "send_email",
    description: "Send an email. Input: { to: string, subject: string, body: string }. IRREVERSIBLE.",
    effect: "IRREVERSIBLE",
    damageIfWrongUSD: 0.4,
    run(input) {
      const to = String(input.to ?? "");
      if (!to.includes("@")) return { ok: false, data: null, error: "invalid recipient" };
      return { ok: true, data: { sent: true, to, messageId: `msg_${hash(JSON.stringify(input))}` } };
    },
  },

  charge_card: {
    name: "charge_card",
    description: "Charge a customer's card. Input: { customer: string, amountUsd: number }. IRREVERSIBLE.",
    effect: "IRREVERSIBLE",
    damageIfWrongUSD: 5,
    run(input) {
      const amount = Number(input.amountUsd ?? 0);
      if (!(amount > 0)) return { ok: false, data: null, error: "invalid amount" };
      return { ok: true, data: { charged: amount, chargeId: `ch_${hash(JSON.stringify(input))}` } };
    },
  },

  generate_report: {
    name: "generate_report",
    description: "Generate a report document. Input: { title: string, body: string }. IRREVERSIBLE.",
    effect: "IRREVERSIBLE",
    damageIfWrongUSD: 0.1,
    run(input) {
      const title = String(input.title ?? "untitled");
      return { ok: true, data: { reportId: `rpt_${hash(title)}`, title } };
    },
  },

  save_to_database: {
    name: "save_to_database",
    description: "Persist a record. Input: { table: string, record: object }. IRREVERSIBLE.",
    effect: "IRREVERSIBLE",
    damageIfWrongUSD: 0.3,
    run(input) {
      const table = String(input.table ?? "");
      if (!table) return { ok: false, data: null, error: "no table" };
      return { ok: true, data: { saved: true, table, rowId: `row_${hash(JSON.stringify(input))}` } };
    },
  },
};

export function defaultEffectMap(): Record<string, "IRREVERSIBLE" | "IDEMPOTENT"> {
  const map: Record<string, "IRREVERSIBLE" | "IDEMPOTENT"> = {};
  for (const t of Object.values(TOOLS)) map[t.name] = t.effect;
  return map;
}

export function toolNames(): string[] {
  return Object.keys(TOOLS);
}

export function toolCatalogText(): string {
  return Object.values(TOOLS)
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
