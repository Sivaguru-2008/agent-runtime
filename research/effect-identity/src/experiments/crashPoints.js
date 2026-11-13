/**
 * Where a replaying process can die, as an ordered partition of one dispatch
 * into structurally distinct failure regions. Shared by the crash worker (which
 * kills itself at one of them) and the parent (which aggregates by them);
 * separate from both so that importing the list does not import a script whose
 * top level reads a trial file and runs.
 *
 *   before_fence         — dies before calling the fence at all.
 *   after_L0             — the canonical lookup missed (a paraphrase hashes
 *                          differently); nothing else has run.
 *   after_witness        — candidates filtered by declared-field projection.
 *   after_judge          — the judge has scored; no decision applied yet. The
 *                          judge call has been paid for and thrown away.
 *   before_external_effect
 *                        — a PENDING intent is durable; nothing has fired.
 *   during_external_commit_window
 *                        — the provider applied the effect and the caller never
 *                          received the response. Locally indistinguishable
 *                          from a call that never landed.
 *   after_external_effect_before_local_commit
 *                        — the call returned; the commit row has not landed.
 *                          Theorem T1's irreducible window.
 *   after_local_commit   — effect and commit row are both durable. This is the
 *                          point content addressing is supposed to handle and
 *                          cannot, because the retry paraphrases.
 */
export const CRASH_POINTS = [
  "before_fence",
  "after_L0",
  "after_witness",
  "after_judge",
  "before_external_effect",
  "during_external_commit_window",
  "after_external_effect_before_local_commit",
  "after_local_commit",
];

/**
 * The points at which the external effect has already happened but nothing
 * durable records it. No local mechanism prevents a re-fire here; the provider's
 * idempotency contract is what closes it (T5). Kept as a named set so the
 * headline can never quietly average over them.
 */
export const COMMIT_WINDOW_POINTS = new Set([
  "during_external_commit_window",
  "after_external_effect_before_local_commit",
]);
