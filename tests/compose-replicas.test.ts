import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { renderCompose } from '../src/compose/render-compose.js';
import {
  buildDetailedDryRunPreview,
  evaluateDryRunPolicy,
} from '../src/execution/dependency-schedule.js';
import type { ExecutionPlan, InfrastructureSpec } from '../src/domain/types.js';

describe('compose replicas rendering and scale warnings', () => {
  it('renders deploy.replicas as 1 by default for every service', () => {
    const parsed = YAML.parse(renderCompose(baseSpec())) as {
      services: Record<string, { deploy?: { replicas?: number } }>;
    };

    expect(parsed.services.api?.deploy).toEqual({ replicas: 1 });
    expect(parsed.services.postgres?.deploy).toEqual({ replicas: 1 });
  });

  it('warns when a stateless service scales above one replica', () => {
    const findings = evaluateDryRunPolicy({
      ...baseSpec(),
      services: [
        { kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2 },
      ],
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'replica-preview',
        message: expect.stringContaining('confirm the service is stateless'),
        resourceName: 'api',
      }),
    );
  });

  it('renders database scale requests as explicit service impacts', () => {
    const spec: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 2 },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const plan: ExecutionPlan = {
      summary: 'Scale postgres',
      spec,
      assumptions: ['Postgres replicas use isolated generated volumes.'],
      steps: [{ id: 'compose', description: 'Generate compose', action: 'generate-compose' }],
    };

    const preview = buildDetailedDryRunPreview(plan, renderCompose(spec));

    expect(preview.services.map((service) => service.name)).toEqual([
      'postgres-1',
      'postgres-2',
    ]);
    expect(preview.services.every((service) => service.replicas === 1)).toBe(true);
    expect(preview.volumes).toEqual(['postgres-data-1', 'postgres-data-2']);
  });

  it('renders host ports only for reverse-proxy services', () => {
    const parsed = YAML.parse(renderCompose({
      projectName: 'sample-infra',
      services: [
        { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'] },
        { kind: 'backend', name: 'api', image: 'node:20-alpine', ports: ['3000:3000'] },
        { kind: 'database', name: 'postgres', image: 'postgres:16', ports: ['5432:5432'] },
      ],
      networks: ['app-network'],
      volumes: [],
    })) as { services: Record<string, { ports?: string[] }> };

    expect(parsed.services.nginx?.ports).toEqual(['80:80']);
    expect(parsed.services.api?.ports).toBeUndefined();
    expect(parsed.services.postgres?.ports).toBeUndefined();
  });
});

function baseSpec(): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [
      { kind: 'backend', name: 'api', image: 'node:20-alpine' },
      { kind: 'database', name: 'postgres', image: 'postgres:16' },
    ],
    networks: ['app-network'],
    volumes: [],
  };
}
