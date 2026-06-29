import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ScanImageSchema, VulnerabilityReportSchema } from "../types.js";
import { formatError, withRetry } from "../docker.js";

interface TrivyVuln {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion: string;
  Severity: string;
  Title: string;
  Description?: string;
}

interface TrivyResult {
  Target: string;
  Vulnerabilities?: TrivyVuln[];
}

function parseTrivyOutput(output: string): { results: TrivyResult[]; summary: Record<string, number> } {
  try {
    const data = JSON.parse(output);
    const results: TrivyResult[] = data.Results || [];
    const summary: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
    for (const result of results) {
      for (const vuln of result.Vulnerabilities || []) {
        const sev = (vuln.Severity || "UNKNOWN").toUpperCase();
        summary[sev] = (summary[sev] || 0) + 1;
      }
    }
    return { results, summary };
  } catch {
    return { results: [], summary: {} };
  }
}

function formatVulnTable(vulns: TrivyVuln[]): string {
  if (vulns.length === 0) return "No vulnerabilities found.";
  const lines = ["ID | Package | Installed | Fixed | Severity | Title"];
  lines.push("---|---------|-----------|-------|----------|-----");
  for (const v of vulns.slice(0, 30)) {
    lines.push(`${v.VulnerabilityID} | ${v.PkgName} | ${v.InstalledVersion} | ${v.FixedVersion || "N/A"} | ${v.Severity} | ${(v.Title || "").substring(0, 60)}`);
  }
  if (vulns.length > 30) lines.push(`... and ${vulns.length - 30} more`);
  return lines.join("\n");
}

export function registerSecurityTools(server: McpServer, docker: Dockerode): void {
  // scan_image — scan a Docker image for vulnerabilities using Trivy
  server.tool(
    "scan_image",
    "Scan a Docker image for known vulnerabilities using Trivy. Runs Trivy inside a temporary container to scan the specified image. Returns a summary of critical/high/medium/low vulnerabilities with package names and fix availability. Requires Trivy to be available on the Docker host or uses the aquasec/trivy image automatically.",
    ScanImageSchema.shape,
    { readOnlyHint: true, openWorldHint: false },
    async (params) => {
      try {
        const imageRef = params.tag
          ? `${params.image}:${params.tag}`
          : params.image;

        // Pull trivy image if not present
        try {
          await docker.getImage("aquasec/trivy:latest").inspect();
        } catch {
          const pullStream = await docker.pull("aquasec/trivy:latest");
          await new Promise<void>((resolve, reject) => {
            docker.modem.followProgress(pullStream, (err: Error | null) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }

        const severity = params.severity || "CRITICAL,HIGH,MEDIUM";
        const formatFlag = "--format json";
        const severityFlag = `--severity ${severity}`;

        // Create and run trivy container
        const container = await docker.createContainer({
          Image: "aquasec/trivy:latest",
          Cmd: ["image", formatFlag, severityFlag, "--no-progress", "--quiet", imageRef],
          HostConfig: {
            Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
            AutoRemove: true,
          },
        });

        await container.start();

        // Wait for completion with timeout
        const timeoutMs = params.timeout || 120;
        const result = await Promise.race([
          container.wait(),
          new Promise<{ StatusCode: number }>((_, reject) =>
            setTimeout(() => reject(new Error(`Scan timed out after ${timeoutMs}s`)), timeoutMs * 1000)
          ),
        ]);

        // Get logs
        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        const output = logs.toString("utf-8").trim();

        if ((result as any).StatusCode !== 0 && !output.includes("Vulnerability")) {
          return {
            content: [{
              type: "text",
              text: `Trivy scan failed (exit code ${(result as any).StatusCode}):\n${output.substring(0, 2000)}`,
            }],
            isError: true,
          };
        }

        const { results, summary } = parseTrivyOutput(output);
        const totalVulns = Object.values(summary).reduce((a, b) => a + b, 0);

        // Format detailed vulnerabilities by severity
        const allVulns: TrivyVuln[] = [];
        for (const r of results) {
          for (const v of r.Vulnerabilities || []) {
            allVulns.push(v);
          }
        }

        const critical = allVulns.filter(v => v.Severity === "CRITICAL");
        const high = allVulns.filter(v => v.Severity === "HIGH");

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              image: imageRef,
              scan_summary: {
                total_vulnerabilities: totalVulns,
                critical: summary.CRITICAL || 0,
                high: summary.HIGH || 0,
                medium: summary.MEDIUM || 0,
                low: summary.LOW || 0,
                unknown: summary.UNKNOWN || 0,
              },
              targets: results.map(r => r.Target),
              critical_vulns: critical.slice(0, 10).map(v => ({
                id: v.VulnerabilityID,
                package: v.PkgName,
                installed: v.InstalledVersion,
                fixed: v.FixedVersion || "N/A",
                title: (v.Title || "").substring(0, 100),
              })),
              high_vulns: high.slice(0, 10).map(v => ({
                id: v.VulnerabilityID,
                package: v.PkgName,
                installed: v.InstalledVersion,
                fixed: v.FixedVersion || "N/A",
                title: (v.Title || "").substring(0, 100),
              })),
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  // vulnerability_report — generate a detailed vulnerability report for an image
  server.tool(
    "vulnerability_report",
    "Generate a detailed vulnerability report for a Docker image, including all severities. Returns a structured report with remediation recommendations (which packages to upgrade). More detailed than scan_image — includes full descriptions and fix versions for all vulnerabilities.",
    VulnerabilityReportSchema.shape,
    { readOnlyHint: true, openWorldHint: false },
    async (params) => {
      try {
        const imageRef = params.tag
          ? `${params.image}:${params.tag}`
          : params.image;

        // Pull trivy image if not present
        try {
          await docker.getImage("aquasec/trivy:latest").inspect();
        } catch {
          const pullStream = await docker.pull("aquasec/trivy:latest");
          await new Promise<void>((resolve, reject) => {
            docker.modem.followProgress(pullStream, (err: Error | null) => {
              if (err) reject(err);
              else resolve();
            });
          });
        }

        const severity = params.severity || "CRITICAL,HIGH,MEDIUM,LOW";

        const container = await docker.createContainer({
          Image: "aquasec/trivy:latest",
          Cmd: ["image", "--format", "json", "--severity", severity, "--no-progress", "--quiet", imageRef],
          HostConfig: {
            Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
            AutoRemove: true,
          },
        });

        await container.start();

        const timeoutMs = params.timeout || 180;
        const result = await Promise.race([
          container.wait(),
          new Promise<{ StatusCode: number }>((_, reject) =>
            setTimeout(() => reject(new Error(`Report timed out after ${timeoutMs}s`)), timeoutMs * 1000)
          ),
        ]);

        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        const output = logs.toString("utf-8").trim();

        if ((result as any).StatusCode !== 0 && !output.includes("Vulnerability")) {
          return {
            content: [{
              type: "text",
              text: `Trivy report failed (exit code ${(result as any).StatusCode}):\n${output.substring(0, 2000)}`,
            }],
            isError: true,
          };
        }

        const { results, summary } = parseTrivyOutput(output);
        const allVulns: TrivyVuln[] = [];
        for (const r of results) {
          for (const v of r.Vulnerabilities || []) {
            allVulns.push(v);
          }
        }

        // Build remediation list: packages with available fixes
        const fixable = allVulns
          .filter(v => v.FixedVersion && v.FixedVersion !== "N/A")
          .reduce((acc, v) => {
            const key = `${v.PkgName}@${v.InstalledVersion}`;
            if (!acc[key]) {
              acc[key] = {
                package: v.PkgName,
                current_version: v.InstalledVersion,
                fix_version: v.FixedVersion,
                vulnerabilities: [],
                highest_severity: v.Severity,
              };
            }
            acc[key].vulnerabilities.push(v.VulnerabilityID);
            // Track highest severity
            const sevOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
            if ((sevOrder[v.Severity as keyof typeof sevOrder] || 0) >
                (sevOrder[acc[key].highest_severity as keyof typeof sevOrder] || 0)) {
              acc[key].highest_severity = v.Severity;
            }
            return acc;
          }, {} as Record<string, any>);

        const remediation = Object.values(fixable)
          .sort((a: any, b: any) => {
            const sevOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
            return (sevOrder[b.highest_severity as keyof typeof sevOrder] || 0) -
                   (sevOrder[a.highest_severity as keyof typeof sevOrder] || 0);
          });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              image: imageRef,
              report_summary: {
                total_vulnerabilities: allVulns.length,
                critical: summary.CRITICAL || 0,
                high: summary.HIGH || 0,
                medium: summary.MEDIUM || 0,
                low: summary.LOW || 0,
                fixable_packages: remediation.length,
              },
              remediation: remediation.slice(0, 20),
              detailed_vulnerabilities: formatVulnTable(allVulns),
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}
