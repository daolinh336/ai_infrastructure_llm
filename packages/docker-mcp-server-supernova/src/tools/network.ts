import Dockerode from 'dockerode';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CreateNetworkSchema,
  ListNetworksSchema,
  ListVolumesSchema,
  RemoveNetworkSchema,
} from '../types.js';
import { formatError, withRetry } from '../docker.js';

export function registerNetworkTools(
  server: McpServer,
  docker: Dockerode,
): void {
  server.tool(
    'list_networks',
    'List Docker networks on the local host with optional filter. Returns an array of objects with ID, name, driver (bridge/overlay/host), and scope (local/swarm). Use inspect_network (via docker inspect) for full configuration. Read-only and safe to call repeatedly.',
    ListNetworksSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const networks = await withRetry(
          () =>
            docker.listNetworks({
              filters: params.filter
                ? JSON.stringify({ name: [params.filter] })
                : undefined,
            }),
          { label: 'list_networks' },
        );
        const results = networks.map((n) => ({
          id: n.Id.substring(0, 12),
          name: n.Name,
          driver: n.Driver,
          scope: n.Scope,
          created: n.Created,
          containers: n.Containers
            ? Object.fromEntries(
                Object.entries(n.Containers).map(([id, c]) => [
                  id.substring(0, 12),
                  {
                    name: (c as { Name?: string }).Name,
                    ipv4: (c as { IPv4Address?: string }).IPv4Address,
                  },
                ]),
              )
            : {},
        }));
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
    'list_volumes',
    'List Docker volumes on the local host with optional filter. Returns an array of objects with name, driver, mountpoint, labels, and scope. Use inspect_volume for full configuration of a single volume; use create_volume to add new ones. Read-only and safe to call repeatedly.',
    ListVolumesSchema.shape,
    { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const result = await docker.listVolumes({
          filters: params.filter
            ? JSON.stringify({ name: [params.filter] })
            : undefined,
        });
        const volumes = (result.Volumes || []).map((v) => ({
          name: (v as unknown as Record<string, unknown>).Name,
          driver: (v as unknown as Record<string, unknown>).Driver,
          mountpoint: (v as unknown as Record<string, unknown>).Mountpoint,
          created:
            (v as unknown as Record<string, unknown>).CreatedAt ??
            (v as unknown as Record<string, unknown>).Created,
          labels: (v as unknown as Record<string, unknown>).Labels,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(volumes, null, 2) }],
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
    'create_network',
    'Create a Docker network with optional driver and labels. Returns network ID and name. Idempotent callers should list networks first.',
    CreateNetworkSchema.shape,
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const network = await withRetry(
          () =>
            docker.createNetwork({
              Name: params.name,
              Driver: params.driver || 'bridge',
              Labels: params.labels,
            }),
          { label: 'create_network' },
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { id: network.id, name: params.name },
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

  server.tool(
    'remove_network',
    'Remove a Docker network by ID or name. Returns a confirmation string. Destructive for that network resource.',
    RemoveNetworkSchema.shape,
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const network = docker.getNetwork(params.network_id);
        await withRetry(() => network.remove(), { label: 'remove_network' });
        return {
          content: [
            { type: 'text', text: `Network ${params.network_id} removed.` },
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
