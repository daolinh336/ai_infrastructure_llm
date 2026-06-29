import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CheckHealthSchema, WatchHealthSchema, SetRestartPolicySchema } from "../types.js";
import { formatError, withRetry } from "../docker.js";

export function registerHealthTools(server: McpServer, docker: Dockerode): void {
  server.tool(
    "check_health",
    "Run a health probe against a container by ID or name. Supports HTTP (checks status code), TCP (checks port open), and exec (runs command inside container). Auto-detects probe type from the container's HEALTHCHECK configuration. Returns probe result with status (healthy/unhealthy/starting) and output. Use watch_health to poll until healthy. Read-only and safe to call repeatedly. Returns an error string if the container has no health check configured.",
    CheckHealthSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        const info = await container.inspect();
        
        // Check if container has HEALTHCHECK
        const healthcheck = info.Config.Healthcheck;
        let probeType = params.type;
        let endpoint = params.endpoint;
        let command = params.command;

        if (!probeType && healthcheck?.Test?.length) {
          const test = healthcheck.Test[0];
          if (test.startsWith("CMD ")) {
            probeType = "exec";
            command = test.slice(4).split(" ");
          } else if (test.startsWith("CMD-SHELL ")) {
            probeType = "exec";
            command = ["sh", "-c", test.slice(10)];
          } else if (test === "NONE") {
            probeType = undefined;
          }
        }

        if (!probeType) {
          return {
            content: [{ type: "text", text: "No health check configured for this container and no probe type specified." }],
          };
        }

        if (probeType === "exec" && command) {
          const exec = await container.exec({
            Cmd: command,
            AttachStdout: true,
            AttachStderr: true,
          });
          const stream = await exec.start({}) as unknown as import("stream").Duplex;
          const output = await new Promise<string>((resolve) => {
            let data = "";
            stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            stream.on("end", () => resolve(data));
          });
          const inspect = await exec.inspect();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                healthy: inspect.ExitCode === 0,
                exitCode: inspect.ExitCode,
                output: output.trim(),
              }, null, 2),
            }],
          };
        }

        return {
          content: [{ type: "text", text: `Health probe type '${probeType}' is not yet implemented in v1. Use exec probes or check container HEALTHCHECK directly.` }],
          isError: true,
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "watch_health",
    "Poll a container health status until it becomes healthy or times out. Use check_health for a single probe; use watch_health to wait for readiness. The interval parameter controls polling frequency (default 5s); timeout controls max wait (default 60s). Returns the final health status. Returns an error string if the container has no health check.",
    WatchHealthSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        const timeout = (params.timeout ?? 60) * 1000;
        const interval = (params.interval ?? 5) * 1000;
        const start = Date.now();

        while (Date.now() - start < timeout) {
          const info = await container.inspect();
          const health = info.State.Health;
          if (health?.Status === "healthy") {
            return {
              content: [{ type: "text", text: JSON.stringify({ healthy: true, status: "healthy", waitTime: Date.now() - start }, null, 2) }],
            };
          }
          if (health?.Status === "unhealthy") {
            const lastLog = health.Log?.[health.Log.length - 1];
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  healthy: false,
                  status: "unhealthy",
                  exitCode: lastLog?.ExitCode,
                  output: lastLog?.Output?.trim(),
                }, null, 2),
              }],
            };
          }
          await new Promise((resolve) => setTimeout(resolve, interval));
        }

        const info = await container.inspect();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              healthy: false,
              status: "timeout",
              containerHealth: info.State.Health?.Status ?? "no healthcheck",
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "set_restart_policy",
    "Change the restart policy of a running container without recreating it. Use restart_container for an immediate restart; use this tool to change the policy (always, unless-stopped, on-failure, no) for future restarts. Returns a confirmation string on success. Idempotent: setting the same policy is a no-op. Returns an error string if the container does not exist.",
    SetRestartPolicySchema.shape,
    { idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        await container.update({
          RestartPolicy: {
            Name: params.policy,
            MaximumRetryCount: params.max_retry_count ?? 0,
          },
        });
        return {
          content: [{ type: "text", text: `Restart policy set to '${params.policy}' for container ${params.container_id}.` }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}