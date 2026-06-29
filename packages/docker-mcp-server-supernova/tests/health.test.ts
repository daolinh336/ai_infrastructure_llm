import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockInspect = vi.fn();
const mockExec = vi.fn();
const mockUpdate = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getContainer: vi.fn().mockReturnValue({
        inspect: mockInspect,
        exec: mockExec,
        update: mockUpdate,
      }),
    })),
  };
});

import { registerHealthTools } from "../src/tools/health.js";
import { createDockerClient } from "../src/docker.js";

// Minimal MCP server mock (matches pattern from container.test.ts)
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

describe("Health Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: ReturnType<typeof createDockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    docker = createDockerClient();
    registerHealthTools(server as any, docker);
  });

  describe("check_health", () => {
    it("returns no-healthcheck message when container has no HEALTHCHECK and no probe type", async () => {
      mockInspect.mockResolvedValue({
        Config: { Healthcheck: { Test: ["NONE"] } },
      });

      const result = await server.tools["check_health"].handler({
        container_id: "abc123",
      });

      expect(result.content[0].text).toContain("No health check configured");
    });

    it("auto-detects exec probe from CMD-SHELL HEALTHCHECK", async () => {
      mockInspect.mockResolvedValue({
        Config: {
          Healthcheck: { Test: ["CMD-SHELL curl -f http://localhost/ || exit 1"] },
        },
      });

      // Mock exec flow
      const mockStream = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === "data") cb(Buffer.from("OK\n"));
          if (event === "end") cb();
        }),
      };
      mockExec.mockResolvedValue({
        start: vi.fn().mockResolvedValue(mockStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      });

      const result = await server.tools["check_health"].handler({
        container_id: "abc123",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(true);
      expect(data.exitCode).toBe(0);
      expect(data.output).toBe("OK");
    });

    it("auto-detects exec probe from CMD HEALTHCHECK", async () => {
      mockInspect.mockResolvedValue({
        Config: {
          Healthcheck: { Test: ["CMD pg_isready -U postgres"] },
        },
      });

      const mockStream = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === "data") cb(Buffer.from(""));
          if (event === "end") cb();
        }),
      };
      mockExec.mockResolvedValue({
        start: vi.fn().mockResolvedValue(mockStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
      });

      const result = await server.tools["check_health"].handler({
        container_id: "abc123",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        expect.objectContaining({
          Cmd: ["pg_isready", "-U", "postgres"],
        })
      );
    });

    it("uses explicit exec command when type=exec and command provided", async () => {
      mockInspect.mockResolvedValue({
        Config: { Healthcheck: { Test: ["NONE"] } },
      });

      const mockStream = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === "data") cb(Buffer.from("error: connection refused\n"));
          if (event === "end") cb();
        }),
      };
      mockExec.mockResolvedValue({
        start: vi.fn().mockResolvedValue(mockStream),
        inspect: vi.fn().mockResolvedValue({ ExitCode: 1 }),
      });

      const result = await server.tools["check_health"].handler({
        container_id: "abc123",
        type: "exec",
        command: ["sh", "-c", "nc -z localhost 5432"],
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(false);
      expect(data.exitCode).toBe(1);
    });

    it("returns not-implemented for http probe type", async () => {
      mockInspect.mockResolvedValue({
        Config: { Healthcheck: { Test: ["NONE"] } },
      });

      const result = await server.tools["check_health"].handler({
        container_id: "abc123",
        type: "http",
        endpoint: "/health",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not yet implemented");
    });

    it("returns not-implemented for tcp probe type", async () => {
      mockInspect.mockResolvedValue({
        Config: { Healthcheck: { Test: ["NONE"] } },
      });

      const result = await server.tools["check_health"].handler({
        container_id: "abc123",
        type: "tcp",
        endpoint: "5432",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not yet implemented");
    });

    it("returns error on Docker API failure", async () => {
      mockInspect.mockRejectedValue(new Error("No such container"));

      const result = await server.tools["check_health"].handler({
        container_id: "nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No such container");
    });
  });

  describe("watch_health", () => {
    it("returns healthy when container is already healthy", async () => {
      mockInspect.mockResolvedValue({
        State: { Health: { Status: "healthy" } },
      });

      const result = await server.tools["watch_health"].handler({
        container_id: "abc123",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(true);
      expect(data.status).toBe("healthy");
    });

    it("returns unhealthy with exit code and output", async () => {
      mockInspect.mockResolvedValue({
        State: {
          Health: {
            Status: "unhealthy",
            Log: [{ ExitCode: 1, Output: "connection refused" }],
          },
        },
      });

      const result = await server.tools["watch_health"].handler({
        container_id: "abc123",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(false);
      expect(data.status).toBe("unhealthy");
      expect(data.exitCode).toBe(1);
      expect(data.output).toBe("connection refused");
    });

    it("times out when container never becomes healthy", async () => {
      // Always return "starting" status
      mockInspect.mockResolvedValue({
        State: { Health: { Status: "starting" } },
      });

      const result = await server.tools["watch_health"].handler({
        container_id: "abc123",
        timeout: 1, // 1 second timeout
        interval: 1, // 1 second interval (fast for test)
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(false);
      expect(data.status).toBe("timeout");
    });

    it("returns error on Docker API failure", async () => {
      mockInspect.mockRejectedValue(new Error("No such container"));

      const result = await server.tools["watch_health"].handler({
        container_id: "nonexistent",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No such container");
    });
  });

  describe("set_restart_policy", () => {
    it("sets restart policy to always", async () => {
      mockUpdate.mockResolvedValue(undefined);

      const result = await server.tools["set_restart_policy"].handler({
        container_id: "abc123",
        policy: "always",
      });

      expect(result.content[0].text).toContain("always");
      expect(mockUpdate).toHaveBeenCalledWith({
        RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
      });
    });

    it("sets restart policy to on-failure with max retry count", async () => {
      mockUpdate.mockResolvedValue(undefined);

      const result = await server.tools["set_restart_policy"].handler({
        container_id: "abc123",
        policy: "on-failure",
        max_retry_count: 5,
      });

      expect(result.content[0].text).toContain("on-failure");
      expect(mockUpdate).toHaveBeenCalledWith({
        RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
      });
    });

    it("sets restart policy to no", async () => {
      mockUpdate.mockResolvedValue(undefined);

      const result = await server.tools["set_restart_policy"].handler({
        container_id: "abc123",
        policy: "no",
      });

      expect(result.content[0].text).toContain("no");
      expect(mockUpdate).toHaveBeenCalledWith({
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      });
    });

    it("returns error on Docker API failure", async () => {
      mockUpdate.mockRejectedValue(new Error("No such container"));

      const result = await server.tools["set_restart_policy"].handler({
        container_id: "nonexistent",
        policy: "always",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No such container");
    });
  });
});
