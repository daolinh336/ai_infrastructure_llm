import { loadState } from '../state/file-state-store.js';

export class StatusService {
  async showStatus(): Promise<string> {
    const snapshot = await loadState();

    if (!snapshot) {
      return 'No infrastructure state found yet.';
    }

    return [
      `Project: ${snapshot.desired.projectName}`,
      `Services: ${snapshot.desired.services.map((service) => service.name).join(', ')}`,
      `Last applied: ${snapshot.lastAppliedAt ?? 'never'}`,
      `Observed containers: ${snapshot.actual.containers.join(', ') || 'none'}`,
      `Last observed: ${snapshot.actual.lastObservedAt ?? 'never'}`,
    ].join('\n');
  }
}
