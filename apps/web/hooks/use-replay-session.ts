"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cognitionApi, type ReplaySession } from "@/lib/cognition-api";

export interface UseReplaySessionResult {
  session: ReplaySession | undefined;
  isLoading: boolean;
  error: string | undefined;
  seek: (frameIndex: number) => Promise<void>;
  play: (speed: number) => Promise<void>;
  pause: () => Promise<void>;
  step: (delta: number) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Drives the replay timeline scrubber. Auto-advances when `speed > 0`,
 * polls the server only on user-initiated actions.
 */
export function useReplaySession(sessionId: string | undefined): UseReplaySessionResult {
  const [session, setSession] = useState<ReplaySession | undefined>();
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(sessionId));
  const [error, setError] = useState<string | undefined>();
  const tickRef = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      setIsLoading(true);
      const view = await cognitionApi.getReplaySession(sessionId);
      setSession(view.session);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!session || session.cursor.speed <= 0 || session.status !== "PLAYING") {
      if (tickRef.current) window.clearInterval(tickRef.current);
      return;
    }
    const intervalMs = Math.max(80, 600 / session.cursor.speed);
    tickRef.current = window.setInterval(() => {
      setSession((prev) => {
        if (!prev) return prev;
        const nextIndex = Math.min(prev.cursor.frameIndex + 1, prev.frames.length - 1);
        if (nextIndex === prev.cursor.frameIndex) {
          if (tickRef.current) window.clearInterval(tickRef.current);
          return { ...prev, status: "ENDED" };
        }
        return {
          ...prev,
          cursor: { ...prev.cursor, frameIndex: nextIndex, eventSequence: prev.frames[nextIndex]?.eventSequence ?? 0 }
        };
      });
    }, intervalMs);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [session?.cursor.speed, session?.status]);

  const seek = useCallback(
    async (frameIndex: number) => {
      if (!sessionId) return;
      // Optimistic update.
      setSession((prev) => (prev ? { ...prev, cursor: { ...prev.cursor, frameIndex }, status: "PAUSED" } : prev));
      try {
        const updated = await cognitionApi.seekReplay(sessionId, frameIndex);
        setSession(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId]
  );

  const play = useCallback(
    async (speed: number) => {
      if (!sessionId) return;
      setSession((prev) => (prev ? { ...prev, cursor: { ...prev.cursor, speed }, status: speed === 0 ? "PAUSED" : "PLAYING" } : prev));
      try {
        const updated = await cognitionApi.playReplay(sessionId, speed);
        setSession(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId]
  );

  const pause = useCallback(() => play(0), [play]);

  const step = useCallback(
    async (delta: number) => {
      if (!session) return;
      const next = Math.max(0, Math.min(session.frames.length - 1, session.cursor.frameIndex + delta));
      await seek(next);
    },
    [session, seek]
  );

  return { session, isLoading, error, seek, play, pause, step, refresh };
}
