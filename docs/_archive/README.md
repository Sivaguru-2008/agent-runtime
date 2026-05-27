# Archived design notes

These documents represent earlier phases of the platform's design and
are **not authoritative**. Living specs are in [`../specs/`](../specs/);
the architecture overview is in [`../architecture.md`](../architecture.md).

Why they're here, not deleted:
- Sprint notes (`sprint-*.md`) capture historical decisions that may be
  useful when reading old commits.
- Hardening reports (`*-hardening.md`, `runtime-correctness-report.md`,
  `reliability-phase-v3.md`) document constraints discovered during
  earlier audits; the conclusions are folded into the canonical specs.
- `distributed-topology.md` describes a worker/API split that V1 does
  not need; it returns in V2 when scale demands.
- `multi-tenant-security-hardening.md` is V2 work; single-tenant API
  key is V1's auth model.
- `chaos-*` reports are vanity certification artifacts pre-PMF; the
  test files themselves remain in `apps/api/test/chaos/` as property
  tests for the new invariants.
- `productization_blueprint.md` is a UX wishlist for V2+; the V1 UI is
  one timeline page per execution. Motion design, popovers, and the
  "SLO governance" panels are deferred.
- `task.md` is a working scratchpad and has no canonical status.

If you reference one of these from new code or specs, you are probably
doing the wrong thing — read the canonical doc instead.
