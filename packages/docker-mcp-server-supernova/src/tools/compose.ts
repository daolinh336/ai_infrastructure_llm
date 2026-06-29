import { execSync, exec as execCb } from "child_process";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ComposeUpSchema,
  ComposeDownSchema,
  ComposePsSchema,
  ComposeLogsSchema,
  ComposeRestartSchema,
} from "../types.js";
import { formatError, sanitizeOutput } from "../docker.js";

const execAsync = promisify(execCb);

const COMPOSE_FILE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

function resolveComposePath(inputPath: string): string {
  // If it's already a file that exists, use it directly
  if (existsSync(inputPath) && statSync(inputPath).isFile()) {
    return inputPath;
  }
  // If it's a directory, look for compose files inside it
  if (existsSync(inputPath) && statSync(inputPath).isDirectory()) {
    for (const name of COMPOSE_FILE_NAMES) {
      const filePath = join(inputPath, name);
      if (existsSync(filePath)) return filePath;
    }
    throw new Error(`No docker-compose.yml found in ${inputPath}. Looked for: ${COMPOSE_FILE_NAMES.join(", ")}`);
  }
  // Path doesn't exist — pass it through and let Docker produce the error
  return inputPath;
}

function runCompose(path: string, args: string[]): string {
  const filePath = resolveComposePath(path);
  try {
    const result = execSync(`docker compose -f "${filePath}" ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 30000,
    });
    return result.trim();
  } catch (error: unknown) {
    const err = error as { stderr?: string; stdout?: string };
    throw new Error(err.stderr || err.stdout || formatError(error));
  }
}

export function registerComposeTools(server: McpServer): void {
  server.tool(
    "compose_up",
    "Bring up Docker Compose services from a docker-compose.yml file at path. Use compose_ps to check service states after bringing them up; use compose_logs to inspect output. Optionally rebuild images before starting (build=true). Returns a confirmation string listing which services were started. Idempotent: already-running services are left untouched. Returns an error string if the Compose file is missing or invalid.",
    ComposeUpSchema.shape,
    { idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const args = ["up", "-d"];
        if (params.build) args.push("--build");
        if (params.services?.length) args.push(...params.services);
        const output = runCompose(params.path, args);
        return { content: [{ type: "text", text: output || "Compose services started." }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "compose_down",
    "Tear down Docker Compose services defined by docker-compose.yml at path. Stops and removes containers, networks created by compose_up. Use volumes=true to also remove named volumes (destructive — data is lost). Returns a confirmation string listing stopped services. Use compose_ps to verify teardown. Returns an error string if the Compose file is missing.",
    ComposeDownSchema.shape,
    { destructiveHint: true, openWorldHint: false },
    async (params) => {
      try {
        const args = ["down"];
        if (params.volumes) args.push("-v");
        if (params.timeout) args.push(`--timeout ${params.timeout}`);
        const output = runCompose(params.path, args);
        return { content: [{ type: "text", text: output || "Compose services stopped." }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "compose_ps",
    "List service states across a Docker Compose stack defined by docker-compose.yml at path. Returns an array of services with name, state (running, exited, etc.), health status, and port mappings. Use compose_up to start services; use compose_logs to inspect output. Read-only and safe to call repeatedly. Returns an error string if the Compose file is missing.",
    ComposePsSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const output = runCompose(params.path, ["ps", "--format", "json"]);
        const lines = output.split("\n").filter(Boolean);
        const services = lines.map((line) => {
          try { return JSON.parse(line); } catch { return { raw: line }; }
        });
        return { content: [{ type: "text", text: JSON.stringify(services, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "compose_logs",
    "Tail logs from one or more services in a Docker Compose stack defined by docker-compose.yml at path. Use this for multi-service log inspection; for single-container logs use stream_logs instead. The services filter limits output to named services; tail controls how many recent lines to return (default 100); follow=true streams new lines until cancelled. Returns UTF-8 log text with stream headers stripped, or 'No logs found.' when the stack has not produced output. Read-only and safe to call repeatedly. Returns an error string if path does not resolve to a Compose project.",
    ComposeLogsSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const args = ["logs", "--tail", String(params.tail ?? 100)];
        if (params.follow) args.push("-f");
        if (params.services?.length) args.push(...params.services);
        const output = runCompose(params.path, args);
        // Use 100KB cap for log output to keep LLM context small
        return { content: [{ type: "text", text: sanitizeOutput(output, 100_000) || "No logs found." }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "compose_restart",
    "Restart Docker Compose services defined by docker-compose.yml at path. Restart specific services or the entire stack. Unlike stop+start, this preserves container configuration. The timeout parameter controls how long to wait before force-killing (default 10s). Returns a confirmation string. Use compose_ps to verify state after restart. Returns an error string if the Compose file is missing.",
    ComposeRestartSchema.shape,
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const args = ["restart"];
        if (params.timeout) args.push(`--timeout ${params.timeout}`);
        if (params.services?.length) args.push(...params.services);
        const output = runCompose(params.path, args);
        return { content: [{ type: "text", text: output || "Compose services restarted." }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}