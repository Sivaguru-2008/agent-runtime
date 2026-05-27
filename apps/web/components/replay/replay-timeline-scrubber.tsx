"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatTime } from "@/lib/utils";
import type { ReplayFrame, ReplaySession } from "@/lib/cognition-api";

const TONE_COLOR: Record<ReplayFrame["preview"]["tone"], string> = {
  info: "bg-sky-500/70",
  success: "bg-emerald-500/70",
  warning: "bg-amber-500/70",
  error: "bg-rose-500/80",
  neutral: "bg-zinc-500/60"
};

export interface ReplayTimelineScrubberProps {
  session: ReplaySession | undefined;
  onSeek: (frameIndex: number) => void;
  onPlay: (speed: number) => void;
  onPause: () => void;
  onStep: (delta: number) => void;
  onSnapshot?: (frameIndex: number) => void;
  onBranch?: (frameIndex: number) => void;
}

/**
 * Replay Timeline Scrubber — Chrome DevTools style horizontal track with
 * per-frame markers, current cursor, and transport controls.
 */
export function ReplayTimelineScrubber({
  session,
  onSeek,
  onPlay,
  onPause,
  onStep,
  onSnapshot,
  onBranch
}: ReplayTimelineScrubberProps) {
  const frames = session?.frames ?? [];
  const cursor = session?.cursor.frameIndex ?? 0;
  const total = frames.length;
  const playing = session?.status === "PLAYING";
  const focused = frames[cursor];

  const markers = useMemo(() => {
    if (total === 0) return [];
    const out: Array<{ index: number; left: string; tone: ReplayFrame["preview"]["tone"]; kind: ReplayFrame["kind"] }> = [];
    for (const frame of frames) {
      out.push({
        index: frame.index,
        left: `${(frame.index / Math.max(1, total - 1)) * 100}%`,
        tone: frame.preview.tone,
        kind: frame.kind
      });
    }
    return out;
  }, [frames, total]);

  return (
    <Card className="p-4 space-y-3 bg-zinc-950/60 border-zinc-800">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Badge variant="muted" className="text-xs">
            {session ? session.status : "no session"}
          </Badge>
          <span className="text-xs text-zinc-400">
            frame {cursor + 1} / {total || 0}
          </span>
          {focused && (
            <span className="text-xs text-zinc-500 truncate max-w-[36ch]">
              {focused.eventType}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => onStep(-1)} disabled={!session || cursor === 0}>◀ step</Button>
          {playing ? (
            <Button size="sm" variant="secondary" onClick={onPause}>⏸ pause</Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => onPlay(1)} disabled={!session}>▶ play</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onPlay(2)} disabled={!session}>2×</Button>
          <Button size="sm" variant="ghost" onClick={() => onPlay(4)} disabled={!session}>4×</Button>
          <Button size="sm" variant="ghost" onClick={() => onStep(1)} disabled={!session || cursor >= total - 1}>step ▶</Button>
          {onSnapshot && (
            <Button size="sm" variant="secondary" onClick={() => onSnapshot(cursor)} disabled={!session}>📸 snapshot</Button>
          )}
          {onBranch && focused && (
            <Button size="sm" variant="secondary" onClick={() => onBranch(cursor)} disabled={!session}>⑂ branch</Button>
          )}
        </div>
      </div>

      <div className="relative h-12 rounded bg-zinc-900/80 border border-zinc-800 overflow-hidden">
        {/* Frame markers */}
        {markers.map((m) => (
          <div
            key={m.index}
            className={cn(
              "absolute top-1 bottom-1 w-[2px] cursor-pointer hover:w-[3px] transition-all",
              TONE_COLOR[m.tone],
              m.kind === "SNAPSHOT" && "ring-1 ring-cyan-400",
              m.kind === "BRANCH_POINT" && "ring-1 ring-fuchsia-400"
            )}
            style={{ left: m.left }}
            onClick={() => onSeek(m.index)}
            title={`Frame ${m.index} · ${m.kind}`}
          />
        ))}
        {/* Cursor */}
        {total > 0 && (
          <div
            className="absolute top-0 bottom-0 w-[3px] bg-amber-300 shadow-[0_0_10px_rgba(252,211,77,0.6)]"
            style={{ left: `${(cursor / Math.max(1, total - 1)) * 100}%` }}
          />
        )}
        {/* Click-to-seek track */}
        <input
          type="range"
          min={0}
          max={Math.max(0, total - 1)}
          value={cursor}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          aria-label="Replay scrubber"
        />
      </div>

      {focused && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <KV label="event" value={focused.eventType} />
          <KV label="kind" value={focused.kind} />
          <KV label="time" value={formatTime(focused.timestamp)} />
          <KV label="aggregate" value={focused.preview.aggregateId.slice(0, 12) + "…"} />
          <KV label="label" value={focused.preview.label} />
          <KV label="fingerprint" value={focused.preview.fingerprint ?? "—"} mono />
        </div>
      )}
    </Card>
  );
}

function KV({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded px-2 py-1">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={cn("text-zinc-200 truncate", mono && "font-mono")}>{value}</div>
    </div>
  );
}
