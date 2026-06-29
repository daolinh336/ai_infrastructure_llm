import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ExecInContainerSchema } from "../types.js";
import { formatError, sanitizeOutput } from "../docker.js";

export function registerExecTools(server: McpServer, docker: Dockerode): void {
  server.tool(
    "exec_in_container",
    "Execute a command inside a running Docker container by ID or name. Returns stdout, stderr, and exit code as JSON. Use start_container to ensure the container is running first. The command is executed as the container's default user unless user is specified. Returns an error string if the container is not running or the command fails.",
    ExecInContainerSchema.shape,
    { openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        const exec = await container.exec({
          Cmd: params.command,
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: params.working_dir,
          Env: params.env ? Object.entries(params.env).map(([k, v]) => `${k}=${v}`) : undefined,
        });

        const stream = await exec.start({});
        const output = await new Promise<string>((resolve) => {
          let data = "";
          stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          stream.on("end", () => resolve(data));
        });

        const inspect = await exec.inspect();
        const cleanOutput = sanitizeOutput(output);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              exitCode: inspect.ExitCode,
              stdout: cleanOutput,
              stderr: "",
            }, null, 2),
          }],
          isError: inspect.ExitCode !== 0,
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}