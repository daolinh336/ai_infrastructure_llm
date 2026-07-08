/**
 * Docker MCP response parsers.
 *
 * Shared parser helpers for MCP tool responses, tested independently
 * and reused across gateway operations.
 */
import type {
  RuntimeContainerObservation,
  RuntimeContainerSummary,
  RuntimeImageObservation,
  RuntimeNamedResourceObservation,
} from '../domain/types.js';

/**
 * Parse the text output of the MCP `ps` tool into container observations.
 * The output is expected to be a table with a header row.
 */
export function parseContainerList(output: string): RuntimeContainerObservation[] {
  const parsed = parseJsonArray(output);
  if (parsed) {
    return parsed.map((container) => ({
      name: stringField(container, 'name') ?? stringField(container, 'Name') ?? stringField(container, 'id') ?? '',
      image: normalizeImage(container.image ?? container.Image),
      status: stringField(container, 'status') ?? stringField(container, 'State') ?? null,
      ports: normalizePorts(container.ports ?? container.Ports),
    }));
  }

  const lines = output.trim().split('\n');
  if (lines.length <= 1) return [];
  const headerColumns = (lines[0] ?? '').trim().split(/\s{2,}/);
  const imageIndex = findColumnIndex(headerColumns, 'IMAGE', 1);
  const statusIndex = findColumnIndex(headerColumns, 'STATUS', 4);
  const portsIndex = findColumnIndex(headerColumns, 'PORTS', 5);
  const nameIndex = findColumnIndex(headerColumns, 'NAMES', headerColumns.length - 1);
  return lines.slice(1).filter((l) => l.trim().length > 0).map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    const rawPorts = parts.length > nameIndex ? parts[portsIndex] ?? '' : '';
    return {
      name: parts[nameIndex] ?? parts[parts.length - 1] ?? '',
      image: parts[imageIndex] ?? parts[1] ?? null,
      status: parts[statusIndex] ?? null,
      ports: rawPorts
        ? rawPorts.split(',').map(normalizePortText).filter(Boolean)
        : [],
    };
  });
}

/**
 * Parse the JSON output of the MCP `inspect` tool into a container observation.
 */
export function parseInspectResult(output: string, containerName: string): RuntimeContainerObservation | null {
  try {
    const parsed = JSON.parse(output);
    const c = Array.isArray(parsed) ? parsed[0] : parsed;
    const config = c.Config as Record<string, unknown> | undefined;
    const rawName = typeof c.Name === 'string' ? c.Name.replace(/^\//, '') : containerName;
    return {
      name: rawName,
      image: normalizeImage(config?.Image ?? c.Image),
      status: c.State?.Status ?? c.Status ?? null,
      ports: extractPortsFromInspect(c),
      environment: extractEnvironmentFromInspect(c),
      healthStatus: extractHealthStatus(c),
      restartCount: numberField(c, 'RestartCount'),
      exitCode: isRecord(c.State) ? numberField(c.State, 'ExitCode') : null,
    };
  } catch {
    return { name: containerName, image: null, status: null, ports: [], environment: null };
  }
}


/**
 * Parse Docker inspect output into the narrow planner-safe summary.
 * This intentionally omits env values, labels, raw command, bind sources, and
 * internal network metadata while retaining conflict-planning signals.
 */
export function parseInspectSummaryResult(output: string, containerName: string): RuntimeContainerSummary | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    const inspect = Array.isArray(parsed) ? parsed.find(isRecord) : parsed;
    if (!isRecord(inspect)) return null;
    const config = isRecord(inspect.Config) ? inspect.Config : undefined;
    const hostConfig = isRecord(inspect.HostConfig) ? inspect.HostConfig : undefined;
    const rawName = typeof inspect.Name === 'string' ? inspect.Name.replace(/^\//, '') : containerName;
    return {
      name: rawName,
      image: normalizeImage(config?.Image ?? inspect.Image),
      status: isRecord(inspect.State) ? stringField(inspect.State, 'Status') : stringField(inspect, 'Status'),
      ports: extractPortsFromInspect(inspect),
      networks: extractNetworkNamesFromInspect(inspect),
      mountDestinations: extractMountDestinationsFromInspect(inspect),
      restartPolicy: extractRestartPolicy(hostConfig),
      healthStatus: extractHealthStatus(inspect),
    };
  } catch {
    return null;
  }
}

function extractHealthStatus(inspect: Record<string, unknown>): string | null {
  const state = inspect.State;
  if (!isRecord(state)) return null;
  const health = state.Health;
  if (!isRecord(health)) return null;
  return stringField(health, 'Status');
}

function extractRestartPolicy(hostConfig: Record<string, unknown> | undefined): string | null {
  if (!hostConfig) return null;
  const restartPolicy = hostConfig.RestartPolicy;
  if (!isRecord(restartPolicy)) return null;
  const name = stringField(restartPolicy, 'Name');
  if (!name || name === 'no') return null;
  const maximumRetryCount = numberField(restartPolicy, 'MaximumRetryCount');
  return maximumRetryCount && maximumRetryCount > 0 ? name + ':' + String(maximumRetryCount) : name;
}

function extractNetworkNamesFromInspect(inspect: Record<string, unknown>): string[] {
  const networkSettings = inspect.NetworkSettings;
  if (!isRecord(networkSettings) || !isRecord(networkSettings.Networks)) return [];
  return Object.keys(networkSettings.Networks).filter((name) => name.trim().length > 0).sort();
}

function extractMountDestinationsFromInspect(inspect: Record<string, unknown>): string[] {
  const mounts = inspect.Mounts;
  if (!Array.isArray(mounts)) return [];
  const destinations = new Set<string>();
  for (const mount of mounts) {
    if (!isRecord(mount)) continue;
    const destination = stringField(mount, 'Destination') ?? stringField(mount, 'Target');
    if (destination) destinations.add(destination);
  }
  return [...destinations].sort();
}

/**
 * Extract port mappings from a Docker inspect result object.
 */
export function extractPortsFromInspect(inspect: Record<string, unknown>): string[] {
  try {
    const ns = inspect.NetworkSettings as Record<string, unknown> | undefined;
    const ports = ns?.Ports as Record<string, unknown> | undefined;
    if (!ports) return [];
    return Object.entries(ports)
      .filter(([, bindings]) => bindings !== null)
      .map(([containerPort, bindings]) => {
        if (Array.isArray(bindings) && bindings.length > 0) {
          const b = bindings[0] as Record<string, string>;
          return b.HostPort + ':' + containerPort.split('/')[0];
        }
        return containerPort;
      });
  } catch {
    return [];
  }
}

/**
 * Extract environment variables from a Docker inspect result object.
 * Docker stores Config.Env as an array of "KEY=VALUE" strings.
 */
export function extractEnvironmentFromInspect(inspect: Record<string, unknown>): Record<string, string> | null {
  try {
    const config = inspect.Config as Record<string, unknown> | undefined;
    const env = config?.Env as unknown[] | undefined;
    if (!Array.isArray(env)) {
      return null;
    }
    const result: Record<string, string> = {};
    for (const entry of env) {
      if (typeof entry !== 'string') continue;
      const eqIndex = entry.indexOf('=');
      if (eqIndex <= 0) continue;
      const key = entry.slice(0, eqIndex);
      const value = entry.slice(eqIndex + 1);
      result[key] = value;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Check whether an MCP tool list includes an inspect-capable tool.
 * Used to fall back gracefully when the MCP server does not expose inspect.
 */
export function hasInspectTool(tools: ReadonlyArray<{ name: string }>): boolean {
  return tools.some((tool) => /inspect/i.test(tool.name));
}

/**
 * Parse the text output of the MCP `images` tool into image observations.
 */
export function parseImageList(output: string): RuntimeImageObservation[] {
  const parsed = parseJsonArray(output);
  if (parsed) {
    return parsed.map((image) => {
      const tags = Array.isArray(image.tags) ? image.tags : Array.isArray(image.repo_tags) ? image.repo_tags : [];
      return {
        reference: stringField(image, 'reference') ?? stringField(image, 'name') ?? String(tags[0] ?? stringField(image, 'id') ?? '<none>'),
        id: stringField(image, 'id') ?? stringField(image, 'short_id') ?? null,
        status: stringField(image, 'status') ?? null,
      };
    });
  }

  const lines = output.trim().split('\n');
  if (lines.length <= 1) return [];
  return lines.slice(1).filter((l) => l.trim().length > 0).map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    const repo = parts[0] ?? '<none>';
    const tag = parts[1] ?? '<none>';
    return {
      reference: tag === '<none>' ? repo : repo + ':' + tag,
      id: parts[2] ?? null,
      status: parts[3] ?? null,
    };
  });
}

/**
 * Extract a container ID from the text output of the MCP `run` tool.
 */
export function extractContainerIdFromRunResult(output: string, containerName: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (isRecord(parsed)) {
      return stringField(parsed, 'id') ?? stringField(parsed, 'short_id') ?? stringField(parsed, 'name') ?? containerName;
    }
  } catch {
    // Fall back to text output below.
  }
  const trimmed = output.trim();
  if (trimmed.length > 0) return trimmed.split(/\s+/)[0] ?? containerName;
  return containerName;
}

/**
 * Parse the text output of MCP `network_ls` or `volume_ls` tools
 * into named resource observations.
 */
export function parseNamedResourceList(output: string, _kind: 'network' | 'volume'): RuntimeNamedResourceObservation[] {
  const parsed = parseJsonArray(output);
  if (parsed) {
    return parsed.map((resource) => ({
      name: stringField(resource, 'name') ?? stringField(resource, 'id') ?? '',
      status: stringField(resource, 'status') ?? stringField(resource, 'driver') ?? null,
    }));
  }

  const lines = output.trim().split('\n');
  if (lines.length <= 1) return [];
  return lines.slice(1).filter((l) => l.trim().length > 0).map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    return { name: parts[0] ?? '', status: parts[1] ?? null };
  });
}

function parseJsonArray(output: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isRecord);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePorts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map(normalizePortText).filter(Boolean);
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([containerPort, bindings]) => {
      const port = containerPort.split('/')[0] ?? containerPort;
      if (Array.isArray(bindings) && bindings.length > 0) {
        return bindings
          .filter(isRecord)
          .map((binding) => {
            const hostPort = stringField(binding, 'HostPort');
            return hostPort ? hostPort + ':' + port : port;
          });
      }
      return [port];
    });
  }
  return [];
}

function findColumnIndex(columns: string[], name: string, fallback: number): number {
  const index = columns.findIndex((column) => column.trim().toUpperCase() === name);
  return index >= 0 ? index : fallback;
}

function normalizePortText(value: string): string {
  const trimmed = value.trim();
  const arrowMatch = /(?:^|:)(\d{1,5})->(\d{1,5})(?:\/[A-Za-z0-9_-]+)?$/.exec(trimmed);
  if (arrowMatch) {
    return `${arrowMatch[1]}:${arrowMatch[2]}`;
  }

  const directMatch = /^(\d{1,5}):(\d{1,5})(?:\/[A-Za-z0-9_-]+)?$/.exec(trimmed);
  if (directMatch) {
    return `${directMatch[1]}:${directMatch[2]}`;
  }

  return trimmed;
}

function normalizeImage(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) {
    const tags = value.tags ?? value.repo_tags;
    if (Array.isArray(tags) && tags.length > 0) return String(tags[0]);
    return stringField(value, 'id') ?? stringField(value, 'short_id');
  }
  return null;
}
