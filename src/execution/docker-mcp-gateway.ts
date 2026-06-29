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
import {
  McpConnectionPlug,
  type McpConnectionPlugOptions,
  type McpToolDefinition,
} from './mcp-connection-plug.js';
import {
  McpRoutingTable,
  DOCKER_MCP_ROUTES,
  type McpRouteDefinition,
} from './mcp-routing-table.js';
import {
  parseContainerList,
  parseInspectResult,
  parseInspectSummaryResult,
  parseImageList,
  parseNamedResourceList,
  extractContainerIdFromRunResult,
} from './docker-mcp-parsers.js';
import {
  buildCapabilityReport,
  resolveDockerMcpRuntimeProfile,
  resolveRoutesForServerTools,
  type DockerMcpCapabilityReport,
} from './docker-mcp-profile.js';
import type {
  RuntimeContainerObservation,
  RuntimeContainerSummary,
  RuntimeImageObservation,
  RuntimeNamedResourceObservation,
} from '../domain/types.js';
import {
  DockerMutationSafetyError,
  type ContainerCreateSpec,
} from '../domain/types.js';
import { evaluateToolPolicy } from './tool-policy.js';

// --- Options ---

export interface DockerMcpGatewayOptions {
  /** Command to spawn the MCP server (default: 'node') */
  command?: string;
  /** Arguments for the command (default: ['packages/docker-mcp-server-supernova/dist/index.js']) */
  args?: string[];
  /** Timeout for individual MCP requests in milliseconds */
  requestTimeoutMs?: number;
  /** Skip the MCP initialize handshake (for testing) */
  skipInitialize?: boolean;
  /** Custom routing table (default: DOCKER_MCP_ROUTES) */
  routes?: ReadonlyArray<McpRouteDefinition>;
}

const READ_OPERATIONS = [
  'listContainers',
  'inspectContainer',
  'listImages',
  'listNetworks',
  'listVolumes',
] as const;
const MUTATE_OPERATIONS = [
  'pullImage',
  'createContainer',
  'startContainer',
  'stopContainer',
  'restartContainer',
  'removeContainer',
  'removeImage',
  'createNetwork',
  'removeNetwork',
  'createVolume',
  'removeVolume',
] as const;

// --- DockerMcpGateway ---

export class DockerMcpGateway {
  /** The underlying MCP transport connection. */
  readonly plug: McpConnectionPlug;
  /** The operation→tool routing table. */
  readonly routes: McpRoutingTable;

  private allowMutationsInternal = false;
  private readonly baseRoutes: ReadonlyArray<McpRouteDefinition>;
  private readonly runtimeProfile = resolveDockerMcpRuntimeProfile();
  private readonly commandInternal: string;
  private readonly argsInternal: string[];
  private capabilityReportInternal: DockerMcpCapabilityReport | null = null;

  constructor(options: DockerMcpGatewayOptions = {}) {
    this.commandInternal = options.command ?? this.runtimeProfile.command;
    this.argsInternal = options.args ?? this.runtimeProfile.args;
    const plugOptions: McpConnectionPlugOptions = {
      command: this.commandInternal,
      args: this.argsInternal,
    };
    if (options.requestTimeoutMs !== undefined) {
      plugOptions.requestTimeoutMs = options.requestTimeoutMs;
    }
    if (options.skipInitialize !== undefined) {
      plugOptions.skipHandshake = options.skipInitialize;
    }
    this.baseRoutes = options.routes ?? DOCKER_MCP_ROUTES;
    this.plug = new McpConnectionPlug(plugOptions);
    this.routes = new McpRoutingTable(this.baseRoutes);
  }

  // --- Lifecycle ---

  get isInitialized(): boolean {
    return this.plug.isConnected;
  }

  get runtimeProfileName(): string {
    return this.runtimeProfile.name;
  }

  get serverInfo(): { name: string; version: string } | null {
    return this.plug.serverInfo;
  }

  get connectionCommand(): { command: string; args: string[] } {
    return { command: this.commandInternal, args: [...this.argsInternal] };
  }

  async initialize(): Promise<void> {
    try {
      await this.plug.connect();
    } catch (error) {
      throw new Error(
        'Docker MCP gateway initialization failed. Build the Supernova MCP server with `npm run build:supernova-mcp` and ensure Docker Engine is reachable. Cause: ' +
          inspectErrorMessage(error),
      );
    }
    await this.preflightReadCapabilities();
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

  get capabilityReport(): DockerMcpCapabilityReport | null {
    return this.capabilityReportInternal;
  }

  async preflightCapabilities(
    operations: ReadonlyArray<string> = [
      ...READ_OPERATIONS,
      ...MUTATE_OPERATIONS,
    ],
  ): Promise<DockerMcpCapabilityReport> {
    let tools: McpToolDefinition[];
    try {
      tools = await this.listServerTools();
    } catch (error) {
      throw new Error(
        'Docker MCP capability preflight failed during tools/list. ' +
          'Build the Supernova MCP server and ensure it exposes Docker runtime tools. Cause: ' +
          inspectErrorMessage(error),
      );
    }
    const resolvedRoutes = resolveRoutesForServerTools(tools, this.baseRoutes);
    const report = buildCapabilityReport(tools, operations, resolvedRoutes);
    this.replaceRoutes(resolvedRoutes);
    this.capabilityReportInternal = report;
    if (report.missingOperations.length > 0) {
      throw new Error(
        'Docker MCP capability preflight failed. Missing required operation(s): ' +
          report.missingOperations.join(', ') +
          '. Supernova Docker MCP server must expose these Docker runtime capabilities. Available tools: ' +
          (report.toolNames.join(', ') || '(none)'),
      );
    }
    return report;
  }

  async preflightReadCapabilities(): Promise<DockerMcpCapabilityReport> {
    return this.preflightCapabilities(READ_OPERATIONS);
  }

  async preflightMutationCapabilities(
    operations: ReadonlyArray<string>,
  ): Promise<DockerMcpCapabilityReport> {
    return this.preflightCapabilities([
      ...new Set([...READ_OPERATIONS, ...operations]),
    ]);
  }

  // --- Read-only methods ---

  async listContainers(all?: boolean): Promise<RuntimeContainerObservation[]> {
    const result = await this.executeRoute('listContainers', {
      all: all ?? false,
    });
    return parseContainerList(result);
  }

  async inspectContainer(
    containerName: string,
  ): Promise<RuntimeContainerObservation | null> {
    const result = await this.executeRoute('inspectContainer', {
      container_id: containerName,
    });
    return parseInspectResult(result, containerName);
  }

  async inspectContainerSummary(
    containerName: string,
  ): Promise<RuntimeContainerSummary | null> {
    const result = await this.executeRoute('inspectContainer', {
      container_id: containerName,
    });
    return parseInspectSummaryResult(result, containerName);
  }

  async readContainerLogs(
    _containerName: string,
    _tailLines = 80,
  ): Promise<string | null> {
    return null;
  }

  async listUsedHostPorts(): Promise<
    Array<{ hostPort: string; containerName: string }>
  > {
    const containers = await this.listContainers(true);
    return containers.flatMap((container) =>
      (container.ports ?? [])
        .map((port) => port.split(':')[0]?.trim() ?? '')
        .filter((hostPort) => /^\d+$/.test(hostPort))
        .map((hostPort) => ({ hostPort, containerName: container.name })),
    );
  }

  /**
   * Whether the connected MCP server exposes an inspect-capable tool.
   * Returns false until the server has been queried via listServerTools().
   */
  async supportsInspect(): Promise<boolean> {
    const tools = await this.listServerTools();
    const report = buildCapabilityReport(
      tools,
      ['inspectContainer'],
      this.baseRoutes,
    );
    return report.missingOperations.length === 0;
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
    if (spec.command && spec.command.length > 0) args.command = spec.command;
    if (spec.ports && spec.ports.length > 0)
      args.ports = mapPortBindings(spec.ports);
    if (spec.environment) args.env = spec.environment;
    if (spec.volumes && spec.volumes.length > 0) args.volumes = spec.volumes;
    if (spec.networks && spec.networks.length > 0)
      args.network = spec.networks[0];
    if (spec.labels && Object.keys(spec.labels).length > 0)
      args.labels = spec.labels;
    args.detach = true;
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
    await this.executeRoute('restartContainer', {
      container_id: containerName,
      image: '',
    });
  }

  async removeContainer(containerName: string): Promise<void> {
    await this.executeRoute('removeContainer', {
      container_id: containerName,
      force: true,
    });
  }

  async removeImage(ref: string): Promise<void> {
    await this.executeRoute('removeImage', { image: ref });
  }

  async createNetwork(
    name: string,
    labels?: Record<string, string>,
  ): Promise<void> {
    const args: Record<string, unknown> = { name };
    if (labels && Object.keys(labels).length > 0) args.labels = labels;
    await this.executeRoute('createNetwork', args);
  }

  async removeNetwork(name: string): Promise<void> {
    await this.executeRoute('removeNetwork', { network_id: name });
  }

  async createVolume(
    name: string,
    labels?: Record<string, string>,
  ): Promise<void> {
    const args: Record<string, unknown> = { name };
    if (labels && Object.keys(labels).length > 0) args.labels = labels;
    await this.executeRoute('createVolume', args);
  }

  async observeActualState(): Promise<
    import('../domain/types.js').RuntimeActualState
  > {
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

  /**
   * Observe actual runtime state, enriching each container with detailed
   * inspect data (image, status, ports, environment) when the MCP server
   * exposes an inspect tool.
   *
   * When inspect is unavailable, containers fall back to list-only data.
   * In that case environment remains undefined, which lets drift detection
   * mark runtime evidence as uncertain instead of reporting a false OK.
   */
  async observeActualStateWithInspect(
    options: { containerNames?: string[] } = {},
  ): Promise<import('../domain/types.js').RuntimeActualState> {
    const [containers, networks, volumes, images] = await Promise.all([
      this.listContainers(true),
      this.listNetworks(),
      this.listVolumes(),
      this.listImages(),
    ]);

    const candidateNames = options.containerNames?.length
      ? options.containerNames
      : containers.map((c) => c.name);
    const inspected = await Promise.all(
      candidateNames.map((name) => this.inspectContainer(name)),
    );
    const inspectedMap = new Map(
      inspected
        .filter((c): c is RuntimeContainerObservation => c !== null)
        .map((c) => [c.name, c]),
    );
    const enrichedContainers = containers.map((container) => {
      const inspectedContainer = inspectedMap.get(container.name);
      return inspectedContainer ?? container;
    });

    return {
      source: 'mcp-readonly',
      containers: enrichedContainers,
      networks,
      volumes,
      images,
      lastObservedAt: new Date().toISOString(),
    };
  }

  async removeVolume(name: string): Promise<void> {
    await this.executeRoute('removeVolume', { name, force: true });
  }

  // --- Internal: route resolution + approval guard + tool call ---

  private async executeRoute(
    operation: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!this.plug.isConnected) {
      throw new Error(
        'DockerMcpGateway is not initialized. Call initialize() before invoking tools.',
      );
    }
    const route = this.routes.resolve(operation);

    const policy = evaluateToolPolicy(
      route.destructive ? 'destructive' : route.category,
      {
        dryRun: !this.allowMutationsInternal,
        approved: this.allowMutationsInternal,
      },
    );
    if (!policy.allowed) {
      throw new DockerMutationSafetyError(route.mcpToolName);
    }

    return this.plug.callTool(route.mcpToolName, args);
  }

  private replaceRoutes(routes: ReadonlyArray<McpRouteDefinition>): void {
    (this as { routes: McpRoutingTable }).routes = new McpRoutingTable(routes);
  }
}

function inspectErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapImageReference(ref: string): Record<string, unknown> {
  const colonIndex = ref.lastIndexOf(':');
  if (colonIndex > -1 && !ref.slice(colonIndex + 1).includes('/')) {
    return { image: ref.slice(0, colonIndex), tag: ref.slice(colonIndex + 1) };
  }
  return { image: ref };
}

function mapPortBindings(ports: string[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const port of ports) {
    const [host, container] = port.split(':');
    if (!host || !container) continue;
    bindings[container + '/tcp'] = host;
  }
  return bindings;
}
