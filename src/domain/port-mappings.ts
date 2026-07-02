export interface ParsedPortMapping {
  hostPort: string | null;
  containerPort: string;
  protocol: string | null;
}

export function missingDesiredPortMappings(
  desiredPorts: readonly string[] | undefined,
  actualPorts: readonly string[] | undefined,
): string[] {
  const parsedActualPorts = (actualPorts ?? [])
    .map(parseObservedPortMapping)
    .filter((port): port is ParsedPortMapping => port !== null);

  return (desiredPorts ?? []).filter((desiredPort) => {
    const parsedDesiredPort = parseDesiredPortMapping(desiredPort);
    if (!parsedDesiredPort) return true;
    return !parsedActualPorts.some((actualPort) => portsMatch(parsedDesiredPort, actualPort));
  });
}

export function desiredPortMappingsPresent(
  desiredPorts: readonly string[] | undefined,
  actualPorts: readonly string[] | undefined,
): boolean {
  return missingDesiredPortMappings(desiredPorts, actualPorts).length === 0;
}

function parseDesiredPortMapping(port: string): ParsedPortMapping | null {
  const match = port.trim().match(/^(\d{1,5}):(\d{1,5})$/);
  if (!match) return null;
  return {
    hostPort: match[1] ?? null,
    containerPort: match[2] ?? '',
    protocol: 'tcp',
  };
}

function parseObservedPortMapping(port: string): ParsedPortMapping | null {
  const normalized = port.trim();
  if (normalized.length === 0) return null;

  const directMapping = normalized.match(/^(\d{1,5}):(\d{1,5})(?:\/([A-Za-z0-9_-]+))?$/);
  if (directMapping) {
    return {
      hostPort: directMapping[1] ?? null,
      containerPort: directMapping[2] ?? '',
      protocol: normalizeProtocol(directMapping[3] ?? null),
    };
  }

  const arrowParts = normalized.split('->');
  if (arrowParts.length === 2) {
    const hostMatch = (arrowParts[0] ?? '').match(/(?:^|:)(\d{1,5})$/);
    const containerMatch = (arrowParts[1] ?? '').match(/^(\d{1,5})(?:\/([A-Za-z0-9_-]+))?$/);
    if (hostMatch && containerMatch) {
      return {
        hostPort: hostMatch[1] ?? null,
        containerPort: containerMatch[1] ?? '',
        protocol: normalizeProtocol(containerMatch[2] ?? null),
      };
    }
  }

  const containerOnly = normalized.match(/^(\d{1,5})(?:\/([A-Za-z0-9_-]+))$/);
  if (containerOnly) {
    return {
      hostPort: null,
      containerPort: containerOnly[1] ?? '',
      protocol: normalizeProtocol(containerOnly[2] ?? null),
    };
  }

  return null;
}

function portsMatch(desiredPort: ParsedPortMapping, actualPort: ParsedPortMapping): boolean {
  return desiredPort.hostPort === actualPort.hostPort &&
    desiredPort.containerPort === actualPort.containerPort &&
    protocolsMatch(desiredPort.protocol, actualPort.protocol);
}

function protocolsMatch(desiredProtocol: string | null, actualProtocol: string | null): boolean {
  return actualProtocol === null || desiredProtocol === actualProtocol;
}

function normalizeProtocol(protocol: string | null): string | null {
  return protocol ? protocol.toLowerCase() : null;
}
