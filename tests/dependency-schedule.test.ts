import { describe, expect, it } from 'vitest';
import type { ExecutionPlan, InfrastructureSpec } from '../src/domain/types.js';
import {
  buildDependencyAwareExecutionSchedule,
  buildDetailedDryRunPreview,
} from '../src/execution/dependency-schedule.js';
import { renderCompose } from '../src/compose/render-compose.js';

const webStackSpec: InfrastructureSpec = {
  projectName: 'sample-infra',
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
        POSTGRES_DB: 'app',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'app',
      },
      volumes: ['postgres-data:/var/lib/postgresql/data'],
    },
  ],
};

function createPlan(spec: InfrastructureSpec = webStackSpec): ExecutionPlan {
  return {
    summary: 'Test plan',
    spec,
    assumptions: ['Test fixture keeps InfrastructureSpec as source of truth.'],
    steps: [
      {
        id: 'generate-compose',
        description: 'Generate compose.',
        action: 'generate-compose',
      },
    ],
  };
}

describe('dependency-aware execution schedule', () => {
  it('orders foundation resources before postgres, api, and nginx', () => {
    const schedule = buildDependencyAwareExecutionSchedule(webStackSpec);

    expect(schedule.serviceStartOrder).toEqual(['postgres', 'api', 'nginx']);
    expect(schedule.destroyOrder).toEqual(['nginx', 'api', 'postgres']);
    expect(schedule.steps[0]).toMatchObject({
      level: 0,
      resourceType: 'network',
      resourceName: 'app-network',
    });
    expect(schedule.steps[1]).toMatchObject({
      level: 0,
      resourceType: 'volume',
      resourceName: 'postgres-data',
    });

    const postgresStart = schedule.steps.find(
      (step) => step.kind === 'start-service' && step.resourceName === 'postgres',
    );
    const apiStart = schedule.steps.find(
      (step) => step.kind === 'start-service' && step.resourceName === 'api',
    );
    const nginxStart = schedule.steps.find(
      (step) => step.kind === 'start-service' && step.resourceName === 'nginx',
    );

    expect(postgresStart?.order).toBeLessThan(apiStart?.order ?? 0);
    expect(apiStart?.order).toBeLessThan(nginxStart?.order ?? 0);
    expect(apiStart).toMatchObject({
      replicas: 2,
      dependsOn: ['postgres'],
      dependents: ['nginx'],
    });
  });

  it('keeps deterministic order for independent services', () => {
    const schedule = buildDependencyAwareExecutionSchedule({
      projectName: 'independent',
      networks: ['app-network'],
      volumes: ['redis-data', 'postgres-data'],
      services: [
        {
          kind: 'database',
          name: 'redis',
          image: 'redis:7-alpine',
          volumes: ['redis-data:/data'],
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
    });

    expect(schedule.serviceStartOrder).toEqual(['redis', 'postgres']);
  });

  it('rejects missing dependencies before dry-run is ready', () => {
    expect(() =>
      buildDependencyAwareExecutionSchedule({
        ...webStackSpec,
        services: [
          {
            kind: 'backend',
            name: 'api',
            image: 'node:20-alpine',
            dependsOn: ['missing-db'],
          },
        ],
      }),
    ).toThrow(/Unknown service dependency "missing-db"/);
  });

  it('rejects circular dependencies before dry-run is ready', () => {
    expect(() =>
      buildDependencyAwareExecutionSchedule({
        projectName: 'cycle-demo',
        networks: ['app-network'],
        volumes: [],
        services: [
          {
            kind: 'backend',
            name: 'api',
            image: 'node:20-alpine',
            dependsOn: ['nginx'],
          },
          {
            kind: 'reverse-proxy',
            name: 'nginx',
            image: 'nginx:stable',
            dependsOn: ['api'],
          },
        ],
      }),
    ).toThrow(/Circular service dependency detected/);
  });
});

describe('detailed dry-run preview', () => {
  it('describes resources, wait gates, policy warnings, and actions not performed', () => {
    const plan = createPlan();
    const composeYaml = renderCompose(plan.spec);
    const schedule = buildDependencyAwareExecutionSchedule(plan.spec);
    const preview = buildDetailedDryRunPreview(plan, composeYaml, schedule);

    expect(preview.totalServices).toBe(3);
    expect(preview.totalContainers).toBe(4);
    expect(preview.artifactTargetPath).toBe('docker-compose.yaml');
    expect(preview.artifactWritten).toBe(false);
    expect(preview.stateSaved).toBe(false);
    expect(preview.dockerCalled).toBe(false);
    expect(preview.mcpCalled).toBe(false);
    expect(preview.actionsNotPerformed.join('\n')).toContain('Docker Engine API was not called');
    expect(preview.actionsNotPerformed.join('\n')).toContain('state/infra-state.json was not saved');

    expect(preview.services.find((service) => service.name === 'postgres')).toMatchObject({
      waitCondition: 'wait until database accepts connections / service healthy',
      readinessEnforced: false,
      environment: {
        POSTGRES_DB: 'app',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'app',
      },
    });
    expect(preview.services.find((service) => service.name === 'api')).toMatchObject({
      replicas: 2,
      waitCondition: 'wait until service running/healthy',
    });
    expect(preview.services.find((service) => service.name === 'nginx')).toMatchObject({
      waitCondition: 'wait until upstream backend ready/running',
    });
    expect(preview.policyFindings.map((finding) => finding.code)).toContain(
      'readiness-not-enforced-in-dry-run',
    );
    expect(preview.policyFindings.map((finding) => finding.code)).toContain(
      'exposed-host-port',
    );
    expect(preview.policyFindings.map((finding) => finding.code)).toContain(
      'default-secret-preview-value',
    );
    expect(preview.policyFindings.map((finding) => finding.message).join('\n')).toContain(
      'PostgreSQL service "postgres" must be healthy before backend service "api" starts.',
    );
    expect(preview.policyFindings.map((finding) => finding.message).join('\n')).toContain(
      'Backend service "api" readiness is required before reverse proxy service "nginx" routes traffic.',
    );
  });
});
