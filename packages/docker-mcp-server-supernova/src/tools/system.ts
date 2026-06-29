import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DockerInfoSchema, DiskUsageSchema } from "../types.js";
import { formatError, withRetry } from "../docker.js";

interface DockerInfoResult {
  ServerVersion: string;
  OperatingSystem: string;
  KernelVersion: string;
  Architecture: string;
  NCPU: number;
  MemTotal: number;
  DockerRootDir: string;
  Driver: string;
  ContainersRunning: number;
  ContainersStopped: number;
  ContainersPaused: number;
  Images: number;
  Labels: string[];
  ID: string;
}

interface DiskUsageImage {
  Id: string;
  RepoTags: string[];
  Size: number;
  Containers: number;
}

interface DiskUsageContainer {
  Id: string;
  Name: string;
  Image: string;
  Size: number;
  Reclaimable: boolean;
}

interface DiskUsageVolume {
  Name: string;
  Size: number;
  Reclaimable: boolean;
}

interface DiskUsageBuildCache {
  ID: string;
  Type: string;
  Description: string;
  Size: number;
  InUse: boolean;
}

interface DiskUsageResult {
  LayersSize: number;
  Images: DiskUsageImage[];
  Containers: DiskUsageContainer[];
  Volumes: DiskUsageVolume[];
  BuildCache: DiskUsageBuildCache[];
}

export function registerSystemTools(server: McpServer, docker: Dockerode): void {
  server.tool(
    "docker_info",
    "Get Docker daemon system information: server version, OS, kernel, CPU count, memory total, storage driver, and runtime. Returns a JSON object with all daemon metadata. Use disk_usage for space breakdown. Read-only and safe to call repeatedly.",
    DockerInfoSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const info = (await withRetry(() => docker.info(), { label: "docker_info" })) as DockerInfoResult;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              server_version: info.ServerVersion,
              os: info.OperatingSystem,
              kernel: info.KernelVersion,
              architecture: info.Architecture,
              cpus: info.NCPU,
              memory_total: info.MemTotal,
              memory_total_human: formatBytes(info.MemTotal),
              docker_root: info.DockerRootDir,
              storage_driver: info.Driver,
              containers_running: info.ContainersRunning,
              containers_stopped: info.ContainersStopped,
              containers_paused: info.ContainersPaused,
              images: info.Images,
              labels: info.Labels,
              server_id: info.ID,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  server.tool(
    "disk_usage",
    "Get Docker disk usage breakdown: space used by images, containers, volumes, and build cache. Shows total and per-item sizes with reclaimable space. Use docker_info for daemon metadata; use list_images/list_containers for item details. Read-only and safe to call repeatedly.",
    DiskUsageSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const df = (await withRetry(() => docker.df(), { label: "disk_usage" })) as DiskUsageResult;

        const images = (df.Images || []).map((img) => ({
          id: img.Id?.substring(0, 19),
          tags: img.RepoTags || [],
          size: img.Size,
          size_human: formatBytes(img.Size),
          containers: img.Containers,
        }));

        const containers = (df.Containers || []).map((c) => ({
          id: c.Id?.substring(0, 12),
          name: c.Name,
          image: c.Image,
          size: c.Size,
          size_human: formatBytes(c.Size),
          reclaimable: c.Reclaimable,
        }));

        const volumes = (df.Volumes || []).map((v) => ({
          name: v.Name,
          size: v.Size,
          size_human: formatBytes(v.Size),
          reclaimable: v.Reclaimable,
        }));

        const buildCache = (df.BuildCache || []).map((bc) => ({
          id: bc.ID,
          type: bc.Type,
          description: bc.Description?.substring(0, 120),
          size: bc.Size,
          size_human: formatBytes(bc.Size),
          in_use: bc.InUse,
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              summary: {
                images: { count: df.LayersSize ? images.length : 0, total_size: df.LayersSize, total_human: formatBytes(df.LayersSize || 0) },
                containers: { count: containers.length },
                volumes: { count: volumes.length },
                build_cache: { count: buildCache.length, total_human: formatBytes(buildCache.reduce((sum, bc) => sum + (bc.size || 0), 0)) },
              },
              images,
              containers,
              volumes,
              build_cache: buildCache.slice(0, 10), // Top 10 only
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
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}