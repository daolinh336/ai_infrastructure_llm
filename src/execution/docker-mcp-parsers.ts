/**
 * Docker MCP response parsers.
 *
 * Extracted from the original DockerMcpClient so they can be tested
 * independently and reused across different gateway implementations.
 */
import type {
  RuntimeContainerObservation,
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
  return lines.slice(1).filter((l) => l.trim().length > 0).map((line) => {
    const parts = line.trim().split(/\s{2,}/);
    return {
      name: parts[parts.length - 1] ?? '',
      image: parts[1] ?? null,
      status: parts[3] ?? null,
      ports: parts[4] ? parts[4].split(',').map((port) => port.trim()).filter(Boolean) : [],
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
    return {
      name: c.Name ?? containerName,
      image: c.Image ?? null,
      status: c.State?.Status ?? c.Status ?? null,
      ports: extractPortsFromInspect(c),
    };
  } catch {
    return { name: containerName, image: null, status: null, ports: [] };
  }
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

function normalizePorts(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
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

function normalizeImage(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) {
    const tags = value.tags ?? value.repo_tags;
    if (Array.isArray(tags) && tags.length > 0) return String(tags[0]);
    return stringField(value, 'id') ?? stringField(value, 'short_id');
  }
  return null;
}
