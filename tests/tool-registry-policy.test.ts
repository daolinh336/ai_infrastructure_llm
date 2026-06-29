import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentToolRegistry, AgentToolRegistryError } from '../src/agent/tool-registry.js';
import { defineAgentTool } from '../src/agent/tool-types.js';
import { DockerMcpGateway } from '../src/execution/docker-mcp-gateway.js';
import { buildCapabilityReport, resolveDockerMcpRuntimeProfile, resolveRoutesForServerTools } from '../src/execution/docker-mcp-profile.js';
import { DOCKER_MCP_ROUTES, McpRoutingTable } from '../src/execution/mcp-routing-table.js';
import { evaluateToolPolicy } from '../src/execution/tool-policy.js';

describe('AgentToolRegistry', () => {
  it('rejects duplicate internal tool names', () => {
    const tool = defineAgentTool({
      name: 'load_state',
      description: 'load state',
      category: 'read',
      async invoke() {
        return { ok: true, observation: 'ok', data: null };
      },
    });

    expect(() => new AgentToolRegistry([tool, tool])).toThrow(AgentToolRegistryError);
  });

  it('validates tool input and output schemas', async () => {
    const registry = new AgentToolRegistry([
      defineAgentTool({
        name: 'echo',
        description: 'echo string length',
        category: 'plan',
        inputSchema: z.object({ value: z.string() }),
        outputSchema: z.object({ length: z.number() }),
        async invoke(input) {
          const typed = input as { value: string };
          return { ok: true, observation: 'echoed', data: { length: typed.value.length } };
        },
      }),
    ]);

    await expect(registry.invoke('echo', { value: 'abc' })).resolves.toMatchObject({
      ok: true,
      data: { length: 3 },
    });
    await expect(registry.invoke('echo', { value: 1 })).resolves.toMatchObject({ ok: false });
  });
});

describe('tool policy', () => {
  it('allows read tools in dry-run', () => {
    expect(evaluateToolPolicy('read', { dryRun: true, approved: false })).toMatchObject({
      allowed: true,
    });
  });

  it('blocks mutation tools without approval', () => {
    expect(evaluateToolPolicy('mutate', { dryRun: false, approved: false })).toMatchObject({
      allowed: false,
    });
  });

  it('blocks destructive tools in dry-run', () => {
    expect(evaluateToolPolicy('destructive', { dryRun: true, approved: true })).toMatchObject({
      allowed: false,
    });
  });
});

describe('Docker MCP route metadata', () => {
  it('keeps all runtime routes explicitly categorized', () => {
    const table = new McpRoutingTable();

    expect(table.size).toBe(16);
    expect(DOCKER_MCP_ROUTES.filter((route) => route.category === 'read')).toHaveLength(5);
    expect(DOCKER_MCP_ROUTES.filter((route) => route.category === 'mutate')).toHaveLength(11);
    expect(DOCKER_MCP_ROUTES.filter((route) => route.destructive)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'removeContainer' }),
        expect.objectContaining({ operation: 'removeNetwork' }),
        expect.objectContaining({ operation: 'removeVolume' }),
      ]),
    );
  });

  it('uses the local Supernova Docker MCP server profile by default', () => {
    const profile = resolveDockerMcpRuntimeProfile({});

    expect(profile).toEqual({
      name: 'supernova-local',
      command: 'node',
      args: ['packages/docker-mcp-server-supernova/dist/index.js'],
    });
  });

  it('allows explicit env overrides and the official Docker MCP profile', () => {
    expect(resolveDockerMcpRuntimeProfile({ INFRA_DOCKER_MCP_PROFILE: 'official' })).toMatchObject({
      name: 'official',
      command: 'docker',
      args: ['mcp', 'gateway', 'run'],
    });
    expect(resolveDockerMcpRuntimeProfile({
      INFRA_DOCKER_MCP_COMMAND: 'custom-mcp',
      INFRA_DOCKER_MCP_ARGS: '["serve","docker"]',
    })).toMatchObject({ name: 'supernova-local', command: 'custom-mcp', args: ['serve', 'docker'] });
  });

  it('maps internal operations to official-style docker-prefixed tool aliases', () => {
    const routes = resolveRoutesForServerTools([
      { name: 'docker_list_containers' },
      { name: 'docker_inspect_container' },
    ]);
    const table = new McpRoutingTable(routes);

    expect(table.resolve('listContainers').mcpToolName).toBe('docker_list_containers');
    expect(table.resolve('inspectContainer').mcpToolName).toBe('docker_inspect_container');
  });

  it('reports missing inspect capability instead of silently falling back', () => {
    const report = buildCapabilityReport([{ name: 'list_containers' }], ['inspectContainer']);

    expect(report.missingOperations).toEqual(['inspectContainer']);
  });

  it('accepts the Supernova Docker MCP tool surface for deploy operations', () => {
    const supernovaTools = [
      'list_containers',
      'inspect_container',
      'list_images',
      'list_networks',
      'list_volumes',
      'pull_image',
      'run_container',
      'start_container',
      'stop_container',
      'remove_container',
      'create_network',
      'remove_network',
      'create_volume',
      'remove_volume',
    ].map((name) => ({ name }));

    const report = buildCapabilityReport(supernovaTools, [
      'listContainers',
      'inspectContainer',
      'pullImage',
      'createContainer',
      'createNetwork',
      'removeNetwork',
      'createVolume',
      'removeVolume',
    ]);

    expect(report.missingOperations).toEqual([]);
    expect(new McpRoutingTable(resolveRoutesForServerTools(supernovaTools)).resolve('createContainer').mcpToolName)
      .toBe('run_container');
  });

  it('maps container creation arguments to the Supernova run_container schema', async () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });
    const executeRoute = vi.fn().mockResolvedValue('Container created and started. ID: abc123');

    (gateway as unknown as { executeRoute: typeof executeRoute }).executeRoute = executeRoute;

    await gateway.createContainer({
      name: 'demo-web',
      image: 'nginx:stable',
      command: ['nginx', '-g', 'daemon off;'],
      ports: ['8080:80'],
      environment: { APP_ENV: 'smoke' },
      volumes: ['/tmp/demo:/usr/share/nginx/html'],
      networks: ['demo-network'],
      labels: { 'infra-react-agent.operation-id': 'op-1' },
    });

    expect(executeRoute).toHaveBeenCalledWith('createContainer', {
      image: 'nginx:stable',
      name: 'demo-web',
      command: ['nginx', '-g', 'daemon off;'],
      ports: { '80/tcp': '8080' },
      env: { APP_ENV: 'smoke' },
      volumes: ['/tmp/demo:/usr/share/nginx/html'],
      network: 'demo-network',
      labels: { 'infra-react-agent.operation-id': 'op-1' },
      detach: true,
    });
  });

  it('keeps mutation tools blocked before approval at the gateway layer', async () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });
    (gateway as unknown as { plug: { isConnected: boolean; callTool: () => Promise<string> } }).plug = {
      isConnected: true,
      callTool: async () => 'ok',
    };

    await expect(gateway.createNetwork('blocked-network')).rejects.toThrow('requires allowMutations=true');
  });
});
