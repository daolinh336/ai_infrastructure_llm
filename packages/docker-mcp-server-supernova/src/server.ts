import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Dockerode from "dockerode";
import { registerContainerTools } from "./tools/container.js";
import { registerImageTools } from "./tools/image.js";
import { registerComposeTools } from "./tools/compose.js";
import { registerHealthTools } from "./tools/health.js";
import { registerLogsTools } from "./tools/logs.js";
import { registerExecTools } from "./tools/exec.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerVolumeTools } from "./tools/volume.js";
import { registerMonitoringTools } from "./tools/monitoring.js";
import { registerSystemTools } from "./tools/system.js";
import { registerTransferTools } from "./tools/transfer.js";
import { registerRegistryTools } from "./tools/registry.js";
import { registerSecurityTools } from "./tools/security.js";
import { registerContextTools } from "./tools/context.js";

export interface ServerOptions {
  timeoutMs?: number;
}

export function createServer(docker: Dockerode, options?: ServerOptions): McpServer {
  const server = new McpServer({
    name: "docker-mcp-server",
    version: "0.4.1",
  });

  // Register all tool categories
  registerContainerTools(server, docker);
  registerImageTools(server, docker);
  registerComposeTools(server);
  registerHealthTools(server, docker);
  registerLogsTools(server, docker);
  registerExecTools(server, docker);
  registerNetworkTools(server, docker);
  registerVolumeTools(server, docker);
  registerMonitoringTools(server, docker);
  registerSystemTools(server, docker);
  registerTransferTools(server, docker);
  registerRegistryTools(server, docker);
  registerSecurityTools(server, docker);
  registerContextTools(server, docker);

  return server;
}