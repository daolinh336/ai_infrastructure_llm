import { describe, expect, it } from 'vitest';
import type { InfrastructureSpec, RuntimeActualState } from '../src/domain/types.js';
import { buildDriftReport } from '../src/execution/drift-detector.js';
import { buildRepairPlan } from '../src/execution/repair-planner.js';

describe('repair planner for replicated services', () => {
  it('targets the specific missing replica container', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [{ kind: 'backend', name: 'nodejs-backend', image: 'node:20-alpine', replicas: 2 }],
      networks: ['app-network'],
      volumes: [],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        { name: 'sample-infra-nodejs-backend-1', image: 'node:20-alpine', status: 'running', ports: [], environment: {} },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'node:20-alpine', id: 'sha256:test', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };

    const plan = buildRepairPlan(buildDriftReport(desired, actual, new Date(0).toISOString()));

    expect(plan.actions).toContainEqual({
      kind: 'recreate-container',
      risk: 'approval-required',
      resourceName: 'sample-infra-nodejs-backend-2',
      reason: 'Service "nodejs-backend" is missing expected container "sample-infra-nodejs-backend-2".',
    });
  });
});
