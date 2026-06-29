import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListImagesSchema,
  PullImageSchema,
  BuildImageSchema,
  RemoveImageSchema,
  PruneImagesSchema,
} from "../types.js";
import { formatImage, formatError, withRetry } from "../docker.js";

export function registerImageTools(server: McpServer, docker: Dockerode): void {
  server.tool(
    "list_images",
    "List Docker images on the local host with optional filters. Returns an array of objects with ID, tags, size (bytes), and creation date. Use inspect_image (via docker inspect) for full metadata. Read-only and safe to call repeatedly. Returns an empty array if no images match the filter.",
    ListImagesSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const images = await withRetry(() => docker.listImages({
          all: params.all ?? false,
          filters: params.filter ? JSON.stringify({ reference: [params.filter] }) : undefined,
        }), { label: "list_images" });
        const results = images.map(formatImage);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "pull_image",
    "Pull a Docker image from a registry by image name (e.g. nginx:latest). Use list_images to see locally available images after pulling. Returns pull progress events as text. Idempotent: pulling an already-up-to-date image is a no-op. Returns an error string if the image does not exist on the registry or the pull fails.",
    PullImageSchema.shape,
    { idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const imageRef = params.tag ? `${params.image}:${params.tag}` : params.image;
        const stream = await docker.pull(imageRef);
        // Wait for pull to complete
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return { content: [{ type: "text", text: `Image ${imageRef} pulled successfully.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "build_image",
    "Build a Docker image from a Dockerfile or build context directory. The path should contain a Dockerfile or point to a directory with one. Use tag to name the resulting image (e.g., myapp:latest). Returns build output log. Use list_images to verify the build succeeded. Returns an error string if the Dockerfile is missing or the build fails.",
    BuildImageSchema.shape,
    { idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const stream = await docker.buildImage(
          {
            context: params.context,
            src: [params.dockerfile ?? "Dockerfile"],
          },
          { t: params.tag, dockerfile: params.dockerfile, buildargs: params.build_args, target: params.target }
        );
        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return { content: [{ type: "text", text: `Image ${params.tag} built successfully.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "remove_image",
    "Remove a Docker image by name or ID. Use force=true to remove even if tagged or referenced by stopped containers. Use list_images to find image IDs; use prune_images to remove all unused images. Returns a confirmation string. Returns an error string if the image does not exist or is in use without force.",
    RemoveImageSchema.shape,
    { destructiveHint: true, openWorldHint: false },
    async (params) => {
      try {
        const image = docker.getImage(params.image);
        await image.remove({ force: params.force ?? false });
        return { content: [{ type: "text", text: `Image ${params.image} removed.` }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  // prune_images — remove unused Docker images
  server.tool(
    "prune_images",
    "Remove unused Docker images (dangling and unreferenced). Returns the number of images deleted and reclaimed disk space. Only removes images not used by any container. Use list_images first to see what will be removed. Useful for reclaiming disk space after builds or when switching base images frequently.",
    PruneImagesSchema.shape,
    { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => {
      try {
        const filterObj: Record<string, string[]> = {};
        if (params.filter) {
          try {
            const parsed = JSON.parse(params.filter);
            Object.assign(filterObj, parsed);
          } catch {
            // If not JSON, try key=value format
            const parts = params.filter.split('=');
            if (parts.length === 2) {
              filterObj[parts[0]] = [parts[1]];
            }
          }
        }
        const result = await withRetry(
          () => docker.pruneImages({ filters: filterObj }),
          { label: "prune_images" }
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              images_deleted: (result.ImagesDeleted || []).length,
              space_reclaimed: result.SpaceReclaimed || 0,
              space_reclaimed_human: formatBytes(result.SpaceReclaimed || 0),
              deleted_ids: (result.ImagesDeleted || []).map((img: any) =>
                typeof img === 'string' ? img.substring(0, 19) : img.Deleted?.substring(0, 19) || 'unknown'
              ),
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}