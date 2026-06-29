import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockListNetworks = vi.fn();
const mockListVolumes = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      listNetworks: mockListNetworks,
      listVolumes: mockListVolumes,
    })),
  };
});

import { registerNetworkTools } from "../src/tools/network.js";
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

describe("Network Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: ReturnType<typeof createDockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    docker = createDockerClient();
    registerNetworkTools(server as any, docker);
  });

  describe("list_networks", () => {
    it("should list networks with basic info", async () => {
      mockListNetworks.mockResolvedValue([
        {
          Id: "abc123def456",
          Name: "bridge",
          Driver: "bridge",
          Scope: "local",
          Created: "2026-01-01T00:00:00Z",
        },
      ]);

      const result = await server.tools.list_networks.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("abc123def456");
      expect(parsed[0].name).toBe("bridge");
      expect(parsed[0].driver).toBe("bridge");
    });

    it("should include container info when available", async () => {
      mockListNetworks.mockResolvedValue([
        {
          Id: "abc123def456",
          Name: "my-network",
          Driver: "bridge",
          Scope: "local",
          Created: "2026-01-01T00:00:00Z",
          Containers: {
            "container12345678": {
              Name: "web",
              IPv4Address: "172.18.0.2/16",
            },
          },
        },
      ]);

      const result = await server.tools.list_networks.handler({});
      const parsed = JSON.parse(result.content[0].text);
      // IDs are truncated to 12 chars
      const containerKeys = Object.keys(parsed[0].containers);
      expect(containerKeys).toHaveLength(1);
      expect(containerKeys[0]).toMatch(/^container123/);
      expect(parsed[0].containers[containerKeys[0]].name).toBe("web");
    });

    it("should pass filter to Docker API", async () => {
      mockListNetworks.mockResolvedValue([]);

      await server.tools.list_networks.handler({ filter: "my-network" });
      expect(mockListNetworks).toHaveBeenCalledWith({
        filters: JSON.stringify({ name: ["my-network"] }),
      });
    });

    it("should not pass filters when no filter provided", async () => {
      mockListNetworks.mockResolvedValue([]);

      await server.tools.list_networks.handler({});
      expect(mockListNetworks).toHaveBeenCalledWith({ filters: undefined });
    });

    it("should handle empty network list", async () => {
      mockListNetworks.mockResolvedValue([]);

      const result = await server.tools.list_networks.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(0);
    });

    it("should handle errors gracefully", async () => {
      mockListNetworks.mockRejectedValue(new Error("Cannot connect to Docker daemon"));

      const result = await server.tools.list_networks.handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("list_volumes", () => {
    it("should list volumes with basic info", async () => {
      mockListVolumes.mockResolvedValue({
        Volumes: [
          {
            Name: "my-volume",
            Driver: "local",
            Mountpoint: "/var/lib/docker/volumes/my-volume/_data",
            CreatedAt: "2026-01-01T00:00:00Z",
            Labels: {},
          },
        ],
      });

      const result = await server.tools.list_volumes.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("my-volume");
      expect(parsed[0].driver).toBe("local");
    });

    it("should pass filter to Docker API", async () => {
      mockListVolumes.mockResolvedValue({ Volumes: [] });

      await server.tools.list_volumes.handler({ filter: "my-volume" });
      expect(mockListVolumes).toHaveBeenCalledWith({
        filters: JSON.stringify({ name: ["my-volume"] }),
      });
    });

    it("should handle empty volumes", async () => {
      mockListVolumes.mockResolvedValue({ Volumes: [] });

      const result = await server.tools.list_volumes.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(0);
    });

    it("should handle null Volumes field", async () => {
      mockListVolumes.mockResolvedValue({ Volumes: null });

      const result = await server.tools.list_volumes.handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(0);
    });

    it("should handle errors gracefully", async () => {
      mockListVolumes.mockRejectedValue(new Error("Cannot connect to Docker daemon"));

      const result = await server.tools.list_volumes.handler({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });
});
