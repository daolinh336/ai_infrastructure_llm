import { describe, expect, it } from 'vitest';
import { buildDriftReport } from '../src/execution/drift-detector.js';
import { deriveSpecFromRuntime } from '../src/execution/spec-sync.js';
import type { InfrastructureSpec, RuntimeActualState } from '../src/domain/types.js';

const sourceSpec: InfrastructureSpec = {
  projectName: 'demo',
  services: [{ kind: 'reverse-proxy', name: 'web', image: 'nginx:latest', ports: ['8080:80'] }],
  networks: ['app-network'],
  volumes: ['data'],
};

describe('deriveSpecFromRuntime', () => {
  it('normalizes compose runtime names to desired spec names', () => {
    const actual: RuntimeActualState = {
      source: 'runtime-adapter',
      containers: [{ name: 'demo-web-1', image: 'nginx:1.27', status: 'running', ports: ['8081:80'], environment: {} }],
      networks: [{ name: 'demo-app-network', status: 'bridge' }],
      volumes: [{ name: 'demo-data', status: 'local' }],
      images: [{ reference: 'nginx:1.27', id: null, status: null }],
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    };

    const synced = deriveSpecFromRuntime(actual, sourceSpec);

    expect(synced).toEqual({
      projectName: 'demo',
      services: [{ kind: 'reverse-proxy', name: 'web', image: 'nginx:1.27', ports: ['8081:80'] }],
      networks: ['app-network'],
      volumes: ['data'],
    });
    expect(buildDriftReport(synced, actual).status).toBe('none');
  });

  it('syncs an empty runtime as no desired services', () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: null, status: null }],
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    };

    const synced = deriveSpecFromRuntime(actual, sourceSpec);

    expect(synced.services).toEqual([]);
    expect(buildDriftReport(synced, actual).status).toBe('none');
  });
  it('drops missing services and stale references when syncing partial runtime', () => {
    const twoServiceSpec: InfrastructureSpec = {
      projectName: 'demo',
      services: [
        {
          kind: 'reverse-proxy',
          name: 'web',
          image: 'nginx:latest',
          ports: ['8080:80'],
          dependsOn: ['api'],
          volumes: ['cache:/cache'],
        },
        { kind: 'backend', name: 'api', image: 'node:20-alpine' },
      ],
      networks: ['app-network'],
      volumes: ['cache'],
    };
    const actual: RuntimeActualState = {
      source: 'runtime-adapter',
      containers: [{ name: 'demo-web-1', image: 'nginx:1.27', status: 'running', ports: ['8080:80'], environment: {} }],
      networks: [{ name: 'demo-app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:1.27', id: null, status: null }],
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    };

    const synced = deriveSpecFromRuntime(actual, twoServiceSpec);

    expect(synced.services).toEqual([{ kind: 'reverse-proxy', name: 'web', image: 'nginx:1.27', ports: ['8080:80'] }]);
    expect(buildDriftReport(synced, actual).status).toBe('none');
  });

  it('syncs exited runtime containers as desired stopped without stale desired ports', () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [{ name: 'demo-web', image: 'nginx:stable', status: 'exited', ports: [], environment: {} }],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: null, status: null }],
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    };

    const synced = deriveSpecFromRuntime(actual, sourceSpec);

    expect(synced.services).toEqual([
      { kind: 'reverse-proxy', name: 'web', image: 'nginx:stable', desiredStatus: 'stopped' },
    ]);
    expect(buildDriftReport(synced, actual).status).toBe('none');
  });

  it('does not sync Docker Desktop extension networks into desired spec', () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [{ name: 'demo-web', image: 'nginx:stable', status: 'running', ports: [], environment: {} }],
      networks: [
        { name: 'app-network', status: 'bridge' },
        { name: 'docker_labs-ai-tools-for-devs-desktop-extension_default', status: 'bridge' },
      ],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: null, status: null }],
      lastObservedAt: '2026-01-01T00:00:00.000Z',
    };

    const synced = deriveSpecFromRuntime(actual, sourceSpec);

    expect(synced.networks).toEqual(['app-network']);
  });
});

