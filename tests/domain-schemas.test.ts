import { describe, expect, it } from 'vitest';
import type { InfrastructureSpec, StateSnapshot } from '../src/domain/types.js';
import {
  DomainValidationError,
  validateInfrastructureSpec,
  validateStateSnapshot,
} from '../src/domain/schemas.js';

const validSpec: InfrastructureSpec = {
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

describe('domain schemas', () => {
  it('accepts the current seed infrastructure spec', () => {
    expect(validateInfrastructureSpec(validSpec)).toEqual(validSpec);
  });

  it('rejects malformed service fields before compose rendering', () => {
    expect(() =>
      validateInfrastructureSpec({
        ...validSpec,
        services: [
          {
            kind: 'backend',
            name: '',
            image: 'node:20-alpine',
            replicas: -2,
            ports: ['abc'],
          },
        ],
      }),
    ).toThrow(DomainValidationError);
  });

  it('rejects dependencies that do not reference known services', () => {
    expect(() =>
      validateInfrastructureSpec({
        ...validSpec,
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

  it('rejects service volume sources that are not declared top-level volumes', () => {
    expect(() =>
      validateInfrastructureSpec({
        ...validSpec,
        volumes: [],
      }),
    ).toThrow(/Volume source "postgres-data" must be declared/);
  });

  it('rejects unsupported images at the final spec validation boundary', () => {
    expect(() =>
      validateInfrastructureSpec({
        projectName: 'bad-demo',
        networks: ['app-network'],
        volumes: [],
        services: [
          {
            kind: 'database',
            name: 'cassandra',
            image: 'cassandra:latest',
          },
        ],
      }),
    ).toThrow(/Image "cassandra:latest" is not supported/);
  });

  it('accepts a valid state snapshot', () => {
    const snapshot: StateSnapshot = {
      desired: validSpec,
      actual: {
        containers: [],
        lastObservedAt: null,
      },
      desiredStateSavedAt: '2026-06-04T11:24:44.723Z',
      lastAppliedAt: null,
    };

    expect(validateStateSnapshot(snapshot)).toEqual(snapshot);
  });
});
