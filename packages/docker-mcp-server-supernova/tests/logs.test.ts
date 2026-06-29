import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockLogs = vi.fn();
const mockStats = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getContainer: vi.fn().mockReturnValue({
        logs: mockLogs,
        stats: mockStats,
      }),
    })),
  };
});

import { registerLogsTools } from "../src/tools/logs.js";
import { createDockerClient } from "../src/docker.js";

// Minimal MCP server mock
function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (name: string, description: string, _schemaOrAnnotations: unknown, _annotationsOrHandler: unknown, _maybeHandler?: Function) => {
      const handler = typeof _annotationsOrHandler === 'function' ? _annotationsOrHandler : (_maybeHandler as Function);
      tools[name] = { description, handler };
    },
    tools,
  };
}

describe("Logs Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: ReturnType<typeof createDockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    docker = createDockerClient();
    registerLogsTools(server as any, docker);
  });

  describe("stream_logs", () => {
    it("should return logs from a container", async () => {
      mockLogs.mockResolvedValue(Buffer.from("2026-01-01T00:00:00Z listening on port 80\n"));

      const result = await server.tools.stream_logs.handler({ container_id: "web", tail: 100 });
      expect(result.content[0].text).toContain("listening on port 80");
    });

    it("should return default message when no logs", async () => {
      mockLogs.mockResolvedValue(Buffer.from(""));

      const result = await server.tools.stream_logs.handler({ container_id: "web" });
      expect(result.content[0].text).toBe("No logs found.");
    });

    it("should pass tail parameter", async () => {
      mockLogs.mockResolvedValue(Buffer.from("log line\n"));

      await server.tools.stream_logs.handler({ container_id: "web", tail: 50 });
      expect(mockLogs).toHaveBeenCalledWith(
        expect.objectContaining({ tail: 50 })
      );
    });

    it("should pass since parameter as unix timestamp", async () => {
      mockLogs.mockResolvedValue(Buffer.from("log line\n"));
      const sinceDate = "2026-06-21T10:00:00Z";

      await server.tools.stream_logs.handler({ container_id: "web", since: sinceDate });
      const callArgs = mockLogs.mock.calls[0][0];
      expect(callArgs.since).toBe(Math.floor(new Date(sinceDate).getTime() / 1000));
    });

    it("should always set follow=false", async () => {
      mockLogs.mockResolvedValue(Buffer.from("log line\n"));

      await server.tools.stream_logs.handler({ container_id: "web" });
      const callArgs = mockLogs.mock.calls[0][0];
      expect(callArgs.follow).toBe(false);
    });

    it("should handle errors gracefully", async () => {
      mockLogs.mockRejectedValue(new Error("No such container"));

      const result = await server.tools.stream_logs.handler({ container_id: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("container_stats", () => {
    it("should return CPU and memory stats", async () => {
      mockStats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 1000000 },
          system_cpu_usage: 10000000,
          online_cpus: 2,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 500000 },
          system_cpu_usage: 9000000,
        },
        memory_stats: {
          usage: 1024 * 1024 * 100, // 100MB
          limit: 1024 * 1024 * 512, // 512MB
        },
        networks: {
          eth0: { rx_bytes: 1024, tx_bytes: 2048 },
        },
        blkio_stats: {
          io_service_bytes: [{ value: 4096 }, { value: 8192 }],
        },
      });

      const result = await server.tools.container_stats.handler({ container_id: "web" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.name).toBe("web");
      expect(parsed.cpu.cores).toBe(2);
      expect(parsed.memory.usage).toBeDefined();
      expect(parsed.memory.limit).toBeDefined();
      expect(parsed.network.eth0.rx).toBeDefined();
      expect(parsed.blockIO.read).toBeDefined();
    });

    it("should calculate CPU percent correctly", async () => {
      mockStats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 2000000 },
          system_cpu_usage: 20000000,
          online_cpus: 1,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1000000 },
          system_cpu_usage: 18000000,
        },
        memory_stats: { usage: 0, limit: 0 },
      });

      const result = await server.tools.container_stats.handler({ container_id: "web" });
      const parsed = JSON.parse(result.content[0].text);
      // cpuDelta=1000000, systemDelta=2000000, cpuCount=1 -> 50%
      expect(parsed.cpu.percent).toBe(50);
    });

    it("should handle zero system delta", async () => {
      mockStats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 1000 },
          system_cpu_usage: 1000,
          online_cpus: 1,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1000 },
          system_cpu_usage: 1000,
        },
        memory_stats: { usage: 0, limit: 0 },
      });

      const result = await server.tools.container_stats.handler({ container_id: "web" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.cpu.percent).toBe(0);
    });

    it("should handle missing network stats", async () => {
      mockStats.mockResolvedValue({
        cpu_stats: {
          cpu_usage: { total_usage: 0 },
          system_cpu_usage: 1000,
          online_cpus: 1,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 0 },
          system_cpu_usage: 1000,
        },
        memory_stats: { usage: 0, limit: 0 },
      });

      const result = await server.tools.container_stats.handler({ container_id: "web" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.network).toEqual({});
    });

    it("should handle errors gracefully", async () => {
      mockStats.mockRejectedValue(new Error("No such container"));

      const result = await server.tools.container_stats.handler({ container_id: "nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });
});
