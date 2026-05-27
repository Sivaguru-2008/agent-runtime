/**
 * PHASE 6 — Operator Platform Page
 *
 * Full-screen operator platform at /operator. Hosts the Replay Experience as
 * the primary product surface plus the Phase 4 operational tabs.
 *
 * All UI is client-side because it polls live data from the API.
 */

import type { Metadata } from "next";
import { OperatorPlatform } from "../../components/operator/operator-platform";

export const metadata: Metadata = {
  title: "Replay Experience — Operator Platform",
  description:
    "Phase 6: Replayable, inspectable, debuggable AI execution infrastructure — execution timeline, cognition node explorer, root-cause analysis, operator controls, and deterministic replay verification."
};

export default function OperatorPage() {
  return <OperatorPlatform />;
}
