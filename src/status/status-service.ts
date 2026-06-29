import type {
  InfrastructureStateSnapshot,
  VerifiedRuntimeSnapshot,
} from '../domain/types.js';
import {
  loadState,
  StateStoreError,
  type StateStoreOptions,
} from '../state/sqlite-state-store.js';

export class StatusService {
  constructor(private readonly stateStore: StateStoreOptions = {}) {}

  async showStatus(): Promise<string> {
    let snapshot: InfrastructureStateSnapshot | null;

    try {
      snapshot = await loadState(this.stateStore);
    } catch (error) {
      if (error instanceof StateStoreError) {
        return ['Infrastructure state is invalid.', error.message].join('\n');
      }

      throw error;
    }

    if (!snapshot) {
      return 'No infrastructure state found yet.';
    }

    return [
      `State schema version: ${snapshot.schemaVersion}`,
      formatCurrentState(snapshot),
      formatPendingPreview(snapshot),
      `History records: ${snapshot.history.length}`,
    ].join('\n');
  }
}

function toContainerName(projectName: string, serviceName: string): string {
  return projectName + '-' + serviceName.replace(/[_\s]+/g, '-');
}

function isRunningStatus(status: string | null): boolean {
  return status === 'running';
}

function formatDesiredActualComparison(current: VerifiedRuntimeSnapshot): string[] {
  const desired = current.desired;
  const containers = current.actual.containers;
  const nameWidth = Math.max(...desired.services.map((service) => service.name.length), '(extra)'.length);
  const lines: string[] = [];
  const matched = new Set<string>();

  for (const service of desired.services) {
    const expected = toContainerName(desired.projectName, service.name);
    const container =
      containers.find((entry) => entry.name === expected) ??
      containers.find((entry) => entry.name.includes(service.name)) ??
      null;
    if (container) matched.add(container.name);
    const label = service.name.padEnd(nameWidth);

    if (!container) {
      const desiredStatus = service.desiredStatus ?? 'running';
      lines.push(
        `  - ${label} | MISSING | image: ${service.image} | ports: ${(service.ports ?? []).join(', ') || 'none'} | desired: ${desiredStatus} | status: absent (DRIFT)`,
      );
      continue;
    }

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
    const portsOk = !shouldComparePorts || (service.ports ?? []).every((port) =>
      (container.ports ?? []).some((actualPort) => actualPort.includes(port.split(':')[0] ?? '')),
    );
    const portsMarker = shouldComparePorts ? (portsOk ? '(ok)' : '(DRIFT)') : '(not checked)';
    lines.push(
      `  - ${label} | image: ${service.image} ${imageOk ? '==' : '!='} ${container.image ?? 'unknown'} ${imageOk ? '(ok)' : '(DRIFT)'} | lifecycle: ${desiredStatus} ${lifecycleOk ? '==' : '!='} ${status} ${lifecycleOk ? '(ok)' : '(DRIFT)'} | ports: ${desiredPorts} ${portsOk ? '==' : '!='} ${actualPorts} ${portsMarker}`,
    );
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
function formatPendingPreview(snapshot: InfrastructureStateSnapshot): string {
  if (!snapshot.pendingPreview) {
    return 'Pending preview: none';
  }

  const pending = snapshot.pendingPreview;
  const artifactStatus = pending.composeArtifact.written
    ? `written at ${pending.composeArtifact.writtenAt}`
    : 'not written';

  return [
    `Pending preview project: ${pending.desired.projectName}`,
    `Pending request: ${pending.request.raw}`,
    `Pending services: ${pending.desired.services.map((service) => service.name).join(', ')}`,
    `Pending preview created: ${pending.createdAt}`,
    `Pending preview accepted: ${pending.acceptedAt ?? 'not accepted'}`,
    `Compose artifact: ${pending.composeArtifact.targetPath} (${artifactStatus})`,
    `Compose artifact hash: ${pending.composeArtifact.previewSha256}`,
    `Dry-run containers if applied: ${pending.dryRunPreview?.totalContainers ?? 'unknown'}`,
  ].join('\n');
}
