import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type {
  ApprovedAction,
  InfrastructureSpec,
  RuntimeActualState,
  VerifiedRuntimeSnapshot,
} from '../src/domain/types.js';
import { renderCompose } from '../src/compose/render-compose.js';
import { expandStatefulDatabaseReplicas } from '../src/domain/stateful-database-volumes.js';
import { buildDependencyAwareExecutionSchedule } from '../src/execution/dependency-schedule.js';
import { buildDriftReport } from '../src/execution/drift-detector.js';
import { DockerMcpGateway } from '../src/execution/docker-mcp-gateway.js';
import { ExecutionEngine } from '../src/execution/execution-engine.js';
import { buildRepairPlan } from '../src/execution/repair-planner.js';
import { toReplicaContainerNames } from '../src/execution/container-names.js';

const SUPERNOVA_DIST = 'packages/docker-mcp-server-supernova/dist/index.js';
const REAL_DOCKER_TIMEOUT_MS = 420_000;
const checkedAt = new Date(0).toISOString();

type ScaleCase = {
  name: string;
  nginx: number;
  node: number;
  postgres: number;
  expectedContainers: number;
};

const scaleCases: ScaleCase[] = [
  { name: 'small real matrix a=2 b=2 c=2', nginx: 2, node: 2, postgres: 2, expectedContainers: 6 },
  { name: 'medium real matrix a=3 b=3 c=3', nginx: 3, node: 3, postgres: 3, expectedContainers: 9 },
  { name: 'larger real matrix a=4 b=4 c=4', nginx: 4, node: 4, postgres: 4, expectedContainers: 12 },
  { name: 'max requested real matrix a=5 b=5 c=5', nginx: 5, node: 5, postgres: 5, expectedContainers: 15 },
];

describe('3-tier real Docker MCP matrix and chaos pipeline', () => {
  it.each(scaleCases)('$name deploys, observes, and destroys real containers', async ({ nginx, node, postgres, expectedContainers }) => {
    await access(SUPERNOVA_DIST);
    const spec = threeTierSpec({ nginx, node, postgres, publishProxy: false });
    const engine = new ExecutionEngine({ dockerPullRetry: fastRetry() });
    const gateway = new DockerMcpGateway({ requestTimeoutMs: 90_000 });
    const containerNames = expectedContainerNames(spec);

    await gateway.initialize();
    try {
      const compose = renderCompose(spec);
      const parsed = YAML.parse(compose) as { services?: Record<string, unknown> };
      const schedule = buildDependencyAwareExecutionSchedule(spec);

      expect(schedule.serviceStartOrder).toEqual([
        ...databaseServiceNames(postgres),
        'api',
        'nginx',
      ]);
      expect(schedule.destroyOrder).toEqual([
        'nginx',
        'api',
        ...databaseServiceNames(postgres).reverse(),
      ]);
      expect(totalReplicas(spec)).toBe(expectedContainers);
      expect(Object.keys(parsed.services ?? {})).toEqual([
        ...databaseServiceNames(postgres),
        'api',
        'nginx',
      ]);

      await engine.deployWithDocker(approvedActionFor(spec), gateway);
      const actual = await gateway.observeActualStateWithInspect({ containerNames });
      const managedContainers = actual.containers.filter((container) => containerNames.includes(container.name));

      expect(managedContainers).toHaveLength(expectedContainers);
      expect(managedContainers.every((container) => container.status?.toLowerCase().includes('up') || container.status === 'running')).toBe(true);
      expectNoContainerOrImageDrift(buildDriftReport(spec, actual, checkedAt));
    } finally {
      await cleanupRealResources(gateway, spec);
      await gateway.shutdown();
    }
  }, REAL_DOCKER_TIMEOUT_MS);

  it('blocks replicated fixed host ports before mutating real Docker', async () => {
    await access(SUPERNOVA_DIST);
    const spec = threeTierSpec({ nginx: 2, node: 2, postgres: 2, publishProxy: true });
    const gateway = new DockerMcpGateway({ requestTimeoutMs: 90_000 });

    await gateway.initialize();
    try {
      await expect(
        new ExecutionEngine({ dockerPullRetry: fastRetry() }).deployWithDocker(approvedActionFor(spec), gateway),
      ).rejects.toThrow('Replicated services cannot publish fixed host ports');

      const actual = await gateway.observeActualState();
      expect(actual.containers.filter((container) => container.name.startsWith(spec.projectName + '-'))).toEqual([]);
    } finally {
      await cleanupRealResources(gateway, spec);
      await gateway.shutdown();
    }
  }, REAL_DOCKER_TIMEOUT_MS);

  it('runs real deploy -> status/drift -> repair -> destroy pipeline', async () => {
    await access(SUPERNOVA_DIST);
    const spec = threeTierSpec({ nginx: 2, node: 3, postgres: 2, publishProxy: false });
    const engine = new ExecutionEngine({ dockerPullRetry: fastRetry() });
    const gateway = new DockerMcpGateway({ requestTimeoutMs: 90_000 });
    const containerNames = expectedContainerNames(spec);

    await gateway.initialize();
    try {
      await engine.deployWithDocker(approvedActionFor(spec), gateway);
      const deployed = await gateway.observeActualStateWithInspect({ containerNames });
      expectNoContainerOrImageDrift(buildDriftReport(spec, deployed, checkedAt));

      gateway.setAllowMutations(true);
      await gateway.removeContainer(`${spec.projectName}-api-2`);
      gateway.setAllowMutations(false);

      const drifted = await gateway.observeActualState();
      const drift = buildDriftReport(spec, drifted, checkedAt);
      const repair = buildRepairPlan(drift);
      expect(repair.actions).toContainEqual(
        expect.objectContaining({ kind: 'recreate-container', resourceName: `${spec.projectName}-api-2` }),
      );

      const repairResult = await engine.repairWithDocker(
        verifiedSnapshotFor(spec, drifted),
        gateway,
        repair.actions.filter((action) => action.kind === 'recreate-container'),
      );
      const repaired = await gateway.observeActualStateWithInspect({ containerNames });
      expect(repairResult.report.status).toBe('applied');
      expectNoContainerOrImageDrift(buildDriftReport(spec, repaired, checkedAt));

      await engine.destroyWithDocker(
        verifiedSnapshotFor(spec, repaired),
        gateway,
        { projectName: spec.projectName, removeVolumes: true },
      );
      const afterDestroy = await gateway.observeActualState();
      expect(afterDestroy.containers.filter((container) => containerNames.includes(container.name))).toEqual([]);
    } finally {
      await cleanupRealResources(gateway, spec);
      await gateway.shutdown();
    }
  }, REAL_DOCKER_TIMEOUT_MS);
});

function expectNoContainerOrImageDrift(report: ReturnType<typeof buildDriftReport>): void {
  expect(report.findings.filter((finding) => finding.resourceType === 'container' || finding.resourceType === 'image')).toEqual([]);
}

function threeTierSpec(options: {
  nginx: number;
  node: number;
  postgres: number;
  publishProxy: boolean;
}): InfrastructureSpec {
  const projectName = `matrix-real-${options.nginx}-${options.node}-${options.postgres}`;
  return expandStatefulDatabaseReplicas({
    projectName,
    services: [
      {
        kind: 'database',
        name: 'postgres',
        image: 'postgres:16-alpine',
        replicas: options.postgres,
        environment: {
          POSTGRES_DB: 'app',
          POSTGRES_USER: 'app',
          POSTGRES_PASSWORD: 'app-secret',
        },
      },
      {
        kind: 'backend',
        name: 'api',
        image: 'node:20-alpine',
        replicas: options.node,
        environment: {
          DATABASE_URL: 'postgres://app:app-secret@postgres:5432/app',
          NODE_ENV: 'production',
        },
        dependsOn: ['postgres'],
      },
      {
        kind: 'reverse-proxy',
        name: 'nginx',
        image: 'nginx:stable-alpine',
        replicas: options.nginx,
        ...(options.publishProxy ? { ports: ['80:80'] } : {}),
        dependsOn: ['api'],
      },
    ],
    networks: [`${projectName}-net`],
    volumes: [],
  });
}

function databaseServiceNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `postgres-${index + 1}`);
}

function approvedActionFor(validatedSpec: InfrastructureSpec): ApprovedAction {
  return {
    id: `approved-${validatedSpec.projectName}`,
    action: 'write-compose-artifact',
    request: { raw: 'Deploy a real 3-tier matrix system', normalizedPrompt: 'deploy real 3 tier matrix system', intent: 'create' },
    classification: {
      capability: 'compose-artifact-write',
      risk: 'runtime-create',
      summary: 'deploy real matrix',
      requiresApproval: true,
      mutatesRuntime: true,
      writesArtifact: true,
      writesState: true,
      callsDocker: true,
      callsMcp: true,
    },
    approval: {
      id: `approval-${validatedSpec.projectName}`,
      requestId: `request-${validatedSpec.projectName}`,
      decision: 'approved',
      respondedAt: checkedAt,
      approvedBy: 'cli-user',
      reason: null,
    },
    approvalMarker: {
      type: 'phase8-human-approval',
      approvalId: `approval-${validatedSpec.projectName}`,
      approvedAt: checkedAt,
      approvedBy: 'cli-user',
    },
    validatedSpec,
    composeArtifact: {
      targetPath: 'docker-compose.yaml',
      previewContent: renderCompose(validatedSpec),
      previewSha256: 'sha256-test',
      lineCount: 1,
      written: true,
      writtenAt: checkedAt,
    },
    dependencySchedule: buildDependencyAwareExecutionSchedule(validatedSpec),
    preflight: {
      status: 'passed',
      checkedAt,
      issues: [],
      evidence: ['test preflight passed'],
      policyFindings: [],
      verificationReport: {
        status: 'passed',
        scope: 'meta-preflight',
        checkedAt,
        issues: [],
        evidence: ['test verification passed'],
        errorReason: null,
        revisionHint: null,
        confidence: 1,
      },
    },
    policyFindings: [],
    dockerCalled: true,
    mcpCalled: true,
    runtimeMutation: true,
  };
}

function verifiedSnapshotFor(desired: InfrastructureSpec, actual: RuntimeActualState): VerifiedRuntimeSnapshot {
  return {
    id: `verified-${desired.projectName}`,
    request: {
      raw: 'Deploy a real 3-tier matrix system',
      normalizedPrompt: 'deploy real 3 tier matrix system',
      intent: 'create',
    },
    desired,
    composeArtifact: {
      targetPath: 'docker-compose.yaml',
      previewContent: renderCompose(desired),
      previewSha256: 'sha256-test',
      lineCount: 1,
      written: true,
      writtenAt: checkedAt,
    },
    actual,
    verification: {
      status: 'passed',
      scope: 'runtime',
      checkedAt,
      summary: 'test snapshot verified',
      issues: [],
      evidence: ['test snapshot verified'],
    },
    verificationReport: {
      status: 'passed',
      scope: 'tool-runtime',
      checkedAt,
      issues: [],
      evidence: ['test snapshot verified'],
      errorReason: null,
      revisionHint: null,
      confidence: 1,
    },
    driftReport: buildDriftReport(desired, actual, checkedAt),
    resourceRefs: {
      projectName: desired.projectName,
      containers: actual.containers.map((container) => container.name),
      networks: actual.networks.map((network) => network.name),
      volumes: actual.volumes.map((volume) => volume.name),
      images: actual.images.map((image) => image.reference),
    },
    operation: 'deploy',
    approvedAt: checkedAt,
    appliedAt: checkedAt,
    savedAt: checkedAt,
  };
}

async function cleanupRealResources(gateway: DockerMcpGateway, spec: InfrastructureSpec): Promise<void> {
  if (!gateway.isInitialized) return;
  gateway.setAllowMutations(true);
  try {
    for (const name of expectedContainerNames(spec).reverse()) {
      await gateway.removeContainer(name).catch(() => undefined);
    }
    for (const network of spec.networks) {
      await gateway.removeNetwork(network).catch(() => undefined);
    }
    for (const volume of spec.volumes) {
      await gateway.removeVolume(volume).catch(() => undefined);
    }
  } finally {
    gateway.setAllowMutations(false);
  }
}

function expectedContainerNames(spec: InfrastructureSpec): string[] {
  return spec.services.flatMap((service) => toReplicaContainerNames(spec.projectName, service));
}

function totalReplicas(spec: InfrastructureSpec): number {
  return spec.services.reduce((total, service) => total + (service.replicas ?? 1), 0);
}

function fastRetry() {
  return { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 };
}






