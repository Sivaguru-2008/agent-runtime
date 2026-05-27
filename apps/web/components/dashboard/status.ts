import type { ExecutionStatus, RuntimeStatus } from "@/types/observability";

export type BadgeTone = "default" | "muted" | "warning" | "critical" | "success";

export function statusVariant(status?: RuntimeStatus | ExecutionStatus | string): BadgeTone {
  if (!status) return "muted";
  if (["ERROR", "FAILED", "critical"].includes(status)) return "critical";
  if (["DEGRADED", "RUNNING", "BUSY", "QUEUED", "warning"].includes(status)) return "warning";
  if (["READY", "COMPLETED", "IDLE"].includes(status)) return "success";
  return "muted";
}
