#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDockerClient, checkDockerConnection } from "./docker.js";
import { createServer } from "./server.js";

const DEFAULT_TIMEOUT_MS = 30_000;

async function main() {
  const docker = createDockerClient();

  // Startup health check: verify Docker daemon is reachable
  const health = await checkDockerConnection(docker);
  if (!health.ok) {
    process.stderr.write(`${health.error}\n`);
    process.exit(1);
  }
  process.stderr.write("Docker daemon reachable\n");

  const server = createServer(docker, { timeoutMs: DEFAULT_TIMEOUT_MS });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("Docker MCP Server running on stdio\n");
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
