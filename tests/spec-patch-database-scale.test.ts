import { describe, expect, it } from 'vitest';
import { applySpecPatchPlan } from '../src/agent/spec-patch-applier.js';
import { getStatefulDatabaseShrinkRemovalOrder } from '../src/domain/stateful-database-volumes.js';
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

  it('shrinks an already-expanded database to one physical service and keeps suffix 1', () => {
    const spec = expandedSpec(3);
    expect(getStatefulDatabaseShrinkRemovalOrder(spec, 'postgres', 1)).toEqual([
      { ordinal: 3, serviceName: 'postgres-3', volumeNames: ['postgres-data-3'] },
      { ordinal: 2, serviceName: 'postgres-2', volumeNames: ['postgres-data-2'] },
    ]);

    const result = applySpecPatchPlan(spec, [
      {
        op: 'set-service-replicas',
        target: { name: 'postgres' },
        replicas: 1,
        reason: 'User asked to reduce DB to one instance.',
      },
    ]);

    expect(result.results[0]?.applied).toBe(true);
    expect(result.spec.services.map((service) => service.name)).toEqual(['api', 'postgres-1']);
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['postgres-1']);
    expect(result.spec.services.find((service) => service.name === 'postgres-1')).toMatchObject({
      kind: 'database',
      volumes: ['postgres-data-1:/var/lib/postgresql/data'],
    });
    expect(result.spec.volumes).toEqual(['postgres-data-1']);
  });

  it.each([
    ['postgres', 'postgres:16', '/var/lib/postgresql/data'],
    ['mysql', 'mysql:8', '/var/lib/mysql'],
    ['mariadb', 'mariadb:11', '/var/lib/mysql'],
    ['mongo', 'mongo:7', '/data/db'],
    ['redis', 'redis:7-alpine', '/data'],
    ['rabbitmq', 'rabbitmq:3-management', '/var/lib/rabbitmq'],
    ['elasticsearch', 'docker.elastic.co/elasticsearch/elasticsearch:8.15.0', '/usr/share/elasticsearch/data'],
    ['kafka', 'apache/kafka:3.8.0', '/tmp/kraft-combined-logs'],
  ])('shrinks %s groups in descending removal order', (name, image, target) => {
    const spec = expandedDatabaseSpec(name, image, target, 3);

    expect(getStatefulDatabaseShrinkRemovalOrder(spec, name, 1)).toEqual([
      { ordinal: 3, serviceName: `${name}-3`, volumeNames: [`${name}-data-3`] },
      { ordinal: 2, serviceName: `${name}-2`, volumeNames: [`${name}-data-2`] },
    ]);

    const result = applySpecPatchPlan(spec, [
      {
        op: 'set-service-replicas',
        target: { kind: 'database', imageFamily: name },
        replicas: 1,
        reason: 'User asked to shrink the logical database group to one instance.',
      },
    ]);

    expect(result.results[0]?.applied).toBe(true);
    expect(result.spec.services.map((service) => service.name)).toEqual(['api', `${name}-1`]);
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual([`${name}-1`]);
    expect(result.spec.services.find((service) => service.name === `${name}-1`)?.volumes).toEqual([`${name}-data-1:${target}`]);
    expect(result.spec.volumes).toEqual([`${name}-data-1`]);
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

  it('resolves explicit logical replica-group targets for already-expanded databases', () => {
    const result = applySpecPatchPlan(expandedSpec(3), [
      {
        op: 'set-service-replicas',
        target: { targetKind: 'replica-group', name: 'postgres', kind: 'database', imageFamily: 'postgres' },
        replicas: 4,
        reason: 'LLM mapped logical database feedback to the expanded postgres replica group.',
      },
    ]);

    expect(result.results[0]?.blockedReason).toBeNull();
    expect(result.results[0]?.applied).toBe(true);
    expect(result.results[0]?.matchedServiceNames).toEqual(['postgres-1', 'postgres-2', 'postgres-3']);
    expect(result.spec.services.map((service) => service.name)).toEqual(['api', 'postgres-1', 'postgres-2', 'postgres-3', 'postgres-4']);
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual([
      'postgres-1',
      'postgres-2',
      'postgres-3',
      'postgres-4',
    ]);
  });

  it('expands non-Postgres databases with image-specific data volume targets', () => {
    const result = applySpecPatchPlan(mysqlSpec(), [
      {
        op: 'set-service-replicas',
        target: { name: 'mysql' },
        replicas: 2,
        reason: 'User asked to scale MySQL to two instances.',
      },
    ]);

    expect(result.results[0]?.applied).toBe(true);
    expect(result.spec.services.map((service) => service.name)).toEqual(['api', 'mysql-1', 'mysql-2']);
    expect(result.spec.services.find((service) => service.name === 'mysql-1')?.volumes).toEqual(['mysql-data-1:/var/lib/mysql']);
    expect(result.spec.services.find((service) => service.name === 'mysql-2')).toMatchObject({
      dependsOn: ['mysql-1'],
      volumes: ['mysql-data-2:/var/lib/mysql'],
    });
    expect(result.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['mysql-1', 'mysql-2']);
    expect(result.spec.volumes).toEqual(['mysql-data-1', 'mysql-data-2']);
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

function mysqlSpec(): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [
      { kind: 'backend', name: 'api', image: 'node:20-alpine', dependsOn: ['mysql'] },
      {
        kind: 'database',
        name: 'mysql',
        image: 'mysql:8',
        environment: {
          MYSQL_DATABASE: 'mydb',
          MYSQL_USER: 'user',
          MYSQL_PASSWORD: 'password',
        },
        volumes: ['mysql-data:/var/lib/mysql'],
      },
    ],
    networks: ['app-network'],
    volumes: ['mysql-data'],
  };
}

function expandedDatabaseSpec(name: string, image: string, target: string, replicas: number): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [
      {
        kind: 'backend',
        name: 'api',
        image: 'node:20-alpine',
        dependsOn: Array.from({ length: replicas }, (_, index) => `${name}-${index + 1}`),
      },
      ...Array.from({ length: replicas }, (_, index) => ({
        kind: 'database' as const,
        name: `${name}-${index + 1}`,
        image,
        volumes: [`${name}-data-${index + 1}:${target}`],
        ...(index === 0 ? {} : { dependsOn: [`${name}-1`] }),
      })),
    ],
    networks: ['app-network'],
    volumes: Array.from({ length: replicas }, (_, index) => `${name}-data-${index + 1}`),
  };
}
