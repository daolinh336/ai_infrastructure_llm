import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockInfo = vi.fn();
const mockDf = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      info: mockInfo,
      df: mockDf,
    })),
  };
});

import { registerSystemTools } from "../src/tools/system.js";

// Minimal MCP server mock
function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (name: string, description: string, _schema: unknown, _hints: unknown, handler: Function) => {
      tools[name] = { description, handler };
    },
    tools,
  };
}

describe("System Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    server = createMockServer();
    docker = {
      info: mockInfo,
      df: mockDf,
    };
    registerSystemTools(server as any, docker);
    vi.clearAllMocks();
  });

  describe("docker_info", () => {
    it("should register docker_info tool", () => {
      expect(server.tools["docker_info"]).toBeDefined();
      expect(server.tools["docker_info"].description).toContain("system information");
    });

    it("should return formatted Docker info", async () => {
      mockInfo.mockResolvedValue({
        ServerVersion: "29.5.3",
        OperatingSystem: "Ubuntu 26.04 LTS",
        KernelVersion: "7.0.0-15-generic",
        Architecture: "x86_64",
        NCPU: 2,
        MemTotal: 4000079872,
        DockerRootDir: "/var/lib/docker",
        Driver: "overlay2",
        ContainersRunning: 3,
        ContainersStopped: 5,
        ContainersPaused: 0,
        Images: 12,
        Labels: ["com.docker.compose.version=2.29.1"],
        ID: "ABC1:DEF2:GHI3:JKL4:MNO5:PQR6:STUV:WXYZ:1234:5678:ABCD:EF90:1234:5678",
      });

      const result = await server.tools["docker_info"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.server_version).toBe("29.5.3");
      expect(data.os).toBe("Ubuntu 26.04 LTS");
      expect(data.kernel).toBe("7.0.0-15-generic");
      expect(data.cpus).toBe(2);
      expect(data.memory_total_human).toBe("3.7 GB");
      expect(data.containers_running).toBe(3);
      expect(data.containers_stopped).toBe(5);
      expect(data.images).toBe(12);
      expect(data.storage_driver).toBe("overlay2");
    });

    it("should handle errors", async () => {
      mockInfo.mockRejectedValue(new Error("Cannot connect to Docker daemon"));

      const result = await server.tools["docker_info"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("disk_usage", () => {
    it("should register disk_usage tool", () => {
      expect(server.tools["disk_usage"]).toBeDefined();
      expect(server.tools["disk_usage"].description).toContain("disk usage");
    });

    it("should return formatted disk usage", async () => {
      mockDf.mockResolvedValue({
        LayersSize: 623591029,
        Images: [
          {
            Id: "sha256:a6894d60f28f051f4c3e44a6b5f0b669023fc47ea936355d65e5fcc10856767f",
            RepoTags: ["nginx:latest"],
            Size: 395120924,
            Containers: 1,
          },
          {
            Id: "sha256:b2894d60f28f051f4c3e44a6b5f0b669023fc47ea936355d65e5fcc10856767g",
            RepoTags: ["alpine:latest"],
            Size: 13068376,
            Containers: 0,
          },
        ],
        Containers: [
          {
            Id: "abc123def456",
            Name: "web-app",
            Image: "nginx:latest",
            Size: 1048576,
            Reclaimable: true,
          },
        ],
        Volumes: [
          {
            Name: "data-vol",
            Size: 52428800,
            Reclaimable: false,
          },
        ],
        BuildCache: [
          {
            ID: "cache1",
            Type: "regular",
            Description: "pulled from docker.io/library/node:22",
            Size: 9032241,
            InUse: false,
          },
          {
            ID: "cache2",
            Type: "regular",
            Description: "COPY package.json",
            Size: 156559,
            InUse: false,
          },
        ],
      });

      const result = await server.tools["disk_usage"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.summary.images.count).toBe(2);
      expect(data.summary.images.total_human).toMatch(/^594\.\d MB$/);
      expect(data.summary.containers.count).toBe(1);
      expect(data.summary.volumes.count).toBe(1);
      expect(data.summary.build_cache.count).toBe(2);

      // Check image details
      expect(data.images[0].tags).toContain("nginx:latest");
      expect(data.images[0].size_human).toMatch(/^376\.\d MB$/);

      // Check container details
      expect(data.containers[0].name).toBe("web-app");
      expect(data.containers[0].size_human).toBe("1 MB");

      // Check volume details
      expect(data.volumes[0].name).toBe("data-vol");
      expect(data.volumes[0].size_human).toBe("50 MB");
    });

    it("should handle empty disk usage", async () => {
      mockDf.mockResolvedValue({
        LayersSize: 0,
        Images: [],
        Containers: [],
        Volumes: [],
        BuildCache: [],
      });

      const result = await server.tools["disk_usage"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.summary.images.count).toBe(0);
      expect(data.summary.containers.count).toBe(0);
      expect(data.images).toEqual([]);
    });

    it("should handle errors", async () => {
      mockDf.mockRejectedValue(new Error("Docker API error"));

      const result = await server.tools["disk_usage"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });
});
