import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '../src/domain/types.js';
import { ExecutionEngine } from '../src/execution/execution-engine.js';

describe('ExecutionEngine validation', () => {
  it('rejects invalid agent results before rendering compose YAML', async () => {
    const result: AgentRunResult = {
      status: 'planned',
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
