import type {
  DriftFinding,
  DriftReport,
  DriftSeverity,
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeContainerObservation,
} from '../domain/types.js';

function toContainerName(projectName: string, serviceName: string): string {
  return projectName + '-' + serviceName.replace(/[_\s]+/g, '-');
}

function imageBase(image: string): string {
  return (image.split(':')[0] ?? '').split('/').pop() ?? image.toLowerCase();
}

function finding(
  kind: DriftFinding['kind'],
  severity: DriftSeverity,
  resourceType: DriftFinding['resourceType'],
  resourceName: string,
  message: string,
  expected: string | null,
  actual: string | null,
  autoRepairable: boolean,
): DriftFinding {
  return { kind, severity, resourceType, resourceName, message, expected, actual, autoRepairable };
}

export function buildDriftReport(
  desired: InfrastructureSpec,
  actual: RuntimeActualState,
  checkedAt = new Date().toISOString(),
): DriftReport {
  const findings: DriftFinding[] = [];

  for (const service of desired.services) {
    const expectedName = toContainerName(desired.projectName, service.name);
    const matches = actual.containers.filter(
      (container) => container.name === expectedName || container.name.includes(service.name),
    );

    if (matches.length === 0) {
      findings.push(
        finding(
          'missing-container',
          'major',
          'container',
          expectedName,
          'Service "' + service.name + '" has no matching container.',
          expectedName,
          null,
          true,
        ),
      );
      continue;
    }

    const container = matches[0] as RuntimeContainerObservation;
    if (container.status !== null && container.status !== 'running') {
      findings.push(
        finding(
          'stopped-container',
          'minor',
          'container',
          container.name,
          'Container "' + container.name + '" is not running (status: ' + container.status + ').',
          'running',
          container.status,
          true,
        ),
      );
    }

    if (container.image !== null && !container.image.startsWith(service.image) && !service.image.startsWith(container.image)) {
      findings.push(
        finding(
          'image-mismatch',
          'major',
          'container',
          container.name,
          'Container "' + container.name + '" image mismatch.',
          service.image,
          container.image,
          true,
        ),
      );
    }

    if (service.ports && service.ports.length > 0) {
      const actualPorts = container.ports ?? [];
      const missingPorts = service.ports.filter(
        (port) => !actualPorts.some((actualPort) => actualPort.includes(port.split(':')[0] ?? '')),
      );
      if (missingPorts.length > 0) {
        findings.push(
          finding(
            'port-mismatch',
            'risky',
            'container',
            container.name,
            'Container "' + container.name + '" missing port mappings: ' + missingPorts.join(', ') + '.',
            service.ports.join(', '),
            actualPorts.join(', '),
            true,
          ),
        );
      }
    }
  }

  for (const network of desired.networks) {
    if (!actual.networks.some((entry) => entry.name === network)) {
      findings.push(
        finding(
          'missing-network',
          'minor',
          'network',
          network,
          'Network "' + network + '" declared in desired spec but not found in runtime.',
          network,
          null,
          true,
        ),
      );
    }
  }

  for (const service of desired.services) {
    for (const volume of service.volumes ?? []) {
      const volumeName = volume.split(':')[0] ?? '';
      if (volumeName && !actual.volumes.some((entry) => entry.name === volumeName)) {
        findings.push(
          finding(
            'missing-volume',
            'risky',
            'volume',
            volumeName,
            'Volume "' + volumeName + '" declared for service "' + service.name + '" but not found in runtime.',
            volumeName,
            null,
            true,
          ),
        );
      }
    }
  }

  for (const image of new Set(desired.services.map((service) => service.image))) {
    if (!actual.images.some((entry) => entry.reference === image || imageBase(entry.reference) === imageBase(image))) {
      findings.push(
        finding(
          'missing-image',
          'minor',
          'image',
          image,
          'Image "' + image + '" not found in runtime images.',
          image,
          null,
          true,
        ),
      );
    }
  }

  const status: DriftReport['status'] =
    findings.length === 0 ? 'none' : findings.some((entry) => entry.severity === 'unknown') ? 'uncertain' : 'drifted';
  const summary =
    findings.length === 0
      ? 'No drift detected: desired spec matches observed runtime.'
      : 'Detected ' + String(findings.length) + ' drift finding(s).';

  return {
    status,
    checkedAt,
    projectName: desired.projectName,
    findings,
    summary,
  };
}
