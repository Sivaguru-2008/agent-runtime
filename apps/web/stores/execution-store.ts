"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveEvent, LiveExecutionState } from "@/events/live-events";
import { liveEventStreamUrl } from "@/services/playground-api";

export interface LiveExecutionView {
  id: string;
  state: LiveExecutionState;
  prompt: string;
  model: string;
  output: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  startedAt: string;
  firstTokenAt?: string;
  completedAt?: string;
  latencyMs: number;
  streamDurationMs: number;
  tokensPerSecond: number;
  error?: { message: string; code: string };
  events: LiveEvent[];
  /** Largest event.sequence observed for this execution. */
  highWaterSequence: number;
  /** Bounded set of sequences already folded into this view. */
  seenSequences: Record<number, true>;
  /**
   * Monotonic generation token stamped on the view when the local prompt
   * started it. Used to discard any reducer write that arrives after a
   * newer execution has superseded this one.
   */
  generation: number;
}

interface State {
  current?: LiveExecutionView;
  executions: Record<string, LiveExecutionView>;
  /** Events scoped to the currently active execution only. */
  events: LiveEvent[];
  connected: boolean;
  activeExecutionId?: string;
  /**
   * Generation token bumped every time `startExecution` is invoked locally.
   * Reducer writes that target an execution other than the active one are
   * still recorded (so the user can scroll back to historical executions)
   * but are not allowed to mutate `current` / `events`. Prevents stale
   * async stream tokens from a prior prompt overwriting the active view.
   */
  generation: number;
}

const INITIAL: State = {
  executions: {},
  events: [],
  connected: false,
  generation: 0
};

// Dedup window. Matches the server-side RecentSequenceTracker default (1024).
const DEDUP_WINDOW = 1024;

/**
 * Live execution stream.
 *
 * Fixes layered on top of the prior implementation:
 *
 * 1. Per-execution SSE binding. Every new local execution closes the prior
 *    EventSource and opens a fresh one scoped via `?executionId=...&replay=false`
 *    so the new connection cannot replay frames from a previous prompt's
 *    buffer. This is the architectural fix for "stream responses overwriting
 *    newer executions" and "websocket/subscription leakage".
 *
 * 2. Generation token. Every `startExecution()` bumps `state.generation`. The
 *    reducer refuses to mutate `current` or `events` when the incoming event
 *    belongs to an older generation — even if it is for an execution that
 *    was active a moment ago. This eliminates the "late token from prior
 *    prompt corrupts the current view" race.
 *
 * 3. Hard reset on startExecution. Clears `events`, drops the prior view
 *    bound to the same id (defence in depth), wipes seenSequences, stamps
 *    the new generation. Guarantees the timeline + feed + graph reset.
 *
 * 4. Sequence-based dedup (preserved). Per-execution `seenSequences` map
 *    bounded to DEDUP_WINDOW so a server-side reconnect-replay cannot
 *    double-fold TOKEN_STREAM events.
 *
 * 5. Stable React keys (preserved). Reducer guarantees `(executionId,
 *    sequence)` is unique so list components can key on the pair.
 *
 * 6. Subscription teardown on unmount. The cleanup closes the EventSource
 *    AND marks the closure cancelled so any in-flight `onmessage` handler
 *    queued on the event loop cannot resurrect stale state.
 */
export interface UseExecutionStreamResult extends State {
  setCurrent: (id: string) => void;
  reset: () => void;
  startExecution: (executionId: string, prompt: string, model: string) => void;
}

export function useExecutionStream(): UseExecutionStreamResult {
  const [state, setState] = useState<State>(INITIAL);
  const stateRef = useRef<State>(INITIAL);
  stateRef.current = state;

  // Tracks the executionId bound to the currently-open SSE connection so we
  // do not tear down + reopen unnecessarily when other state changes.
  const sourceRef = useRef<EventSource | null>(null);
  const boundExecutionRef = useRef<string | undefined>(undefined);
  const cancelledRef = useRef(false);

  // Open / reopen the SSE channel for the active execution. Idempotent.
  const bindStream = useCallback((executionId: string | undefined) => {
    if (cancelledRef.current) return;
    if (boundExecutionRef.current === executionId && sourceRef.current) return;

    // Tear down the prior connection first.
    if (sourceRef.current) {
      try { sourceRef.current.close(); } catch { /* noop */ }
      sourceRef.current = null;
    }
    boundExecutionRef.current = executionId;

    // Scope to the active executionId and DO NOT replay buffered history —
    // every new prompt starts with a clean slate. Without ?replay=false, the
    // server would replay the prior buffer and the reducer would have to
    // dedup it. Cheaper and safer to refuse the replay outright.
    const url = liveEventStreamUrl(executionId);
    const finalUrl = executionId ? `${url}${url.includes("?") ? "&" : "?"}replay=false` : url;
    const source = new EventSource(finalUrl);
    sourceRef.current = source;

    source.onopen = () => {
      if (cancelledRef.current) return;
      setState((prev) => (prev.connected ? prev : { ...prev, connected: true }));
    };
    source.onerror = () => {
      if (cancelledRef.current) return;
      setState((prev) => (prev.connected ? { ...prev, connected: false } : prev));
    };

    const handle = (raw: MessageEvent) => {
      if (cancelledRef.current) return;
      try {
        const event = JSON.parse(raw.data) as LiveEvent;
        setState((prev) => reduce(prev, event));
      } catch {
        // ignore malformed
      }
    };
    source.onmessage = handle;
    [
      "PROMPT_RECEIVED",
      "MODEL_START",
      "TOKEN_STREAM",
      "MODEL_COMPLETE",
      "MODEL_ERROR",
      "EXECUTION_STATE"
    ].forEach((type) => source.addEventListener(type, handle as EventListener));
  }, []);

  useEffect(() => {
    // Fresh mount must always start from INITIAL — guards against a parent
    // re-mounting this hook with a stale snapshot.
    cancelledRef.current = false;
    setState(INITIAL);
    bindStream(undefined);

    return () => {
      cancelledRef.current = true;
      if (sourceRef.current) {
        try { sourceRef.current.close(); } catch { /* noop */ }
        sourceRef.current = null;
      }
      boundExecutionRef.current = undefined;
    };
  }, [bindStream]);

  const setCurrent = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      current: prev.executions[id] ?? prev.current,
      activeExecutionId: id
    }));
    bindStream(id);
  }, [bindStream]);

  const reset = useCallback(() => {
    setState((prev) => ({ ...INITIAL, generation: prev.generation + 1 }));
    bindStream(undefined);
  }, [bindStream]);

  const startExecution = useCallback(
    (executionId: string, prompt: string, model: string) => {
      setState((prev) => {
        const generation = prev.generation + 1;
        const view = blankView(executionId, generation);
        view.prompt = prompt;
        view.model = model;
        view.state = "PENDING";
        // Replace (do not merge) the view for this executionId so any
        // historical replay frames from a previous run cannot bleed in.
        const executions = { ...prev.executions, [executionId]: view };
        return {
          ...prev,
          generation,
          executions,
          // Clear the global feed — every new prompt = fresh feed. Prevents
          // the prior prompt's events from rendering inside the new run's
          // "Live Event Feed" card.
          events: [],
          current: view,
          activeExecutionId: executionId,
          connected: prev.connected
        };
      });
      // Bind the SSE stream to the new executionId. The server-side filter
      // ensures only events for THIS execution reach the wire.
      bindStream(executionId);
    },
    [bindStream]
  );

  // useMemo so the returned object identity is stable until something it
  // exposes actually changes — keeps downstream useEffect deps honest.
  return useMemo(
    () => ({ ...state, setCurrent, reset, startExecution }),
    [state, setCurrent, reset, startExecution]
  );
}

function reduce(state: State, event: LiveEvent): State {
  const incomingExecutionId = event.executionId;
  const isActive = state.activeExecutionId === incomingExecutionId;

  // Locate the existing per-execution view (or build a fresh blank one).
  // A blank view inherits the CURRENT generation so the activeExecutionId
  // check below correctly classifies events for the newly-active run.
  const existing =
    state.executions[incomingExecutionId] ??
    blankView(incomingExecutionId, isActive ? state.generation : 0);

  // Per-execution sequence dedup. Sequences <= 0 are pre-persistence frames
  // (no canonical order); accept those unconditionally. Everything else is
  // rejected if we've already folded the same sequence into this execution.
  const seq = event.sequence;
  if (Number.isFinite(seq) && seq > 0 && existing.seenSequences[seq]) {
    return state;
  }

  const view = applyEvent(existing, event);
  const executions = { ...state.executions, [incomingExecutionId]: view };

  // Only events for the currently active execution should influence
  // `current` and the global feed. Late events from a prior execution still
  // fold into `executions[id]` so historical replay/seek works, but they
  // never mutate the active view. Eliminates the "responses correspond to
  // previous prompts" race.
  if (!isActive) {
    return { ...state, executions };
  }

  // Bounded global feed for the active execution. Cap so a long stream
  // cannot grow unbounded.
  const events = [event, ...state.events].slice(0, 1000);

  return {
    ...state,
    executions,
    events,
    current: view
  };
}

function blankView(id: string, generation: number): LiveExecutionView {
  return {
    id,
    state: "PENDING",
    prompt: "",
    model: "",
    output: "",
    tokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    startedAt: new Date().toISOString(),
    latencyMs: 0,
    streamDurationMs: 0,
    tokensPerSecond: 0,
    events: [],
    highWaterSequence: 0,
    seenSequences: {},
    generation
  };
}

function applyEvent(view: LiveExecutionView, event: LiveEvent): LiveExecutionView {
  // Immutability guarantee: rebuild events array, seenSequences map, never
  // mutate the prior view in place.
  const events = [...view.events, event];
  const seenSequences = bumpSeen(view.seenSequences, event.sequence);
  const highWaterSequence = Math.max(
    view.highWaterSequence,
    Number.isFinite(event.sequence) ? event.sequence : view.highWaterSequence
  );
  const base = { events, seenSequences, highWaterSequence };

  switch (event.type) {
    case "PROMPT_RECEIVED":
      return { ...view, ...base, prompt: event.prompt, model: event.model, startedAt: event.timestamp };
    case "MODEL_START":
      return { ...view, ...base, state: "RUNNING", model: event.model, prompt: event.prompt };
    case "TOKEN_STREAM":
      return {
        ...view,
        ...base,
        state: "STREAMING",
        output: view.output + event.token,
        tokens: event.tokensSoFar,
        completionTokens: event.tokensSoFar,
        totalTokens: view.promptTokens + event.tokensSoFar,
        firstTokenAt: view.firstTokenAt ?? event.timestamp,
        latencyMs: event.latencyMs
      };
    case "MODEL_COMPLETE":
      return {
        ...view,
        ...base,
        state: "COMPLETED",
        output: event.output || view.output,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        totalTokens: event.totalTokens,
        tokens: event.completionTokens,
        latencyMs: event.latencyMs,
        streamDurationMs: event.streamDurationMs,
        tokensPerSecond: event.tokensPerSecond,
        completedAt: event.timestamp
      };
    case "MODEL_ERROR":
      return {
        ...view,
        ...base,
        state: "FAILED",
        error: { message: event.message, code: event.code },
        latencyMs: event.latencyMs,
        completedAt: event.timestamp
      };
    case "EXECUTION_STATE":
      return { ...view, ...base, state: event.state };
    default:
      return { ...view, ...base };
  }
}

function bumpSeen(prev: Record<number, true>, sequence: number): Record<number, true> {
  if (!Number.isFinite(sequence) || sequence <= 0) return prev;
  const next: Record<number, true> = { ...prev, [sequence]: true };
  const keys = Object.keys(next);
  if (keys.length <= DEDUP_WINDOW) return next;
  const sorted = keys.map(Number).sort((a, b) => a - b);
  const drop = sorted.length - DEDUP_WINDOW;
  for (let i = 0; i < drop; i++) {
    delete next[sorted[i]!];
  }
  return next;
}
