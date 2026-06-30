import { describe, expect, it, vi } from 'vitest';
import { collectDestroyAllTargets, isMissingDockerResourceError, printDetailedDryRunPreview } from '../src/cli/shared.js';
import type { DetailedDryRunPreview, InfrastructureStateSnapshot, RuntimeActualState, VerifiedRuntimeSnapshot } from '../src/domain/types.js';

describe('destroy-all target collection', () => {
  it('skips protected Docker Desktop networks even when stale state references them', () => {
    const state: InfrastructureStateSnapshot = {
      schemaVersion: 1,
      current: snapshotWithStaleRefs(),
      pendingPreview: null,
      history: [],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [
        { name: 'sample-infra-net', status: 'bridge' },
        { name: 'docker_labs-ai-tools-for-devs-desktop-extension_default', status: 'bridge' },
      ],
      volumes: [],
      images: [],
      lastObservedAt: new Date(0).toISOString(),
    };

    const targets = collectDestroyAllTargets(state, actual, false);

    expect(targets.networks).toEqual(['app-network', 'sample-infra-net']);
  });
});

describe('isMissingDockerResourceError', () => {
  it('treats Docker 404 missing resources as already absent', () => {
    expect(isMissingDockerResourceError(new Error('MCP tool error: Error: (HTTP code 404) no such container - No such container: sample-infra-web'))).toBe(true);
    expect(isMissingDockerResourceError(new Error('MCP tool error: Error: (HTTP code 404) no such network - network app-network not found'))).toBe(true);
  });
});

describe('printDetailedDryRunPreview', () => {
  it('shows only user-facing warnings and hides noisy dry-run policy details', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let output = '';
    try {
      printDetailedDryRunPreview(sampleDryRunPreview());
      output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain('[warning] weak-hardcoded-secret (postgres)');
    expect(output).toContain('[warning] exposed-host-port (postgres)');
    expect(output).toContain('[warning] replica-preview (postgres)');
    expect(output).toContain('[warning] schedule-readiness-warning');
    expect(output).toContain('[info] auto-generated-secret (postgres)');
    expect(output).toContain('[info] env-secret-used (mysql)');
    expect(output).toContain('[warning] secret-policy-auto-repaired (mongo)');
    expect(output).toContain('[warning] weak-env-secret (redis)');
    expect(output).toContain('must be healthy before backend service');
    expect(output).toContain('readiness is required before reverse proxy service');
    expect(output).toContain('MYSQL_PASSWORD');
    expect(output).toContain('REDIS_PASSWORD');
    expect(output).not.toContain('safe-env-password-2026');
    expect(output).not.toContain('abcabcabc');
    expect(output).not.toContain('readiness-not-enforced-in-dry-run');
    expect(output).not.toContain('persistent-volume-preview');
    expect(output).not.toContain('keepalive-demo-command');
    expect(output).not.toContain('exposed-host-port (web)');
    expect(output).not.toContain('Readiness gate is preview-only');
    expect(output).not.toContain('confirm the service is stateless');
  });
});

function snapshotWithStaleRefs(): VerifiedRuntimeSnapshot {
  const checkedAt = new Date(0).toISOString();
  return {
    id: 'snapshot-1',
    request: { raw: 'create infra', normalizedPrompt: 'create infra', intent: 'create' },
    desired: {
      projectName: 'sample-infra',
      services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine' }],
      networks: ['app-network', 'docker_labs-ai-tools-for-devs-desktop-extension_default'],
      volumes: [],
    },
    composeArtifact: { targetPath: 'docker-compose.yaml', previewContent: '', previewSha256: '', lineCount: 0, written: true, writtenAt: checkedAt },
    actual: { source: 'mcp-readonly', containers: [], networks: [], volumes: [], images: [], lastObservedAt: checkedAt },
    verification: { status: 'passed', scope: 'runtime', checkedAt, summary: 'ok', issues: [], evidence: [] },
    resourceRefs: {
      projectName: 'sample-infra',
      containers: ['sample-infra-api'],
      networks: ['app-network', 'docker_labs-ai-tools-for-devs-desktop-extension_default'],
      volumes: [],
      images: [],
    },
    approvedAt: checkedAt,
    appliedAt: checkedAt,
    savedAt: checkedAt,
  };
}

function sampleDryRunPreview(): DetailedDryRunPreview {
  return {
    projectName: 'sample-infra',
    artifactTargetPath: 'docker-compose.yaml',
    artifactWritten: false,
    stateSaved: false,
    dockerCalled: false,
    mcpCalled: false,
    composePreviewLineCount: 1,
    totalServices: 3,
    totalContainers: 4,
    networks: ['app-network'],
    volumes: ['postgres-data'],
    services: [
      {
        name: 'web',
        kind: 'reverse-proxy',
        image: 'nginx:stable',
        replicas: 1,
        ports: ['80:80'],
        volumes: [],
        environmentKeys: [],
        environment: {},
        dependsOn: ['api'],
        dependents: [],
        waitCondition: 'wait until upstream backend ready/running',
        readinessEnforced: false,
        warnings: ['Readiness gate is preview-only in this dry-run: wait until upstream backend ready/running.'],
      },
      {
        name: 'api',
        kind: 'backend',
        image: 'node:20-alpine',
        replicas: 2,
        ports: [],
        volumes: [],
        environmentKeys: [],
        environment: {},
        dependsOn: ['postgres'],
        dependents: ['web'],
        waitCondition: 'wait until service running/healthy',
        readinessEnforced: false,
        warnings: [
          'Readiness gate is preview-only in this dry-run: wait until service running/healthy.',
          'Service "api" scales from 1 to 2 replicas; confirm the service is stateless and does not use fixed host ports or shared writable state.',
        ],
      },
      {
        name: 'postgres',
        kind: 'database',
        image: 'postgres:16',
        replicas: 2,
        ports: ['5432:5432'],
        volumes: ['postgres-data:/var/lib/postgresql/data'],
        environmentKeys: ['POSTGRES_PASSWORD'],
        environment: { POSTGRES_PASSWORD: 'password' },
        dependsOn: [],
        dependents: ['api'],
        waitCondition: 'wait until database accepts connections / service healthy',
        readinessEnforced: false,
        warnings: [
          'Readiness gate is preview-only in this dry-run: wait until database accepts connections / service healthy.',
          'Service "postgres" scales from 1 to 2 replicas; stateful databases must use isolated per-replica services and volumes, not one shared data volume.',
        ],
      },
    ],
    schedule: {
      projectName: 'sample-infra',
      steps: [],
      dependencyGraph: [
        { serviceName: 'web', dependsOn: ['api'], dependents: [] },
        { serviceName: 'api', dependsOn: ['postgres'], dependents: ['web'] },
        { serviceName: 'postgres', dependsOn: [], dependents: ['api'] },
      ],
      serviceStartOrder: ['postgres', 'api', 'web'],
      destroyOrder: ['web', 'api', 'postgres'],
      warnings: [],
    },
    policyFindings: [
      { severity: 'warning', code: 'exposed-host-port', message: 'Service "web" would expose host port mapping 80:80.', resourceName: 'web', resourceType: 'service' },
      { severity: 'warning', code: 'exposed-host-port', message: 'Service "postgres" would expose host port mapping 5432:5432.', resourceName: 'postgres', resourceType: 'service' },
      { severity: 'info', code: 'auto-generated-secret', message: 'Service "postgres" uses an auto-generated secret for POSTGRES_PASSWORD.', resourceName: 'postgres', resourceType: 'service' },
      { severity: 'info', code: 'env-secret-used', message: 'Service "mysql" uses the password from env var MYSQL_PASSWORD for MYSQL_PASSWORD.', resourceName: 'mysql', resourceType: 'service' },
      { severity: 'warning', code: 'secret-policy-auto-repaired', message: 'Service "mongo" had an obvious secret for MONGO_INITDB_ROOT_PASSWORD (common default password); it was automatically replaced in the compose YAML. Check the generated YAML for the new value.', resourceName: 'mongo', resourceType: 'service' },
      { severity: 'warning', code: 'weak-env-secret', message: 'Service "redis" uses weak or guessable env secret REDIS_PASSWORD for REDIS_PASSWORD; change the env value before apply.', resourceName: 'redis', resourceType: 'service' },
      { severity: 'warning', code: 'weak-hardcoded-secret', message: 'Service "postgres" uses a weak hardcoded value for POSTGRES_PASSWORD; replace it before real apply.', resourceName: 'postgres', resourceType: 'service' },
      { severity: 'info', code: 'persistent-volume-preview', message: 'Service "postgres" would use persistent volume mount(s): postgres-data:/var/lib/postgresql/data.', resourceName: 'postgres', resourceType: 'service' },
      { severity: 'warning', code: 'replica-preview', message: 'Service "api" scales from 1 to 2 replicas; confirm the service is stateless and does not use fixed host ports or shared writable state.', resourceName: 'api', resourceType: 'service' },
      { severity: 'warning', code: 'replica-preview', message: 'Service "postgres" scales from 1 to 2 replicas; stateful databases must use isolated per-replica services and volumes, not one shared data volume.', resourceName: 'postgres', resourceType: 'service' },
      { severity: 'warning', code: 'readiness-not-enforced-in-dry-run', message: 'Service "api" has a planned wait gate, but this dry-run preview does not enforce runtime healthchecks yet.', resourceName: 'api', resourceType: 'service' },
      { severity: 'info', code: 'keepalive-demo-command', message: 'Service "api" uses a raw runtime image with an injected keepalive command.', resourceName: 'api', resourceType: 'service' },
      { severity: 'warning', code: 'schedule-readiness-warning', message: 'PostgreSQL service "postgres" must be healthy before backend service "api" starts.', resourceName: null, resourceType: null },
      { severity: 'warning', code: 'schedule-readiness-warning', message: 'Backend service "api" readiness is required before reverse proxy service "web" routes traffic.', resourceName: null, resourceType: null },
      { severity: 'warning', code: 'schedule-readiness-warning', message: 'Service "api" has planned wait condition, but this preview does not enforce runtime healthchecks yet.', resourceName: null, resourceType: null },
    ],
    actionsNotPerformed: ['Docker Engine API was not called.'],
  };
}
