import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockCreateVolume = vi.fn();
const mockListVolumes = vi.fn();
const mockPruneVolumes = vi.fn();
const mockGetVolume = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      createVolume: mockCreateVolume,
      listVolumes: mockListVolumes,
      pruneVolumes: mockPruneVolumes,
      getVolume: mockGetVolume,
    })),
  };
});

import { registerVolumeTools } from "../src/tools/volume.js";

// Minimal MCP server mock
function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (
      name: string,
      description: string,
      _schema: unknown,
      _hints: unknown,
      handler: Function
    ) => {
      tools[name] = { description, handler };
    },
    tools,
  };
}

describe("Volume Tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    // Create a fresh docker-like object with direct mock references
    const docker = {
      createVolume: mockCreateVolume,
      listVolumes: mockListVolumes,
      pruneVolumes: mockPruneVolumes,
      getVolume: mockGetVolume,
    } as any;
    registerVolumeTools(server, docker);
  });

  describe("create_volume", () => {
    it("should create a volume with default driver", async () => {
      mockCreateVolume.mockResolvedValue({
        Name: "test-vol",
        Driver: "local",
        Mountpoint: "/var/lib/docker/volumes/test-vol/_data",
        CreatedAt: "2026-06-13T12:00:00Z",
        Labels: {},
      });

      const handler = server.tools["create_volume"].handler;
      const result = await handler({ name: "test-vol" });

      expect(mockCreateVolume).toHaveBeenCalledWith({
        Name: "test-vol",
        Driver: "local",
        Labels: undefined,
        DriverOpts: undefined,
      });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe("test-vol");
      expect(data.driver).toBe("local");
    });

    it("should create a volume with custom driver and labels", async () => {
      mockCreateVolume.mockResolvedValue({
        Name: "nfs-vol",
        Driver: "nfs",
        Mountpoint: "/var/lib/docker/volumes/nfs-vol/_data",
        Labels: { env: "prod" },
      });

      const handler = server.tools["create_volume"].handler;
      const result = await handler({
        name: "nfs-vol",
        driver: "nfs",
        labels: { env: "prod" },
      });

      expect(mockCreateVolume).toHaveBeenCalledWith({
        Name: "nfs-vol",
        Driver: "nfs",
        Labels: { env: "prod" },
        DriverOpts: undefined,
      });
      expect(result.isError).toBeFalsy();
    });

    it("should handle creation errors", async () => {
      mockCreateVolume.mockRejectedValue(new Error("volume name already exists"));

      const handler = server.tools["create_volume"].handler;
      const result = await handler({ name: "existing-vol" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("volume name already exists");
    });
  });

  describe("inspect_volume", () => {
    it("should inspect a volume", async () => {
      const mockInspect = vi.fn().mockResolvedValue({
        Name: "test-vol",
        Driver: "local",
        Mountpoint: "/var/lib/docker/volumes/test-vol/_data",
        Labels: {},
        Scope: "local",
        Options: {},
        Status: null,
        UsageData: null,
      });
      mockGetVolume.mockReturnValue({ inspect: mockInspect });

      const handler = server.tools["inspect_volume"].handler;
      const result = await handler({ name: "test-vol" });

      expect(mockGetVolume).toHaveBeenCalledWith("test-vol");
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.name).toBe("test-vol");
      expect(data.scope).toBe("local");
    });

    it("should handle inspect errors for non-existent volumes", async () => {
      const mockInspect = vi.fn().mockRejectedValue(new Error("No such volume"));
      mockGetVolume.mockReturnValue({ inspect: mockInspect });

      const handler = server.tools["inspect_volume"].handler;
      const result = await handler({ name: "missing-vol" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No such volume");
    });
  });

  describe("remove_volume", () => {
    it("should remove a volume without force", async () => {
      const mockRemove = vi.fn().mockResolvedValue(undefined);
      mockGetVolume.mockReturnValue({ remove: mockRemove });

      const handler = server.tools["remove_volume"].handler;
      const result = await handler({ name: "old-vol" });

      expect(mockRemove).toHaveBeenCalledWith({ force: false });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
    });

    it("should remove a volume with force", async () => {
      const mockRemove = vi.fn().mockResolvedValue(undefined);
      mockGetVolume.mockReturnValue({ remove: mockRemove });

      const handler = server.tools["remove_volume"].handler;
      const result = await handler({ name: "in-use-vol", force: true });

      expect(mockRemove).toHaveBeenCalledWith({ force: true });
      expect(result.isError).toBeFalsy();
    });

    it("should handle removal errors", async () => {
      const mockRemove = vi.fn().mockRejectedValue(new Error("volume is in use"));
      mockGetVolume.mockReturnValue({ remove: mockRemove });

      const handler = server.tools["remove_volume"].handler;
      const result = await handler({ name: "busy-vol" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("volume is in use");
    });
  });

  describe("prune_volumes", () => {
    it("should prune unused volumes", async () => {
      mockPruneVolumes.mockResolvedValue({
        VolumesDeleted: ["vol1", "vol2"],
        SpaceReclaimed: 1024000,
      });

      const handler = server.tools["prune_volumes"].handler;
      const result = await handler({});

      expect(mockPruneVolumes).toHaveBeenCalledWith({ filters: undefined });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.volumes_deleted).toEqual(["vol1", "vol2"]);
      expect(data.space_reclaimed).toBe(1024000);
    });

    it("should prune with label filter", async () => {
      mockPruneVolumes.mockResolvedValue({
        VolumesDeleted: ["old-cache"],
        SpaceReclaimed: 500000,
      });

      const handler = server.tools["prune_volumes"].handler;
      const result = await handler({ filter: "label=env=test" });

      expect(mockPruneVolumes).toHaveBeenCalledWith({
        filters: { label: ["env=test"] },
      });
      expect(result.isError).toBeFalsy();
    });

    it("should handle prune errors", async () => {
      mockPruneVolumes.mockRejectedValue(new Error("prune failed"));

      const handler = server.tools["prune_volumes"].handler;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("prune failed");
    });
  });
});
