"use client";

/**
 * ExecutionMetadataPanel — single, reusable identity + failure surface for a
 * run/execution. Renders only the IDs that are actually known (every field is
 * optional) and gives each a one-click copy button so an operator can paste a
 * correlated id straight into Diagnose / Trace / logs.
 *
 * IDs surfaced (in correlation order):
 *   Run ID        — the top-level run (parent execution) when distinct.
 *   Execution ID  — the execution backing this view.
 *   Trace ID      — OpenTelemetry/event-stream trace correlation id.
 *   Cognition ID  — the cognition graph driving the run, when present.
 *   Runtime ID    — the API runtime instance that served/failed the request
 *                   (from the `x-runtime-id` response header).
 *
 * When a `failure` is supplied the panel renders the originating reason
 * (message + code + recoverability) instead of leaving the run as an opaque
 * FAILED badge elsewhere in the UI.
 */

import { useCallback, useState } from "react";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ExecutionMetadataPanelProps {
  runId?: string;
  executionId?: string;
  traceId?: string;
  cognitionId?: string;
  runtimeId?: string;
  failure?: { message: string; code?: string; recoverable?: boolean };
  /** Optional status badge text (e.g. the execution status). */
  status?: string;
  /** Cognition execution mode — "MODEL-BACKED" (real LLM) vs "DETERMINISTIC". */
  mode?: string;
  title?: string;
  className?: string;
}

interface Row {
  label: string;
  value?: string;
  accent?: boolean;
}

export function ExecutionMetadataPanel({
  runId,
  executionId,
  traceId,
  cognitionId,
  runtimeId,
  failure,
  status,
  mode,
  title = "Execution Metadata",
  className,
}: ExecutionMetadataPanelProps) {
  const rows: Row[] = [
    { label: "Run ID", value: runId },
    { label: "Execution ID", value: executionId, accent: true },
    { label: "Trace ID", value: traceId },
    { label: "Cognition ID", value: cognitionId },
    { label: "Runtime ID", value: runtimeId },
  ].filter((r) => !!r.value);

  if (rows.length === 0 && !failure) return null;

  return (
    <div
      className={cn(
        "rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">
          {title}
        </div>
        <div className="flex items-center gap-1.5">
          {mode && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border font-mono",
                /MODEL/i.test(mode)
                  ? "border-violet-700 bg-violet-950/40 text-violet-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              )}
              title={/MODEL/i.test(mode)
                ? "Cognition ran through a real model provider"
                : "Cognition ran deterministic heuristics (no model provider)"}
            >
              {mode}
            </span>
          )}
          {status && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border font-mono",
                status === "FAILED"
                  ? "border-rose-700 bg-rose-950/40 text-rose-300"
                  : status === "COMPLETED"
                  ? "border-emerald-700 bg-emerald-950/30 text-emerald-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              )}
            >
              {status}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {rows.map((row) => (
          <MetadataRow key={row.label} label={row.label} value={row.value!} accent={row.accent} />
        ))}
      </div>

      {failure && (
        <div className="rounded border border-rose-800/50 bg-rose-950/20 p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-rose-400 font-medium">
            <AlertTriangle className="h-3 w-3" />
            Failure reason
            {failure.code && (
              <span className="ml-1 font-mono text-rose-300/80 normal-case">{failure.code}</span>
            )}
            <span className="ml-auto text-rose-300/60 normal-case">
              {failure.recoverable === false ? "non-recoverable" : "recoverable"}
            </span>
          </div>
          <div className="text-xs text-rose-200 break-words select-text">{failure.message}</div>
        </div>
      )}
    </div>
  );
}

function MetadataRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-zinc-500 w-24 shrink-0">{label}</span>
      <span
        className={cn(
          "font-mono text-xs truncate select-all flex-1",
          accent ? "text-zinc-100" : "text-zinc-300"
        )}
        title={value}
      >
        {value}
      </span>
      <CopyButton text={value} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — noop */
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={onCopy}
      title={`Copy ${text}`}
      className="p-1 text-zinc-500 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded transition-colors active:scale-95 flex items-center justify-center h-6 w-6 shrink-0"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}
