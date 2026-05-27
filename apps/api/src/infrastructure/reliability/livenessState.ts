/**
 * D5 — Process-level liveness state.
 *
 * Three terminal states the orchestrator (Kubernetes, Nomad, systemd) needs
 * to be able to distinguish:
 *
 *   healthy              — event loop responsive, mandatory dependencies up.
 *   degraded             — process alive, but at least one optional
 *                          subsystem is misbehaving. Soft signal: the pod
 *                          should NOT be restarted; alerting + circuit
 *                          breakers handle the user impact.
 *   strict-prod-failure  — a STRICT_PROD precondition (Postgres reachable,
 *                          Redis reachable, migrations applied, no
 *                          in-memory fallback) was violated. Boot fails
 *                          immediately; the orchestrator must back off and
 *                          must NOT restart-loop the pod into the same
 *                          broken downstream.
 *
 * Why a module-level singleton:
 *   The state must be readable from the /live HTTP handler AND writable
 *   from connectivity probes that run *before* RuntimeContainer exists.
 *   Threading a dependency through every callsite would force the
 *   pre-boot probes to know about the still-unbuilt container, so a
 *   tiny global is the lesser evil here. It is initialized at the most
 *   permissive value ("healthy" = optimistic) and tightened by the boot
 *   sequence as it runs.
 */

export type LivenessState = "healthy" | "degraded" | "strict-prod-failure";

let state: LivenessState = "healthy";
let reason: string | undefined;
let strictMode = false;

export function setLivenessState(next: LivenessState, why?: string): void {
  state = next;
  if (why) reason = why;
}

export function setLivenessReason(why: string): void {
  reason = why;
}

export function getLivenessState(): { state: LivenessState; reason?: string; strict: boolean } {
  return { state, reason, strict: strictMode };
}

export function setStrictMode(on: boolean): void {
  strictMode = on;
}

/**
 * Reset to defaults — test-only.
 */
export function __resetLivenessForTests(): void {
  state = "healthy";
  reason = undefined;
  strictMode = false;
}
