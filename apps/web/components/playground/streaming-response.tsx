"use client";

import { useEffect, useRef } from "react";
import { Brain } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LiveExecutionView } from "@/stores/execution-store";
import { ExecutionStatusBadge } from "./execution-status-badge";

export function StreamingResponse({ view }: { view?: LiveExecutionView }) {
  const scrollRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [view?.output]);

  const isStreaming = view?.state === "STREAMING" || view?.state === "RUNNING";

  return (
    <Card className="h-[420px]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          Streaming Response
        </CardTitle>
        {view ? <ExecutionStatusBadge state={view.state} /> : null}
      </CardHeader>
      <CardContent className="h-[360px] p-0">
        {view ? (
          <pre
            ref={scrollRef}
            className="h-full overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground"
          >
            {view.output || (isStreaming ? "Waiting for tokens..." : "")}
            {isStreaming ? <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-primary align-middle" /> : null}
            {view.state === "FAILED" && view.error ? (
              <span className="mt-2 block text-critical">
                {view.error.code}: {view.error.message}
              </span>
            ) : null}
          </pre>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Submit a prompt to see the model stream tokens here.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
