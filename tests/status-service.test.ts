import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  InfrastructureSpec,
  InfrastructureStateFile,
} from '../src/domain/types.js';
import { StatusService } from '../src/status/status-service.js';
import {
  createComposeArtifactRecord,
  createVerificationState,
  saveState,
} from '../src/state/file-state-store.js';

const validSpec: InfrastructureSpec = {
  projectName: 'demo',
  networks: ['app-network'],
  volumes: [],
  services: [
    {
      kind: 'reverse-proxy',
      name: 'nginx',
      image: 'nginx:stable',
      ports: ['80:80'],
    },
  ],
};

describe('StatusService', () => {
  it('reports missing state clearly', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-status-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await expect(new StatusService({ stateFilePath }).showStatus()).resolves.toBe(
        'No infrastructure state found yet.',
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('shows pending preview state separately from actual runtime observation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-status-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await saveState(createPendingOnlyStateFile(), { stateFilePath });
      const status = await new StatusService({ stateFilePath }).showStatus();

      expect(status).toContain('Current verified state: none');
      expect(status).toContain('Actual runtime state: not observed');
      expect(status).toContain('Pending preview project: demo');
      expect(status).toContain('Compose artifact: docker-compose.yaml (not written)');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('shows verified current state when runtime observation exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-status-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await saveState(createVerifiedCurrentStateFile(), { stateFilePath });
      const status = await new StatusService({ stateFilePath }).showStatus();

      expect(status).toContain('Current verified project: demo');
      expect(status).toContain('Actual runtime source: runtime-adapter');
      expect(status).toContain('Observed containers: demo-nginx');
      expect(status).toContain('Pending preview: none');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports invalid state file errors', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-status-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await writeFile(stateFilePath, JSON.stringify({ schemaVersion: 1 }), 'utf8');
      const status = await new StatusService({ stateFilePath }).showStatus();

      expect(status).toContain('Infrastructure state is invalid.');
      expect(status).toContain('State file has invalid schema.');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createPendingOnlyStateFile(): InfrastructureStateFile {
  return {
    schemaVersion: 1,
    current: null,
    pendingPreview: {
      id: 'pending-test',
      request: {
        raw: 'Tao nginx port 80',
        normalizedPrompt: 'Tao nginx port 80',
        intent: 'create',
      },
      desired: validSpec,
      plan: createPlan(),
      composeArtifact: createComposeArtifactRecord(
        'docker-compose.yaml',
        'services:\n  nginx:\n    image: nginx:stable\n',
        false,
        null,
      ),
      dryRunPreview: null,
      observations: [],
      trace: [],
      verification: createVerificationState('preview', 'Preview not verified.'),
      createdAt: '2026-06-04T11:24:44.723Z',
      acceptedAt: null,
    },
    history: [],
  };
}

function createVerifiedCurrentStateFile(): InfrastructureStateFile {
  return {
    schemaVersion: 1,
    current: {
      id: 'current-test',
      request: {
        raw: 'Tao nginx port 80',
        normalizedPrompt: 'Tao nginx port 80',
        intent: 'create',
      },
      desired: validSpec,
      composeArtifact: createComposeArtifactRecord(
        'docker-compose.yaml',
        'services:\n  nginx:\n    image: nginx:stable\n',
        true,
        '2026-06-04T11:24:44.723Z',
      ),
      actual: {
        source: 'runtime-adapter',
        containers: [
          {
            name: 'demo-nginx',
            image: 'nginx:stable',
            status: 'running',
            ports: ['80:80'],
          },
        ],
        networks: [
          {
            name: 'app-network',
            status: 'present',
          },
        ],
        volumes: [],
        images: [
          {
            reference: 'nginx:stable',
            id: 'sha256:test',
            status: 'present',
          },
        ],
        lastObservedAt: '2026-06-04T11:25:44.723Z',
      },
      verification: {
        status: 'passed',
        scope: 'runtime',
        checkedAt: '2026-06-04T11:25:44.723Z',
        summary: 'Runtime state matched desired state.',
        issues: [],
        evidence: ['Container demo-nginx was running.'],
      },
      approvedAt: '2026-06-04T11:24:50.000Z',
      appliedAt: '2026-06-04T11:25:00.000Z',
      savedAt: '2026-06-04T11:25:44.723Z',
    },
    pendingPreview: null,
    history: [],
  };
}

function createPlan() {
  return {
    summary: 'Test plan',
    spec: validSpec,
    assumptions: ['Test fixture.'],
    steps: [
      {
        id: 'generate-compose',
        description: 'Generate compose.',
        action: 'generate-compose' as const,
      },
    ],
  };
}
