import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '../src/domain/types.js';
import { ExecutionEngine } from '../src/execution/execution-engine.js';
import { loadState } from '../src/state/file-state-store.js';

describe('ExecutionEngine validation', () => {
  it('returns a detailed dry-run preview without runtime side effects', async () => {
    const result: AgentRunResult = {
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
        spec: {
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
        },
        steps: [
          {
            id: 'generate-compose',
            description: 'Generate compose.',
            action: 'generate-compose',
          },
        ],
      },
    };

    const execution = await new ExecutionEngine().dryRun(result);

    expect(execution.dryRunPreview.schedule.serviceStartOrder).toEqual([
      'postgres',
      'api',
      'nginx',
    ]);
    expect(execution.dryRunPreview.totalContainers).toBe(4);
    expect(execution.dryRunPreview.artifactWritten).toBe(false);
    expect(execution.dryRunPreview.stateSaved).toBe(false);
    expect(execution.dryRunPreview.dockerCalled).toBe(false);
    expect(execution.dryRunPreview.mcpCalled).toBe(false);
  });

  it('does not write state during dry-run', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await new ExecutionEngine({ stateStore: { stateFilePath } }).dryRun(
        createValidAgentResult(),
      );

      await expect(loadState({ stateFilePath })).resolves.toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('saveDesiredState writes a pending preview instead of verified current state', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-state-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await new ExecutionEngine({ stateStore: { stateFilePath } }).saveDesiredState(
        createValidAgentResult(),
      );
      const state = await loadState({ stateFilePath });

      expect(state?.schemaVersion).toBe(1);
      expect(state?.current).toBeNull();
      expect(state?.pendingPreview?.desired.projectName).toBe('demo');
      expect(state?.pendingPreview?.composeArtifact.written).toBe(false);
      expect(state?.pendingPreview?.dryRunPreview?.stateSaved).toBe(false);
      expect(state?.history.map((record) => record.type)).toContain('pending-preview-saved');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid agent results before rendering compose YAML', async () => {
    const result: AgentRunResult = {
      status: 'planned',
      request: {
        raw: 'Invalid plan',
        normalizedPrompt: 'Invalid plan',
        intent: 'create',
      },
      observations: [
        {
          source: 'reason',
          message: 'Test observation.',
        },
      ],
      plan: {
        summary: 'Invalid plan',
        assumptions: ['Test plan fixture.'],
        spec: {
          projectName: 'bad-demo',
          networks: ['app-network'],
          volumes: [],
          services: [
            {
              kind: 'backend',
              name: 'api',
              image: 'node:20-alpine',
              replicas: 0,
              ports: ['99999:80'],
            },
          ],
        },
        steps: [
          {
            id: 'generate-compose',
            description: 'Generate compose.',
            action: 'generate-compose',
          },
        ],
      },
    };

    await expect(new ExecutionEngine().dryRun(result)).rejects.toThrow(
      /Invalid agent run result/,
    );
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
      spec: {
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
      },
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
