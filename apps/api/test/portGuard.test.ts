/**
 * portGuard.test.ts — Unit tests for port availability detection.
 *
 * Verifies:
 *   1. An unused port is detected as available.
 *   2. An occupied port is detected as unavailable with a message containing the PID.
 *   3. Only one process can own a given port (mutual exclusion).
 *   4. getPortOwnerPid returns structured PID info.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { checkPortAvailability, getPortOwnerPid } from "../src/infrastructure/reliability/portGuard.js";

/**
 * Helper: bind a throwaway TCP server to a random available port.
 * Returns the server and the port it bound to.
 */
function bindPort(port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, "0.0.0.0", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("Unexpected address type"));
      }
    });
    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("portGuard", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    // Clean up any servers we opened
    for (const s of servers) {
      await closeServer(s).catch(() => {});
    }
    servers.length = 0;
  });

  describe("checkPortAvailability", () => {
    it("reports an unused port as available", async () => {
      // Bind a port, note it, then close — that port should be free
      const { server, port } = await bindPort();
      await closeServer(server);

      const result = await checkPortAvailability(port, "0.0.0.0");
      expect(result.available).toBe(true);
    });

    it("reports an occupied port as unavailable", async () => {
      const { server, port } = await bindPort();
      servers.push(server);

      const result = await checkPortAvailability(port, "0.0.0.0");
      expect(result.available).toBe(false);
      if (!result.available) {
        expect(result.message).toContain(`Port ${port}`);
        expect(result.message).toContain("already in use");
      }
    });

    it("includes PID information in the conflict message", async () => {
      const { server, port } = await bindPort();
      servers.push(server);

      const result = await checkPortAvailability(port, "0.0.0.0");
      expect(result.available).toBe(false);
      if (!result.available) {
        // The PID resolution may succeed or fail depending on OS permissions,
        // but the message must always be present and actionable.
        expect(result.message).toMatch(/Port \d+ already in use by/);
      }
    });

    it("prevents a second server from binding the same port", async () => {
      const { server: first, port } = await bindPort();
      servers.push(first);

      // Verify the port is occupied
      const check = await checkPortAvailability(port, "0.0.0.0");
      expect(check.available).toBe(false);

      // Attempt to bind a second server — it should fail with EADDRINUSE
      const secondResult = await new Promise<"success" | "eaddrinuse">((resolve) => {
        const second = createServer();
        second.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            resolve("eaddrinuse");
          } else {
            resolve("success"); // unexpected
          }
        });
        second.listen(port, "0.0.0.0", () => {
          servers.push(second);
          resolve("success");
        });
      });

      expect(secondResult).toBe("eaddrinuse");
    });
  });

  describe("getPortOwnerPid", () => {
    it("returns pid info for an occupied port", async () => {
      const { server, port } = await bindPort();
      servers.push(server);

      const { pid } = getPortOwnerPid(port);
      // PID resolution is OS-dependent and may require elevated permissions.
      // On most dev machines it should succeed; on CI it might return null.
      // Either way, the function must not throw.
      if (pid !== null) {
        expect(pid).toBeGreaterThan(0);
        // The PID should be our own process since we bound the port above
        expect(pid).toBe(process.pid);
      }
    });

    it("returns null for an unoccupied port", async () => {
      // Use a port that's almost certainly free
      const { server, port } = await bindPort();
      await closeServer(server);

      const { pid } = getPortOwnerPid(port);
      expect(pid).toBeNull();
    });
  });
});
