import { describe, expect, it } from 'vitest';
import { buildPreDeployVerificationReport, StandardVerifierAgent } from '../src/agent/standard-verifier-agent.js';
import type { InfrastructureSpec, RuntimeActualState } from '../src/domain/types.js';
import { createPlannerRuntimeReader, createVerifierRuntimeReader, type VerifierRuntimeReader } from '../src/execution/runtime-environment-reader.js';
import { DockerMcpGateway } from '../src/execution/docker-mcp-gateway.js';

class FakeVerifierRuntimeReader implements VerifierRuntimeReader {
  readonly isReady = true;
  inspectCalls: Array<{ containerNames?: string[] }> = [];
  logCalls: string[] = [];

  constructor(private readonly actual: RuntimeActualState, private readonly logs: Record<string, string> = {}) {}

  async read(_desiredSpec: InfrastructureSpec, options: { containerNames?: string[] } = {}): Promise<RuntimeActualState> {
    this.inspectCalls.push(options);
    return this.actual;
  }

  async readLogs(containerName: string): Promise<string | null> {
    this.logCalls.push(containerName);
    return this.logs[containerName] ?? null;
  }
}

describe('buildPreDeployVerificationReport', () => {
  it('allows existing networks and volumes but reports host port conflicts', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        { kind: 'reverse-proxy', name: 'web-tinh', image: 'nginx:stable', ports: ['80:80'], volumes: ['web-data:/usr/share/nginx/html'] },
      ],
      networks: ['app-network'],
      volumes: ['web-data'],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [{ name: 'old-web', image: 'nginx:stable', status: 'running', ports: ['80:80'] }],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [{ name: 'web-data', status: 'local' }],
      images: [],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = buildPreDeployVerificationReport(desired, actual, new Date(0).toISOString());

    expect(report.status).toBe('failed');
    expect(report.findings?.map((finding) => finding.code)).toEqual([
      'HOST_PORT_CONFLICT',
    ]);
  });

  it('reports conflicts for each expected replica container name', () => {
    const desired = replicatedSpec();
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [{ name: 'sample-infra-api-2', image: 'node:20-alpine', status: 'exited', ports: [] }],
      networks: [],
      volumes: [],
      images: [],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = buildPreDeployVerificationReport(desired, actual, new Date(0).toISOString());

    expect(report.status).toBe('failed');
    expect(report.findings?.map((finding) => finding.resourceName)).toContain('sample-infra-api-2');
  });

  it('blocks replicated services with fixed host port bindings', () => {
    const desired: InfrastructureSpec = {
      ...replicatedSpec(),
      services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2, ports: ['3000:3000'] }],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [],
      volumes: [],
      images: [],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = buildPreDeployVerificationReport(desired, actual, new Date(0).toISOString());

    expect(report.status).toBe('failed');
    expect(report.findings?.some((finding) => finding.code === 'HOST_PORT_CONFLICT')).toBe(true);
  });
});
describe('readonly runtime reader guards', () => {
  it('does not expose mutate methods through planner or verifier readers', () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });
    const plannerReader = createPlannerRuntimeReader(gateway);
    const verifierReader = createVerifierRuntimeReader(gateway);
    const mutateMethods = [
      'createContainer',
      'startContainer',
      'stopContainer',
      'restartContainer',
      'removeContainer',
      'createNetwork',
      'removeNetwork',
      'createVolume',
      'removeVolume',
      'pullImage',
      'removeImage',
    ];

    for (const method of mutateMethods) {
      expect(method in plannerReader).toBe(false);
      expect(method in verifierReader).toBe(false);
      expect(method in gateway).toBe(true);
    }
  });
});

describe('StandardVerifierAgent', () => {
  it('uses inspect-enriched runtime state for drift verification', async () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-web-tinh',
          image: 'nginx:stable',
          status: 'running',
          ports: ['80:80'],
          environment: {},
        },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: 'sha256:test', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };
    const reader = new FakeVerifierRuntimeReader(actual);

    const report = await new StandardVerifierAgent().verify(spec(), reader);

    expect(reader.inspectCalls).toEqual([{ containerNames: ['sample-infra-web-tinh'] }]);
    expect(report.status).toBe('passed');
    expect(report.issues).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it('reports missing containers as structured findings', async () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = await new StandardVerifierAgent().verify(spec(), new FakeVerifierRuntimeReader(actual));

    expect(report.status).toBe('failed');
    expect(report.findings?.map((finding) => finding.code)).toContain('MISSING_CONTAINER');
    expect(report.issues[0]).toContain('MISSING_CONTAINER');
  });

  it('verifies replicated services by exact expected replica names', async () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        { name: 'sample-infra-api-1', image: 'node:20-alpine', status: 'running', ports: [], environment: {} },
        { name: 'sample-infra-api-2', image: 'node:20-alpine', status: 'running', ports: [], environment: {} },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'node:20-alpine', id: 'sha256:test', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };
    const reader = new FakeVerifierRuntimeReader(actual);

    const report = await new StandardVerifierAgent().verify(replicatedSpec(), reader);

    expect(reader.inspectCalls).toEqual([{ containerNames: ['sample-infra-api-1', 'sample-infra-api-2'] }]);
    expect(report.status).toBe('passed');
  });

  it('reports the specific missing replica container', async () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        { name: 'sample-infra-api-1', image: 'node:20-alpine', status: 'running', ports: [], environment: {} },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'node:20-alpine', id: 'sha256:test', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = await new StandardVerifierAgent().verify(replicatedSpec(), new FakeVerifierRuntimeReader(actual));

    const missing = report.findings?.find((finding) => finding.code === 'MISSING_CONTAINER');
    expect(report.status).toBe('failed');
    expect(missing?.resourceName).toBe('sample-infra-api-2');
    expect(missing?.evidence.join(' ')).toContain('sample-infra-api-2');
  });

  it('reports non-running status for each replicated container', async () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        { name: 'sample-infra-api-1', image: 'node:20-alpine', status: 'running', ports: [], environment: {} },
        { name: 'sample-infra-api-2', image: 'node:20-alpine', status: 'exited', ports: [], environment: {} },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'node:20-alpine', id: 'sha256:test', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };
    const reader = new FakeVerifierRuntimeReader(actual, { 'sample-infra-api-2': 'startup failed' });

    const report = await new StandardVerifierAgent().verify(replicatedSpec(), reader);

    const stopped = report.findings?.find((finding) => finding.code === 'CONTAINER_NOT_RUNNING');
    expect(report.status).toBe('failed');
    expect(reader.logCalls).toEqual(['sample-infra-api-2']);
    expect(stopped?.resourceName).toBe('sample-infra-api-2');
    expect(stopped?.evidence.join(' ')).toContain('startup failed');
  });

  it('requires all dependency replicas to be ready', async () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 2 },
        { kind: 'backend', name: 'api', image: 'node:20-alpine', dependsOn: ['postgres'] },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        { name: 'sample-infra-postgres-1', image: 'postgres:16', status: 'running', ports: [], environment: {}, healthStatus: 'healthy' },
        { name: 'sample-infra-postgres-2', image: 'postgres:16', status: 'exited', ports: [], environment: {} },
        { name: 'sample-infra-api', image: 'node:20-alpine', status: 'running', ports: [], environment: {} },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [
        { reference: 'postgres:16', id: 'sha256:postgres', status: null },
        { reference: 'node:20-alpine', id: 'sha256:node', status: null },
      ],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = await new StandardVerifierAgent().verify(desired, new FakeVerifierRuntimeReader(actual));

    const dependency = report.findings?.find((finding) => finding.code === 'DEPENDENCY_NOT_READY');
    expect(report.status).toBe('failed');
    expect(dependency?.resourceName).toBe('api');
    expect(dependency?.evidence.join(' ')).toContain('sample-infra-postgres-2');
  });

  it('does not treat numbered volume names as missing replica resources', async () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'database',
          name: 'postgres-1',
          image: 'postgres:16',
          volumes: ['postgres-data-1:/var/lib/postgresql/data'],
        },
      ],
      networks: ['app-network'],
      volumes: ['postgres-data-1'],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-postgres-1',
          image: 'postgres:16',
          status: 'running',
          ports: [],
          environment: {},
          healthStatus: 'healthy',
        },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [{ name: 'postgres-data-1', status: 'local' }],
      images: [{ reference: 'postgres:16', id: 'sha256:postgres', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };

    const report = await new StandardVerifierAgent().verify(desired, new FakeVerifierRuntimeReader(actual));

    expect(report.findings?.some((finding) => finding.code === 'VOLUME_MISMATCH')).toBe(false);
    expect(report.status).toBe('passed');
  });

  it('reads bounded logs for stopped containers and asks for user input', async () => {
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-web-tinh',
          image: 'nginx:stable',
          status: 'exited',
          ports: ['80:80'],
          environment: {},
          exitCode: 1,
        },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: 'sha256:test', status: null }],
      lastObservedAt: new Date(0).toISOString(),
    };
    const reader = new FakeVerifierRuntimeReader(actual, { 'sample-infra-web-tinh': 'nginx failed to bind' });

    const report = await new StandardVerifierAgent().verify(spec(), reader);

    expect(reader.logCalls).toEqual(['sample-infra-web-tinh']);
    const stopped = report.findings?.find((finding) => finding.code === 'CONTAINER_NOT_RUNNING');
    expect(stopped?.requiresUserInput).toBe(true);
    expect(stopped?.evidence.join(' ')).toContain('nginx failed to bind');
  });
});

function spec(): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [{ kind: 'reverse-proxy', name: 'web-tinh', image: 'nginx:stable', ports: ['80:80'] }],
    networks: ['app-network'],
    volumes: [],
  };
}

function replicatedSpec(): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2 }],
    networks: ['app-network'],
    volumes: [],
  };
}
