import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CreateVolumeSchema,
  InspectVolumeSchema,
  RemoveVolumeSchema,
  PruneVolumesSchema,
} from "../types.js";
import { formatError, withRetry } from "../docker.js";

export function registerVolumeTools(server: McpServer, docker: Dockerode): void {
  server.tool(
    "create_volume",
    "Create a Docker volume with optional driver, labels, and options. Returns volume name, driver, and mount point. Use inspect_volume to verify creation; use list_volumes to see all volumes. Returns an error string if the volume name is already in use.",
    CreateVolumeSchema.shape,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const result = await withRetry(() => docker.createVolume({
          Name: params.name,
          Driver: params.driver || "local",
          Labels: params.labels,
          DriverOpts: params.options,
        }), { label: "create_volume" });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: result.Name,
              driver: result.Driver,
              mountpoint: result.Mountpoint,
              created: result.CreatedAt,
              labels: result.Labels,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "inspect_volume",
    "Inspect a Docker volume by name. Returns detailed info including name, driver, mountpoint, labels, scope, and options. Use list_volumes to find volume names; use remove_volume to delete. Returns an error string if the volume does not exist.",
    InspectVolumeSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const volume = docker.getVolume(params.name);
        const info = await volume.inspect();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name: info.Name,
              driver: info.Driver,
              mountpoint: info.Mountpoint,
              labels: info.Labels,
              scope: info.Scope,
              options: info.Options,
              status: info.Status || null,
              usage: info.UsageData || null,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "remove_volume",
    "Remove a Docker volume by name. Requires the volume to be unused unless force=true is set (which removes even if mounted). Use prune_volumes to remove all unused volumes at once. Returns a confirmation string. Returns an error string if the volume does not exist.",
    RemoveVolumeSchema.shape,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const volume = docker.getVolume(params.name);
        await volume.remove({ force: params.force || false });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, name: params.name, message: `Volume '${params.name}' removed` }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "prune_volumes",
    "Remove all unused Docker volumes (not mounted by any container). Returns the number of volumes removed and reclaimed disk space. Use list_volumes to see what exists before pruning. Safe to call repeatedly — no-op when no unused volumes exist.",
    PruneVolumesSchema.shape,
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (params) => {
      try {
        const filters: Record<string, string[]> = {};
        if (params.filter) {
          const match = params.filter.match(/label=(.+)/);
          if (match) {
            filters.label = [match[1]];
          }
        }
        const result = await docker.pruneVolumes({
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              volumes_deleted: result.VolumesDeleted || [],
              space_reclaimed: result.SpaceReclaimed || 0,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}