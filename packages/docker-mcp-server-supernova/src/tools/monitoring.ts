import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ContainerHealthStatusSchema,
  ContainerResourceUsageSchema,
  WatchEventsSchema,
  SearchLogsSchema,
  ResourceAlertCheckSchema,
  MonitorDashboardSchema,
} from "../types.js";
import { sanitizeOutput } from "../docker.js";

export function registerMonitoringTools(server: McpServer, docker: Dockerode): void {
  // 1. fleet_status — health status of all running containers
  server.tool(
    "container_health_status",
    "Check health status, uptime, and restart count for all running Docker containers. Returns JSON with container name, state, health probe status (healthy/unhealthy/no-healthcheck), and restart count. Use this for a quick fleet health overview; for resource metrics use container_resource_usage instead. Returns an array of objects with name, id, state, status, health, uptime, restartCount, and image fields. Read-only and safe to call repeatedly.",
    ContainerHealthStatusSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const containers = await docker.listContainers({ all: false });
        const results = await Promise.all(
          containers.map(async (c) => {
            const info = await docker.getContainer(c.Id).inspect();
            return {
              name: c.Names[0]?.replace(/^\//, "") || c.Id.slice(0, 12),
              id: c.Id.slice(0, 12),
              state: c.State,
              status: c.Status,
              health: info.State.Health?.Status || "no-healthcheck",
              uptime: info.State.StartedAt,
              restartCount: info.RestartCount,
              image: c.Image,
            };
          })
        );
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 2. fleet_stats — resource usage for all running containers
  server.tool(
    "container_resource_usage",
    "Monitor CPU, memory, and network I/O across all running Docker containers. Returns sorted resource usage metrics with percentage breakdowns for each container. Use container_health_status for health probes; use resource_alert_check for threshold violations. Supports sort by cpu, memory, or network. Returns array of objects with name, id, cpu_percent, memory_usage_mb, memory_percent, network_rx_mb, network_tx_mb. Read-only and safe to call repeatedly.",
    ContainerResourceUsageSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const containers = await docker.listContainers({ all: false });
        const results = await Promise.all(
          containers.map(async (c) => {
            const stats = await docker.getContainer(c.Id).stats({ stream: false });
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
            const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage ?? 0);
            const cpuCount = stats.cpu_stats.online_cpus ?? 1;
            const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
            const memUsage = stats.memory_stats?.usage ?? 0;
            const memLimit = stats.memory_stats?.limit ?? 1;
            const memPercent = (memUsage / memLimit) * 100;
            const netRx = Object.values(stats.networks ?? {}).reduce((sum: number, n: any) => sum + (n.rx_bytes ?? 0), 0);
            const netTx = Object.values(stats.networks ?? {}).reduce((sum: number, n: any) => sum + (n.tx_bytes ?? 0), 0);

            return {
              name: c.Names[0]?.replace(/^\//, "") || c.Id.slice(0, 12),
              id: c.Id.slice(0, 12),
              cpu_percent: Math.round(cpuPercent * 100) / 100,
              memory_usage_mb: Math.round((memUsage / 1024 / 1024) * 100) / 100,
              memory_percent: Math.round(memPercent * 100) / 100,
              network_rx_mb: Math.round((netRx / 1024 / 1024) * 100) / 100,
              network_tx_mb: Math.round((netTx / 1024 / 1024) * 100) / 100,
            };
          })
        );

        const sortBy = params.sort_by || "cpu";
        results.sort((a: any, b: any) => {
          if (sortBy === "cpu") return b.cpu_percent - a.cpu_percent;
          if (sortBy === "memory") return b.memory_percent - a.memory_percent;
          return (b.network_rx_mb + b.network_tx_mb) - (a.network_rx_mb + a.network_tx_mb);
        });

        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 3. watch_events — stream Docker events (simplified: collect events for a duration)
  server.tool(
    "watch_events",
    "Stream Docker container events (start, stop, die, restart, health_status) over a configurable time window. Filter by specific container or event type. Use container_health_status for current state; use this tool to watch for changes over time. Returns array of event objects with type, action, container, and time fields. Returns 'No events captured in the time window.' when no events occur. Read-only and safe to call repeatedly.",
    WatchEventsSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const durationMs = (params.duration || 30) * 1000;
        const filter: any = {};
        if (params.container) filter.container = [params.container];
        if (params.event_type && params.event_type !== "all") filter.event = [params.event_type];
        if (params.since) filter.since = [params.since];

        const events: any[] = [];
        const stream = await docker.getEvents(filter as Dockerode.GetEventsOptions) as unknown as NodeJS.ReadableStream;

        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            resolve();
          }, durationMs);

          stream.on("data", (chunk: Buffer) => {
            try {
              const event = JSON.parse(chunk.toString());
              events.push({
                type: event.Type,
                action: event.Action,
                container: event.Actor?.Attributes?.name || event.Actor?.ID?.slice(0, 12),
                time: new Date(event.time * 1000).toISOString(),
              });
            } catch {}
          });

          stream.on("error", () => {
            clearTimeout(timeout);
            resolve();
          });

          stream.on("end", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        return {
          content: [{ type: "text", text: events.length ? JSON.stringify(events, null, 2) : "No events captured in the time window." }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 4. search_logs — search logs across multiple containers
  server.tool(
    "search_logs",
    "Search Docker container logs across multiple containers using regex pattern matching. Use stream_logs for single-container log tailing; use this tool to search across multiple containers at once. Returns matching log lines with container name and line content. The pattern parameter accepts any valid regex; set ignore_case for case-insensitive matching. Returns 'No matches found.' when no lines match. Read-only and safe to call repeatedly.",
    SearchLogsSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const targetContainers = params.containers || [];
        let containers: { id: string; name: string }[];

        if (targetContainers.length > 0) {
          containers = await Promise.all(
            targetContainers.map(async (id) => {
              const info = await docker.getContainer(id).inspect();
              return { id, name: info.Name.replace(/^\//, "") };
            })
          );
        } else {
          const list = await docker.listContainers({ all: false });
          containers = list.map((c) => ({ id: c.Id, name: c.Names[0]?.replace(/^\//, "") || c.Id.slice(0, 12) }));
        }

        const regex = new RegExp(params.pattern, params.ignore_case ? "i" : "");
        const matches: any[] = [];

        for (const container of containers) {
          try {
            const logStream = await docker.getContainer(container.id).logs({
              stdout: true,
              stderr: true,
              tail: params.tail || 500,
              since: params.since ? Math.floor(new Date(params.since).getTime() / 1000) : undefined,
            });
            const output = sanitizeOutput(logStream.toString("utf-8"), 100_000);
            const lines = output.split("\n");
            for (const line of lines) {
              if (regex.test(line)) {
                matches.push({ container: container.name, line: line.trim() });
              }
            }
          } catch {}
        }

        return {
          content: [{ type: "text", text: matches.length ? JSON.stringify(matches, null, 2) : "No matches found." }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 5. check_thresholds — check all containers against thresholds
  server.tool(
    "resource_alert_check",
    "Check all running Docker containers against configurable CPU%, memory%, and restart count thresholds. Returns containers that violate thresholds with specific metrics that triggered alerts. Use container_resource_usage for raw metrics; use this tool for automated alerting. Default thresholds: 80% CPU, 80% memory, 5 restarts. Returns { violations: [...], checked: N } or { message: 'All containers within thresholds.', checked: N }. Read-only and safe to call repeatedly.",
    ResourceAlertCheckSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const cpuThreshold = params.cpu_percent ?? 80;
        const memThreshold = params.memory_percent ?? 80;
        const restartThreshold = params.restart_count ?? 5;
        const containers = await docker.listContainers({ all: false });
        const violations: any[] = [];

        for (const c of containers) {
          const info = await docker.getContainer(c.Id).inspect();
          const issues: string[] = [];

          // Check restart count
          if (info.RestartCount > restartThreshold) {
            issues.push(`restarts: ${info.RestartCount} > ${restartThreshold}`);
          }

          // Check CPU and memory
          try {
            const stats = await docker.getContainer(c.Id).stats({ stream: false });
            const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
            const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage ?? 0);
            const cpuCount = stats.cpu_stats.online_cpus ?? 1;
            const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
            const memUsage = stats.memory_stats?.usage ?? 0;
            const memLimit = stats.memory_stats?.limit ?? 1;
            const memPercent = (memUsage / memLimit) * 100;

            if (cpuPercent > cpuThreshold) issues.push(`cpu: ${Math.round(cpuPercent)}% > ${cpuThreshold}%`);
            if (memPercent > memThreshold) issues.push(`memory: ${Math.round(memPercent)}% > ${memThreshold}%`);
          } catch {}

          if (issues.length > 0) {
            violations.push({
              container: c.Names[0]?.replace(/^\//, "") || c.Id.slice(0, 12),
              id: c.Id.slice(0, 12),
              issues,
            });
          }
        }

        return {
          content: [{
            type: "text",
            text: violations.length
              ? JSON.stringify({ violations, checked: containers.length }, null, 2)
              : JSON.stringify({ message: "All containers within thresholds.", checked: containers.length }),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // 6. monitor_dashboard — single-call fleet summary
  server.tool(
    "monitor_dashboard",
    "Comprehensive Docker fleet dashboard in a single API call. Aggregates health status of all containers, top 5 CPU consumers, recent events (last 5 minutes), and threshold violations into one response. Use individual tools (container_health_status, container_resource_usage, watch_events) for targeted queries; use this for a complete fleet overview. Returns object with summary (total, running, healthy, unhealthy), top_consumers, recent_events, and violations. Read-only and safe to call repeatedly.",
    MonitorDashboardSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const containers = await docker.listContainers({ all: false });

        // Fleet health
        const health = await Promise.all(
          containers.map(async (c) => {
            const info = await docker.getContainer(c.Id).inspect();
            return {
              name: c.Names[0]?.replace(/^\//, "") || c.Id.slice(0, 12),
              state: c.State,
              health: info.State.Health?.Status || "no-healthcheck",
              restartCount: info.RestartCount,
            };
          })
        );

        // Resource usage (top 5 by CPU)
        const stats = await Promise.all(
          containers.map(async (c) => {
            try {
              const s = await docker.getContainer(c.Id).stats({ stream: false });
              const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
              const systemDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats?.system_cpu_usage ?? 0);
              const cpuCount = s.cpu_stats.online_cpus ?? 1;
              const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
              const memUsage = s.memory_stats?.usage ?? 0;
              const memLimit = s.memory_stats?.limit ?? 1;
              const memPercent = (memUsage / memLimit) * 100;
              return {
                name: c.Names[0]?.replace(/^\//, "") || c.Id.slice(0, 12),
                cpu_percent: Math.round(cpuPercent * 100) / 100,
                memory_percent: Math.round(memPercent * 100) / 100,
              };
            } catch {
              return null;
            }
          })
        );

        const topConsumers = stats.filter(Boolean).sort((a: any, b: any) => b.cpu_percent - a.cpu_percent).slice(0, 5);

        // Recent events (last 5 minutes) - use simple approach
        const recentEvents: any[] = [];
        try {
          const sinceTs = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
          const eventStream = await docker.getEvents({ since: sinceTs }) as unknown as NodeJS.ReadableStream;
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => { resolve(); }, 2000);
            eventStream.on("data", (chunk: Buffer) => {
              try {
                const e = JSON.parse(chunk.toString());
                recentEvents.push({
                  action: e.Action,
                  container: e.Actor?.Attributes?.name || e.Actor?.ID?.slice(0, 12),
                  time: new Date(e.time * 1000).toISOString(),
                });
              } catch {}
            });
            eventStream.on("error", () => { clearTimeout(timeout); resolve(); });
            eventStream.on("end", () => { clearTimeout(timeout); resolve(); });
          });
        } catch {}

        // Threshold violations
        const violations = stats.filter(Boolean).filter((s: any) => s.cpu_percent > 80 || s.memory_percent > 80);

        const dashboard = {
          summary: {
            total_containers: containers.length,
            running: containers.filter((c) => c.State === "running").length,
            unhealthy: health.filter((h) => h.health === "unhealthy").length,
          },
          health,
          top_cpu_consumers: topConsumers,
          recent_events: recentEvents.slice(0, 10),
          threshold_violations: violations,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(dashboard, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}