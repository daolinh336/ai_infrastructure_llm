/**
 * DockerMcpGateway — Facade combining McpConnectionPlug + McpRoutingTable + ApprovalGuard.
 *
 * This replaces the original DockerMcpClient monolith with a layered design:
 *   1. McpConnectionPlug  — generic MCP transport (JSON-RPC, subprocess)
 *   2. McpRoutingTable    — explicit operation→tool routing with read/mutate classification
 *   3. ApprovalGuard      — mutation gate (setAllowMutations) that blocks mutate routes
 *
 * The public API surface is identical to the original DockerMcpClient so all
 * consumers can migrate by changing only their import.
 */
import { McpConnectionPlug, type McpConnectionPlugOptions, type McpToolDefinition } from './mcp-connection-plug.js';
import { McpRoutingTable, DOCKER_MCP_ROUTES, type McpRouteDefinition } from './mcp-routing-table.js';
import {
  parseContainerList,
  parseInspectResult,
  parseImageList,
  parseNamedResourceList,
  extractContainerIdFromRunResult,
} from './docker-mcp-parsers.js';
import type {
  RuntimeContainerObservation,
  RuntimeImageObservation,
  RuntimeNamedResourceObservation,
} from '../domain/types.js';
import { DockerMutationSafetyError, type ContainerCreateSpec } from '../domain/types.js';

// --- Options ---

export interface DockerMcpGatewayOptions {
  /** Command to spawn the MCP server (default: 'npx') */
  command?: string;
  /** Arguments for the command (default: ['mcp-server-docker']) */
  args?: string[];
  /** Timeout for individual MCP requests in milliseconds */
  requestTimeoutMs?: number;
  /** Skip the MCP initialize handshake (for testing) */
  skipInitialize?: boolean;
  /** Custom routing table (default: DOCKER_MCP_ROUTES) */
  routes?: ReadonlyArray<McpRouteDefinition>;
}

const DEFAULT_COMMAND = 'uvx';
const DEFAULT_ARGS = ['mcp-server-docker'];

// --- DockerMcpGateway ---

export class DockerMcpGateway {
  /** The underlying MCP transport connection. */
  readonly plug: McpConnectionPlug;
  /** The operation→tool routing table. */
  readonly routes: McpRoutingTable;

  private allowMutationsInternal = false;

  constructor(options: DockerMcpGatewayOptions = {}) {
    const plugOptions: McpConnectionPlugOptions = {
      command: options.command ?? DEFAULT_COMMAND,
      args: options.args ?? DEFAULT_ARGS,
    };
    if (options.requestTimeoutMs !== undefined) {
      plugOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    if (options.skipInitialize !== undefined) {
      plugOptions.skipHandshake = options.skipInitialize;
    }
    this.plug = new McpConnectionPlug(plugOptions);
    this.routes = new McpRoutingTable(options.routes ?? DOCKER_MCP_ROUTES);
  }

  // --- Lifecycle ---

  get isInitialized(): boolean {
    return this.plug.isConnected;
  }

  async initialize(): Promise<void> {
    await this.plug.connect();
  }

  async shutdown(): Promise<void> {
    this.allowMutationsInternal = false;
    await this.plug.disconnect();
  }

  // --- Mutation gate ---

  setAllowMutations(allow: boolean): void {
    this.allowMutationsInternal = allow;
  }

  getAllowMutations(): boolean {
    return this.allowMutationsInternal;
  }

  // --- Server capability query ---

  /**
   * Query the MCP server for its list of available tools.
   * Useful for validating routes against actual server capabilities.
   */
  async listServerTools(): Promise<McpToolDefinition[]> {
    return this.plug.listTools();
  }

  // --- Read-only methods ---

  async listContainers(all?: boolean): Promise<RuntimeContainerObservation[]> {
    const result = await this.executeRoute('listContainers', { all: all ?? false });
    return parseContainerList(result);
  }

  async inspectContainer(containerName: string): Promise<RuntimeContainerObservation | null> {
    const result = await this.executeRoute('inspectContainer', { container: containerName });
    return parseInspectResult(result, containerName);
  }

  async listImages(): Promise<RuntimeImageObservation[]> {
    const result = await this.executeRoute('listImages', { all: false });
    return parseImageList(result);
  }

  async listNetworks(): Promise<RuntimeNamedResourceObservation[]> {
    const result = await this.executeRoute('listNetworks', {});
    return parseNamedResourceList(result, 'network');
  }

  async listVolumes(): Promise<RuntimeNamedResourceObservation[]> {
    const result = await this.executeRoute('listVolumes', {});
    return parseNamedResourceList(result, 'volume');
  }

  // --- Mutate methods (require allowMutations = true) ---

  async pullImage(ref: string): Promise<void> {
    await this.executeRoute('pullImage', mapImageReference(ref));
  }

  async createContainer(spec: ContainerCreateSpec): Promise<string> {
    const args: Record<string, unknown> = {
      image: spec.image,
      name: spec.name,
    };
    if (spec.ports && spec.ports.length > 0) args.ports = mapPortBindings(spec.ports);
    if (spec.environment) args.environment = spec.environment;
    if (spec.volumes && spec.volumes.length > 0) args.volumes = spec.volumes;
    if (spec.networks && spec.networks.length > 0) args.network = spec.networks[0];
    const result = await this.executeRoute('createContainer', args);
    return extractContainerIdFromRunResult(result, spec.name);
  }

  async startContainer(containerName: string): Promise<void> {
    await this.executeRoute('startContainer', { container_id: containerName });
  }

  async stopContainer(containerName: string): Promise<void> {
    await this.executeRoute('stopContainer', { container_id: containerName });
  }

  async restartContainer(containerName: string): Promise<void> {
    await this.executeRoute('restartContainer', { container_id: containerName, image: '' });
  }

  async removeContainer(containerName: string): Promise<void> {
    await this.executeRoute('removeContainer', { container_id: containerName, force: true });
  }

  async removeImage(ref: string): Promise<void> {
    await this.executeRoute('removeImage', { image: ref });
  }

  async createNetwork(name: string): Promise<void> {
    await this.executeRoute('createNetwork', { name });
  }

  async removeNetwork(name: string): Promise<void> {
    await this.executeRoute('removeNetwork', { network_id: name });
  }

  async createVolume(name: string): Promise<void> {
    await this.executeRoute('createVolume', { name });
  }

  async observeActualState(): Promise<import('../domain/types.js').RuntimeActualState> {
    const [containers, networks, volumes, images] = await Promise.all([
      this.listContainers(true),
      this.listNetworks(),
      this.listVolumes(),
      this.listImages(),
    ]);
    return {
      source: 'mcp-readonly',
      containers,
      networks,
      volumes,
      images,
      lastObservedAt: new Date().toISOString(),
    };
  }

  async removeVolume(name: string): Promise<void> {
    await this.executeRoute('removeVolume', { volume_name: name, force: true });
  }

  // --- Internal: route resolution + approval guard + tool call ---

  private async executeRoute(operation: string, args: Record<string, unknown>): Promise<string> {
    if (!this.plug.isConnected) {
      throw new Error('DockerMcpGateway is not initialized. Call initialize() before invoking tools.');
    }
    const route = this.routes.resolve(operation);

    if (route.category === 'mutate' && !this.allowMutationsInternal) {
      throw new DockerMutationSafetyError(route.mcpToolName);
    }

    return this.plug.callTool(route.mcpToolName, args);
  }
}


function mapImageReference(ref: string): Record<string, unknown> {
  const colonIndex = ref.lastIndexOf(':');
  if (colonIndex > -1 && !ref.slice(colonIndex + 1).includes('/')) {
    return { repository: ref.slice(0, colonIndex), tag: ref.slice(colonIndex + 1) };
  }
  return { repository: ref };
}

function mapPortBindings(ports: string[]): Record<string, number> {
  const bindings: Record<string, number> = {};
  for (const port of ports) {
    const [host, container] = port.split(':');
    if (!host || !container) continue;
    bindings[container + '/tcp'] = Number(host);
  }
  return bindings;
}
