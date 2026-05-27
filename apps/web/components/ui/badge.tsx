import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "border-primary/35 bg-primary/12 text-primary",
  muted: "border-border bg-muted text-muted-foreground",
  warning: "border-warning/35 bg-warning/12 text-warning",
  critical: "border-critical/35 bg-critical/12 text-critical",
  success: "border-emerald-400/35 bg-emerald-400/12 text-emerald-300"
};

export function Badge({
  className,
  variant = "default",
  children
}: {
  className?: string;
  variant?: keyof typeof variants;
  children: ReactNode;
}) {
  return (
    <span className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium", variants[variant], className)}>
      {children}
    </span>
  );
}
