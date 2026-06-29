import { describe, expect, it } from 'vitest';
import { applySpecPatchPlan } from '../src/agent/spec-patch-applier.js';
import type { InfrastructureSpec } from '../src/domain/types.js';

describe('database scale patches', () => {
  it('expands a database replica request into explicit services with isolated volumes', () => {
    const result = applySpecPatchPlan(baseSpec(), [
      {
        op: 'set-service-replicas',
        target: { name: 'postgres' },
        replicas: 3,
        reason: 'User asked to scale DB to three instances.',
      },
    ]);

    expect(result.results[0]?.applied).toBe(true);
    expect(result.spec.services.map((service) => service.name)).toEqual([
      'api',
      'postgres-1',
      'postgres-2',
      'postgres-3',
    ]);
    const primary = result.spec.services.find((service) => service.name === 'postgres-1');
    expect(primary).not.toHaveProperty('replicas');
    expect(primary).toMatchObject({
      kind: 'database',
      volumes: ['postgres-data-1:/var/lib/postgresql/data'],
    });
    expect(result.spec.services.find((service) => service.name === 'postgres-2')).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-2:/var/lib/postgresql/data'],
    });
    expect(result.spec.services.find((service) => service.name === 'postgres-3')).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-3:/var/lib/postgresql/data'],
    });
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual([
      'postgres-1',
      'postgres-2',
      'postgres-3',
    ]);
    expect(result.spec.volumes).toEqual(['postgres-data-1', 'postgres-data-2', 'postgres-data-3']);
  });

  it('scales down an already-expanded database by removing the highest suffix service', () => {
    const result = applySpecPatchPlan(expandedSpec(3), [
      {
        op: 'set-service-replicas',
        target: { name: 'postgres' },
        replicas: 2,
        reason: 'User asked to reduce DB to two instances.',
      },
    ]);

    expect(result.results[0]?.applied).toBe(true);
    expect(result.spec.services.map((service) => service.name)).toEqual(['api', 'postgres-1', 'postgres-2']);
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['postgres-1', 'postgres-2']);
    expect(result.spec.services.some((service) => service.name === 'postgres-3')).toBe(false);
    expect(result.spec.volumes).toEqual(['postgres-data-1', 'postgres-data-2']);
  });

  it('scales up an already-expanded database by appending the next suffix services', () => {
    const result = applySpecPatchPlan(expandedSpec(3), [
      {
        op: 'set-service-replicas',
        target: { name: 'postgres' },
        replicas: 5,
        reason: 'User asked to increase DB to five instances.',
      },
    ]);

    expect(result.results[0]?.applied).toBe(true);
    expect(result.spec.services.map((service) => service.name)).toEqual(['api', 'postgres-1', 'postgres-2', 'postgres-3', 'postgres-4', 'postgres-5']);
    expect(result.spec.services.find((service) => service.name === 'postgres-4')).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-4:/var/lib/postgresql/data'],
    });
    expect(result.spec.services.find((service) => service.name === 'postgres-5')).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-5:/var/lib/postgresql/data'],
    });
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual([
      'postgres-1',
      'postgres-2',
      'postgres-3',
      'postgres-4',
      'postgres-5',
    ]);
    expect(result.spec.volumes).toEqual(['postgres-data-1', 'postgres-data-2', 'postgres-data-3', 'postgres-data-4', 'postgres-data-5']);
  });
});

function baseSpec(): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [
      { kind: 'backend', name: 'api', image: 'node:20-alpine', dependsOn: ['postgres'] },
      {
        kind: 'database',
        name: 'postgres',
        image: 'postgres:16',
        environment: {
          POSTGRES_DB: 'mydb',
          POSTGRES_USER: 'user',
          POSTGRES_PASSWORD: 'password',
        },
        volumes: ['postgres-data:/var/lib/postgresql/data'],
      },
    ],
    networks: ['app-network'],
    volumes: ['postgres-data'],
  };
}

function expandedSpec(replicas: number): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [
      {
        kind: 'backend',
        name: 'api',
        image: 'node:20-alpine',
        dependsOn: Array.from({ length: replicas }, (_, index) => `postgres-${index + 1}`),
      },
      ...Array.from({ length: replicas }, (_, index) => ({
        kind: 'database' as const,
        name: `postgres-${index + 1}`,
        image: 'postgres:16',
        environment: {
          POSTGRES_DB: 'mydb',
          POSTGRES_USER: 'user',
          POSTGRES_PASSWORD: 'password',
        },
        volumes: [`postgres-data-${index + 1}:/var/lib/postgresql/data`],
        ...(index === 0 ? {} : { dependsOn: ['postgres-1'] }),
      })),
    ],
    networks: ['app-network'],
    volumes: Array.from({ length: replicas }, (_, index) => `postgres-data-${index + 1}`),
  };
}
