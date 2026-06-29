import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListImages = vi.fn();
const mockPull = vi.fn();
const mockBuildImage = vi.fn();
const mockImageRemove = vi.fn();
const mockFollowProgress = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      listImages: mockListImages,
      pull: mockPull,
      buildImage: mockBuildImage,
      getImage: vi.fn().mockReturnValue({
        remove: mockImageRemove,
      }),
      modem: {
        followProgress: mockFollowProgress,
      },
    })),
  };
});

import { registerImageTools } from "../src/tools/image.js";
import { createDockerClient } from "../src/docker.js";

function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (name: string, description: string, _schema: unknown, _hints: unknown, handler: Function) => {
      tools[name] = { description, handler };
    },
    tools,
  };
}

describe("Image Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: ReturnType<typeof createDockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    docker = createDockerClient();
    registerImageTools(server as any, docker);
  });

  describe("list_images", () => {
    it("returns formatted image list", async () => {
      mockListImages.mockResolvedValue([
        {
          Id: "sha256:abc123def456789",
          RepoTags: ["nginx:latest", "nginx:1.25"],
          Size: 187000000,
          Created: "2024-01-15T10:00:00Z",
        },
      ]);

      const result = await server.tools["list_images"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toHaveLength(1);
      expect(data[0].tags).toEqual(["nginx:latest", "nginx:1.25"]);
      expect(data[0].size).toBe(187000000);
    });

    it("handles images with no tags", async () => {
      mockListImages.mockResolvedValue([
        {
          Id: "sha256:abc123",
          RepoTags: null,
          Size: 1000,
          Created: "2024-01-15T10:00:00Z",
        },
      ]);

      const result = await server.tools["list_images"].handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data[0].tags).toEqual(["<none>:<none>"]);
    });

    it("applies filter when specified", async () => {
      mockListImages.mockResolvedValue([]);
      await server.tools["list_images"].handler({ filter: "nginx" });

      expect(mockListImages).toHaveBeenCalledWith({
        all: false,
        filters: JSON.stringify({ reference: ["nginx"] }),
      });
    });
  });

  describe("pull_image", () => {
    it("pulls an image with tag", async () => {
      const mockStream = {};
      mockPull.mockResolvedValue(mockStream);
      mockFollowProgress.mockImplementation((_stream: unknown, cb: Function) => {
        cb(null);
      });

      const result = await server.tools["pull_image"].handler({
        image: "nginx",
        tag: "latest",
      });

      expect(result.content[0].text).toContain("successfully");
      expect(mockPull).toHaveBeenCalledWith("nginx:latest");
    });

    it("pulls an image without tag", async () => {
      mockPull.mockResolvedValue({});
      mockFollowProgress.mockImplementation((_stream: unknown, cb: Function) => {
        cb(null);
      });

      await server.tools["pull_image"].handler({ image: "alpine" });

      expect(mockPull).toHaveBeenCalledWith("alpine");
    });
  });

  describe("remove_image", () => {
    it("removes image without force", async () => {
      mockImageRemove.mockResolvedValue(undefined);

      const result = await server.tools["remove_image"].handler({ image: "nginx:old" });

      expect(result.content[0].text).toContain("removed");
      expect(mockImageRemove).toHaveBeenCalledWith({ force: false });
    });

    it("removes image with force", async () => {
      mockImageRemove.mockResolvedValue(undefined);

      await server.tools["remove_image"].handler({ image: "nginx:old", force: true });

      expect(mockImageRemove).toHaveBeenCalledWith({ force: true });
    });
  });

  describe("error handling", () => {
    it("returns error on list failure", async () => {
      mockListImages.mockRejectedValue(new Error("Cannot connect to Docker"));
      const result = await server.tools["list_images"].handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Cannot connect to Docker");
    });

    it("returns error on pull failure", async () => {
      mockPull.mockRejectedValue(new Error("image not found"));
      const result = await server.tools["pull_image"].handler({ image: "nonexistent" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("image not found");
    });
  });
});
