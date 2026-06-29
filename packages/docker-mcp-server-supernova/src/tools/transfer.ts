import Dockerode from "dockerode";
import { Readable } from "stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CopyFromContainerSchema, CopyToContainerSchema } from "../types.js";
import { formatError, withRetry } from "../docker.js";

/**
 * Read a file from a container using docker exec (cat).
 * Much simpler and more reliable than parsing getArchive tar streams.
 */
async function readFileViaExec(
  docker: Dockerode,
  containerId: string,
  filePath: string
): Promise<{ content: string; size: number }> {
  const container = docker.getContainer(containerId);

  // Create exec to cat the file
  const exec = await container.exec({
    Cmd: ["cat", filePath],
    AttachStdout: true,
    AttachStderr: true,
  });

  // Start exec and collect output
  const stream = await exec.start({ Detach: false });

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      // Docker exec streams have 8-byte headers per frame
      // Skip the header bytes (first 8 bytes of each frame)
      if (chunk.length > 8) {
        chunks.push(chunk.slice(8));
      }
    });
    stream.on("end", () => {
      const content = Buffer.concat(chunks).toString("utf-8");
      resolve({ content, size: content.length });
    });
    stream.on("error", reject);
  });
}

/**
 * Get file metadata (size, permissions) via stat command.
 */
async function getFileStat(
  docker: Dockerode,
  containerId: string,
  filePath: string
): Promise<{ size: number; mode: string; isFile: boolean }> {
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ["stat", "-c", "%s %a %f", filePath],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false });
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      if (chunk.length > 8) chunks.push(chunk.slice(8));
    });
    stream.on("end", () => {
      const output = Buffer.concat(chunks).toString("utf-8").trim();
      const [sizeStr, modeStr, typeStr] = output.split(" ");
      const size = parseInt(sizeStr, 10) || 0;
      const mode = modeStr || "644";
      const isFile = typeStr?.startsWith("81") ?? true;
      resolve({ size, mode: `0${mode}`, isFile });
    });
    stream.on("error", reject);
  });
}

/**
 * Create a minimal tar archive buffer containing a single file.
 * Used for putArchive to inject files into containers.
 */
function createSingleFileTar(
  filePath: string,
  content: string,
  mode: number
): Buffer {
  const contentBuffer = Buffer.from(content, "utf-8");
  const contentBlocks = Math.ceil(contentBuffer.length / 512);
  const totalSize = 512 + contentBlocks * 512;

  const tar = Buffer.alloc(totalSize, 0);

  // File name (100 bytes, null-terminated)
  const nameBytes = Buffer.from(filePath, "utf-8");
  nameBytes.copy(tar, 0, 0, Math.min(nameBytes.length, 100));

  // File mode (8 bytes, octal, null-padded)
  const modeStr = mode.toString(8).padStart(7, "0") + "\0";
  Buffer.from(modeStr).copy(tar, 100);

  // Owner ID (8 bytes) - 0
  Buffer.from("0000000\0").copy(tar, 108);

  // Group ID (8 bytes) - 0
  Buffer.from("0000000\0").copy(tar, 116);

  // File size (12 bytes, octal)
  const sizeStr = contentBuffer.length.toString(8).padStart(11, "0") + "\0";
  Buffer.from(sizeStr).copy(tar, 124);

  // Modification time (12 bytes, octal)
  const mtime = Math.floor(Date.now() / 1000);
  const mtimeStr = mtime.toString(8).padStart(11, "0") + "\0";
  Buffer.from(mtimeStr).copy(tar, 136);

  // Type flag (1 byte) - '0' = regular file
  tar[156] = 0x30; // '0'

  // Checksum placeholder (8 bytes)
  tar.fill(" ", 148, 156);

  // Compute checksum
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += tar[i];
  }
  const chkStr = checksum.toString(8).padStart(7, "0") + "\0";
  Buffer.from(chkStr).copy(tar, 148);

  // Copy content
  contentBuffer.copy(tar, 512);

  return tar;
}

export function registerTransferTools(
  server: McpServer,
  docker: Dockerode
): void {
  server.tool(
    "copy_from_container",
    "Copy a file from a Docker container to read its contents. Returns the file content as text along with metadata (size, permissions). Useful for inspecting config files, logs, or application state inside running containers.",
    CopyFromContainerSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const { content, size } = await withRetry(
          () => readFileViaExec(docker, params.container_id, params.container_path),
          { label: "copy_from_container" }
        );

        // Get metadata (stat)
        let mode = "0644";
        try {
          const stat = await getFileStat(
            docker,
            params.container_id,
            params.container_path
          );
          mode = stat.mode;
        } catch {
          // stat might fail if file doesn't exist, exec already validated it
        }

        const result = {
          path: params.container_path,
          content,
          size,
          mode,
          truncated: content.length > 50000,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "copy_to_container",
    "Write file content into a Docker container at the specified path. Overwrites existing files. Useful for injecting configuration files, scripts, or environment files into running or stopped containers.",
    CopyToContainerSchema.shape,
    { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        const mode = params.mode ?? 0o644;

        // Create tar archive with the file
        const tarBuffer = createSingleFileTar(
          params.container_path,
          params.content,
          mode
        );

        // putArchive expects the path to be the PARENT directory
        const parts = params.container_path.split("/");
        parts.pop(); // remove filename
        const dirPath = parts.join("/") || "/";

        const readable = Readable.from(tarBuffer);

        // Use putArchive with promise API
        await withRetry(
          () =>
            new Promise<void>((resolve, reject) => {
              container
                .putArchive(readable as any, { path: dirPath })
                .then(() => resolve())
                .catch(reject);
            }),
          { label: "copy_to_container" }
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                path: params.container_path,
                size: Buffer.byteLength(params.content, "utf-8"),
                mode: `0${(mode & 0o777).toString(8)}`,
                message: `File written to ${params.container_path} in container ${params.container_id}`,
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    }
  );
}
