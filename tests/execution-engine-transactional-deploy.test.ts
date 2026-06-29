import { describe, expect, it } from 'vitest';
import type {
  ApprovedAction,
  ContainerCreateSpec,
  InfrastructureSpec,
  RuntimeContainerObservation,
  RuntimeImageObservation,
  RuntimeNamedResourceObservation,
} from '../src/domain/types.js';
import { ExecutionEngine } from '../src/execution/execution-engine.js';
import { buildDependencyAwareExecutionSchedule } from '../src/execution/dependency-schedule.js';
import type { DockerMcpGateway } from '../src/execution/docker-mcp-gateway.js';

class FakeDockerGateway {
  isInitialized = true;
  calls: string[] = [];
  containers: RuntimeContainerObservation[] = [];
  networks: RuntimeNamedResourceObservation[] = [];
  volumes: RuntimeNamedResourceObservation[] = [];
  images: RuntimeImageObservation[] = [];
  failCreateContainer = false;
  networkRemovalFailures = new Map<string, string>();
  pullFailures: string[] = [];
  createdSpecs: ContainerCreateSpec[] = [];

  setAllowMutations(_allowed: boolean): void {}

  async listContainers(): Promise<RuntimeContainerObservation[]> {
    return this.containers;
  }

  async listNetworks(): Promise<RuntimeNamedResourceObservation[]> {
    return this.networks;
  }

  async listVolumes(): Promise<RuntimeNamedResourceObservation[]> {
    return this.volumes;
  }

  async listImages(): Promise<RuntimeImageObservation[]> {
    return this.images;
  }

  async observeActualState() {
    return {
      source: 'mcp-readonly' as const,
      containers: this.containers,
      networks: this.networks,
      volumes: this.volumes,
      images: this.images,
      lastObservedAt: new Date(0).toISOString(),
    };
  }

  async pullImage(ref: string): Promise<void> {
    this.calls.push(`pullImage:${ref}`);
    const failure = this.pullFailures.shift();
    if (failure) {
      throw new Error(failure);
    }
  }

  async createNetwork(name: string): Promise<void> {
    this.calls.push(`createNetwork:${name}`);
    this.networks.push({ name, status: 'created' });
  }

  async createVolume(name: string): Promise<void> {
    this.calls.push(`createVolume:${name}`);
    this.volumes.push({ name, status: 'created' });
  }

  async removeNetwork(name: string): Promise<void> {
    this.calls.push(`removeNetwork:${name}`);
    const failure = this.networkRemovalFailures.get(name);
    if (failure) {
      throw new Error(failure);
    }
    this.networks = this.networks.filter((network) => network.name !== name);
  }

  async createContainer(spec: ContainerCreateSpec): Promise<string> {
    this.calls.push(`createContainer:${spec.name}`);
    this.calls.push(`createContainerCommand:${spec.command?.join(' ') ?? ''}`);
    this.createdSpecs.push(spec);
    if (this.failCreateContainer) {
      throw new Error('create container failed');
    }
    this.containers.push({ name: spec.name, image: spec.image, status: 'created', ports: spec.ports ?? [] });
    return 'container-id';
  }

  async startContainer(name: string): Promise<void> {
    this.calls.push(`startContainer:${name}`);
  }

  async stopContainer(name: string): Promise<void> {
    this.calls.push(`stopContainer:${name}`);
  }

  async removeContainer(name: string): Promise<void> {
    this.calls.push(`removeContainer:${name}`);
    this.containers = this.containers.filter((container) => container.name !== name);
  }

  async removeVolume(name: string): Promise<void> {
    this.calls.push(`removeVolume:${name}`);
  }
}

describe('ExecutionEngine transactional deploy', () => {
  it('blocks existing non-running containers before creating resources', async () => {
    const gateway = new FakeDockerGateway();
    gateway.containers = [{ name: 'demo-web', image: 'nginx:latest', status: 'exited', ports: [] }];

    await expect(new ExecutionEngine().deployWithDocker(actionFor(spec()), gateway as unknown as DockerMcpGateway))
      .rejects.toThrow('All-or-nothing deploy blocked');

    expect(gateway.calls).toEqual([]);
  });

  it('passes runtime keepalive command for raw Node.js backend images', async () => {
    const gateway = new FakeDockerGateway();

    await new ExecutionEngine().deployWithDocker(actionFor(nodeBackendSpec()), gateway as unknown as DockerMcpGateway);

    expect(gateway.createdSpecs.find((created) => created.name === 'demo-api')?.command).toEqual([
      'tail',
      '-f',
      '/dev/null',
    ]);
    expect(gateway.calls).toContain('createContainerCommand:tail -f /dev/null');
  });

  it('creates one container per backend replica with deterministic names', async () => {
    const gateway = new FakeDockerGateway();

    await new ExecutionEngine().deployWithDocker(actionFor(replicatedBackendSpec()), gateway as unknown as DockerMcpGateway);

    expect(gateway.createdSpecs.map((created) => created.name)).toEqual([
      'demo-api-1',
      'demo-api-2',
    ]);
    expect(gateway.calls).toContain('startContainer:demo-api-1');
    expect(gateway.calls).toContain('startContainer:demo-api-2');
  });

  it('removes stale numbered database containers before applying a scale-down deploy', async () => {
    const gateway = new FakeDockerGateway();
    gateway.containers = [
      { name: 'demo-db-3', image: 'postgres:16', status: 'running', ports: [] },
    ];

    await new ExecutionEngine().deployWithDocker(actionFor(databaseSpec(2)), gateway as unknown as DockerMcpGateway);

    expect(gateway.calls).toContain('stopContainer:demo-db-3');
    expect(gateway.calls).toContain('removeContainer:demo-db-3');
    expect(gateway.createdSpecs.map((created) => created.name)).toEqual(['demo-db-1', 'demo-db-2']);
    expect(gateway.containers.some((container) => container.name === 'demo-db-3')).toBe(false);
  });

  it('blocks replicated services with fixed host port bindings', async () => {
    const gateway = new FakeDockerGateway();

    await expect(
      new ExecutionEngine().deployWithDocker(actionFor(replicatedBackendWithPortSpec()), gateway as unknown as DockerMcpGateway),
    ).rejects.toThrow('Replicated services cannot publish fixed host ports');

    expect(gateway.calls).toEqual([]);
  });

  it('rolls back newly created resources when deploy fails mid-flight', async () => {
    const gateway = new FakeDockerGateway();
    gateway.failCreateContainer = true;

    await expect(new ExecutionEngine().deployWithDocker(actionFor(spec()), gateway as unknown as DockerMcpGateway))
      .rejects.toThrow('cleanup attempted');

    expect(gateway.calls).toEqual([
      'createNetwork:demo-net',
      'pullImage:nginx:latest',
      'createContainer:demo-web',
      'createContainerCommand:',
      'removeNetwork:demo-net',
    ]);
    expect(gateway.networks).toEqual([]);
  });

  it('retries transient image pull timeout before creating containers', async () => {
    const gateway = new FakeDockerGateway();
    gateway.pullFailures = ['MCP request timed out (30000ms): tools/call'];

    await engineWithFastPullRetry().deployWithDocker(
      actionFor(spec()),
      gateway as unknown as DockerMcpGateway,
    );

    expect(gateway.calls).toEqual([
      'createNetwork:demo-net',
      'pullImage:nginx:latest',
      'pullImage:nginx:latest',
      'createContainer:demo-web',
      'createContainerCommand:',
      'startContainer:demo-web',
    ]);
  });

  it('stops retrying non-retryable image pull errors and cleans up created resources', async () => {
    const gateway = new FakeDockerGateway();
    gateway.pullFailures = ['manifest unknown: manifest unknown'];

    await expect(
      engineWithFastPullRetry().deployWithDocker(actionFor(spec()), gateway as unknown as DockerMcpGateway),
    ).rejects.toThrow('non-retryable pull error');

    expect(gateway.calls).toEqual([
      'createNetwork:demo-net',
      'pullImage:nginx:latest',
      'removeNetwork:demo-net',
    ]);
    expect(gateway.networks).toEqual([]);
  });

  it('reports exhausted retry attempts for persistent image pull timeouts', async () => {
    const gateway = new FakeDockerGateway();
    gateway.pullFailures = [
      'MCP request timed out (30000ms): tools/call',
      'network deadline exceeded',
      'TLS handshake timeout',
    ];

    await expect(
      engineWithFastPullRetry().deployWithDocker(actionFor(spec()), gateway as unknown as DockerMcpGateway),
    ).rejects.toThrow('retryable pull error persisted after configured attempts');

    expect(gateway.calls).toEqual([
      'createNetwork:demo-net',
      'pullImage:nginx:latest',
      'pullImage:nginx:latest',
      'pullImage:nginx:latest',
      'removeNetwork:demo-net',
    ]);
    expect(gateway.networks).toEqual([]);
  });

  it('destroys containers before scoped networks and ignores unrelated refs', async () => {
    const gateway = new FakeDockerGateway();
    gateway.containers = [
      { name: 'demo-web', image: 'nginx:latest', status: 'running', ports: [] },
      { name: 'docker-ext-service', image: 'ext:latest', status: 'running', ports: [] },
    ];
    gateway.networks = [
      { name: 'demo-net', status: 'bridge' },
      { name: 'docker_labs-ai-tools-for-devs-desktop-extension_default', status: 'bridge' },
      { name: 'host', status: 'host' },
    ];

    const result = await new ExecutionEngine().destroyWithDocker(
      {
        desired: {
          ...spec(),
          networks: ['demo-net', 'docker_labs-ai-tools-for-devs-desktop-extension_default'],
        },
        resourceRefs: {
          projectName: 'demo',
          containers: ['demo-web', 'docker-ext-service'],
          networks: ['demo-net', 'docker_labs-ai-tools-for-devs-desktop-extension_default', 'host'],
          volumes: [],
          images: [],
        },
      } as never,
      gateway as unknown as DockerMcpGateway,
      { projectName: 'demo' },
    );

    expect(gateway.calls).toEqual([
      'stopContainer:demo-web',
      'removeContainer:demo-web',
      'removeNetwork:demo-net',
    ]);
    expect(result.containersRemoved).toEqual(['demo-web']);
    expect(result.networksRemoved).toEqual(['demo-net']);
    expect(gateway.containers.map((container) => container.name)).toEqual(['docker-ext-service']);
    expect(gateway.networks.map((network) => network.name)).toEqual([
      'docker_labs-ai-tools-for-devs-desktop-extension_default',
      'host',
    ]);
  });

  it('reports partial destroy when a shared network still has active endpoints', async () => {
    const gateway = new FakeDockerGateway();
    gateway.containers = [{ name: 'demo-web', image: 'nginx:latest', status: 'running', ports: [] }];
    gateway.networks = [{ name: 'demo-net', status: 'bridge' }];
    gateway.networkRemovalFailures.set('demo-net', 'network demo-net has active endpoints');

    const result = await new ExecutionEngine().destroyWithDocker(
      {
        desired: spec(),
        resourceRefs: {
          projectName: 'demo',
          containers: ['demo-web'],
          networks: ['demo-net'],
          volumes: [],
          images: [],
        },
      } as never,
      gateway as unknown as DockerMcpGateway,
      { projectName: 'demo' },
    );

    expect(result.containersRemoved).toEqual(['demo-web']);
    expect(result.networksRemoved).toEqual([]);
    expect(result.removalErrors).toEqual([
      'Network "demo-net" could not be removed: network demo-net has active endpoints',
    ]);
    expect(result.verificationReport.status).toBe('failed');
    expect(result.verificationReport.issues).toContain('Network "demo-net" still present after destroy.');
  });
});

function spec(): InfrastructureSpec {
  return {
    projectName: 'demo',
    services: [{ kind: 'reverse-proxy', name: 'web', image: 'nginx:latest', ports: ['8080:80'] }],
    networks: ['demo-net'],
    volumes: [],
  };
}

function nodeBackendSpec(): InfrastructureSpec {
  return {
    projectName: 'demo',
    services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine', ports: ['3000:3000'] }],
    networks: ['demo-net'],
    volumes: [],
  };
}

function replicatedBackendSpec(): InfrastructureSpec {
  return {
    projectName: 'demo',
    services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2 }],
    networks: ['demo-net'],
    volumes: [],
  };
}

function replicatedBackendWithPortSpec(): InfrastructureSpec {
  return {
    projectName: 'demo',
    services: [{ kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2, ports: ['3000:3000'] }],
    networks: ['demo-net'],
    volumes: [],
  };
}

function databaseSpec(replicas: number): InfrastructureSpec {
  return {
    projectName: 'demo',
    services: [
      {
        kind: 'database',
        name: 'db',
        image: 'postgres:16',
        replicas,
        environment: {
          POSTGRES_DB: 'app',
          POSTGRES_USER: 'app',
          POSTGRES_PASSWORD: 'password',
        },
      },
    ],
    networks: ['demo-net'],
    volumes: [],
  };
}

function actionFor(validatedSpec: InfrastructureSpec): ApprovedAction {
  const checkedAt = new Date(0).toISOString();
  const verificationReport = {
    status: 'passed' as const,
    scope: 'meta-preflight' as const,
    checkedAt,
    issues: [],
    evidence: [],
    errorReason: null,
    revisionHint: null,
    confidence: 1,
  };
  return {
    id: 'approved-action-1',
    action: 'write-compose-artifact',
    request: { raw: 'create nginx', normalizedPrompt: 'create nginx', intent: 'create' },
    classification: {
      capability: 'compose-artifact-write',
      risk: 'runtime-create',
      summary: 'deploy nginx',
      requiresApproval: true,
      mutatesRuntime: true,
      writesArtifact: true,
      writesState: true,
      callsDocker: true,
      callsMcp: true,
    },
    approval: {
      id: 'approval-1',
      requestId: 'request-1',
      decision: 'approved',
      respondedAt: checkedAt,
      approvedBy: 'cli-user',
      reason: null,
    },
    approvalMarker: {
      type: 'phase8-human-approval',
      approvalId: 'approval-1',
      approvedAt: checkedAt,
      approvedBy: 'cli-user',
    },
    validatedSpec,
    composeArtifact: {
      targetPath: 'docker-compose.yaml',
      previewContent: 'services: {}',
      previewSha256: 'hash',
      lineCount: 1,
      written: true,
      writtenAt: checkedAt,
    },
    dependencySchedule: buildDependencyAwareExecutionSchedule(validatedSpec),
    preflight: {
      status: 'passed',
      checkedAt,
      issues: [],
      evidence: [],
      policyFindings: [],
      verificationReport,
    },
    policyFindings: [],
    dockerCalled: true,
    mcpCalled: true,
    runtimeMutation: true,
  };
}

function engineWithFastPullRetry(): ExecutionEngine {
  return new ExecutionEngine({
    dockerPullRetry: {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
    },
  });
}
