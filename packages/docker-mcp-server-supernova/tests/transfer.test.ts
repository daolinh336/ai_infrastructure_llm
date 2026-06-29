import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "stream";

const { mockExec, mockPutArchive } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockPutArchive: vi.fn(),
}));

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getContainer: vi.fn().mockReturnValue({
        exec: mockExec,
        putArchive: mockPutArchive,
      }),
    })),
  };
});

import { registerTransferTools } from "../src/tools/transfer.js";
import { createDockerClient } from "../src/docker.js";

function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (
      name: string,
      description: string,
      _schemaOrAnnotations: unknown,
      _annotationsOrHandler: unknown,
      _maybeHandler?: Function
    ) => {
      const handler =
        typeof _annotationsOrHandler === "function"
          ? _annotationsOrHandler
          : (_maybeHandler as Function);
      tools[name] = { description, handler };
    },
    tools,
  };
}

describe("Transfer Tools", () => {
  let server: ReturnType<typeof createMockServer>;
  let docker: ReturnType<typeof createDockerClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    docker = createDockerClient();
    registerTransferTools(server as any, docker);
  });

  describe("copy_from_container", () => {
    it("calls exec with correct command", async () => {
      // Mock exec to reject (error path tests the call chain)
      mockExec.mockRejectedValue(new Error("No such container"));

      const result = await server.tools["copy_from_container"].handler({
        container_id: "test-container",
        container_path: "/etc/hosts",
      });

      // Verify exec was called with the correct options
      expect(mockExec).toHaveBeenCalledWith({
        Cmd: ["cat", "/etc/hosts"],
        AttachStdout: true,
        AttachStderr: true,
      });
      expect(result.isError).toBe(true);
    });

    it("handles exec errors gracefully", async () => {
      mockExec.mockRejectedValue(new Error("No such container"));

      const result = await server.tools["copy_from_container"].handler({
        container_id: "nonexistent",
        container_path: "/etc/hosts",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
      expect(result.content[0].text).toContain("No such container");
    });

    it("tool is registered with correct metadata", () => {
      const tool = server.tools["copy_from_container"];
      expect(tool).toBeDefined();
      expect(tool.description).toContain("Copy a file from a Docker container");
    });
  });

  describe("copy_to_container", () => {
    it("writes a file into container", async () => {
      mockPutArchive.mockResolvedValue({});

      const result = await server.tools["copy_to_container"].handler({
        container_id: "abc123",
        container_path: "/app/config.json",
        content: '{"key": "value"}',
        mode: 0o644,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.path).toBe("/app/config.json");
      expect(data.size).toBe(16); // '{"key": "value"}' = 16 bytes
      expect(result.isError).toBeFalsy();
    });

    it("uses default mode 0o644 when not specified", async () => {
      mockPutArchive.mockResolvedValue({});

      const result = await server.tools["copy_to_container"].handler({
        container_id: "abc123",
        container_path: "/app/script.sh",
        content: "#!/bin/bash\necho hello",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.mode).toBe("0644");
    });

    it("calls putArchive with parent directory", async () => {
      mockPutArchive.mockResolvedValue({});

      await server.tools["copy_to_container"].handler({
        container_id: "abc123",
        container_path: "/app/config.json",
        content: "data",
      });

      // putArchive should be called (stream, { path: "/app" })
      expect(mockPutArchive).toHaveBeenCalled();
      const callArgs = mockPutArchive.mock.calls[0];
      expect(callArgs[1]).toEqual({ path: "/app" });
    });

    it("handles nested paths correctly", async () => {
      mockPutArchive.mockResolvedValue({});

      const result = await server.tools["copy_to_container"].handler({
        container_id: "abc123",
        container_path: "/etc/nginx/nginx.conf",
        content: "worker_processes 1;",
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(data.path).toBe("/etc/nginx/nginx.conf");

      // Parent dir should be /etc/nginx
      const callArgs = mockPutArchive.mock.calls[0];
      expect(callArgs[1]).toEqual({ path: "/etc/nginx" });
    });

    it("handles putArchive errors gracefully", async () => {
      mockPutArchive.mockRejectedValue(new Error("Permission denied"));

      const result = await server.tools["copy_to_container"].handler({
        container_id: "abc123",
        container_path: "/root/secret.txt",
        content: "data",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });

    it("tool is registered with correct metadata", () => {
      const tool = server.tools["copy_to_container"];
      expect(tool).toBeDefined();
      expect(tool.description).toContain("Write file content into a Docker container");
    });
  });
});
