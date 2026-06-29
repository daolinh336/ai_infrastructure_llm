import type { McpToolDefinition } from './mcp-connection-plug.js';
import {
  DOCKER_MCP_ROUTES,
  type McpRouteDefinition,
} from './mcp-routing-table.js';

export type DockerMcpProfileName =
  | 'supernova-local'
  | 'legacy-uvx'
  | 'official';

export interface DockerMcpRuntimeProfile {
  name: DockerMcpProfileName;
  command: string;
  args: string[];
}

export interface DockerMcpCapabilityReport {
  checkedOperations: string[];
  missingOperations: string[];
  toolNames: string[];
}

const SUPERNOVA_LOCAL_PROFILE: DockerMcpRuntimeProfile = {
  name: 'supernova-local',
  command: 'node',
  args: ['packages/docker-mcp-server-supernova/dist/index.js'],
};

const LEGACY_UVX_PROFILE: DockerMcpRuntimeProfile = {
  name: 'legacy-uvx',
  command: 'uvx',
  args: ['mcp-server-docker'],
};

const OFFICIAL_PROFILE: DockerMcpRuntimeProfile = {
  name: 'official',
  command: 'docker',
  args: ['mcp', 'gateway', 'run'],
};

const ROUTE_ALIASES: Record<string, string[]> = Object.fromEntries(
  DOCKER_MCP_ROUTES.map((route) => [
    route.operation,
    [route.mcpToolName, dockerNamespaceAlias(route.mcpToolName)],
  ]),
);

export function resolveDockerMcpRuntimeProfile(
  env: NodeJS.ProcessEnv = process.env,
): DockerMcpRuntimeProfile {
  const requestedProfile = env.INFRA_DOCKER_MCP_PROFILE?.trim();
  const baseProfile =
    requestedProfile === 'legacy-uvx'
      ? LEGACY_UVX_PROFILE
      : requestedProfile === 'official'
        ? OFFICIAL_PROFILE
        : SUPERNOVA_LOCAL_PROFILE;
  const command = env.INFRA_DOCKER_MCP_COMMAND?.trim() || baseProfile.command;
  const args = env.INFRA_DOCKER_MCP_ARGS
    ? parseMcpArgs(env.INFRA_DOCKER_MCP_ARGS)
    : [...baseProfile.args];

  return { name: baseProfile.name, command, args };
}

export function resolveRoutesForServerTools(
  tools: ReadonlyArray<McpToolDefinition>,
  routes: ReadonlyArray<McpRouteDefinition> = DOCKER_MCP_ROUTES,
): ReadonlyArray<McpRouteDefinition> {
  const availableToolNames = new Set(tools.map((tool) => tool.name));
  return routes.map((route) => ({
    ...route,
    mcpToolName: resolveToolName(
      route.operation,
      route.mcpToolName,
      availableToolNames,
    ),
  }));
}

export function buildCapabilityReport(
  tools: ReadonlyArray<McpToolDefinition>,
  operations: ReadonlyArray<string>,
  routes: ReadonlyArray<McpRouteDefinition> = DOCKER_MCP_ROUTES,
): DockerMcpCapabilityReport {
  const resolvedRoutes = resolveRoutesForServerTools(tools, routes);
  const routeByOperation = new Map(
    resolvedRoutes.map((route) => [route.operation, route]),
  );
  const toolNames = tools.map((tool) => tool.name).sort();
  const missingOperations = operations.filter((operation) => {
    const route = routeByOperation.get(operation);
    return !route || !toolNames.includes(route.mcpToolName);
  });

  return {
    checkedOperations: [...operations],
    missingOperations,
    toolNames,
  };
}

function resolveToolName(
  operation: string,
  canonicalToolName: string,
  availableToolNames: Set<string>,
): string {
  const aliases = ROUTE_ALIASES[operation] ?? [canonicalToolName];
  const directMatch = aliases.find((alias) => availableToolNames.has(alias));
  if (directMatch) return directMatch;

  const normalizedAliases = new Set(aliases.map(normalizeToolName));
  const normalizedOperation = normalizeToolName(operation);
  for (const toolName of availableToolNames) {
    const normalizedToolName = normalizeToolName(toolName);
    if (
      normalizedAliases.has(normalizedToolName) ||
      normalizedToolName.endsWith(normalizedOperation)
    ) {
      return toolName;
    }
  }
  return canonicalToolName;
}

function dockerNamespaceAlias(toolName: string): string {
  return 'docker_' + toolName;
}

function normalizeToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function parseMcpArgs(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === 'string')
    ) {
      return parsed;
    }
  } catch {
    // Fall through to whitespace parsing for simple env values.
  }
  return trimmed.split(/\s+/).filter(Boolean);
}
