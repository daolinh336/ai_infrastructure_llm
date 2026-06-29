import Dockerode from 'dockerode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListContainersSchema,
  InspectContainerSchema,
  StartContainerSchema,
  StopContainerSchema,
  RestartContainerSchema,
  RemoveContainerSchema,
  RecreateContainerSchema,
  RunContainerSchema,
  PruneContainersSchema,
  UpdateContainerSchema,
} from '../types.js';
import { formatContainer, formatError, withRetry } from '../docker.js';

export function registerContainerTools(
  server: McpServer,
  docker: Dockerode,
): void {
  server.tool(
    'list_containers',
    'List Docker containers with optional filters (state, name, label). Returns an array of objects with ID, name, image, state (running/exited/etc.), ports, and labels. Use all=true to include stopped containers (default shows only running). Use inspect_container for full configuration of a single container. Read-only and safe to call repeatedly.',
    ListContainersSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const containers = await withRetry(
          () =>
            docker.listContainers({
              all: params.all ?? false,
              filters: JSON.stringify({
                ...(params.label ? { label: params.label } : {}),
                ...(params.name ? { name: [`/${params.name}`] } : {}),
                ...(params.state ? { status: [params.state] } : {}),
              }),
            }),
          { label: 'list_containers' },
        );
        const results = containers.map(formatContainer);
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'inspect_container',
    'Get detailed configuration and state of a Docker container by ID or name. Returns full JSON including image, command, environment variables, network settings, mount points, restart policy, and health status. Use list_containers to find container IDs; use container_stats for resource usage. Returns an error string if the container does not exist.',
    InspectContainerSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        const info = await container.inspect();
        return {
          content: [{ type: 'text', text: JSON.stringify(info, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'start_container',
    'Start a stopped Docker container by ID or name. Use list_containers to find stopped containers (state=exited). Returns a confirmation string on success. Idempotent: starting an already-running container is a no-op. Returns an error string if the container does not exist.',
    StartContainerSchema.shape,
    { idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        await withRetry(() => container.start(), { label: 'start_container' });
        return {
          content: [
            { type: 'text', text: `Container ${params.container_id} started.` },
          ],
        };
      } catch (error: any) {
        // 304 means container is already running — start is idempotent.
        if (error?.statusCode === 304) {
          return {
            content: [
              {
                type: 'text',
                text: `Container ${params.container_id} was already started.`,
              },
            ],
          };
        }
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'stop_container',
    'Stop a running Docker container by ID or name with optional timeout. Sends SIGTERM, then SIGKILL after timeout seconds (default 10s). Use restart_container to restart without stopping; use remove_container to delete entirely. Returns a confirmation string. Handles the 304 already-stopped case gracefully. Returns an error string if the container does not exist.',
    StopContainerSchema.shape,
    { destructiveHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        await withRetry(() => container.stop({ t: params.timeout ?? 10 }), {
          label: 'stop_container',
        });
        return {
          content: [
            { type: 'text', text: `Container ${params.container_id} stopped.` },
          ],
        };
      } catch (error: any) {
        // 304 means container is already stopped — treat as success
        if (error?.statusCode === 304) {
          return {
            content: [
              {
                type: 'text',
                text: `Container ${params.container_id} was already stopped.`,
              },
            ],
          };
        }
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'restart_container',
    'Restart a Docker container by ID or name with optional timeout. This tears down the running process and starts a new one — use stop_container for a graceful shutdown or remove_container to delete entirely. The timeout parameter (default 10s) controls how long to wait before force-killing. Returns a confirmation string on success. Idempotent: restarting an already-stopped container starts it again. Returns an error string if the container does not exist or is not running.',
    RestartContainerSchema.shape,
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        await withRetry(() => container.restart({ t: params.timeout ?? 10 }), {
          label: 'restart_container',
        });
        return {
          content: [
            {
              type: 'text',
              text: `Container ${params.container_id} restarted.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'remove_container',
    'Remove a Docker container by ID or name. Requires the container to be stopped first unless force=true is set (which stops and removes in one step). Use stop_container for graceful shutdown; use restart_container to restart. Returns a confirmation string. Returns an error string if the container does not exist or is running without force.',
    RemoveContainerSchema.shape,
    { destructiveHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        await container.remove({ force: params.force ?? false });
        return {
          content: [
            { type: 'text', text: `Container ${params.container_id} removed.` },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'recreate_container',
    'Recreate a Docker container with the same configuration (stop, remove, re-create). Useful for applying config changes without手动编写 run commands. Preserves image, env, ports, volumes, and labels from the original. Returns a confirmation string with the new container ID. Returns an error string if the original container does not exist.',
    RecreateContainerSchema.shape,
    { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const container = docker.getContainer(params.container_id);
        const info = await container.inspect();

        // Stop and remove
        try {
          await container.stop({ t: params.timeout ?? 10 });
        } catch {
          /* already stopped */
        }
        await container.remove({ force: true });

        // Re-create with same config
        const createOpts: Dockerode.ContainerCreateOptions = {
          name: info.Name.replace(/^\//, ''),
          Image: info.Config.Image,
          Env: info.Config.Env,
          Cmd: info.Config.Cmd,
          WorkingDir: info.Config.WorkingDir,
          Labels: info.Config.Labels || {},
          HostConfig: {
            Binds: info.HostConfig?.Binds,
            PortBindings: info.HostConfig?.PortBindings,
            RestartPolicy: info.HostConfig?.RestartPolicy,
            NetworkMode: info.HostConfig?.NetworkMode,
          },
        };

        const newContainer = await docker.createContainer(createOpts);
        await newContainer.start();
        return {
          content: [
            {
              type: 'text',
              text: `Container recreated and started. New ID: ${newContainer.id.substring(0, 12)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'run_container',
    'Create and start a new Docker container with one command. Supports image, env, ports, volumes, restart policy, and command override. Auto-pulls missing images.',
    RunContainerSchema.shape,
    { openWorldHint: false },
    async (params) => {
      try {
        const createOpts: Dockerode.ContainerCreateOptions = {
          Image: params.image,
          name: params.name,
          Env: params.env
            ? Object.entries(params.env).map(([k, v]) => `${k}=${v}`)
            : undefined,
          Cmd: params.command,
          ExposedPorts: params.ports
            ? Object.fromEntries(Object.keys(params.ports).map((k) => [k, {}]))
            : undefined,
          HostConfig: {
            NetworkMode: params.network,
            PortBindings: params.ports
              ? Object.fromEntries(
                  Object.entries(params.ports).map(
                    ([containerPort, hostBinding]) => [
                      containerPort,
                      [{ HostPort: hostBinding }],
                    ],
                  ),
                )
              : undefined,
            Binds: params.volumes,
            RestartPolicy: params.restart_policy
              ? { Name: params.restart_policy, MaximumRetryCount: 0 }
              : undefined,
          },
          Labels: params.labels,
        };

        let container;
        try {
          container = await docker.createContainer(createOpts);
        } catch (createError: any) {
          // Auto-pull if image not found (HTTP 404)
          if (
            createError?.statusCode === 404 &&
            /no such image|No such image/i.test(createError.message || '')
          ) {
            const stream = await docker.pull(params.image);
            await new Promise<void>((resolve, reject) => {
              docker.modem.followProgress(stream, (err: Error | null) => {
                if (err) reject(err);
                else resolve();
              });
            });
            container = await docker.createContainer(createOpts);
          } else {
            throw createError;
          }
        }

        await container.start();
        return {
          content: [
            {
              type: 'text',
              text: `Container created and started. ID: ${container.id.substring(0, 12)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // prune_containers — remove stopped containers
  server.tool(
    'prune_containers',
    'Remove all stopped Docker containers. Returns the number of containers removed and reclaimed disk space. This is a destructive operation — stopped containers and their non-persisted data will be deleted. Use list_containers first to see what will be removed. Useful for cleanup after deployments or when disk space is low.',
    PruneContainersSchema.shape,
    { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => {
      try {
        const filterObj: Record<string, string[]> = {};
        if (params.filter) {
          const separatorIndex = params.filter.indexOf('=');
          if (separatorIndex <= 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Error: prune_containers filter must use key=value format.',
                },
              ],
              isError: true,
            };
          }
          const key = params.filter.slice(0, separatorIndex);
          const value = params.filter.slice(separatorIndex + 1);
          filterObj[key] = [value];
        }
        const result = await withRetry(
          () =>
            docker.pruneContainers({
              filters:
                Object.keys(filterObj).length > 0 ? filterObj : undefined,
            }),
          { label: 'prune_containers' },
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  containers_deleted: (result.ContainersDeleted || []).length,
                  space_reclaimed: result.SpaceReclaimed || 0,
                  space_reclaimed_human: formatBytes(
                    result.SpaceReclaimed || 0,
                  ),
                  deleted_ids: (result.ContainersDeleted || []).map(
                    (id: string) => id.substring(0, 12),
                  ),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // update_container — update container resource limits
  server.tool(
    'update_container',
    "Update a Docker container's resource limits (CPU, memory, CPU shares). Requires the container to be stopped first. Returns the updated resource limits. Use this to right-size containers based on actual usage — set CPU limits to prevent runaway processes and memory limits to prevent OOM kills.",
    UpdateContainerSchema.shape,
    { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    async (params) => {
      try {
        const updateConfig: Record<string, any> = {};
        if (params.cpu_limit !== undefined) {
          updateConfig.NanoCpus = Math.round(params.cpu_limit * 1e9);
        }
        if (params.memory_limit !== undefined) {
          updateConfig.Memory = parseMemory(params.memory_limit);
        }
        if (params.cpu_shares !== undefined) {
          updateConfig.CpuShares = params.cpu_shares;
        }

        if (Object.keys(updateConfig).length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: No resource limits specified. Provide at least one of: cpu_limit, memory_limit, cpu_shares.',
              },
            ],
            isError: true,
          };
        }

        const container = docker.getContainer(params.container_id);
        await withRetry(() => container.update(updateConfig), {
          label: 'update_container',
        });

        // Inspect to return current state
        const info = await withRetry(() => container.inspect(), {
          label: 'update_container_inspect',
        });
        const hostConfig = info.HostConfig || {};

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  container: params.container_id,
                  state: info.State?.Status,
                  resource_limits: {
                    cpu_limit_cores: hostConfig.NanoCpus
                      ? hostConfig.NanoCpus / 1e9
                      : null,
                    memory_limit: hostConfig.Memory || null,
                    memory_limit_human: hostConfig.Memory
                      ? formatBytes(hostConfig.Memory)
                      : null,
                    cpu_shares: hostConfig.CpuShares || null,
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true,
        };
      }
    },
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function parseMemory(mem: string): number {
  const match = mem.match(/^(\d+)(b|k|m|g|t)?$/i);
  if (!match) throw new Error(`Invalid memory format: ${mem}`);
  const value = parseInt(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
    t: 1024 ** 4,
  };
  return value * (multipliers[unit] || 1);
}
