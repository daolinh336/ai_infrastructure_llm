import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRunResult, InfrastructureSpec } from '../src/domain/types.js';
import { ExecutionEngine } from '../src/execution/execution-engine.js';
import {
  loadState,
  savePendingPreview,
  StateStoreError,
} from '../src/state/file-state-store.js';

const validSpec: InfrastructureSpec = {
  projectName: 'demo',
  networks: ['app-network'],
  volumes: ['postgres-data'],
  services: [
    {
      kind: 'reverse-proxy',
      name: 'nginx',
      image: 'nginx:stable',
      ports: ['80:80'],
      dependsOn: ['api'],
    },
    {
      kind: 'backend',
      name: 'api',
      image: 'node:20-alpine',
      replicas: 2,
      dependsOn: ['postgres'],
    },
    {
      kind: 'database',
      name: 'postgres',
      image: 'postgres:16',
      environment: {
        POSTGRES_PASSWORD: 'app',
      },
      volumes: ['postgres-data:/var/lib/postgresql/data'],
    },
  ],
};

describe('file state store', () => {
  it('returns null when the state file is missing', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await expect(loadState({ stateFilePath })).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports malformed JSON separately from invalid schemas', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await writeFile(stateFilePath, '{', 'utf8');

      await expect(loadState({ stateFilePath })).rejects.toThrow(StateStoreError);
      await expect(loadState({ stateFilePath })).rejects.toThrow(/malformed JSON/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports invalid schemas when neither v1 nor legacy migration matches', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await writeFile(
        stateFilePath,
        JSON.stringify({ schemaVersion: 1, current: null, pendingPreview: null }),
        'utf8',
      );

      await expect(loadState({ stateFilePath })).rejects.toThrow(/invalid schema/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('migrates legacy desired-state snapshots into pending preview memory', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await writeFile(
        stateFilePath,
        JSON.stringify({
          desired: validSpec,
          actual: {
            containers: [],
            lastObservedAt: null,
          },
          desiredStateSavedAt: '2026-06-04T11:24:44.723Z',
          lastAppliedAt: null,
        }),
        'utf8',
      );

      const state = await loadState({ stateFilePath });

      expect(state?.schemaVersion).toBe(1);
      expect(state?.current).toBeNull();
      expect(state?.pendingPreview?.desired.projectName).toBe('demo');
      expect(state?.pendingPreview?.dryRunPreview).toBeNull();
      expect(state?.history.map((record) => record.type)).toEqual([
        'legacy-state-migrated',
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('saves pending preview state with an atomic temp-file rename', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      const execution = await new ExecutionEngine().dryRun(createValidAgentResult());
      await savePendingPreview(execution.pendingPreview, { stateFilePath });
      const state = await loadState({ stateFilePath });
      const files = await readdir(tempDir);

      expect(state?.pendingPreview?.desired.projectName).toBe('demo');
      expect(state?.current).toBeNull();
      expect(files).toEqual(['infra-state.json']);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

function createValidAgentResult(): AgentRunResult {
  return {
    status: 'planned',
    request: {
      raw: 'Tao nginx api postgres',
      normalizedPrompt: 'Tao nginx api postgres',
      intent: 'create',
    },
    observations: [
      {
        source: 'reason',
        message: 'Test observation.',
      },
    ],
    plan: {
      summary: 'Valid plan',
      assumptions: ['Test plan fixture.'],
      spec: validSpec,
      steps: [
        {
          id: 'generate-compose',
          description: 'Generate compose.',
          action: 'generate-compose',
        },
      ],
    },
  };
}
