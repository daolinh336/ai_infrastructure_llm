import type {
  InfrastructureStateSnapshot,
  VerifiedRuntimeSnapshot,
} from '../domain/types.js';
import { desiredPortMappingsPresent } from '../domain/port-mappings.js';
import { toReplicaContainerNames } from '../execution/container-names.js';
import {
  listProjectStates,
  loadProjectState,
  StateStoreError,
  type StateStoreOptions,
} from '../state/sqlite-state-store.js';

export class StatusService {
  constructor(private readonly stateStore: StateStoreOptions = {}) {}

  async showStatus(projectName?: string | null): Promise<string> {
    let snapshots: InfrastructureStateSnapshot[];

    try {
      if (projectName) {
        const projectState = await loadProjectState(projectName, this.stateStore);
        snapshots = projectState?.current ? [projectState] : [];
      } else {
        snapshots = (await listProjectStates(this.stateStore)).filter((snapshot) => snapshot.current);
      }
    } catch (error) {
      if (error instanceof StateStoreError) {
        return ['Infrastructure state is invalid.', error.message].join('\n');
      }

      throw error;
    }

    if (snapshots.length === 0) {
      return projectName
        ? 'No verified infrastructure state found for project "' + projectName + '".'
        : 'No verified infrastructure state found yet.';
    }

    return formatStatusSnapshots(snapshots);
  }
}

export function formatStatusSnapshots(snapshots: InfrastructureStateSnapshot[]): string {
  return snapshots
    .map((snapshot, index) => [
      'Project ' + String(index + 1) + '/' + String(snapshots.length) + ': ' + snapshot.current!.desired.projectName,
      'State schema version: ' + String(snapshot.schemaVersion),
      formatCurrentState(snapshot),
      'History records: ' + String(snapshot.history.length),
    ].join('\n'))
    .join('\n\n');
}

function isRunningStatus(status: string | null): boolean {
  return status === 'running';
}

function formatDesiredEnvironment(environment: Record<string, string> | undefined): string {
  const keys = Object.keys(environment ?? {});
  return keys.length > 0 ? `${keys.length} managed key(s)` : 'none';
}

function formatEnvironmentComparison(
  desiredEnvironment: Record<string, string> | undefined,
  actualEnvironment: Record<string, string> | null | undefined,
): string {
  const desiredEntries = Object.entries(desiredEnvironment ?? {});
  if (desiredEntries.length === 0) return 'none (ok)';
  if (actualEnvironment === undefined) return `${desiredEntries.length} managed key(s) unknown (not inspected)`;
  if (actualEnvironment === null) return `${desiredEntries.length} managed key(s) unknown (inspect missing env)`;

  const missingKeys = desiredEntries
    .filter(([key]) => !(key in actualEnvironment))
    .map(([key]) => key);
  const mismatchedKeys = desiredEntries
    .filter(([key, value]) => key in actualEnvironment && actualEnvironment[key] !== value)
    .map(([key]) => key);
  if (missingKeys.length === 0 && mismatchedKeys.length === 0) {
    return `${desiredEntries.length} managed key(s) (ok)`;
  }

  const details = [
    missingKeys.length > 0 ? `missing: ${missingKeys.join(',')}` : null,
    mismatchedKeys.length > 0 ? `mismatch: ${mismatchedKeys.join(',')}` : null,
  ].filter((entry): entry is string => entry !== null);
  return `${details.join('; ')} (DRIFT)`;
}

function formatDesiredActualComparison(current: VerifiedRuntimeSnapshot): string[] {
  const desired = current.desired;
  const containers = current.actual.containers;
  const nameWidth = Math.max(...desired.services.map((service) => service.name.length), '(extra)'.length);
  const lines: string[] = [];
  const matched = new Set<string>();

  for (const service of desired.services) {
    const expectedNames = toReplicaContainerNames(desired.projectName, service);
    const serviceContainers = expectedNames
      .map((expected) => containers.find((entry) => entry.name === expected) ?? null)
      .filter((container): container is NonNullable<typeof container> => container !== null);
    for (const container of serviceContainers) matched.add(container.name);
    const label = service.name.padEnd(nameWidth);

    if (serviceContainers.length === 0) {
      const desiredStatus = service.desiredStatus ?? 'running';
      lines.push(
        `  - ${label} | MISSING | expected: ${expectedNames.join(', ')} | image: ${service.image} | ports: ${(service.ports ?? []).join(', ') || 'none'} | env: ${formatDesiredEnvironment(service.environment)} | desired: ${desiredStatus} | status: absent (DRIFT)`,
      );
      continue;
    }

    for (const container of serviceContainers) {
      const imageOk =
        container.image == null ||
        container.image.startsWith(service.image) ||
        service.image.startsWith(container.image);
      const desiredPorts = (service.ports ?? []).join(', ') || 'none';
      const actualPorts = (container.ports ?? []).join(', ') || 'none';
      const desiredStatus = service.desiredStatus ?? 'running';
      const status = container.status ?? 'unknown';
      const lifecycleOk = desiredStatus === 'running'
        ? isRunningStatus(container.status)
        : !isRunningStatus(container.status);
      const shouldComparePorts = desiredStatus === 'running' && isRunningStatus(container.status);
      const portsOk = !shouldComparePorts || desiredPortMappingsPresent(service.ports, container.ports ?? []);
      const portsMarker = shouldComparePorts ? (portsOk ? '(ok)' : '(DRIFT)') : '(not checked)';
      const envComparison = formatEnvironmentComparison(service.environment, container.environment);
      lines.push(
        `  - ${label} | container: ${container.name} | image: ${service.image} ${imageOk ? '==' : '!='} ${container.image ?? 'unknown'} ${imageOk ? '(ok)' : '(DRIFT)'} | lifecycle: ${desiredStatus} ${lifecycleOk ? '==' : '!='} ${status} ${lifecycleOk ? '(ok)' : '(DRIFT)'} | ports: ${desiredPorts} ${portsOk ? '==' : '!='} ${actualPorts} ${portsMarker} | env: ${envComparison}`,
      );
    }

    const missingNames = expectedNames.filter((expected) => !matched.has(expected));
    for (const missingName of missingNames) {
      const desiredStatus = service.desiredStatus ?? 'running';
      lines.push(
        `  - ${label} | MISSING | expected: ${missingName} | image: ${service.image} | ports: ${(service.ports ?? []).join(', ') || 'none'} | env: ${formatDesiredEnvironment(service.environment)} | desired: ${desiredStatus} | status: absent (DRIFT)`,
      );
    }
  }

  for (const container of containers) {
    if (matched.has(container.name)) continue;
    const label = '(extra)'.padEnd(nameWidth);
    lines.push(
      `  - ${label} | EXTRA   | container: ${container.name} | image: ${container.image ?? 'unknown'} | status: ${container.status ?? 'unknown'}`,
    );
  }

  return lines;
}

function formatCurrentState(snapshot: InfrastructureStateSnapshot): string {
  if (!snapshot.current) {
    return [
      'Current verified state: none',
      'Actual runtime state: not observed',
    ].join('\n');
  }

  const current = snapshot.current;
  const observedContainers = current.actual.containers
    .map((container) => container.name)
    .join(', ');

  return [
    `Current verified project: ${current.desired.projectName}`,
    `Current services: ${current.desired.services.map((service) => service.name).join(', ')}`,
    `Approved at: ${current.approvedAt ?? 'never'}`,
    `Applied at: ${current.appliedAt ?? 'never'}`,
    `Actual runtime source: ${current.actual.source}`,
    `Observed containers: ${observedContainers || 'none'}`,
    `Last observed: ${current.actual.lastObservedAt ?? 'never'}`,
    `Verification status: ${current.verificationReport?.status ?? current.verification.status}`,
    `Verification findings: ${formatVerificationFindings(current)}`,
    `Observed networks: ${current.actual.networks.map((n) => n.name).join(', ') || 'none'}`,
    `Observed volumes: ${current.actual.volumes.map((v) => v.name).join(', ') || 'none'}`,
    `Observed images: ${current.actual.images.map((i) => i.reference).join(', ') || 'none'}`,
    `Drift status: ${current.driftReport?.status ?? 'not checked'}`,
    `Revision history: ${formatRevisionHistory(current)}`,
    `Operation: ${current.operation ?? 'deploy'}`,
    '',
    'Desired vs actual comparison:',
    ...formatDesiredActualComparison(current),
  ].join('\n');
}

function formatVerificationFindings(
  current: NonNullable<InfrastructureStateSnapshot['current']>,
): string {
  const findings = current.verificationReport?.findings ?? [];
  if (findings.length === 0) {
    return current.verification.issues.length > 0 ? current.verification.issues.join('; ') : 'none';
  }
  return findings
    .map((finding) => `${finding.code}/${finding.severity}${finding.resourceName ? `:${finding.resourceName}` : ''}`)
    .join(', ');
}

function formatRevisionHistory(
  current: NonNullable<InfrastructureStateSnapshot['current']>,
): string {
  const history = current.revisionHistory ?? [];
  if (history.length === 0) return 'none';
  return history
    .map((entry) => `#${entry.attemptIndex}:${entry.revisionDecision}`)
    .join(', ');
}
