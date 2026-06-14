/**
 * A deterministic, rule-based LLMClient for offline runs (CI, tests, and when
 * Groq is unreachable). It is NOT a mock of the pipeline — the tools, analyzers,
 * fence, and database are all real. Only the "model" is deterministic, so the
 * same prompt always produces the same genuine token stream and the same
 * genuine tool results (including real empty results that trip silent-failure
 * detection).
 *
 * It plays a deliberately naive agent for the risky prompts: when a tool comes
 * back empty it still asserts a confident answer — exactly the behaviour the
 * runtime is built to catch.
 */
import type { ChatRequest, JsonResult, LLMClient, StreamResult } from "./client.js";
import { extractJson, tokenize } from "./client.js";

type Action = Record<string, unknown>;
type Planner = (lastValue: number | string | null, lastEmpty: boolean) => Action;

export class MockAgentClient implements LLMClient {
  readonly model = "mock-agent";
  readonly live = false;

  async streamChat(req: ChatRequest, onToken?: (token: string, index: number) => void): Promise<StreamResult> {
    const text = this.respond(req);
    const allTokens = tokenize(text);
    const emitted: string[] = [];
    for (let i = 0; i < allTokens.length; i++) {
      if (req.signal?.aborted) break;
      emitted.push(allTokens[i]!);
      onToken?.(allTokens[i]!, i);
    }
    const joined = emitted.join("");
    return { text: joined, tokens: emitted, inputTokens: Math.ceil((req.system ?? "").length / 4) + 1, outputTokens: Math.ceil(joined.length / 4) + 1 };
  }

  async jsonChat<T = unknown>(req: ChatRequest): Promise<JsonResult<T>> {
    const out = await this.streamChat(req);
    return { raw: out.text, json: extractJson<T>(out.text), inputTokens: out.inputTokens, outputTokens: out.outputTokens };
  }

  private respond(req: ChatRequest): string {
    const sys = req.system ?? "";
    // Stage 0/1/8 calls: return {} and let the heuristic backstops fill in.
    if (/pre-flight risk analyzer|extract the user's intent|ruthless quality evaluator/i.test(sys)) {
      return "{}";
    }
    // Agent loop.
    return JSON.stringify(this.nextAction(req.prompt));
  }

  private nextAction(transcript: string): Action {
    const task = (transcript.match(/Task:\s*(.*)/)?.[1] ?? transcript).toLowerCase();
    const observations = transcript.match(/Observation \(step \d+\):/g)?.length ?? 0;
    const { value, empty } = lastObservation(transcript);

    const plan = planFor(task);
    if (observations < plan.length) {
      return plan[observations]!(value, empty);
    }
    // Past the plan: answer with whatever we have.
    return { thought: "I have enough to answer.", action: "final", final_answer: value !== null ? `Result: ${value}` : "Done." };
  }
}

function planFor(task: string): Planner[] {
  // Clean, groundable facts.
  if (task.includes("capital of france")) {
    return [
      () => ({ thought: "Look up the capital.", expect: "the capital city", action: "search_web", input: { query: "capital France" } }),
      () => ({ thought: "Found it.", action: "final", final_answer: "The capital of France is Paris." }),
    ];
  }
  if (task.includes("boiling point")) {
    return [
      () => ({ thought: "Look up boiling point.", expect: "boiling temperature", action: "search_web", input: { query: "boiling water" } }),
      () => ({ thought: "Confirmed.", action: "final", final_answer: "Water boils at 100°C at sea level." }),
    ];
  }
  // Multi-step compute: population then 12%.
  if (task.includes("population of tokyo")) {
    return [
      () => ({ thought: "Find Tokyo population.", expect: "the population number", action: "search_web", input: { query: "population Tokyo" } }),
      (v) => ({ thought: "Now compute 12%.", expect: "12% of the population", action: "calculate", input: { expression: `${toNum(v) ?? 37000000} * 0.12` } }),
      (v) => ({ thought: "Done.", action: "final", final_answer: `12% of Greater Tokyo's population is about ${toNum(v) ?? "4.44 million"}.` }),
    ];
  }
  // Simple arithmetic then an irreversible save.
  if (task.includes("1850 multiplied by 3") || task.includes("multiplied by 3")) {
    return [
      () => ({ thought: "Compute it.", expect: "the product", action: "calculate", input: { expression: "1850 * 3" } }),
      (v) => ({ thought: "Persist the result.", expect: "a saved row", action: "save_to_database", input: { table: "reports", record: { result: toNum(v) ?? 5550 } } }),
      (v) => ({ thought: "Saved.", action: "final", final_answer: `1850 × 3 = 5550, saved to reports (${v ?? "ok"}).` }),
    ];
  }
  // Lookup then irreversible email.
  if (task.includes("email a summary") || (task.includes("acme") && task.includes("email"))) {
    return [
      () => ({ thought: "Get ACME revenue.", expect: "revenue figure", action: "search_web", input: { query: "revenue ACME" } }),
      (v) => ({ thought: "Email the summary.", expect: "sent confirmation", action: "send_email", input: { to: "cfo@acme.com", subject: "ACME revenue", body: `Revenue: ${v ?? "see attached"}` } }),
      () => ({ thought: "Sent.", action: "final", final_answer: "Summary emailed to cfo@acme.com." }),
    ];
  }
  // Lookup then irreversible charge.
  if (task.includes("refund policy") && task.includes("charge")) {
    return [
      () => ({ thought: "Check refund policy.", expect: "the policy window", action: "search_web", input: { query: "refund policy" } }),
      () => ({ thought: "Apply the fee.", expect: "charge confirmation", action: "charge_card", input: { customer: "cust_42", amountUsd: 5 } }),
      () => ({ thought: "Charged.", action: "final", final_answer: "Applied a $5 restocking fee to cust_42." }),
    ];
  }
  // Real-time stock: tool errors, naive agent fabricates a confident number.
  if (task.includes("stock price")) {
    return [
      () => ({ thought: "Fetch the price.", expect: "the live TSLA price", action: "get_stock_price", input: { ticker: "TSLA" } }),
      () => ({ thought: "I'm confident the price is exactly right.", action: "final", final_answer: "The current TSLA price is exactly $248.50." }),
    ];
  }
  // Real-time BTC then irreversible charge on bad data -> fence hold expected.
  if (task.includes("btc") && task.includes("charge")) {
    return [
      () => ({ thought: "Fetch BTC price.", expect: "the live BTC price", action: "get_stock_price", input: { ticker: "BTC" } }),
      () => ({ thought: "Charge that amount.", expect: "charge confirmation", action: "charge_card", input: { customer: "cust_7", amountUsd: 65000 } }),
      () => ({ thought: "Charged.", action: "final", final_answer: "Charged cust_7 $65000." }),
    ];
  }
  // Over-specific lookup -> empty -> confident fabrication.
  if (task.includes("antarctic division") || task.includes("quarterly revenue")) {
    return [
      () => ({ thought: "Find the figure.", expect: "exact quarterly revenue", action: "search_web", input: { query: "ACME Antarctic division Q3 1998 revenue exact figure" } }),
      () => ({ thought: "I definitely found it.", action: "final", final_answer: "ACME's Antarctic division earned exactly $2.3 million in Q3 1998." }),
    ];
  }
  if (task.includes("kepler-442b") || task.includes("moons")) {
    return [
      () => ({ thought: "Look up the moons.", expect: "moon count", action: "search_web", input: { query: "Kepler-442b moons exact count" } }),
      () => ({ thought: "Certainly two.", action: "final", final_answer: "Kepler-442b certainly has exactly 2 moons." }),
    ];
  }
  // Generic default: one search, then answer.
  return [
    () => ({ thought: "Search for relevant info.", expect: "useful results", action: "search_web", input: { query: task.split(/\s+/).slice(0, 4).join(" ") } }),
    (v) => ({ thought: "Answer.", action: "final", final_answer: v !== null ? `Based on what I found: ${v}` : "I could not find reliable information." }),
  ];
}

function lastObservation(transcript: string): { value: number | string | null; empty: boolean } {
  const matches = [...transcript.matchAll(/Observation \(step \d+\):\s*(.*)/g)];
  const last = matches.at(-1)?.[1];
  if (!last) return { value: null, empty: true };
  try {
    const parsed = extractJson<{ ok?: boolean; data?: unknown }>(last);
    const data = parsed.data;
    if (data === null || data === undefined) return { value: null, empty: true };
    if (Array.isArray(data)) {
      if (data.length === 0) return { value: null, empty: true };
      const first = data[0] as Record<string, unknown>;
      return { value: (first.value as number) ?? (first.snippet as string) ?? null, empty: false };
    }
    if (typeof data === "object") {
      const o = data as Record<string, unknown>;
      const v = (o.value ?? o.result ?? o.reportId ?? o.chargeId ?? o.rowId ?? null) as number | string | null;
      return { value: v, empty: false };
    }
    return { value: data as number | string, empty: false };
  } catch {
    return { value: null, empty: true };
  }
}

function toNum(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
