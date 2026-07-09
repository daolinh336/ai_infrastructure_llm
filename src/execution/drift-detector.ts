import type {
  DriftFinding,
  DriftReport,
  DriftSeverity,
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeContainerObservation,
} from '../domain/types.js';
import { missingDesiredPortMappings } from '../domain/port-mappings.js';
import { toReplicaContainerNames } from './container-names.js';
import { scopeRuntimeActualStateToSpec } from '../domain/runtime-state-scope.js';

function imageBase(image: string): string {
  return (image.split(':')[0] ?? '').split('/').pop() ?? image.toLowerCase();
}
function stripProjectPrefix(name: string, projectName: string): string {
  const prefix = projectName + '-';
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function stripComposeReplicaSuffix(name: string): string {
  return name.replace(/[-_][1-9][0-9]*$/, '');
}

function normalizeObservedContainerName(name: string, projectName: string): string {
  return stripComposeReplicaSuffix(stripProjectPrefix(name, projectName));
}

function normalizeObservedResourceName(name: string, projectName: string): string {
  return stripProjectPrefix(name, projectName);
}

function resourceNameMatches(actualName: string, desiredName: string, projectName: string): boolean {
  return actualName === desiredName || normalizeObservedResourceName(actualName, projectName) === desiredName;
}

function isRunningStatus(status: string | null): boolean {
  return status === 'running';
}

function desiredServiceStatus(service: InfrastructureSpec['services'][number]): 'running' | 'stopped' {
  return service.desiredStatus ?? 'running';
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
  const scopedActual = scopeRuntimeActualStateToSpec(actual, desired);
  const findings: DriftFinding[] = [];

  for (const service of desired.services) {
    const expectedNames = toReplicaContainerNames(desired.projectName, service);
    const replicas = service.replicas ?? 1;
    const matches = scopedActual.containers.filter((container) =>
      expectedNames.includes(container.name) ||
      (replicas <= 1 && normalizeObservedContainerName(container.name, desired.projectName) === service.name),
    );
    const missingNames = expectedNames.filter(
      (expectedName) => !matches.some((container) =>
        container.name === expectedName ||
        (replicas <= 1 && normalizeObservedContainerName(container.name, desired.projectName) === service.name),
      ),
    );

    for (const missingName of missingNames) {
      findings.push(
        finding(
          'missing-container',
          'major',
          'container',
          missingName,
          'Service "' + service.name + '" is missing expected container "' + missingName + '".',
          missingName,
          null,
          true,
        ),
      );
    }

    if (matches.length === 0) {
      continue;
    }

    const container = matches[0] as RuntimeContainerObservation;
    const desiredStatus = desiredServiceStatus(service);
    const actualIsRunning = isRunningStatus(container.status);

    if (container.environment === undefined) {
      findings.push(
        finding(
          'uncertain-runtime-evidence',
          'unknown',
          'runtime',
          container.name,
          'Container "' + container.name + '" was observed via list only; inspect data is unavailable, so environment drift cannot be verified.',
          null,
          null,
          false,
        ),
      );
    }

    if (desiredStatus === 'running' && container.status !== null && !actualIsRunning) {
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

    if (desiredStatus === 'stopped' && actualIsRunning) {
      findings.push(
        finding(
          'running-container',
          'minor',
          'container',
          container.name,
          'Container "' + container.name + '" is running but desired lifecycle is stopped.',
          'stopped',
          'running',
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

    if (desiredStatus === 'running' && service.ports && service.ports.length > 0 && actualIsRunning) {
      const actualPorts = container.ports ?? [];
      const missingPorts = missingDesiredPortMappings(service.ports, actualPorts);
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

    const desiredEnvironment = service.environment ?? {};
    const desiredEnvironmentEntries = Object.entries(desiredEnvironment);
    if (desiredEnvironmentEntries.length > 0 && container.environment === null) {
      findings.push(
        finding(
          'uncertain-runtime-evidence',
          'unknown',
          'runtime',
          container.name,
          'Container "' + container.name + '" inspect data did not include environment values, so environment drift cannot be verified.',
          null,
          null,
          false,
        ),
      );
    }

    if (desiredEnvironmentEntries.length > 0 && container.environment) {
      for (const [key, value] of desiredEnvironmentEntries) {
        if (!(key in container.environment)) {
          findings.push(
            finding(
              'env-mismatch',
              'major',
              'container',
              container.name,
              'Container "' + container.name + '" missing environment variable "' + key + '".',
              key + '=' + value,
              null,
              true,
            ),
          );
        } else if (container.environment[key] !== value) {
          findings.push(
            finding(
              'env-mismatch',
              'risky',
              'container',
              container.name,
              'Container "' + container.name + '" environment variable "' + key + '" has a different value.',
              key + '=' + value,
              key + '=' + container.environment[key],
              true,
            ),
          );
        }
      }
    }
  }

  for (const network of desired.networks) {
    if (!scopedActual.networks.some((entry) => resourceNameMatches(entry.name, network, desired.projectName))) {
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
      if (volumeName && !scopedActual.volumes.some((entry) => resourceNameMatches(entry.name, volumeName, desired.projectName))) {
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
    if (!scopedActual.images.some((entry) => entry.reference === image || imageBase(entry.reference) === imageBase(image))) {
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
    findings.length === 0
      ? 'none'
      : findings.some((entry) => entry.kind === 'uncertain-runtime-evidence')
        ? 'uncertain'
        : findings.some((entry) => entry.severity === 'unknown')
          ? 'uncertain'
          : 'drifted';
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

