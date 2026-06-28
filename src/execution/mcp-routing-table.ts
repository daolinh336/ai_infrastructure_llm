// --- Route Types ---

/** Classification of an MCP route as read-only or mutating. */
export type RouteCategory = 'read' | 'mutate';

/** A single route mapping an agent operation to an MCP tool. */
export interface McpRouteDefinition {
  /** Human-readable operation name used by agent code (e.g. 'listContainers') */
  operation: string;
  /** MCP tool name on the server (e.g. 'ps') */
  mcpToolName: string;
  /** Whether this tool reads state or mutates it */
  category: RouteCategory;
  /** Brief description for logging and debugging */
  description: string;
  /** Whether this route can remove or replace existing resources. */
  destructive: boolean;
  /** Whether this route requires an approved action context. */
  approvalRequired: boolean;
  /** Operational risk used by policy/tests/docs. */
  riskLevel: 'low' | 'medium' | 'high';
}

// --- Docker MCP Routes (Static Registry) ---

/**
 * Canonical routing table for the Docker MCP server.
 *
 * Each entry maps a typed operation name (used in agent/execution code)
 * to the MCP tool name exposed by `mcp-server-docker`.
 *
 * Security note: grep `category: 'mutate'` to audit all mutation routes.
 */
export const DOCKER_MCP_ROUTES: ReadonlyArray<McpRouteDefinition> = [
  // --- Read-only ---
  { operation: 'listContainers',    mcpToolName: 'list_containers',             category: 'read',   description: 'List Docker containers', destructive: false, approvalRequired: false, riskLevel: 'low' },
  { operation: 'inspectContainer',  mcpToolName: 'inspect_container',        category: 'read',   description: 'Inspect a container and return detailed config/state', destructive: false, approvalRequired: false, riskLevel: 'low' },
  { operation: 'listImages',        mcpToolName: 'list_images',         category: 'read',   description: 'List Docker images', destructive: false, approvalRequired: false, riskLevel: 'low' },
  { operation: 'listNetworks',      mcpToolName: 'list_networks',     category: 'read',   description: 'List Docker networks', destructive: false, approvalRequired: false, riskLevel: 'low' },
  { operation: 'listVolumes',       mcpToolName: 'list_volumes',      category: 'read',   description: 'List Docker volumes', destructive: false, approvalRequired: false, riskLevel: 'low' },
  // --- Mutate ---
  { operation: 'pullImage',         mcpToolName: 'pull_image',           category: 'mutate', description: 'Pull a Docker image', destructive: false, approvalRequired: true, riskLevel: 'medium' },
  { operation: 'createContainer',   mcpToolName: 'create_container',            category: 'mutate', description: 'Create and run a container', destructive: false, approvalRequired: true, riskLevel: 'medium' },
  { operation: 'startContainer',    mcpToolName: 'start_container',          category: 'mutate', description: 'Start a stopped container', destructive: false, approvalRequired: true, riskLevel: 'medium' },
  { operation: 'stopContainer',     mcpToolName: 'stop_container',           category: 'mutate', description: 'Stop a running container', destructive: true, approvalRequired: true, riskLevel: 'high' },
  { operation: 'restartContainer',  mcpToolName: 'recreate_container',        category: 'mutate', description: 'Restart a container', destructive: true, approvalRequired: true, riskLevel: 'high' },
  { operation: 'removeContainer',   mcpToolName: 'remove_container',             category: 'mutate', description: 'Remove a container', destructive: true, approvalRequired: true, riskLevel: 'high' },
  { operation: 'removeImage',       mcpToolName: 'remove_image',            category: 'mutate', description: 'Remove an image', destructive: true, approvalRequired: true, riskLevel: 'high' },
  { operation: 'createNetwork',     mcpToolName: 'create_network', category: 'mutate', description: 'Create a Docker network', destructive: false, approvalRequired: true, riskLevel: 'medium' },
  { operation: 'removeNetwork',     mcpToolName: 'remove_network',     category: 'mutate', description: 'Remove a Docker network', destructive: true, approvalRequired: true, riskLevel: 'high' },
  { operation: 'createVolume',      mcpToolName: 'create_volume',  category: 'mutate', description: 'Create a Docker volume', destructive: false, approvalRequired: true, riskLevel: 'medium' },
  { operation: 'removeVolume',      mcpToolName: 'remove_volume',      category: 'mutate', description: 'Remove a Docker volume', destructive: true, approvalRequired: true, riskLevel: 'high' },
];

// --- McpRoutingTable ---

/**
 * Explicit routing table that maps typed operation names to MCP tool routes.
 *
 * The routing table is the single source of truth for which operations
 * exist and whether they are read-only or mutating. This makes security
 * auditing trivial: inspect the route registry to see all possible actions.
 */
export class McpRoutingTable {
  private readonly routeMap: Map<string, McpRouteDefinition>;

  constructor(routes: ReadonlyArray<McpRouteDefinition> = DOCKER_MCP_ROUTES) {
    this.routeMap = new Map();
    for (const route of routes) {
      if (this.routeMap.has(route.operation)) {
        throw new Error('Duplicate route operation: ' + route.operation);
      }
      this.routeMap.set(route.operation, route);
    }
  }

  /**
   * Resolve an operation name to its route definition.
   * @throws Error if the operation is not registered.
   */
  resolve(operation: string): McpRouteDefinition {
    const route = this.routeMap.get(operation);
    if (!route) {
      throw new Error(
        'Unknown MCP route operation: "' + operation + '". ' +
        'Registered operations: ' + [...this.routeMap.keys()].join(', '),
      );
    }
    return route;
  }

  /** Check whether an operation is classified as read-only. */
  isReadOnly(operation: string): boolean {
    return this.resolve(operation).category === 'read';
  }

  /** Check whether an operation is classified as mutating. */
  isMutating(operation: string): boolean {
    return this.resolve(operation).category === 'mutate';
  }

  /** Get all routes for a given category. */
  getRoutesByCategory(category: RouteCategory): McpRouteDefinition[] {
    return [...this.routeMap.values()].filter((r) => r.category === category);
  }

  /** List all registered operation names. */
  listOperations(): string[] {
    return [...this.routeMap.keys()];
  }

  /** Total number of registered routes. */
  get size(): number {
    return this.routeMap.size;
  }
}
