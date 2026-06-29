import type { VerifierRuntimeReader } from '../execution/runtime-environment-reader.js';
import type {
  DriftFindingKind,
  InfrastructureService,
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeContainerObservation,
  RuntimeResourceRefs,
  VerificationFinding,
  VerificationReport,
} from '../domain/types.js';
import { validateVerificationReport } from '../domain/schemas.js';
import { buildDriftReport } from '../execution/drift-detector.js';
import { toReplicaContainerNames, toServiceContainerName } from '../execution/container-names.js';
import { isProtectedDockerNetwork } from '../execution/protected-docker-resources.js';
import type { VerifierAgent } from './agent-interfaces.js';

export class StandardVerifierAgent implements VerifierAgent {
  async verify(
    desiredSpec: InfrastructureSpec,
    runtimeReader: VerifierRuntimeReader,
  ): Promise<VerificationReport> {
    const checkedAt = new Date().toISOString();
    const evidence: string[] = [];
    const findings: VerificationFinding[] = [];

    try {
      if (!runtimeReader.isReady) {
        return validateVerificationReport(buildReport({
          status: 'uncertain',
          checkedAt,
          findings: [createFinding({
            code: 'RUNTIME_OBSERVATION_UNCERTAIN',
            severity: 'blocker',
            resourceKind: 'runtime',
            resourceName: null,
            expected: 'initialized verifier runtime reader',
            actual: 'not initialized',
            evidence: ['VerifierRuntimeReader is not initialized.'],
            confidence: 1,
            suggestedAction: { action: 'retry-observe', summary: 'Provide a ready verifier runtime reader before verify().' },
          })],
          evidence: [],
          errorReason: 'Cannot verify because verifier runtime reader is not initialized.',
          revisionHint: 'Provide a ready verifier runtime reader before verify().',
          confidence: 0,
        }));
      }

      const containerNames = desiredSpec.services.flatMap((service) =>
        toReplicaContainerNames(desiredSpec.projectName, service),
      );
      const actual: RuntimeActualState = await runtimeReader.read(desiredSpec, { containerNames });
      const containers = actual.containers;
      const networks = actual.networks;
      const volumes = actual.volumes;
      const images = actual.images;
      const drift = buildDriftReport(desiredSpec, actual, checkedAt);
      if (drift.status !== 'none') {
        for (const driftFinding of drift.findings) {
          findings.push(createFinding({
            code: mapDriftCode(driftFinding.kind),
            severity: driftFinding.severity === 'risky' ? 'blocker' : driftFinding.severity === 'major' ? 'error' : 'warning',
            resourceKind: driftFinding.resourceType === 'runtime' ? 'runtime' : driftFinding.resourceType,
            resourceName: driftFinding.resourceName,
            expected: driftFinding.expected,
            actual: driftFinding.actual,
            evidence: [driftFinding.message],
            confidence: driftFinding.severity === 'unknown' ? 0.35 : 0.75,
            suggestedAction: { action: driftFinding.autoRepairable ? 'repair-runtime' : 'auto-revise', summary: driftFinding.message },
            requiresUserInput: driftFinding.severity === 'risky' || driftFinding.severity === 'unknown',
          }));
        }
        evidence.push('Drift report: ' + drift.summary);
      } else {
        evidence.push('Drift report: no drift detected.');
      }

      evidence.push('Observed ' + String(containers.length) + ' container(s), ' + String(networks.length) + ' network(s), ' + String(volumes.length) + ' volume(s), ' + String(images.length) + ' image(s).');

      for (const service of desiredSpec.services) {
        await runServiceChecks(desiredSpec, service, actual, runtimeReader, findings, evidence);
      }

      for (const network of desiredSpec.networks) {
        const networkExists = networks.some((n) => n.name === network);
        if (!networkExists) {
          findings.push(createFinding({
            code: 'NETWORK_MISMATCH',
            severity: 'error',
            resourceKind: 'network',
            resourceName: network,
            expected: 'network exists',
            actual: 'missing',
            evidence: ['Network "' + network + '" is declared in spec but not found in Docker.'],
            confidence: 0.85,
            suggestedAction: { action: 'repair-runtime', summary: 'Create the missing network before service start.' },
          }));
        } else {
          evidence.push('Network "' + network + '" found in Docker.');
        }
      }

      for (const service of desiredSpec.services) {
        for (const volume of service.volumes ?? []) {
          const volumeName = volume.split(':')[0];
          const volumeExists = volumes.some((v) => v.name === volumeName);
          if (!volumeExists) {
            findings.push(createFinding({
              code: 'VOLUME_MISMATCH',
              severity: 'error',
              resourceKind: 'volume',
              resourceName: volumeName ?? null,
              expected: 'volume exists for service ' + service.name,
              actual: 'missing',
              evidence: ['Volume "' + volumeName + '" declared in service "' + service.name + '" but not found in Docker.'],
              confidence: 0.85,
              suggestedAction: { action: 'repair-runtime', summary: 'Create the missing volume before service start.' },
            }));
          }
        }
      }

      const uniqueFindings = dedupeFindings(findings);
      const status = uniqueFindings.length === 0 ? 'passed' : uniqueFindings.some((finding) => finding.confidence < 0.5) ? 'uncertain' : 'failed';
      return validateVerificationReport(buildReport({
        status,
        checkedAt,
        findings: uniqueFindings,
        evidence,
        errorReason: uniqueFindings.length > 0 ? 'Verification found ' + String(uniqueFindings.length) + ' finding(s).' : null,
        revisionHint: uniqueFindings.length > 0 ? 'Re-run plan or repair the deployment to match the desired spec.' : null,
        confidence: uniqueFindings.length === 0 ? 0.95 : Math.max(0.25, Math.min(...uniqueFindings.map((finding) => finding.confidence))),
      }));
    } catch (error) {
      return validateVerificationReport(buildReport({
        status: 'uncertain',
        checkedAt,
        findings: [createFinding({
          code: 'RUNTIME_OBSERVATION_UNCERTAIN',
          severity: 'blocker',
          resourceKind: 'runtime',
          resourceName: null,
          expected: 'successful runtime observation',
          actual: getErrorMessage(error),
          evidence: ['Verification failed with error: ' + getErrorMessage(error)],
          confidence: 0,
          suggestedAction: { action: 'manual-check', summary: 'Check Docker daemon and MCP connectivity.' },
          requiresUserInput: true,
        })],
        evidence: [],
        errorReason: 'Unexpected error during verification.',
        revisionHint: 'Check Docker daemon and MCP connectivity.',
        confidence: 0,
      }));
    }
  }

  async verifyPreDeploy(
    desired: InfrastructureSpec,
    actual: RuntimeActualState,
  ): Promise<VerificationReport> {
    return buildPreDeployVerificationReport(desired, actual, new Date().toISOString());
  }
  async compareState(
    desired: InfrastructureSpec,
    actual: RuntimeActualState,
  ): Promise<VerificationReport> {
    const checkedAt = new Date().toISOString();
    const findings: VerificationFinding[] = [];
    const evidence: string[] = [];

    for (const service of desired.services) {
      const matchingContainer = actual.containers.find(
        (c) => c.name.includes(service.name),
      );
      if (!matchingContainer) {
        findings.push(createFinding({
          code: 'MISSING_CONTAINER',
          severity: 'error',
          resourceKind: 'container',
          resourceName: toContainerName(desired.projectName, service.name),
          expected: 'container exists',
          actual: 'missing',
          evidence: ['Service "' + service.name + '" not found in actual state.'],
          confidence: 0.8,
          suggestedAction: { action: 'repair-runtime', summary: 'Create or start the missing container.' },
        }));
        continue;
      }
      evidence.push('Service "' + service.name + '" found in actual state.');
    }

    const status = findings.length === 0 ? 'passed' : 'failed';
    return validateVerificationReport(buildReport({
      status,
      checkedAt,
      findings,
      evidence,
      errorReason: findings.length > 0 ? 'Desired state differs from actual state.' : null,
      revisionHint: findings.length > 0 ? 'Re-run plan or repair the deployment.' : null,
      confidence: status === 'passed' ? 0.9 : 0.5,
    }));
  }
}

async function runServiceChecks(
  desiredSpec: InfrastructureSpec,
  service: InfrastructureService,
  actual: RuntimeActualState,
  runtimeReader: VerifierRuntimeReader,
  findings: VerificationFinding[],
  evidence: string[],
): Promise<void> {
  const expectedNames = toReplicaContainerNames(desiredSpec.projectName, service);
  const matchingContainers = actual.containers.filter((container) =>
    expectedNames.includes(container.name),
  );
  const missingNames = expectedNames.filter(
    (expectedName) => !matchingContainers.some((container) => container.name === expectedName),
  );

  if (matchingContainers.length === 0) {
    findings.push(createFinding({
      code: 'MISSING_CONTAINER',
      severity: 'error',
      resourceKind: 'container',
      resourceName: expectedNames[0]!,
      expected: 'container exists',
      actual: 'missing',
      evidence: ['Service "' + service.name + '" has no matching container (expected: ' + expectedNames.join(', ') + ').'],
      confidence: 0.9,
      suggestedAction: { action: 'repair-runtime', summary: 'Create and start the missing service container.' },
    }));
    return;
  }

  if (service.replicas && service.replicas > 1 && matchingContainers.length !== service.replicas) {
    findings.push(createFinding({
      code: 'MISSING_CONTAINER',
      severity: 'error',
      resourceKind: missingNames.length === 1 ? 'container' : 'service',
      resourceName: missingNames.length === 1 ? missingNames[0]! : service.name,
      expected: String(service.replicas) + ' replica(s)',
      actual: String(matchingContainers.length) + ' replica(s)',
      evidence: [
        'Service "' + service.name + '" expected ' + String(service.replicas) + ' replica(s), found ' + String(matchingContainers.length) + '.',
        ...(missingNames.length > 0 ? ['Missing container(s): ' + missingNames.join(', ') + '.'] : []),
      ],
      confidence: 0.85,
      suggestedAction: { action: 'repair-runtime', summary: 'Recreate service replicas to match the spec.' },
    }));
  } else if (service.replicas && service.replicas > 1) {
    evidence.push('Service "' + service.name + '" has ' + String(service.replicas) + ' replica(s) as expected.');
  }

  const container = matchingContainers[0]!;
  if (container.image && !container.image.includes(service.image.split(':')[0]!)) {
    findings.push(createFinding({
      code: 'IMAGE_MISMATCH',
      severity: 'error',
      resourceKind: 'image',
      resourceName: service.name,
      expected: service.image,
      actual: container.image,
      evidence: ['Service "' + service.name + '" image mismatch: expected "' + service.image + '", running "' + container.image + '".'],
      confidence: 0.8,
      suggestedAction: { action: 'auto-revise', summary: 'Revise the service image or recreate the container with the desired image.' },
    }));
  } else if (container.image) {
    evidence.push('Service "' + service.name + '" running expected image.');
  } else {
    findings.push(createFinding({
      code: 'RUNTIME_OBSERVATION_UNCERTAIN',
      severity: 'warning',
      resourceKind: 'image',
      resourceName: service.name,
      expected: service.image,
      actual: 'unknown',
      evidence: ['Runtime did not return inspected image for service "' + service.name + '".'],
      confidence: 0.35,
      suggestedAction: { action: 'retry-observe', summary: 'Retry with inspect-capable Docker observation.' },
    }));
  }

  addReadinessFindings(service, container, findings);

  if ((container.status ?? '').toLowerCase() !== 'running') {
    const logs = await runtimeReader.readLogs(container.name, 80);
    const evidenceItems = ['Container "' + container.name + '" is not running (status: ' + String(container.status ?? 'unknown') + ').'];
    if (logs) evidenceItems.push('Log tail: ' + logs.replace(/\s+/g, ' ').slice(0, 500));
    findings.push(createFinding({
      code: 'CONTAINER_NOT_RUNNING',
      severity: 'error',
      resourceKind: 'container',
      resourceName: container.name,
      expected: 'running',
      actual: container.status ?? 'unknown',
      evidence: evidenceItems,
      confidence: container.status ? 0.9 : 0.45,
      suggestedAction: { action: logs ? 'ask-user' : 'retry-observe', summary: logs ? 'Review logs and choose a safe revision.' : 'Retry runtime observation with inspect/log support.' },
      requiresUserInput: true,
    }));
  }

  if (service.ports && service.ports.length > 0) {
    const actualPorts = container.ports ?? [];
    const missingPorts = service.ports.filter((port) => !actualPorts.some((actualPort) => actualPort.includes(port.split(':')[0]!)));
    if (missingPorts.length > 0) {
      findings.push(createFinding({
        code: 'PORT_MISMATCH',
        severity: 'error',
        resourceKind: 'port',
        resourceName: service.name,
        expected: service.ports.join(', '),
        actual: actualPorts.join(', ') || 'none',
        evidence: ['Service "' + service.name + '" missing port mappings: ' + missingPorts.join(', ') + '.'],
        confidence: 0.8,
        suggestedAction: { action: 'auto-revise', summary: 'Revise or recreate the container port mappings.' },
      }));
    } else {
      evidence.push('Service "' + service.name + '" has expected port mappings.');
    }
  }

  for (const dependencyName of service.dependsOn ?? []) {
    const dependencyContainerName = toContainerName(desiredSpec.projectName, dependencyName);
    const dependency = actual.containers.find((candidate) => candidate.name === dependencyContainerName || candidate.name.includes(dependencyName));
    const dependencyReady = dependency !== undefined && (dependency.status ?? '').toLowerCase() === 'running' && dependency.healthStatus !== 'unhealthy';
    if (!dependencyReady) {
      findings.push(createFinding({
        code: 'DEPENDENCY_NOT_READY',
        severity: 'warning',
        resourceKind: 'service',
        resourceName: service.name,
        expected: 'dependency ' + dependencyName + ' running/healthy before ' + service.name,
        actual: dependency ? 'status=' + String(dependency.status ?? 'unknown') + ', health=' + String(dependency.healthStatus ?? 'unknown') : 'missing',
        evidence: ['Service "' + service.name + '" depends on "' + dependencyName + '" but dependency is not ready.'],
        confidence: dependency ? 0.75 : 0.9,
        suggestedAction: { action: 'auto-revise', summary: 'Add or repair dependency readiness ordering.' },
      }));
    }
  }
}

function addReadinessFindings(
  service: InfrastructureService,
  container: RuntimeContainerObservation,
  findings: VerificationFinding[],
): void {
  if (container.healthStatus === 'unhealthy') {
    findings.push(createFinding({
      code: 'CONTAINER_UNHEALTHY',
      severity: 'error',
      resourceKind: 'container',
      resourceName: container.name,
      expected: 'healthy',
      actual: 'unhealthy',
      evidence: ['Container "' + container.name + '" reports Docker health status unhealthy.'],
      confidence: 0.9,
      suggestedAction: { action: 'ask-user', summary: 'Inspect logs, environment, secrets, and dependencies before revising.' },
      requiresUserInput: true,
    }));
  }
  if ((container.restartCount ?? 0) > 0) {
    findings.push(createFinding({
      code: 'CONTAINER_UNHEALTHY',
      severity: 'warning',
      resourceKind: 'container',
      resourceName: container.name,
      expected: '0 restarts',
      actual: String(container.restartCount) + ' restart(s)',
      evidence: ['Service "' + service.name + '" has restart count ' + String(container.restartCount) + '.'],
      confidence: 0.7,
      suggestedAction: { action: 'manual-check', summary: 'Check whether restarts are transient or indicate startup failure.' },
    }));
  }
}

export function buildPreDeployVerificationReport(
  desired: InfrastructureSpec,
  actual: RuntimeActualState,
  checkedAt = new Date().toISOString(),
): VerificationReport {
  const findings: VerificationFinding[] = [];
  const evidence: string[] = ['Pre-deploy runtime scan used read-only Docker observations.'];
  const actualContainersByName = new Map(actual.containers.map((container) => [container.name, container]));

  for (const service of desired.services) {
    for (const containerName of toReplicaContainerNames(desired.projectName, service)) {
      if (actualContainersByName.has(containerName)) {
        findings.push(createFinding({
          code: 'CONTAINER_NAME_CONFLICT',
          severity: 'blocker',
          resourceKind: 'container',
          resourceName: containerName,
          expected: 'container name available',
          actual: 'already exists',
          evidence: [`Container name conflict: "${containerName}" already exists in Docker runtime.`],
          confidence: 0.98,
          suggestedAction: { action: 'auto-revise', summary: 'Add a safe project suffix before deployment.' },
        }));
      }
    }

    if ((service.replicas ?? 1) > 1 && (service.ports?.length ?? 0) > 0) {
      findings.push(createFinding({
        code: 'HOST_PORT_CONFLICT',
        severity: 'blocker',
        resourceKind: 'port',
        resourceName: service.name,
        expected: 'replicated service without host port bindings',
        actual: service.ports?.join(', ') ?? '',
        evidence: [`Service "${service.name}" requests ${service.replicas ?? 1} replicas with host port binding(s): ${(service.ports ?? []).join(', ')}.`],
        confidence: 0.95,
        suggestedAction: { action: 'auto-revise', summary: 'Remove host port bindings from replicated internal services.' },
      }));
    }
  }

  const usedHostPorts = new Map<string, RuntimeContainerObservation[]>();
  for (const container of actual.containers) {
    for (const port of container.ports ?? []) {
      const hostPort = port.split(':')[0]?.trim();
      if (!hostPort || !/^\d+$/.test(hostPort)) continue;
      const entries = usedHostPorts.get(hostPort) ?? [];
      entries.push(container);
      usedHostPorts.set(hostPort, entries);
    }
  }

  for (const service of desired.services) {
    for (const port of service.ports ?? []) {
      const hostPort = port.split(':')[0]?.trim();
      if (!hostPort || !/^\d+$/.test(hostPort)) continue;
      const conflicts = usedHostPorts.get(hostPort) ?? [];
      if (conflicts.length > 0) {
        findings.push(createFinding({
          code: 'HOST_PORT_CONFLICT',
          severity: 'blocker',
          resourceKind: 'port',
          resourceName: service.name,
          expected: hostPort,
          actual: conflicts.map((container) => container.name).join(', '),
          evidence: [`Host port conflict: service "${service.name}" wants ${hostPort}, already used by ${conflicts.map((container) => container.name).join(', ')}.`],
          confidence: 0.98,
          suggestedAction: { action: 'auto-revise', summary: 'Choose the next available host port before deployment.' },
        }));
      }
    }
  }



  const uniqueFindings = dedupeFindings(findings);
  return validateVerificationReport(buildReport({
    status: uniqueFindings.length > 0 ? 'failed' : 'passed',
    checkedAt,
    findings: uniqueFindings,
    evidence,
    errorReason: uniqueFindings.length > 0 ? 'Pre-deploy conflict detection blocked unsafe deployment.' : null,
    revisionHint: uniqueFindings.length > 0 ? 'Revise conflicting names or ports before Docker mutation.' : null,
    confidence: uniqueFindings.length > 0 ? 0.98 : 0.95,
  }));
}
export function buildResourceRefs(
  projectName: string,
  actual: RuntimeActualState,
  desired?: InfrastructureSpec,
): RuntimeResourceRefs {
  const desiredContainers = new Set(
    desired?.services.flatMap((service) => toReplicaContainerNames(projectName, service)) ?? [],
  );
  const desiredNetworks = new Set(desired?.networks ?? []);
  const desiredVolumes = new Set(desired?.volumes ?? []);
  const desiredImages = new Set(desired?.services.map((service) => service.image) ?? []);

  return {
    projectName,
    containers: actual.containers
      .map((container) => container.name)
      .filter((name) => name.startsWith(projectName + '-') || desiredContainers.has(name)),
    networks: actual.networks
      .map((network) => network.name)
      .filter((name) => !isProtectedDockerNetwork(name) && (name.startsWith(projectName + '-') || desiredNetworks.has(name))),
    volumes: actual.volumes
      .map((volume) => volume.name)
      .filter((name) => name.startsWith(projectName + '-') || desiredVolumes.has(name)),
    images: actual.images
      .map((image) => image.reference)
      .filter((reference) => desiredImages.size === 0 || desiredImages.has(reference)),
  };
}

function createFinding(input: Omit<VerificationFinding, 'requiresUserInput'> & { requiresUserInput?: boolean }): VerificationFinding {
  return {
    ...input,
    requiresUserInput: input.requiresUserInput ?? input.suggestedAction?.action === 'ask-user',
  };
}

function buildReport(input: {
  status: VerificationReport['status'];
  checkedAt: string;
  findings: VerificationFinding[];
  evidence: string[];
  errorReason: string | null;
  revisionHint: string | null;
  confidence: number;
}): VerificationReport {
  const findings = dedupeFindings(input.findings);
  return {
    status: input.status,
    scope: 'tool-runtime',
    checkedAt: input.checkedAt,
    issues: findings.map(formatFindingIssue),
    findings,
    evidence: input.evidence,
    errorReason: input.errorReason,
    revisionHint: input.revisionHint,
    confidence: input.confidence,
  };
}

function dedupeFindings(findings: VerificationFinding[]): VerificationFinding[] {
  const byKey = new Map<string, VerificationFinding>();
  for (const finding of findings) {
    const key = [finding.code, finding.resourceKind, finding.resourceName, finding.expected, finding.actual].join('|');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }
    byKey.set(key, {
      ...existing,
      severity: severityRank(finding.severity) > severityRank(existing.severity) ? finding.severity : existing.severity,
      evidence: [...new Set([...existing.evidence, ...finding.evidence])],
      confidence: Math.max(existing.confidence, finding.confidence),
      suggestedAction: finding.requiresUserInput ? finding.suggestedAction : existing.suggestedAction,
      requiresUserInput: existing.requiresUserInput || finding.requiresUserInput,
    });
  }
  return [...byKey.values()];
}

function severityRank(severity: VerificationFinding['severity']): number {
  switch (severity) {
    case 'blocker':
      return 4;
    case 'error':
      return 3;
    case 'warning':
      return 2;
    default:
      return 1;
  }
}

function formatFindingIssue(finding: VerificationFinding): string {
  const target = finding.resourceName ? finding.resourceKind + ' "' + finding.resourceName + '"' : finding.resourceKind;
  return finding.code + ': ' + target + ' expected ' + String(finding.expected ?? 'n/a') + ', actual ' + String(finding.actual ?? 'n/a') + '.';
}

function mapDriftCode(kind: DriftFindingKind): VerificationFinding['code'] {
  switch (kind) {
    case 'missing-container':
      return 'MISSING_CONTAINER';
    case 'stopped-container':
      return 'CONTAINER_NOT_RUNNING';
    case 'image-mismatch':
      return 'IMAGE_MISMATCH';
    case 'port-mismatch':
      return 'PORT_MISMATCH';
    case 'missing-network':
      return 'NETWORK_MISMATCH';
    case 'missing-volume':
      return 'VOLUME_MISMATCH';
    case 'missing-image':
      return 'IMAGE_NOT_FOUND';
    case 'uncertain-runtime-evidence':
      return 'RUNTIME_OBSERVATION_UNCERTAIN';
    default:
      return 'RUNTIME_DRIFT';
  }
}

function toContainerName(projectName: string, serviceName: string): string {
  return toServiceContainerName(projectName, serviceName);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
