"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Thin wrapper over Radix Tooltip. Each tooltip is self-contained (carries its
 * own Provider) so it works anywhere, including in SSR-only render tests where
 * there is no app-level provider. Content lives in a portal and is only
 * rendered while open, so server output is just the trigger.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  delayDuration = 150,
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  className?: string;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={12}
            className={cn(
              "z-[100] max-w-xs rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-xs leading-relaxed text-zinc-200 shadow-xl",
              "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95",
              className
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-zinc-700" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
