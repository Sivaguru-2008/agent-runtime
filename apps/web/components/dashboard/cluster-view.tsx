"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Cpu, GitBranch, HeartPulse, Server, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import type { ClusterSnapshot, RuntimeWorker, WorkerStatus } from "@/types/observability";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BadgeTone } from "./status";

const POLL_MS = 4000;

function workerTone(status: WorkerStatus): BadgeTone {
  switch (status) {
    case "READY":
      return "success";
    case "BUSY":
      return "warning";
    case "DRAINING":
      return "muted";
    case "LOST":
    case "STOPPED":
      return "critical";
    default:
      return "muted";
  }
}

function fmtAge(ms: number): string {
  if (ms < 1500) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function ClusterView() {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await api.clusterSnapshot();
      setSnapshot(next);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Cluster fetch failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const drain = useCallback(async (workerId: string) => {
    setBusy(true);
    try {
      await api.drainWorker(workerId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Drain failed");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const recover = useCallback(async () => {
    setBusy(true);
    try {
      await api.recoverCluster();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Recover failed");
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const overview = snapshot?.overview;
  const workers = snapshot?.workers ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <SummaryCard
          icon={<Server className="h-4 w-4 text-primary" />}
          label="Workers"
          value={overview?.workers.total ?? 0}
          detail={
            overview
              ? `${overview.workers.ready} ready • ${overview.workers.busy} busy • ${overview.workers.lost} lost`
              : ""
          }
        />
        <SummaryCard
          icon={<HeartPulse className="h-4 w-4 text-primary" />}
          label="Heartbeat age"
          value={overview ? fmtAge(overview.meanHeartbeatAgeMs) : "—"}
          detail={overview ? "mean across live workers" : ""}
        />
        <SummaryCard
          icon={<Workflow className="h-4 w-4 text-primary" />}
          label="Active leases"
          value={overview?.leases.active ?? 0}
          detail={`queue depth ${overview?.throughput.queueDepth ?? 0}`}
        />
        <SummaryCard
          icon={<Activity className="h-4 w-4 text-primary" />}
          label="Throughput"
          value={`${(overview?.throughput.eventsPerSecond ?? 0).toFixed(1)} ev/s`}
          detail={`${overview?.throughput.runningExecutions ?? 0} running`}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader>
            <CardTitle>Runtime Workers</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="muted">{workers.length} nodes</Badge>
              <Button size="sm" variant="secondary" onClick={recover} disabled={busy}>
                Reclaim expired leases
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {workers.length ? workers.map((worker) => (
              <WorkerRow key={worker.id} worker={worker} onDrain={drain} busy={busy} />
            )) : (
              <div className="py-12 text-center text-sm text-muted-foreground">No workers registered</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Execution Ownership</CardTitle>
            <Badge variant="muted">{snapshot?.executionsByWorker.length ?? 0} active</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {snapshot?.executionsByWorker.length ? snapshot.executionsByWorker.map((bucket) => (
              <div key={bucket.workerId} className="rounded-md border border-border bg-background p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 truncate text-xs font-semibold">
                    <GitBranch className="h-3 w-3 text-primary" />
                    <span className="truncate">{bucket.workerId}</span>
                  </div>
                  <Badge variant="muted">{bucket.executionIds.length}</Badge>
                </div>
                <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                  {bucket.executionIds.slice(0, 6).map((executionId) => (
                    <li key={executionId} className="truncate">{executionId}</li>
                  ))}
                  {bucket.executionIds.length > 6 ? <li>+{bucket.executionIds.length - 6} more</li> : null}
                </ul>
              </div>
            )) : (
              <div className="py-12 text-center text-sm text-muted-foreground">No active leases</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  detail
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
          {detail ? <div className="text-[11px] text-muted-foreground">{detail}</div> : null}
        </div>
        <div className="rounded-md border border-primary/30 bg-primary/10 p-2">{icon}</div>
      </CardContent>
    </Card>
  );
}

function WorkerRow({
  worker,
  onDrain,
  busy
}: {
  worker: RuntimeWorker;
  onDrain(workerId: string): void;
  busy: boolean;
}) {
  const age = Date.now() - new Date(worker.lastHeartbeatAt).getTime();
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Cpu className="h-4 w-4 text-primary" />
            <span className="truncate">{worker.id}</span>
            <Badge variant={workerTone(worker.status)}>{worker.status}</Badge>
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {worker.host} • v{worker.version} • cap {worker.capacity}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={age > 10_000 ? "critical" : "muted"}>{fmtAge(age)} ago</Badge>
          <Button size="sm" variant="secondary" disabled={busy || worker.status === "DRAINING"} onClick={() => onDrain(worker.id)}>
            Drain
          </Button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-2 text-[11px]">
        <LoadBar label="CPU" value={worker.load.cpu} max={100} />
        <LoadBar label="Mem" value={worker.load.memory} max={100} />
        <LoadBar label="In-flight" value={worker.load.inFlight} max={worker.capacity} />
        <LoadBar label="Queue" value={worker.load.queueDepth} max={Math.max(worker.capacity, 4)} />
        <LoadBar label="ev/s" value={worker.load.eventsPerSecond} max={Math.max(worker.load.eventsPerSecond, 50)} />
      </div>
    </div>
  );
}

function LoadBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.min(100, max ? (value / max) * 100 : 0);
  const tone = pct > 85 ? "bg-critical" : pct > 60 ? "bg-warning" : "bg-primary";
  return (
    <div>
      <div className="flex items-center justify-between font-mono text-muted-foreground">
        <span>{label}</span>
        <span>{value.toFixed(0)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-sm bg-muted">
        <div className={cn("h-1 rounded-sm", tone)} style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
    </div>
  );
}
