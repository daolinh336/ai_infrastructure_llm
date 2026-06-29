import { describe, expect, it } from 'vitest';
import { collectDestroyAllTargets, isMissingDockerResourceError } from '../src/cli/shared.js';
import type { InfrastructureStateSnapshot, RuntimeActualState, VerifiedRuntimeSnapshot } from '../src/domain/types.js';

describe('destroy-all target collection', () => {
  it('skips protected Docker Desktop networks even when stale state references them', () => {
    const state: InfrastructureStateSnapshot = {
      schemaVersion: 1,
      current: snapshotWithStaleRefs(),
      pendingPreview: null,
      history: [],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [
        { name: 'sample-infra-net', status: 'bridge' },
        { name: 'docker_labs-ai-tools-for-devs-desktop-extension_default', status: 'bridge' },
      ],
      volumes: [],
      images: [],
      lastObservedAt: new Date(0).toISOString(),
    };

    const targets = collectDestroyAllTargets(state, actual, false);

    expect(targets.networks).toEqual(['app-network', 'sample-infra-net']);
  });
});

describe('isMissingDockerResourceError', () => {
  it('treats Docker 404 missing resources as already absent', () => {
    expect(isMissingDockerResourceError(new Error('MCP tool error: Error: (HTTP code 404) no such container - No such container: sample-infra-web'))).toBe(true);
    expect(isMissingDockerResourceError(new Error('MCP tool error: Error: (HTTP code 404) no such network - network app-network not found'))).toBe(true);
  });
});

function snapshotWithStaleRefs(): VerifiedRuntimeSnapshot {
  const checkedAt = new Date(0).toISOString();
  return {
    id: 'snapshot-1',
    request: { raw: 'create infra', normalizedPrompt: 'create infra', intent: 'create' },
    desired: {
      projectName: 'sample-infra',
      services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine' }],
      networks: ['app-network', 'docker_labs-ai-tools-for-devs-desktop-extension_default'],
      volumes: [],
    },
    composeArtifact: { targetPath: 'docker-compose.yaml', previewContent: '', previewSha256: '', lineCount: 0, written: true, writtenAt: checkedAt },
    actual: { source: 'mcp-readonly', containers: [], networks: [], volumes: [], images: [], lastObservedAt: checkedAt },
    verification: { status: 'passed', scope: 'runtime', checkedAt, summary: 'ok', issues: [], evidence: [] },
    resourceRefs: {
      projectName: 'sample-infra',
      containers: ['sample-infra-api'],
      networks: ['app-network', 'docker_labs-ai-tools-for-devs-desktop-extension_default'],
      volumes: [],
      images: [],
    },
    approvedAt: checkedAt,
    appliedAt: checkedAt,
    savedAt: checkedAt,
  };
}
