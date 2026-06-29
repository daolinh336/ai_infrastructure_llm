import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockListContainers = vi.fn();
const mockInspect = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRestart = vi.fn();
const mockRemove = vi.fn();
const mockCreateContainer = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      listContainers: mockListContainers,
      getContainer: vi.fn().mockReturnValue({
        inspect: mockInspect,
        start: mockStart,
        stop: mockStop,
        restart: mockRestart,
        remove: mockRemove,
      }),
      createContainer: mockCreateContainer,
    })),
  };
});

import { registerContainerTools } from "../src/tools/container.js";
import { createDockerClient } from "../src/docker.js";

// Minimal MCP server mock
function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (name: string, description: string, _schemaOrAnnotations: unknown, _annotationsOrHandler: unknown, _maybeHandler?: Function) => {
      // Support both 4-param (name, desc, schema, handler) and 5-param (name, desc, schema, annotations, handler)
      const handler = typeof _annotationsOrHandler === 'function' ? _annotationsOrHandler : (_maybeHandler as Function);
      tools[name] = { description, handler };
    },
    tools,
  };
}

describe("Container Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: ReturnType<typeof createDockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    docker = createDockerClient();
    registerContainerTools(server as any, docker);
  });

  describe("list_containers", () => {
    it("returns formatted container list", async () => {
      mockListContainers.mockResolvedValue([
        {
          Id: "abc123def456",
          Names: ["/my-container"],
          Image: "nginx:latest",
          State: "running",
          Status: "Up 2 hours",
          Created: Date.now() / 1000,
          Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
          Labels: { "com.example.env": "prod" },
          Mounts: [],
        },
      ]);

      const result = await server.tools["list_containers"].handler({ all: true });
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("abc123def456");
      expect(data[0].name).toBe("my-container");
      expect(data[0].image).toBe("nginx:latest");
      expect(data[0].state).toBe("running");
    });

    it("calls listContainers with correct filters", async () => {
      mockListContainers.mockResolvedValue([]);
      await server.tools["list_containers"].handler({ state: "running", name: "web" });

      const callArgs = mockListContainers.mock.calls[0][0];
      expect(callArgs.all).toBe(false);
      const filters = JSON.parse(callArgs.filters);
      expect(filters.status).toEqual(["running"]);
      expect(filters.name).toEqual(["/web"]);
    });
  });

  describe("inspect_container", () => {
    it("returns full container inspection", async () => {
      mockInspect.mockResolvedValue({
        Id: "abc123",
        Config: { Image: "nginx", Env: ["FOO=bar"] },
        State: { Running: true },
      });

      const result = await server.tools["inspect_container"].handler({ container_id: "abc123" });
      const data = JSON.parse(result.content[0].text);

      expect(data.Id).toBe("abc123");
      expect(data.Config.Image).toBe("nginx");
    });
  });

  describe("start_container", () => {
    it("starts a container and returns success message", async () => {
      mockStart.mockResolvedValue(undefined);
      const result = await server.tools["start_container"].handler({ container_id: "abc123" });

      expect(result.content[0].text).toContain("started");
      expect(mockStart).toHaveBeenCalled();
    });
  });

  describe("stop_container", () => {
    it("stops with default timeout", async () => {
      mockStop.mockResolvedValue(undefined);
      await server.tools["stop_container"].handler({ container_id: "abc123" });

      expect(mockStop).toHaveBeenCalledWith({ t: 10 });
    });

    it("stops with custom timeout", async () => {
      mockStop.mockResolvedValue(undefined);
      await server.tools["stop_container"].handler({ container_id: "abc123", timeout: 30 });

      expect(mockStop).toHaveBeenCalledWith({ t: 30 });
    });
  });

  describe("restart_container", () => {
    it("restarts with default timeout", async () => {
      mockRestart.mockResolvedValue(undefined);
      await server.tools["restart_container"].handler({ container_id: "abc123" });

      expect(mockRestart).toHaveBeenCalledWith({ t: 10 });
    });
  });

  describe("remove_container", () => {
    it("removes without force by default", async () => {
      mockRemove.mockResolvedValue(undefined);
      await server.tools["remove_container"].handler({ container_id: "abc123" });

      expect(mockRemove).toHaveBeenCalledWith({ force: false });
    });

    it("removes with force when requested", async () => {
      mockRemove.mockResolvedValue(undefined);
      await server.tools["remove_container"].handler({ container_id: "abc123", force: true });

      expect(mockRemove).toHaveBeenCalledWith({ force: true });
    });
  });

  describe("run_container", () => {
    it("creates and starts a container with full options", async () => {
      mockCreateContainer.mockResolvedValue({ id: "new123abc456", start: mockStart });
      mockStart.mockResolvedValue(undefined);

      const result = await server.tools["run_container"].handler({
        image: "nginx:latest",
        name: "web",
        env: { PORT: "8080" },
        ports: { "80/tcp": "8080" },
        restart_policy: "unless-stopped",
      });

      expect(result.content[0].text).toContain("new123abc456");
      expect(mockCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "nginx:latest",
          name: "web",
          Env: ["PORT=8080"],
        })
      );
      expect(mockStart).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("returns error on failure", async () => {
      mockListContainers.mockRejectedValue(new Error("Docker daemon not running"));
      const result = await server.tools["list_containers"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Docker daemon not running");
    });
  });
});
