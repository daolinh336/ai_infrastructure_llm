import type { InfrastructureStateFile } from '../domain/types.js';
import {
  loadState,
  StateStoreError,
  type StateStoreOptions,
} from '../state/file-state-store.js';

export class StatusService {
  constructor(private readonly stateStore: StateStoreOptions = {}) {}

  async showStatus(): Promise<string> {
    let snapshot: InfrastructureStateFile | null;

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

function formatCurrentState(snapshot: InfrastructureStateFile): string {
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
  ].join('\n');
}

function formatPendingPreview(snapshot: InfrastructureStateFile): string {
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
