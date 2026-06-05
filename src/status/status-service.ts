import type { StateSnapshot } from '../domain/types.js';
import { loadState, StateStoreError } from '../state/file-state-store.js';

export class StatusService {
  async showStatus(): Promise<string> {
    let snapshot: StateSnapshot | null;

    try {
      snapshot = await loadState();
    } catch (error) {
      if (error instanceof StateStoreError) {
        return ['Infrastructure state is invalid.', error.message].join('\n');
      }

      throw error;
    }

    if (!snapshot) {
      return 'No infrastructure state found yet.';
    }

    const desiredStateSavedAt = snapshot.desiredStateSavedAt ?? snapshot.lastAppliedAt ?? 'never';
    const lastAppliedAt = snapshot.desiredStateSavedAt ? snapshot.lastAppliedAt ?? 'never' : 'never';

    return [
      `Project: ${snapshot.desired.projectName}`,
      `Services: ${snapshot.desired.services.map((service) => service.name).join(', ')}`,
      `Desired state saved: ${desiredStateSavedAt}`,
      `Last applied: ${lastAppliedAt}`,
      `Observed containers: ${snapshot.actual.containers.join(', ') || 'none'}`,
      `Last observed: ${snapshot.actual.lastObservedAt ?? 'never'}`,
    ].join('\n');
  }
}
