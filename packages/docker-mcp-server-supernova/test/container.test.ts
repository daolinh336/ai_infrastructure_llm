import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerContainerTools } from "../src/tools/container.js";

// Capture registered tools
function createMockServer() {
  const tools: Record<string, { description: string; schema: any; handler: Function }> = {};
  return {
    server: {
      tool: vi.fn(
        (
          name: string,
          description: string,
          schema: any,
          _annotations: any,
          handler: Function
        ) => {
          tools[name] = { description, schema, handler };
        }
      ),
    },
    tools,
  };
}

function createMockDocker(overrides: Record<string, any> = {}) {
  return {
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: "abc123", State: { Running: true } }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      logs: vi.fn().mockResolvedValue("log output"),
      stats: vi.fn().mockResolvedValue({}),
      exec: vi.fn().mockReturnValue({ start: vi.fn().mockResolvedValue(Buffer.from("exec output")) }),
      ...overrides,
    }),
    createContainer: vi.fn().mockResolvedValue({
      id: "new1234567890",
      start: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ Id: "new123" }),
    }),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Id: "img123" }),
    }),
    pruneContainers: vi.fn().mockResolvedValue({ ContainersDeleted: 3 }),
    listImages: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("registerContainerTools", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let mockDocker: ReturnType<typeof createMockDocker>;

  beforeEach(() => {
    mockServer = createMockServer();
    mockDocker = createMockDocker();
    registerContainerTools(mockServer.server as any, mockDocker as any);
  });

  it("registers all container tools", () => {
    const expectedTools = [
      "list_containers",
      "inspect_container",
      "start_container",
      "stop_container",
      "restart_container",
      "remove_container",
      "recreate_container",
      "run_container",
      "prune_containers",
      "update_container",
    ];
    for (const name of expectedTools) {
      expect(mockServer.tools[name]).toBeDefined();
    }
  });

  it("list_containers calls docker.listContainers with filters", async () => {
    const fakeContainer = {
      Id: "abc123def456",
      Names: ["/test-container"],
      Image: "nginx:latest",
      State: "running",
      Status: "Up 1 hour",
      Created: Date.now() / 1000,
      Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }],
      Labels: {},
      Mounts: [],
    };
    mockDocker.listContainers.mockResolvedValue([fakeContainer]);

    const handler = mockServer.tools["list_containers"].handler;
    const result = await handler({ all: true, state: "running" });

    expect(mockDocker.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: JSON.stringify({ status: ["running"] }),
    });
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("abc123def456");
    expect(parsed[0].name).toBe("test-container");
  });

  it("list_containers returns error on failure", async () => {
    mockDocker.listContainers.mockRejectedValue(new Error("Docker daemon down"));
    const handler = mockServer.tools["list_containers"].handler;
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error");
  });

  it("inspect_container returns full container info", async () => {
    const handler = mockServer.tools["inspect_container"].handler;
    const result = await handler({ container_id: "abc123" });

    expect(mockDocker.getContainer).toHaveBeenCalledWith("abc123");
    expect(result.content[0].text).toContain("abc123");
  });

  it("start_container calls container.start()", async () => {
    const handler = mockServer.tools["start_container"].handler;
    const result = await handler({ container_id: "abc123" });

    const containerMock = mockDocker.getContainer();
    expect(containerMock.start).toHaveBeenCalled();
    expect(result.content[0].text).toContain("started");
  });

  it("start_container handles 304 already-started gracefully", async () => {
    const containerMock = mockDocker.getContainer();
    const err = new Error("container already started") as any;
    err.statusCode = 304;
    containerMock.start.mockRejectedValue(err);

    const handler = mockServer.tools["start_container"].handler;
    const result = await handler({ container_id: "abc123" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("already started");
  });

  it("start_container returns error on failure", async () => {
    const containerMock = mockDocker.getContainer();
    containerMock.start.mockRejectedValue(new Error("No such container"));
    const handler = mockServer.tools["start_container"].handler;
    const result = await handler({ container_id: "nonexistent" });

    expect(result.isError).toBe(true);
  });

  it("stop_container uses default timeout of 10", async () => {
    const handler = mockServer.tools["stop_container"].handler;
    const result = await handler({ container_id: "abc123" });

    const containerMock = mockDocker.getContainer();
    expect(containerMock.stop).toHaveBeenCalledWith({ t: 10 });
    expect(result.content[0].text).toContain("stopped");
  });

  it("stop_container uses custom timeout", async () => {
    const handler = mockServer.tools["stop_container"].handler;
    await handler({ container_id: "abc123", timeout: 30 });

    const containerMock = mockDocker.getContainer();
    expect(containerMock.stop).toHaveBeenCalledWith({ t: 30 });
  });

  it("stop_container handles 304 already-stopped gracefully", async () => {
    const containerMock = mockDocker.getContainer();
    const err = new Error("already stopped") as any;
    err.statusCode = 304;
    containerMock.stop.mockRejectedValue(err);

    const handler = mockServer.tools["stop_container"].handler;
    const result = await handler({ container_id: "abc123" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("already stopped");
  });

  it("restart_container calls container.restart()", async () => {
    const handler = mockServer.tools["restart_container"].handler;
    const result = await handler({ container_id: "abc123" });

    const containerMock = mockDocker.getContainer();
    expect(containerMock.restart).toHaveBeenCalledWith({ t: 10 });
    expect(result.content[0].text).toContain("restarted");
  });

  it("remove_container calls container.remove()", async () => {
    const handler = mockServer.tools["remove_container"].handler;
    const result = await handler({ container_id: "abc123" });

    const containerMock = mockDocker.getContainer();
    expect(containerMock.remove).toHaveBeenCalledWith({ force: false });
    expect(result.content[0].text).toContain("removed");
  });

  it("remove_container with force=true passes force option", async () => {
    const handler = mockServer.tools["remove_container"].handler;
    await handler({ container_id: "abc123", force: true });

    const containerMock = mockDocker.getContainer();
    expect(containerMock.remove).toHaveBeenCalledWith({ force: true });
  });

  it("run_container creates and starts a container", async () => {
    const handler = mockServer.tools["run_container"].handler;
    const result = await handler({
      image: "nginx:latest",
      name: "test-nginx",
      ports: { "8080/tcp": "80/tcp" },
    });

    expect(mockDocker.createContainer).toHaveBeenCalled();
    const createCall = mockDocker.createContainer.mock.calls[0][0];
    expect(createCall.Image).toBe("nginx:latest");
    expect(createCall.name).toBe("test-nginx");
    expect(result.content[0].text).toContain("created");
  });

  it("prune_containers calls docker.pruneContainers()", async () => {
    mockDocker.pruneContainers.mockResolvedValue({
      ContainersDeleted: ["abc123def456", "789012345678"],
      SpaceReclaimed: 1024,
    });
    const handler = mockServer.tools["prune_containers"].handler;
    const result = await handler({});

    expect(mockDocker.pruneContainers).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.containers_deleted).toBe(2);
    expect(parsed.space_reclaimed_human).toBe("1 KB");
  });
});
