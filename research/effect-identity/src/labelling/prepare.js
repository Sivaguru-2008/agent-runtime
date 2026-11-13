/**
 * Split a generated corpus into the blind labelling file and the key
 * (PREREG_EXP2.md §A3.2). Run by the generation pipeline, never by the
 * labelling tool.
 *
 *   items: { id, A, B }  — an opaque id and the two tool calls, in a seeded
 *                          random order, each pair in random A/B order
 *   key:   { id, pairId, swapped } — maps the opaque id back to the corpus
 *
 * Opaque ids are positions in the shuffled order ("L0001", ...), so they carry
 * nothing about the pair's label, stratum, split, or seed act.
 */

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {{id: string, tool: string, a: object, b: object}[]} pairs */
export function prepareBlind(pairs, { seed }) {
  if (!Number.isInteger(seed)) throw new Error("an integer seed is required");
  const rand = mulberry32(seed);
  const order = pairs.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const items = [], key = [];
  order.forEach((idx, pos) => {
    const p = pairs[idx];
    const id = `L${String(pos + 1).padStart(4, "0")}`;
    const swapped = rand() < 0.5;
    const first = { tool: p.tool, args: p.a }, second = { tool: p.tool, args: p.b };
    items.push({ id, A: swapped ? second : first, B: swapped ? first : second });
    key.push({ id, pairId: p.id, swapped });
  });
  return { items, key };
}
