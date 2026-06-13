import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { InfrastructureSpec, InfrastructureStateFile } from '../src/domain/types.js';
import {
  DomainValidationError,
  validateInfrastructureStateFile,
  validateInfrastructureSpec,
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

  it('accepts a v1 state file with a pending preview', () => {
    const stateFile = createPendingPreviewStateFile();

    expect(validateInfrastructureStateFile(stateFile)).toEqual(stateFile);
  });

  it('rejects unsupported state schema versions', () => {
    expect(() =>
      validateInfrastructureStateFile({
        ...createPendingPreviewStateFile(),
        schemaVersion: 2,
      }),
    ).toThrow(/Invalid infrastructure state file/);
  });

  it('rejects malformed actual runtime observation sources', () => {
    const stateFile = createPendingPreviewStateFile();

    expect(() =>
      validateInfrastructureStateFile({
        ...stateFile,
        current: {
          id: 'current-test',
          request: stateFile.pendingPreview?.request,
          desired: validSpec,
          composeArtifact: stateFile.pendingPreview?.composeArtifact,
          actual: {
            source: 'docker-compose-file',
            containers: [],
            networks: [],
            volumes: [],
            images: [],
            lastObservedAt: null,
          },
          verification: stateFile.pendingPreview?.verification,
          approvedAt: null,
          appliedAt: null,
          savedAt: '2026-06-04T11:24:44.723Z',
        },
      }),
    ).toThrow(/Invalid infrastructure state file/);
  });

  it('rejects compose-only state that omits canonical desired spec', () => {
    expect(() =>
      validateInfrastructureStateFile({
        schemaVersion: 1,
        current: null,
        pendingPreview: {
          id: 'compose-only',
          request: {
            raw: 'Tao nginx port 80',
            normalizedPrompt: 'Tao nginx port 80',
            intent: 'create',
          },
          composeArtifact: createComposeArtifact(),
          createdAt: '2026-06-04T11:24:44.723Z',
          acceptedAt: null,
        },
        history: [],
      }),
    ).toThrow(/Invalid infrastructure state file/);
  });
});

function createPendingPreviewStateFile(): InfrastructureStateFile {
  return {
    schemaVersion: 1,
    current: null,
    pendingPreview: {
      id: 'pending-test',
      request: {
        raw: 'Tao nginx api postgres',
        normalizedPrompt: 'Tao nginx api postgres',
        intent: 'create',
      },
      desired: validSpec,
      plan: {
        summary: 'Test plan',
        spec: validSpec,
        assumptions: ['Test fixture.'],
        steps: [
          {
            id: 'generate-compose',
            description: 'Generate compose.',
            action: 'generate-compose',
          },
        ],
      },
      composeArtifact: createComposeArtifact(),
      dryRunPreview: null,
      observations: [],
      trace: [],
      verification: {
        status: 'not-run',
        scope: 'preview',
        checkedAt: null,
        summary: 'Preview not verified.',
        issues: [],
        evidence: [],
      },
      createdAt: '2026-06-04T11:24:44.723Z',
      acceptedAt: null,
    },
    history: [],
  };
}

function createComposeArtifact() {
  const previewContent = 'services:\n  nginx:\n    image: nginx:stable\n';

  return {
    targetPath: 'docker-compose.yaml',
    previewContent,
    previewSha256: createHash('sha256').update(previewContent).digest('hex'),
    lineCount: 3,
    written: false,
    writtenAt: null,
  };
}
