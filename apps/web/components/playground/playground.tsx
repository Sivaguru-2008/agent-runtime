"use client";

import { useCallback, useEffect, useState } from "react";
import { ServerCrash } from "lucide-react";
import { playgroundApi, GROQ_MODELS } from "@/services/playground-api";
import { useExecutionStream } from "@/stores/execution-store";
import { PromptInputPanel } from "./prompt-input-panel";
import { StreamingResponse } from "./streaming-response";
import { RuntimeMetricsPanel } from "./runtime-metrics-panel";
import { LiveExecutionGraph } from "@/components/graph/live-execution-graph";
import { LiveTimeline } from "@/components/timeline/live-timeline";
import { LiveEventFeed } from "./live-event-feed";

interface PlaygroundProps {
  /** Shared prompt lifted to the dashboard so Run Studio + Run Trace reuse it. */
  prompt?: string;
  onPromptChange?(value: string): void;
}

export function Playground({ prompt: sharedPrompt, onPromptChange }: PlaygroundProps = {}) {
  const stream = useExecutionStream();
  const { current, events, connected, startExecution } = stream;
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<string>(GROQ_MODELS[0]);
  const [groqOnline, setGroqOnline] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      playgroundApi
        .health()
        .then((res) => {
          if (cancelled) return;
          setGroqOnline(res.ok);
          // Sync the selector to the server's active model on first connect,
          // but never override an explicit user selection afterwards.
          setModel((prev) => prev || res.model);
        })
        .catch(() => {
          if (!cancelled) setGroqOnline(false);
        });
    };
    tick();
    const interval = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const onRun = useCallback(async (prompt: string) => {
    setError(undefined);
    setRunning(true);

    // Abort any in-flight prior fetch BEFORE we reset state — otherwise the
    // prior request's catch handler can fire after the new prompt has been
    // submitted and set `error` against the wrong run.
    if (abortController) {
      try { abortController.abort(); } catch { /* noop */ }
    }

    const executionId = crypto.randomUUID();
    // startExecution clears the global feed + seeds a fresh view + bumps
    // the generation token so any late SSE frame from the prior prompt is
    // refused by the reducer.
    startExecution(executionId, prompt, model || "");

    const controller = new AbortController();
    setAbortController(controller);
    try {
      // Fire-and-stream: the SSE channel surfaces tokens; the POST resolves on completion.
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? "/api/runtime"}/agent/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-execution-id": executionId },
          body: JSON.stringify({ prompt, executionId, model }),
          signal: controller.signal
        }
      );
      if (!res.ok && res.status !== 202 && res.status !== 502) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Run failed: ${res.status} ${text}`);
      }
    } catch (runError) {
      if ((runError as Error).name !== "AbortError") {
        setError(runError instanceof Error ? runError.message : "Unable to run prompt");
      }
    } finally {
      setRunning(false);
      setAbortController(null);
    }
  }, [model, startExecution, abortController]);

  const onCancel = useCallback(() => {
    abortController?.abort();
  }, [abortController]);

  // Auto-clear "running" if the live stream reports completion/error first.
  useEffect(() => {
    if (!current) return;
    if (current.state === "COMPLETED" || current.state === "FAILED") {
      setRunning(false);
    }
  }, [current?.state, current?.id]);

  return (
    <div className="space-y-4">
      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-critical/40 bg-critical/10 px-4 py-3 text-sm text-critical">
          <ServerCrash className="h-4 w-4" />
          {error}
        </div>
      ) : null}

      <RuntimeMetricsPanel current={current} connected={connected} />

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <PromptInputPanel
          running={running}
          model={model}
          models={[...GROQ_MODELS]}
          onModelChange={setModel}
          groqOnline={groqOnline}
          onRun={onRun}
          onCancel={onCancel}
          value={sharedPrompt}
          onValueChange={onPromptChange}
        />
        <StreamingResponse view={current} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr_380px]">
        <LiveExecutionGraph view={current} />
        <LiveTimeline view={current} />
        <LiveEventFeed events={events} connected={connected} />
      </div>
    </div>
  );
}
