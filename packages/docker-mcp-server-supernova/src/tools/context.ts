import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListContextsSchema, UseContextSchema, InspectContextSchema } from "../types.js";
import { formatError, withRetry } from "../docker.js";

interface DockerContext {
  Name: string;
  ContextMetadata?: {
    Description?: string;
    "Stack Orchestrator"?: string;
  };
  Endpoints: Record<string, any>;
}

export function registerContextTools(server: McpServer, docker: Dockerode): void {
  // list_contexts — list all Docker contexts
  server.tool(
    "list_contexts",
    "List all Docker contexts on the host. Docker contexts allow switching between multiple Docker daemon endpoints (local, remote via SSH, remote via TCP, cloud providers). Each context has a name, description, and endpoint configuration. Use use_context to switch the active context.",
    ListContextsSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        // Use Docker CLI via exec since Dockerode doesn't expose context API directly
        const container = await docker.createContainer({
          Image: "docker:latest",
          Cmd: ["context", "ls", "--format", "{{json .}}"],
          HostConfig: {
            Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
            AutoRemove: true,
          },
        });

        await container.start();
        await container.wait();

        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        const output = logs.toString("utf-8").trim();
        const lines = output.split("\n").filter(l => l.trim());

        const contexts = lines.map(line => {
          try {
            const parsed = JSON.parse(line);
            return {
              name: parsed.Name,
              description: parsed.Description || "",
              orchestrator: parsed["Stack Orchestrator"] || "swarm",
              docker_endpoint: parsed.DockerEndpoint || "",
              current: (parsed.Name || "").includes("*") || line.includes("*"),
            };
          } catch {
            // Fallback: parse plain text format
            const parts = line.split(/\s+/);
            const name = parts[0]?.replace("*", "").trim();
            return {
              name,
              description: parts.slice(1).join(" "),
              current: line.includes("*"),
            };
          }
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total_contexts: contexts.length,
              current: contexts.find(c => c.current)?.name || "default",
              contexts,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  // use_context — switch the active Docker context
  server.tool(
    "use_context",
    "Switch the active Docker context to a different endpoint. This changes which Docker daemon subsequent commands target (local, remote SSH, remote TCP, or cloud). Use list_contexts to see available contexts. Changing context affects all subsequent Docker operations in this session.",
    UseContextSchema.shape,
    { destructiveHint: false, openWorldHint: false },
    async (params) => {
      try {
        const container = await docker.createContainer({
          Image: "docker:latest",
          Cmd: ["context", "use", params.context_name],
          HostConfig: {
            Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
            AutoRemove: true,
          },
        });

        await container.start();
        await container.wait();

        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        const output = logs.toString("utf-8").trim();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "switched",
              context: params.context_name,
              message: output || `Active context set to ${params.context_name}`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  // inspect_context — get detailed info about a Docker context
  server.tool(
    "inspect_context",
    "Get detailed configuration for a Docker context including endpoint type (unix, tcp, ssh), host address, default orchestrator, and any TLS settings. Use this to verify context configuration before switching or to troubleshoot connection issues.",
    InspectContextSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = await docker.createContainer({
          Image: "docker:latest",
          Cmd: ["context", "inspect", params.context_name],
          HostConfig: {
            Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
            AutoRemove: true,
          },
        });

        await container.start();
        await container.wait();

        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        const output = logs.toString("utf-8").trim();

        try {
          const contextData = JSON.parse(output);
          const metadata = contextData.Metadata || {};
          const endpoints = contextData.Endpoints || {};

          // Extract endpoint details
          const endpointInfo: Record<string, any> = {};
          for (const [name, ep] of Object.entries(endpoints) as [string, any][]) {
            endpointInfo[name] = {
              host: ep.Host || "unix:///var/run/docker.sock",
              skip_verify: ep.SkipVerify || false,
              default_addr: ep.DefaultAddr || "",
            };
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                name: contextData.Name,
                description: metadata.Description || "",
                orchestrator: metadata["Stack Orchestrator"] || "swarm",
                endpoints: endpointInfo,
                raw: contextData,
              }, null, 2),
            }],
          };
        } catch {
          // Return raw output if JSON parsing fails
          return {
            content: [{
              type: "text",
              text: `Context ${params.context_name}:\n${output}`,
            }],
          };
        }
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}
