import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so mock references are available in vi.mock factory (which is hoisted)
const { mockExecSync, mockExistsSync, mockStatSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockStatSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: mockExecSync,
  exec: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: mockExistsSync,
  statSync: mockStatSync,
}));

import { registerComposeTools } from "../src/tools/compose.js";

// Minimal MCP server mock (matches pattern from other test files)
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

describe("Compose Tools", () => {
  let server: ReturnType<typeof createMockServer>;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerComposeTools(server as any);
  });

  describe("compose_up", () => {
    it("should bring up compose services", async () => {
      mockExistsSync.mockReturnValue(false); // path doesn't exist, pass through
      mockExecSync.mockReturnValue("Container web Started\nContainer db Started");

      const result = await server.tools.compose_up.handler({ path: "/app", build: false });
      expect(result.content[0].text).toContain("Container web Started");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("docker compose"),
        expect.any(Object)
      );
    });

    it("should pass --build flag when build=true", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Built and started");

      await server.tools.compose_up.handler({ path: "/app", build: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("--build"),
        expect.any(Object)
      );
    });

    it("should include specific services when provided", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Started");

      await server.tools.compose_up.handler({ path: "/app", build: false, services: ["web", "db"] });
      const cmd = mockExecSync.mock.calls[0][0];
      expect(cmd).toContain("web");
      expect(cmd).toContain("db");
    });

    it("should return default message when output is empty", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("");

      const result = await server.tools.compose_up.handler({ path: "/app", build: false });
      expect(result.content[0].text).toBe("Compose services started.");
    });

    it("should handle errors gracefully", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => {
        throw { stderr: "no such file: docker-compose.yml" };
      });

      const result = await server.tools.compose_up.handler({ path: "/nonexistent", build: false });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });

  describe("compose_down", () => {
    it("should tear down compose services", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Stopped 2 containers");

      const result = await server.tools.compose_down.handler({ path: "/app" });
      expect(result.content[0].text).toContain("Stopped 2 containers");
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("down"),
        expect.any(Object)
      );
    });

    it("should pass -v flag when volumes=true", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Removed");

      await server.tools.compose_down.handler({ path: "/app", volumes: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("-v"),
        expect.any(Object)
      );
    });

    it("should pass timeout when provided", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Stopped");

      await server.tools.compose_down.handler({ path: "/app", timeout: 30 });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("--timeout 30"),
        expect.any(Object)
      );
    });

    it("should return default message when output is empty", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("");

      const result = await server.tools.compose_down.handler({ path: "/app" });
      expect(result.content[0].text).toBe("Compose services stopped.");
    });
  });

  describe("compose_ps", () => {
    it("should list service states", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue(
        JSON.stringify({ Name: "web", State: "running", Health: "healthy" }) + "\n" +
        JSON.stringify({ Name: "db", State: "running", Health: "" })
      );

      const result = await server.tools.compose_ps.handler({ path: "/app" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].Name).toBe("web");
      expect(parsed[1].Name).toBe("db");
    });

    it("should handle single service output", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue(
        JSON.stringify({ Name: "web", State: "running" })
      );

      const result = await server.tools.compose_ps.handler({ path: "/app" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
    });

    it("should handle malformed JSON lines gracefully", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("not json\n" + JSON.stringify({ Name: "web" }));

      const result = await server.tools.compose_ps.handler({ path: "/app" });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({ raw: "not json" });
      expect(parsed[1].Name).toBe("web");
    });
  });

  describe("compose_logs", () => {
    it("should return logs from compose services", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("web_1  | Listening on port 80\ndb_1  | Ready for connections");

      const result = await server.tools.compose_logs.handler({ path: "/app", tail: 50 });
      expect(result.content[0].text).toContain("Listening on port 80");
    });

    it("should pass tail parameter", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("logs");

      await server.tools.compose_logs.handler({ path: "/app", tail: 25 });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("--tail 25"),
        expect.any(Object)
      );
    });

    it("should pass follow flag when follow=true", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("logs");

      await server.tools.compose_logs.handler({ path: "/app", follow: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("-f"),
        expect.any(Object)
      );
    });

    it("should filter by specific services", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("web logs only");

      await server.tools.compose_logs.handler({ path: "/app", services: ["web"] });
      const cmd = mockExecSync.mock.calls[0][0];
      expect(cmd).toContain("web");
    });

    it("should return default message when no logs", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("");

      const result = await server.tools.compose_logs.handler({ path: "/app" });
      expect(result.content[0].text).toBe("No logs found.");
    });
  });

  describe("compose_restart", () => {
    it("should restart compose services", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Restarted");

      const result = await server.tools.compose_restart.handler({ path: "/app" });
      expect(result.content[0].text).toContain("Restarted");
    });

    it("should pass timeout parameter", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Restarted");

      await server.tools.compose_restart.handler({ path: "/app", timeout: 20 });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("--timeout 20"),
        expect.any(Object)
      );
    });

    it("should restart specific services when provided", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("Restarted");

      await server.tools.compose_restart.handler({ path: "/app", services: ["web"] });
      const cmd = mockExecSync.mock.calls[0][0];
      expect(cmd).toContain("web");
    });

    it("should return default message when output is empty", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockReturnValue("");

      const result = await server.tools.compose_restart.handler({ path: "/app" });
      expect(result.content[0].text).toBe("Compose services restarted.");
    });

    it("should handle errors gracefully", async () => {
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => {
        throw { stderr: "Compose file not found" };
      });

      const result = await server.tools.compose_restart.handler({ path: "/nonexistent" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Error");
    });
  });
});
