import * as nodeFs from "node:fs";

/**
 * The blind labelling session (PREREG_EXP2.md §A3.2).
 *
 * A session knows exactly two paths: the labelling file (opaque id + the two
 * tool calls, nothing else) and the append-only labels file. It is never given
 * the key file's path and has no code path that could open it; the CLI also
 * runs it under Node's permission model, which denies reads of any other file.
 *
 * Labels are final. There is no API that addresses an item other than the
 * current one, a submitted label is appended and never rewritten, and a labels
 * file containing an id twice, an unknown id, or a malformed line is rejected
 * on load rather than repaired.
 *
 * `fs` is injectable so a test can record every path the session touches.
 */

export const LABELS = Object.freeze(["SAME", "DIFF"]);
const ITEM_KEYS = ["A", "B", "id"];

export class LabellingSession {
  constructor({ itemsPath, labelsPath, fs = nodeFs }) {
    if (!itemsPath || !labelsPath) throw new Error("itemsPath and labelsPath are required");
    this.fs = fs;
    this.labelsPath = labelsPath;
    this.items = fs.readFileSync(itemsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ids = new Set();
    for (const it of this.items) {
      const keys = Object.keys(it).sort();
      if (keys.join(",") !== ITEM_KEYS.join(",")) {
        throw new Error(`labelling item carries fields beyond id/A/B (${keys.join(",")}); refusing to show it`);
      }
      if (ids.has(it.id)) throw new Error(`duplicate item id ${it.id}`);
      ids.add(it.id);
    }
    this.done = new Set();
    if (fs.existsSync(labelsPath)) {
      for (const line of fs.readFileSync(labelsPath, "utf8").split("\n").filter(Boolean)) {
        const rec = JSON.parse(line);
        if (!ids.has(rec.id)) throw new Error(`labels file names unknown item ${rec.id}`);
        if (this.done.has(rec.id)) throw new Error(`labels file labels ${rec.id} twice; labels cannot be revised`);
        if (!LABELS.includes(rec.label)) throw new Error(`labels file has invalid label ${JSON.stringify(rec.label)}`);
        this.done.add(rec.id);
      }
    }
    // Items are shown in file order, which the preparation step fixed by a
    // seeded shuffle; resuming continues from the first unlabelled item.
    this.cursor = this.items.findIndex((it) => !this.done.has(it.id));
    if (this.cursor === -1) this.cursor = this.items.length;
  }

  get total() { return this.items.length; }
  get labelled() { return this.done.size; }

  /** The item to label now, or null when every item is labelled. */
  current() {
    if (this.cursor >= this.items.length) return null;
    const { id, A, B } = this.items[this.cursor];
    return { id, A, B, position: this.cursor + 1, total: this.items.length };
  }

  /** Label the current item and move on. The label is final. */
  submit(label) {
    if (!LABELS.includes(label)) throw new Error(`label must be one of ${LABELS.join("/")}`);
    const item = this.current();
    if (!item) throw new Error("every item is already labelled");
    this.fs.appendFileSync(this.labelsPath, JSON.stringify({ id: item.id, label, at: new Date().toISOString() }) + "\n", { flag: "a" });
    this.done.add(item.id);
    this.cursor += 1;
    while (this.cursor < this.items.length && this.done.has(this.items[this.cursor].id)) this.cursor += 1;
    return item.id;
  }
}
