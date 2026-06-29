import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockListContainers = vi.fn();
const mockInspect = vi.fn();
const mockStats = vi.fn();
const mockGetEvents = vi.fn();
const mockLogs = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      listContainers: mockListContainers,
      getContainer: vi.fn().mockReturnValue({
        inspect: mockInspect,
        stats: mockStats,
        logs: mockLogs,
      }),
      getEvents: mockGetEvents,
    })),
  };
});

import { registerMonitoringTools } from "../src/tools/monitoring.js";

// Minimal MCP server mock (same pattern as container.test.ts)
function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (name: string, description: string, _schema: unknown, _hints: unknown, handler: Function) => {
      tools[name] = { description, handler };
    },
    tools,
  };
}

// Helper: mock container list
function mockContainers(ids: string[], names: string[]) {
  mockListContainers.mockResolvedValue(
    ids.map((id, i) => ({
      Id: id,
      Names: [names[i] || `/container-${i}`],
      Image: "nginx:latest",
      State: "running",
      Status: "Up 1 hour",
    }))
  );
}

// Helper: mock inspect result
function mockInspectResult(overrides: Record<string, any> = {}) {
  return {
    Id: "abc123",
    State: {
      Running: true,
      StartedAt: "2026-06-15T10:00:00Z",
      Health: { Status: "healthy" },
    },
    RestartCount: 0,
    Name: "/test-container",
    ...overrides,
  };
}

// Helper: mock stats result
function mockStatsResult(overrides: Record<string, any> = {}) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 1000000 },
      system_cpu_usage: 10000000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 900000 },
      system_cpu_usage: 9500000,
    },
    memory_stats: {
      usage: 100 * 1024 * 1024, // 100MB
      limit: 1024 * 1024 * 1024, // 1GB
    },
    networks: {
      eth0: { rx_bytes: 1024 * 1024, tx_bytes: 512 * 1024 },
    },
    ...overrides,
  };
}

describe("Monitoring Tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.restoreAllMocks();
    server = createMockServer();
    // Create a fresh docker-like object with direct mock references
    const docker = {
      listContainers: mockListContainers,
      getContainer: (id: string) => ({
        inspect: mockInspect,
        stats: mockStats,
        logs: mockLogs,
      }),
      getEvents: mockGetEvents,
    } as any;
    registerMonitoringTools(server, docker);
  });

  describe("container_health_status", () => {
    it("returns health status for all running containers", async () => {
      mockContainers(["abc123", "def456"], ["web", "db"]);
      mockInspect
        .mockResolvedValueOnce(mockInspectResult({ RestartCount: 2 }))
        .mockResolvedValueOnce(mockInspectResult({ RestartCount: 0, State: { Running: true, StartedAt: "2026-06-15T11:00:00Z", Health: { Status: "unhealthy" } } }));

      const result = await server.tools["container_health_status"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("web");
      expect(data[0].id).toBe("abc123");
      expect(data[0].health).toBe("healthy");
      expect(data[0].restartCount).toBe(2);
      expect(data[1].health).toBe("unhealthy");
    });

    it("handles containers with no healthcheck", async () => {
      mockContainers(["abc123"], ["no-health"]);
      mockInspect.mockResolvedValue(mockInspectResult({
        State: { Running: true, StartedAt: "2026-06-15T10:00:00Z" },
      }));

      const result = await server.tools["container_health_status"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data[0].health).toBe("no-healthcheck");
    });

    it("returns error on Docker failure", async () => {
      mockListContainers.mockRejectedValue(new Error("Docker daemon not running"));
      const result = await server.tools["container_health_status"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Docker daemon not running");
    });
  });

  describe("container_resource_usage", () => {
    it("returns resource usage sorted by CPU by default", async () => {
      mockContainers(["abc123", "def456"], ["low-cpu", "high-cpu"]);
      mockStats
        .mockResolvedValueOnce(mockStatsResult({
          cpu_stats: { cpu_usage: { total_usage: 100000 }, system_cpu_usage: 10000000, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 90000 }, system_cpu_usage: 9500000 },
        }))
        .mockResolvedValueOnce(mockStatsResult({
          cpu_stats: { cpu_usage: { total_usage: 500000 }, system_cpu_usage: 10000000, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 100000 }, system_cpu_usage: 9500000 },
        }));

      const result = await server.tools["container_resource_usage"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(2);
      // high-cpu should be first (sorted by CPU desc)
      expect(data[0].name).toBe("high-cpu");
      expect(data[0].cpu_percent).toBeGreaterThan(data[1].cpu_percent);
      expect(data[0].memory_usage_mb).toBeGreaterThan(0);
      expect(data[0].network_rx_mb).toBeGreaterThanOrEqual(0);
    });

    it("sorts by memory when requested", async () => {
      mockContainers(["abc123", "def456"], ["low-mem", "high-mem"]);
      mockStats
        .mockResolvedValueOnce(mockStatsResult({
          memory_stats: { usage: 50 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
        }))
        .mockResolvedValueOnce(mockStatsResult({
          memory_stats: { usage: 900 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
        }));

      const result = await server.tools["container_resource_usage"].handler({ sort_by: "memory" });
      const data = JSON.parse(result.content[0].text);

      expect(data[0].name).toBe("high-mem");
      expect(data[0].memory_percent).toBeGreaterThan(data[1].memory_percent);
    });

    it("returns error on Docker failure", async () => {
      mockListContainers.mockRejectedValue(new Error("Cannot connect"));
      const result = await server.tools["container_resource_usage"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Cannot connect");
    });
  });

  describe("watch_events", () => {
    it("collects events within time window", async () => {
      const { Readable } = await import("stream");
      const event1 = JSON.stringify({ Type: "container", Action: "start", Actor: { Attributes: { name: "web" }, ID: "abc123" }, time: Math.floor(Date.now() / 1000) });
      const event2 = JSON.stringify({ Type: "container", Action: "stop", Actor: { Attributes: { name: "web" }, ID: "abc123" }, time: Math.floor(Date.now() / 1000) });

      const stream = new Readable({
        read() {
          this.push(event1 + "\n");
          this.push(event2 + "\n");
          this.push(null); // end stream
        },
      });
      mockGetEvents.mockResolvedValue(stream);

      const result = await server.tools["watch_events"].handler({ duration: 5 });
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(2);
      expect(data[0].type).toBe("container");
      expect(data[0].action).toBe("start");
      expect(data[0].container).toBe("web");
    });

    it("returns message when no events captured", async () => {
      const { Readable } = await import("stream");
      const stream = new Readable({ read() { this.push(null); } });
      mockGetEvents.mockResolvedValue(stream);

      const result = await server.tools["watch_events"].handler({ duration: 1 });
      expect(result.content[0].text).toBe("No events captured in the time window.");
    });

    it("returns error on Docker failure", async () => {
      mockGetEvents.mockRejectedValue(new Error("Docker socket not found"));
      const result = await server.tools["watch_events"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Docker socket not found");
    });
  });

  describe("search_logs", () => {
    it("searches logs with regex pattern", async () => {
      mockContainers(["abc123"], ["web"]);
      mockInspect.mockResolvedValue(mockInspectResult());
      // Docker logs return Buffer with 8-byte header per line
      const logLines = Buffer.from("2026-06-15 ERROR connection refused\n2026-06-15 INFO server started\n2026-06-15 ERROR timeout\n");
      mockLogs.mockResolvedValue(logLines);

      const result = await server.tools["search_logs"].handler({ pattern: "ERROR" });
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(2);
      expect(data[0].container).toBe("web");
      expect(data[0].line).toContain("ERROR");
    });

    it("searches across multiple containers when no specific containers given", async () => {
      mockContainers(["abc123", "def456"], ["web", "db"]);
      mockInspect
        .mockResolvedValueOnce(mockInspectResult())
        .mockResolvedValueOnce(mockInspectResult());
      mockLogs
        .mockResolvedValueOnce(Buffer.from("2026-06-15 ERROR web error\n"))
        .mockResolvedValueOnce(Buffer.from("2026-06-15 INFO db ready\n"));

      const result = await server.tools["search_logs"].handler({ pattern: "ERROR" });
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(1);
      expect(data[0].container).toBe("web");
    });

    it("returns no matches message when pattern not found", async () => {
      mockContainers(["abc123"], ["web"]);
      mockInspect.mockResolvedValue(mockInspectResult());
      mockLogs.mockResolvedValue(Buffer.from("2026-06-15 INFO all good\n"));

      const result = await server.tools["search_logs"].handler({ pattern: "CRITICAL" });
      expect(result.content[0].text).toBe("No matches found.");
    });

    it("supports case-insensitive matching", async () => {
      mockContainers(["abc123"], ["web"]);
      mockInspect.mockResolvedValue(mockInspectResult());
      mockLogs.mockResolvedValue(Buffer.from("2026-06-15 Error lowercase\n"));

      const result = await server.tools["search_logs"].handler({ pattern: "error", ignore_case: true });
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(1);
    });

    it("returns error on Docker failure", async () => {
      mockListContainers.mockRejectedValue(new Error("Cannot connect"));
      const result = await server.tools["search_logs"].handler({ pattern: "ERROR" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Cannot connect");
    });
  });

  describe("resource_alert_check", () => {
    it("returns violations when containers exceed thresholds", async () => {
      mockContainers(["abc123"], ["high-cpu"]);
      mockInspect.mockResolvedValue(mockInspectResult({ RestartCount: 10 }));
      mockStats.mockResolvedValue(mockStatsResult({
        cpu_stats: { cpu_usage: { total_usage: 9000000 }, system_cpu_usage: 10000000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 1000000 }, system_cpu_usage: 9500000 },
      }));

      const result = await server.tools["resource_alert_check"].handler({ cpu_percent: 80, restart_count: 5 });
      const data = JSON.parse(result.content[0].text);

      expect(data.violations).toHaveLength(1);
      expect(data.violations[0].container).toBe("high-cpu");
      expect(data.violations[0].issues.length).toBeGreaterThan(0);
      expect(data.violations[0].issues.some((i: string) => i.includes("restarts"))).toBe(true);
      expect(data.violations[0].issues.some((i: string) => i.includes("cpu"))).toBe(true);
    });

    it("returns all-clear when within thresholds", async () => {
      mockContainers(["abc123"], ["healthy"]);
      mockInspect.mockResolvedValue(mockInspectResult({ RestartCount: 0 }));
      mockStats.mockResolvedValue(mockStatsResult({
        cpu_stats: { cpu_usage: { total_usage: 100000 }, system_cpu_usage: 10000000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 90000 }, system_cpu_usage: 9500000 },
      }));

      const result = await server.tools["resource_alert_check"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.message).toContain("All containers within thresholds");
      expect(data.checked).toBe(1);
    });

    it("uses default thresholds when not specified", async () => {
      mockContainers(["abc123"], ["ok"]);
      mockInspect.mockResolvedValue(mockInspectResult({ RestartCount: 4 })); // < 5 default
      mockStats.mockResolvedValue(mockStatsResult({
        cpu_stats: { cpu_usage: { total_usage: 100000 }, system_cpu_usage: 10000000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 90000 }, system_cpu_usage: 9500000 },
      }));

      const result = await server.tools["resource_alert_check"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.message).toContain("All containers within thresholds");
    });

    it("returns error on Docker failure", async () => {
      mockListContainers.mockRejectedValue(new Error("Daemon down"));
      const result = await server.tools["resource_alert_check"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Daemon down");
    });
  });

  describe("monitor_dashboard", () => {
    it("returns comprehensive fleet summary", async () => {
      mockContainers(["abc123", "def456"], ["web", "db"]);
      mockInspect
        .mockResolvedValueOnce(mockInspectResult({ RestartCount: 0 }))
        .mockResolvedValueOnce(mockInspectResult({ RestartCount: 3, State: { Running: true, StartedAt: "2026-06-15T10:00:00Z", Health: { Status: "unhealthy" } } }));
      mockStats
        .mockResolvedValueOnce(mockStatsResult({
          cpu_stats: { cpu_usage: { total_usage: 200000 }, system_cpu_usage: 10000000, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 100000 }, system_cpu_usage: 9500000 },
        }))
        .mockResolvedValueOnce(mockStatsResult({
          cpu_stats: { cpu_usage: { total_usage: 5000000 }, system_cpu_usage: 10000000, online_cpus: 2 },
          precpu_stats: { cpu_usage: { total_usage: 1000000 }, system_cpu_usage: 9500000 },
        }));

      // Mock events (empty stream)
      const { Readable } = await import("stream");
      const eventStream = new Readable({ read() { this.push(null); } });
      mockGetEvents.mockResolvedValue(eventStream);

      const result = await server.tools["monitor_dashboard"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.summary.total_containers).toBe(2);
      expect(data.summary.running).toBe(2);
      expect(data.summary.unhealthy).toBe(1);
      expect(data.health).toHaveLength(2);
      expect(data.top_cpu_consumers).toHaveLength(2);
      // db should be first (higher CPU)
      expect(data.top_cpu_consumers[0].name).toBe("db");
    });

    it("handles empty fleet", async () => {
      mockListContainers.mockResolvedValue([]);
      const { Readable } = await import("stream");
      const eventStream = new Readable({ read() { this.push(null); } });
      mockGetEvents.mockResolvedValue(eventStream);

      const result = await server.tools["monitor_dashboard"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.summary.total_containers).toBe(0);
      expect(data.summary.running).toBe(0);
      expect(data.health).toHaveLength(0);
    });

    it("returns error on Docker failure", async () => {
      mockListContainers.mockRejectedValue(new Error("Connection refused"));
      const result = await server.tools["monitor_dashboard"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection refused");
    });
  });
});