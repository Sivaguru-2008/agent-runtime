/**
 * Extracts a structured JSON object from raw LLM text.
 *
 * Strategy (tried in order):
 *  1. Direct JSON.parse of the whole trimmed text.
 *  2. JSON inside a ```json … ``` or ``` … ``` code fence.
 *  3. First `{ … }` block matched with a greedy regex.
 *  4. Fallback: wrap the raw text in { result, raw:true }.
 *
 * Replay implications: the same text always produces the same parsed object
 * because the strategy is deterministic and order-preserving.
 */
export function extractStructuredOutput(
  text: string,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  const trimmed = text.trim();

  // 1. Direct parse.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return parsed;
  } catch {
    /* ignore */
  }

  // 2. Code fence.
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim()) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      /* ignore */
    }
  }

  // 3. First balanced `{ … }` block.
  const braceStart = trimmed.indexOf("{");
  if (braceStart !== -1) {
    const candidate = extractBalancedBraces(trimmed, braceStart);
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isPlainObject(parsed)) return parsed;
      } catch {
        /* ignore */
      }
    }
  }

  // 4. Fallback.
  return { ...fallback, result: text, raw: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extracts the substring from `start` that forms a balanced JSON object. */
function extractBalancedBraces(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
