"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { eventStreamUrl } from "@/lib/api";
import type { TokenChunk } from "@/lib/cognition-api";

interface StreamFrame {
  cognitionId: string;
  nodeId: string;
  chunk: TokenChunk;
  receivedAt: number;
}

export interface TokenStreamOverlayProps {
  cognitionId?: string;
}

/**
 * Live token streaming overlay. Subscribes to the SSE event stream and
 * filters COGNITION_NODE_STREAMING events for the focused cognition.
 *
 * Tokens arrive in order and are color-coded by confidence.
 */
export function TokenStreamOverlay({ cognitionId }: TokenStreamOverlayProps) {
  const [frames, setFrames] = useState<StreamFrame[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Clear any frames from the previous cognition so a stale render does
    // not show another cognition's tokens before the new stream opens.
    setFrames([]);

    // Cancellation token: when the effect cleans up we flip `cancelled` so
    // any in-flight handler queued on the event loop refuses to mutate
    // state for the prior cognition. This is the "websocket leakage" guard.
    let cancelled = false;
    const url = eventStreamUrl();
    const source = new EventSource(url);
    const handler = (event: MessageEvent) => {
      if (cancelled) return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type !== "COGNITION_NODE_STREAMING") return;
        if (cognitionId && parsed.payload?.cognitionId !== cognitionId) return;
        setFrames((prev) => {
          const next = [
            ...prev,
            {
              cognitionId: parsed.payload.cognitionId,
              nodeId: parsed.payload.nodeId,
              chunk: parsed.payload.chunk,
              receivedAt: Date.now()
            }
          ];
          return next.slice(-300);
        });
      } catch {
        // ignore parse errors
      }
    };
    source.addEventListener("COGNITION_NODE_STREAMING", handler as EventListener);
    return () => {
      cancelled = true;
      source.removeEventListener("COGNITION_NODE_STREAMING", handler as EventListener);
      try { source.close(); } catch { /* noop */ }
    };
  }, [cognitionId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [frames.length]);

  return (
    <Card className="p-4 bg-zinc-950/60 border-zinc-800 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-200">Token Stream</div>
          <div className="text-xs text-zinc-500">
            {cognitionId ? cognitionId.slice(0, 12) + "…" : "all live cognitions"}
          </div>
        </div>
        <Badge variant="muted">{frames.length} tokens</Badge>
      </div>
      <div ref={scrollRef} className="max-h-44 overflow-y-auto rounded bg-zinc-900/40 border border-zinc-800 p-2">
        <div className="flex flex-wrap gap-[2px] text-[11px] font-mono leading-snug">
          {frames.map((f) => {
            const c = f.chunk.confidence;
            const bg =
              c > 0.85 ? "rgba(16,185,129,0.25)" :
              c > 0.6  ? "rgba(245,158,11,0.25)" :
              "rgba(244,63,94,0.4)";
            return (
              <span
                key={`${f.nodeId}-${f.chunk.sequence}`}
                style={{ background: bg, color: "#e4e4e7" }}
                className="px-1 rounded"
                title={`node ${f.nodeId.slice(0, 6)} #${f.chunk.sequence} conf=${c.toFixed(2)}`}
              >
                {f.chunk.text}
              </span>
            );
          })}
          {frames.length === 0 && <span className="text-zinc-600">waiting for stream…</span>}
        </div>
      </div>
    </Card>
  );
}
