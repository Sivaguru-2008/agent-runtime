/**
 * portGuard — Pre-flight port availability check.
 *
 * Detects whether the configured port is already in use BEFORE app.listen()
 * is called. When a conflict is found, resolves the owning PID using
 * OS-specific commands so the operator gets an actionable error message
 * rather than a raw EADDRINUSE stack trace.
 *
 * Cross-platform support:
 *   - Windows:  `netstat -ano`
 *   - macOS:    `lsof -i :<port> -sTCP:LISTEN`
 *   - Linux:    `ss -tlnp`
 */

import { createServer } from "node:net";
import { execSync } from "node:child_process";
import { platform } from "node:os";

export interface PortAvailable {
  available: true;
}

export interface PortOccupied {
  available: false;
  pid: number | null;
  processName: string | null;
  message: string;
}

export type PortCheckResult = PortAvailable | PortOccupied;

/**
 * Attempt to resolve the PID that currently owns the given port.
 * Returns `null` when the OS command fails or the output cannot be parsed
 * (non-fatal — we still know the port is occupied, just not by whom).
 */
export function getPortOwnerPid(port: number): { pid: number | null; processName: string | null } {
  const os = platform();

  try {
    if (os === "win32") {
      // `netstat -ano` output on Windows:
      //   TCP    0.0.0.0:4000           0.0.0.0:0              LISTENING       12345
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true
      }).trim();
      const lines = output.split(/\r?\n/);
      for (const line of lines) {
        // Match lines where the local address port is exactly our target
        const match = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (match && parseInt(match[1]!, 10) === port) {
          const pid = parseInt(match[2]!, 10);
          // Try to resolve the process name via tasklist
          let processName: string | null = null;
          try {
            const taskOutput = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
              encoding: "utf8",
              timeout: 3_000,
              windowsHide: true
            }).trim();
            const nameMatch = taskOutput.match(/^"([^"]+)"/);
            if (nameMatch) processName = nameMatch[1]!;
          } catch {
            // Non-fatal
          }
          return { pid, processName };
        }
      }
    } else if (os === "darwin") {
      // macOS: `lsof -i :<port> -sTCP:LISTEN -P -n`
      const output = execSync(`lsof -i :${port} -sTCP:LISTEN -P -n 2>/dev/null`, {
        encoding: "utf8",
        timeout: 5_000
      }).trim();
      const lines = output.split(/\r?\n/).slice(1); // skip header
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          return { pid: parseInt(parts[1]!, 10), processName: parts[0] ?? null };
        }
      }
    } else {
      // Linux: `ss -tlnp`
      const output = execSync(`ss -tlnp sport = :${port} 2>/dev/null`, {
        encoding: "utf8",
        timeout: 5_000
      }).trim();
      const lines = output.split(/\r?\n/).slice(1); // skip header
      for (const line of lines) {
        const pidMatch = line.match(/pid=(\d+)/);
        const nameMatch = line.match(/users:\(\("([^"]+)"/);
        if (pidMatch) {
          return {
            pid: parseInt(pidMatch[1]!, 10),
            processName: nameMatch ? nameMatch[1]! : null
          };
        }
      }
    }
  } catch {
    // Command failed — non-fatal. We still know the port is occupied.
  }

  return { pid: null, processName: null };
}

/**
 * Check whether `port` is available for binding. Returns a structured
 * result — callers should inspect `.available` and act accordingly.
 *
 * Implementation: creates a throwaway `net.Server`, tries to listen on
 * the port, and immediately closes it. If `EADDRINUSE` fires, the port
 * is occupied and we attempt PID resolution.
 */
export function checkPortAvailability(port: number, host = "0.0.0.0"): Promise<PortCheckResult> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const { pid, processName } = getPortOwnerPid(port);
        const pidLabel = pid !== null ? `PID ${pid}` : "an unknown process";
        const nameLabel = processName ? ` (${processName})` : "";
        resolve({
          available: false,
          pid,
          processName,
          message: `Port ${port} already in use by ${pidLabel}${nameLabel}`
        });
      } else {
        // Some other error (permission denied, etc.) — treat as unavailable
        resolve({
          available: false,
          pid: null,
          processName: null,
          message: `Port ${port} cannot be bound: ${err.message}`
        });
      }
    });

    server.listen(port, host, () => {
      // Port is free — close the probe server and report available
      server.close(() => {
        resolve({ available: true });
      });
    });
  });
}
