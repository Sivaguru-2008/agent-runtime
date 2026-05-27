"use client";

import type { LiveExecutionState } from "@/events/live-events";
import { Badge } from "@/components/ui/badge";

const variantFor: Record<LiveExecutionState, "default" | "muted" | "warning" | "critical" | "success"> = {
  PENDING: "muted",
  RUNNING: "warning",
  STREAMING: "default",
  COMPLETED: "success",
  FAILED: "critical"
};

export function ExecutionStatusBadge({ state }: { state: LiveExecutionState }) {
  return <Badge variant={variantFor[state]}>{state}</Badge>;
}
