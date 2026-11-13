/**
 * Effect classification. The developer declares which tools are IRREVERSIBLE
 * (must fire at most once — Stripe charges, emails, writes) versus IDEMPOTENT
 * (safe to re-run on every retry — reads, pure lookups).
 */
export type EffectType = "IRREVERSIBLE" | "IDEMPOTENT";

export type EffectMap = Record<string, EffectType>;

export class EffectRegistry {
  constructor(
    private readonly map: EffectMap,
    private readonly defaultEffect: EffectType = "IDEMPOTENT"
  ) {}

  /** Effect type for a tool, falling back to the configured default. */
  classify(toolName: string): EffectType {
    return this.map[toolName] ?? this.defaultEffect;
  }

  isIrreversible(toolName: string): boolean {
    return this.classify(toolName) === "IRREVERSIBLE";
  }

  /** Whether the tool was explicitly declared (vs. resolved via default). */
  has(toolName: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.map, toolName);
  }
}
