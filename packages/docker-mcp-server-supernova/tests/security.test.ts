import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Dockerode before importing the module under test
const mockInspect = vi.fn();
const mockPull = vi.fn();
const mockCreateContainer = vi.fn();
const mockModemFollowProgress = vi.fn();

vi.mock("dockerode", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      getImage: vi.fn().mockReturnValue({ inspect: mockInspect }),
      pull: mockPull,
      createContainer: mockCreateContainer,
      modem: { followProgress: mockModemFollowProgress },
    })),
  };
});

import { registerSecurityTools } from "../src/tools/security.js";
import { createDockerClient } from "../src/docker.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// Minimal MCP server mock (same pattern as health.test.ts)
function createMockServer() {
  const tools: Record<string, { description: string; handler: Function }> = {};
  return {
    tool: (name: string, description: string, _schemaOrAnnotations: unknown, _annotationsOrHandler: unknown, _maybeHandler?: Function) => {
      const handler = typeof _annotationsOrHandler === 'function' ? _annotationsOrHandler : (_maybeHandler as Function);
      tools[name] = { description, handler };
    },
    _tools: tools,
  };
}

describe("Security Tools", () => {
  describe("scan_image", () => {
    it("returns error when Trivy scan fails with non-zero exit", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      // Image already exists
      mockInspect.mockResolvedValue({ Id: "abc123" });

      // Container created and started
      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 1 }),
        logs: vi.fn().mockResolvedValue(Buffer.from("Error: image not found")),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["scan_image"].handler;

      const result = await handler({ image: "nonexistent/image" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Trivy scan failed");
      expect(result.content[0].text).toContain("exit code 1");
    });

    it("pulls Trivy image when not present locally", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      // Image not found locally
      mockInspect.mockRejectedValue(new Error("no such image"));

      // Pull succeeds
      const mockStream = {};
      mockPull.mockResolvedValue(mockStream);
      mockModemFollowProgress.mockImplementation((_stream: any, cb: Function) => cb(null));

      // Container succeeds with clean output
      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.from('{"Results":[]}')),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["scan_image"].handler;

      const result = await handler({ image: "alpine:latest" });

      expect(mockPull).toHaveBeenCalledWith("aquasec/trivy:latest");
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.scan_summary.total_vulnerabilities).toBe(0);
    });

    it("parses vulnerability output correctly", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      mockInspect.mockResolvedValue({ Id: "abc123" });

      const trivyOutput = JSON.stringify({
        Results: [
          {
            Target: "alpine:3.18",
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-2023-1234",
                PkgName: "openssl",
                InstalledVersion: "3.1.0",
                FixedVersion: "3.1.1",
                Severity: "CRITICAL",
                Title: "Buffer overflow in OpenSSL",
              },
              {
                VulnerabilityID: "CVE-2023-5678",
                PkgName: "curl",
                InstalledVersion: "8.1.0",
                FixedVersion: "",
                Severity: "HIGH",
                Title: "Out-of-bounds read in curl",
              },
            ],
          },
        ],
      });

      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.from(trivyOutput)),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["scan_image"].handler;

      const result = await handler({ image: "alpine:latest", tag: "3.18" });

      const data = JSON.parse(result.content[0].text);
      expect(data.image).toBe("alpine:latest:3.18");
      expect(data.scan_summary.critical).toBe(1);
      expect(data.scan_summary.high).toBe(1);
      expect(data.scan_summary.total_vulnerabilities).toBe(2);
      expect(data.critical_vulns).toHaveLength(1);
      expect(data.critical_vulns[0].id).toBe("CVE-2023-1234");
      expect(data.high_vulns).toHaveLength(1);
    });

    it("respects custom severity filter", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      mockInspect.mockResolvedValue({ Id: "abc123" });

      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.from('{"Results":[]}')),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["scan_image"].handler;

      await handler({ image: "alpine:latest", severity: "CRITICAL" });

      const cmd = mockCreateContainer.mock.calls[0][0].Cmd;
      expect(cmd).toContain("--severity CRITICAL");
    });
  });

  describe("vulnerability_report", () => {
    it("includes remediation recommendations for fixable packages", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      mockInspect.mockResolvedValue({ Id: "abc123" });

      const trivyOutput = JSON.stringify({
        Results: [
          {
            Target: "node:18",
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-2023-0001",
                PkgName: "openssl",
                InstalledVersion: "1.1.1",
                FixedVersion: "1.1.2",
                Severity: "CRITICAL",
                Title: "Critical SSL vuln",
              },
              {
                VulnerabilityID: "CVE-2023-0002",
                PkgName: "openssl",
                InstalledVersion: "1.1.1",
                FixedVersion: "1.1.2",
                Severity: "HIGH",
                Title: "Another SSL vuln",
              },
              {
                VulnerabilityID: "CVE-2023-0003",
                PkgName: "zlib",
                InstalledVersion: "1.2.13",
                FixedVersion: "",
                Severity: "MEDIUM",
                Title: "Unfixable vuln",
              },
            ],
          },
        ],
      });

      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.from(trivyOutput)),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["vulnerability_report"].handler;

      const result = await handler({ image: "node:latest", tag: "18" });

      const data = JSON.parse(result.content[0].text);
      expect(data.image).toBe("node:latest:18");
      expect(data.report_summary.total_vulnerabilities).toBe(3);
      expect(data.report_summary.fixable_packages).toBe(1); // only openssl is fixable
      expect(data.remediation).toHaveLength(1);
      expect(data.remediation[0].package).toBe("openssl");
      expect(data.remediation[0].fix_version).toBe("1.1.2");
      expect(data.remediation[0].highest_severity).toBe("CRITICAL");
    });

    it("sorts remediation by severity (critical first)", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      mockInspect.mockResolvedValue({ Id: "abc123" });

      const trivyOutput = JSON.stringify({
        Results: [
          {
            Target: "base",
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-LOW",
                PkgName: "low-pkg",
                InstalledVersion: "1.0",
                FixedVersion: "1.1",
                Severity: "LOW",
                Title: "Low vuln",
              },
              {
                VulnerabilityID: "CVE-CRIT",
                PkgName: "crit-pkg",
                InstalledVersion: "2.0",
                FixedVersion: "2.1",
                Severity: "CRITICAL",
                Title: "Critical vuln",
              },
            ],
          },
        ],
      });

      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
        logs: vi.fn().mockResolvedValue(Buffer.from(trivyOutput)),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["vulnerability_report"].handler;

      const result = await handler({ image: "test:latest" });

      const data = JSON.parse(result.content[0].text);
      expect(data.remediation[0].package).toBe("crit-pkg");
      expect(data.remediation[1].package).toBe("low-pkg");
    });

    it("returns error when Trivy report fails", async () => {
      const server = createMockServer();
      const docker = createDockerClient();

      mockInspect.mockResolvedValue({ Id: "abc123" });

      const mockContainer = {
        start: vi.fn().mockResolvedValue(undefined),
        wait: vi.fn().mockResolvedValue({ StatusCode: 2 }),
        logs: vi.fn().mockResolvedValue(Buffer.from("FATAL: cannot find image")),
      };
      mockCreateContainer.mockResolvedValue(mockContainer);

      registerSecurityTools(server as any, docker);
      const handler = server._tools["vulnerability_report"].handler;

      const result = await handler({ image: "bad/image" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Trivy report failed");
    });
  });
});
