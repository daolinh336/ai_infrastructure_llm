import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ActionClassification,
  AgentRunResult,
  ApprovalRequest,
  ApprovalResult,
  ApprovedAction,
  DetailedDryRunPreview,
  PendingPreviewState,
  DockerDeployResult,
  PreflightReport,
} from '../domain/types.js';
import { getRuntimeKeepaliveCommand, renderCompose } from '../compose/render-compose.js';
import { resolveSecrets, type SecretResolutionResult } from '../compose/secret-resolver.js';
import { writeGeneratedSecretsFile } from '../compose/generated-secrets-writer.js';
import { validateAgentRunResult } from '../domain/schemas.js';
import {
  createPendingPreviewState,
  loadState,
  saveApprovalRejection,
  saveApprovedAction,
  savePendingPreview as persistPendingPreview,
  type StateStoreOptions,
} from '../state/sqlite-state-store.js';
import {
  buildDependencyAwareExecutionSchedule,
  buildDetailedDryRunPreview,
} from './dependency-schedule.js';
import {
  buildApprovalRequest,
  buildApprovedAction,
  classifyPhase8ApplyAction,
  runPhase8Preflight,
  type ApprovalGate,
} from './phase8-approval.js';
import type { DockerMcpGateway } from './docker-mcp-gateway.js';
import type {
  RuntimeActualState,
  DriftReport,
  RepairReport,
  RepairAction,
  CleanupReport,
  VerifiedRuntimeSnapshot,
  InfrastructureSpec,
  RuntimeResourceRefs,
  VerificationReport,
  AttemptScope,
} from '../domain/types.js';
import { validateVerificationReport } from '../domain/schemas.js';
import { buildDriftReport } from './drift-detector.js';

export interface ExecutionResult {
  composeYaml: string;
  dryRunPreview: DetailedDryRunPreview;
  pendingPreview: PendingPreviewState;
  secretResolution?: SecretResolutionResult;
}

export interface ApplyExecutionResult extends ExecutionResult {
  classification: ActionClassification;
  preflight: PreflightReport;
  approvalRequest: ApprovalRequest | null;
  approval: ApprovalResult | null;
  approvedAction: ApprovedAction | null;
  composeArtifactPath: string | null;
  generatedSecretsPath?: string | null;
}

export interface ApplyPreparationResult extends ExecutionResult {
  classification: ActionClassification;
  preflight: PreflightReport;
  approvalRequest: ApprovalRequest | null;
}

export interface DestroyResult {
  containersRemoved: string[];
  networksRemoved: string[];
  volumesRemoved: string[];
  actual: RuntimeActualState;
  verificationReport: VerificationReport;
}

export interface ExecutionEngineOptions {
  stateStore?: StateStoreOptions;
  artifactDirectory?: string;
}

export class ExecutionEngine {
  constructor(private readonly options: ExecutionEngineOptions = {}) {}

  async dryRun(result: AgentRunResult): Promise<ExecutionResult> {
    const validResult = validateAgentRunResult(result);
    if (validResult.status !== 'planned') {
      throw new Error('Execution requires a planned agent result.');
    }

    const previousState = await loadState(this.options.stateStore);
    const previousSpec =
      previousState?.current?.desired ?? previousState?.pendingPreview?.desired ?? null;
    const secretResolution = resolveSecrets(validResult.plan.spec, previousSpec);
    const resolvedPlan = { ...validResult.plan, spec: secretResolution.updatedSpec };

    const composeYaml = renderCompose(resolvedPlan.spec);
    const schedule = buildDependencyAwareExecutionSchedule(resolvedPlan.spec);
    const dryRunPreview = buildDetailedDryRunPreview(resolvedPlan, composeYaml, schedule);
    const pendingPreview = createPendingPreviewState({
      request: validResult.request,
      plan: resolvedPlan,
      composeYaml,
      dryRunPreview,
      observations: validResult.observations,
      trace: validResult.trace ?? [],
    });

    return {
      composeYaml,
      dryRunPreview,
      pendingPreview,
      secretResolution,
    };
  }

  async savePendingPreview(result: AgentRunResult): Promise<ExecutionResult> {
    const executionResult = await this.dryRun(result);
    await persistPendingPreview(
      executionResult.pendingPreview,
      this.options.stateStore,
    );
    return executionResult;
  }

  async apply(
    result: AgentRunResult,
    approvalGate: ApprovalGate,
  ): Promise<ApplyExecutionResult> {
    const preparation = await this.prepareApply(result);

    if (!preparation.approvalRequest) {
      return {
        ...preparation,
        approval: null,
        approvedAction: null,
        composeArtifactPath: null,
      };
    }

    const approval = await approvalGate.requestApproval(preparation.approvalRequest);
    return this.completeApply(preparation, approval);
  }

  async prepareApply(result: AgentRunResult): Promise<ApplyPreparationResult> {
    const executionResult = await this.dryRun(result);
    const classification = classifyPhase8ApplyAction();
    const preflight = runPhase8Preflight(executionResult);

    if (preflight.status !== 'passed') {
      return {
        ...executionResult,
        classification,
        preflight,
        approvalRequest: null,
      };
    }

    const approvalRequest = buildApprovalRequest({
      pendingPreview: executionResult.pendingPreview,
      dryRunPreview: executionResult.dryRunPreview,
      classification,
      preflight,
    });

    return {
      ...executionResult,
      classification,
      preflight,
      approvalRequest,
    };
  }

  async completeApply(
    preparation: ApplyPreparationResult,
    approval: ApprovalResult,
  ): Promise<ApplyExecutionResult> {
    if (!preparation.approvalRequest) {
      return {
        ...preparation,
        approval: null,
        approvedAction: null,
        composeArtifactPath: null,
      };
    }

    if (approval.requestId !== preparation.approvalRequest.id) {
      throw new Error('Approval result does not match approval request.');
    }

    if (approval.decision === 'rejected') {
      await saveApprovalRejection(
        preparation.pendingPreview,
        approval,
        this.options.stateStore,
      );

      return {
        ...preparation,
        approval,
        approvedAction: null,
        composeArtifactPath: null,
      };
    }

    const approvedAction = buildApprovedAction({
      pendingPreview: preparation.pendingPreview,
      dryRunPreview: preparation.dryRunPreview,
      approvalRequest: preparation.approvalRequest,
      approval,
      preflight: preparation.preflight,
      classification: preparation.classification,
    });
    const composeArtifactPath = await this.writeComposeArtifact(
      approvedAction.composeArtifact.targetPath,
      preparation.composeYaml,
    );

    await saveApprovedAction(
      preparation.pendingPreview,
      approvedAction,
      this.options.stateStore,
    );

    const generatedSecretsPath = preparation.secretResolution
      ? await writeGeneratedSecretsFile(
          preparation.secretResolution.services,
          approvedAction.validatedSpec.projectName,
        )
      : null;

    return {
      ...preparation,
      approval,
      approvedAction,
      composeArtifactPath,
      generatedSecretsPath,
    };
  }

  async deployWithDocker(
    approvedAction: ApprovedAction,
    dockerMcpClient: DockerMcpGateway,
  ): Promise<DockerDeployResult & { operationId: string; attemptScope: AttemptScope }> {

    if (!dockerMcpClient.isInitialized) {
      throw new Error('DockerMcpGateway must be initialized before deployWithDocker');
    }

    const spec = approvedAction.validatedSpec;
    const schedule = buildDependencyAwareExecutionSchedule(spec);
    const operationId = 'op-' + randomUUID();
    const attemptScope: AttemptScope = {
      operationId,
      approvedActionId: approvedAction.id,
      projectName: spec.projectName,
      attemptIndex: 0,
      createdAt: new Date().toISOString(),
    };
    const labels = buildOperationLabels(attemptScope);
    const networksCreated: string[] = [];
    const imagesPulled: string[] = [];
    const containersStarted: Array<{ name: string; id: string }> = [];
    const startedAt = new Date().toISOString();
    const createdNetworks: string[] = [];
    const createdContainers: string[] = [];
    const createdVolumes: string[] = [];

    dockerMcpClient.setAllowMutations(true);
    try {
      // All-or-nothing guard: do not mutate pre-existing stopped containers.
      // If a desired container already exists but is not running, starting it
      // would change state that was not created by this deployment attempt.
      const existingContainers = await dockerMcpClient.listContainers(true);
      const blockedExistingContainers = spec.services
        .map((service) => `${spec.projectName}-${service.name}`)
        .map((name) => existingContainers.find((container) => container.name === name))
        .filter((container): container is NonNullable<typeof container> =>
          Boolean(container && container.status !== 'running'),
        );
      if (blockedExistingContainers.length > 0) {
        throw new Error(
          'All-or-nothing deploy blocked by existing non-running container(s): ' +
            blockedExistingContainers.map((container) => container.name).join(', '),
        );
      }

      // Step 1: Create networks
      const existingNetworks = await dockerMcpClient.listNetworks();
      for (const network of spec.networks) {
        if (existingNetworks.some((existing) => existing.name === network)) {
          networksCreated.push(network);
          continue;
        }
        await dockerMcpClient.createNetwork(network, labels);
        createdNetworks.push(network);
        networksCreated.push(network);
      }

      // Step 2: Pull images
      const uniqueImages = [...new Set(spec.services.map((s) => s.image))];
      for (const image of uniqueImages) {
        await dockerMcpClient.pullImage(image);
        imagesPulled.push(image);
      }

      // Step 3: Create and start containers in dependency order
      for (const step of schedule.steps) {
        if (step.kind !== 'start-service') continue;

        const service = spec.services.find((s) => s.name === step.resourceName);
        if (!service) continue;

        const command = getRuntimeKeepaliveCommand(service.image);
        const containerSpec: import('../domain/types.js').ContainerCreateSpec = {
          name: `${spec.projectName}-${service.name}`,
          image: service.image,
          ...(command ? { command } : {}),
          ports: service.ports,
          environment: service.environment,
          volumes: service.volumes,
          networks: spec.networks.length > 0 ? [spec.networks[0]!] : undefined,
          labels,
        };

        const existingContainer = existingContainers.find(
          (container) => container.name === containerSpec.name,
        );
        if (existingContainer) {
          containersStarted.push({ name: containerSpec.name, id: containerSpec.name });
          continue;
        }

        const containerId = await dockerMcpClient.createContainer(containerSpec);
        createdContainers.push(containerSpec.name);
        await dockerMcpClient.startContainer(containerSpec.name);
        containersStarted.push({ name: containerSpec.name, id: containerId });
      }
    } catch (error) {
      const cleanupReport = await this.cleanupPartialDeploy(
        dockerMcpClient,
        { createdContainers, createdNetworks, createdVolumes },
        'deploy-failed',
      );
      throw new Error(
        getErrorMessage(error) +
          ' | cleanup attempted: ' +
          String(cleanupReport.succeeded.length) +
          ' succeeded, ' +
          String(cleanupReport.failed.length) +
          ' failed, leftovers: ' +
          cleanupReport.leftovers.join(', '),
      );
    } finally {
      dockerMcpClient.setAllowMutations(false);
    }

    return {
      networksCreated,
      imagesPulled,
      containersStarted,
      startedAt,
      operationId,
      attemptScope,
    };
  }

  async destroyWithDocker(
    snapshot: VerifiedRuntimeSnapshot | null,
    mcpClient: DockerMcpGateway,
    options: { projectName?: string; removeVolumes?: boolean } = {},
  ): Promise<DestroyResult> {
    if (!mcpClient.isInitialized) {
      throw new Error('DockerMcpGateway must be initialized before destroyWithDocker');
    }
    const project = options.projectName ?? snapshot?.desired.projectName ?? '';
    if (!project) {
      throw new Error('destroyWithDocker requires a project name from current state or options');
    }
    const desired = snapshot?.desired;
    const refs = snapshot?.resourceRefs;
    const actual = await mcpClient.observeActualState();
    const containersRemoved: string[] = [];
    const networksRemoved: string[] = [];
    const volumesRemoved: string[] = [];

    mcpClient.setAllowMutations(true);
    try {
      const projectContainers = actual.containers.filter(
        (container) =>
          container.name.startsWith(project + '-') ||
          (refs?.containers.includes(container.name) ?? false),
      );
      for (const container of projectContainers) {
        await mcpClient.stopContainer(container.name);
        await mcpClient.removeContainer(container.name);
        containersRemoved.push(container.name);
      }

      const protectedNetworks = new Set(['bridge', 'host', 'none']);
      const projectNetworks = actual.networks.filter(
        (network) =>
          !protectedNetworks.has(network.name) &&
          (network.name.startsWith(project + '-') ||
            (desired?.networks.includes(network.name) ?? false) ||
            (refs?.networks.includes(network.name) ?? false)),
      );
      for (const network of projectNetworks) {
        await mcpClient.removeNetwork(network.name);
        networksRemoved.push(network.name);
      }

      if (options.removeVolumes) {
        const projectVolumes = actual.volumes.filter(
          (volume) =>
            volume.name.startsWith(project + '-') ||
            (refs?.volumes.includes(volume.name) ?? false),
        );
        for (const volume of projectVolumes) {
          await mcpClient.removeVolume(volume.name);
          volumesRemoved.push(volume.name);
        }
      }
    } finally {
      mcpClient.setAllowMutations(false);
    }

    const actualAfterDestroy = await mcpClient.observeActualState();
    const verificationReport = verifyDestroy(
      project,
      desired,
      refs,
      actualAfterDestroy,
      Boolean(options.removeVolumes),
    );
    return {
      containersRemoved,
      networksRemoved,
      volumesRemoved,
      actual: actualAfterDestroy,
      verificationReport,
    };
  }

  async detectRuntimeDrift(
    snapshot: VerifiedRuntimeSnapshot | null,
    mcpClient: DockerMcpGateway,
  ): Promise<{ drift: DriftReport; actual: RuntimeActualState }> {
    if (!snapshot) {
      throw new Error('No current verified runtime snapshot to detect drift against');
    }
    const desired = snapshot.desired;
    const containerNames = desired.services.map(
      (service) => desired.projectName + '-' + service.name.replace(/[_\s]+/g, '-'),
    );
    const actual = await mcpClient.observeActualStateWithInspect({ containerNames });
    const drift = buildDriftReport(snapshot.desired, actual);
    return { drift, actual };
  }

  async repairWithDocker(
    snapshot: VerifiedRuntimeSnapshot | null,
    mcpClient: DockerMcpGateway,
    actions: RepairAction[],
  ): Promise<{ report: RepairReport; actual: RuntimeActualState }> {
    if (!snapshot) {
      throw new Error('No current verified runtime snapshot to repair');
    }

    const actionsAttempted: RepairAction[] = [];
    const actionsSucceeded: RepairAction[] = [];
    const actionsFailed: Array<{ action: RepairAction; error: string }> = [];

    if (actions.length > 0) {
      mcpClient.setAllowMutations(true);
      try {
        for (const action of actions) {
          actionsAttempted.push(action);
          try {
            if (action.kind === 'start-container') {
              await mcpClient.startContainer(action.resourceName);
            } else if (action.kind === 'stop-container') {
              await mcpClient.stopContainer(action.resourceName);
            } else if (action.kind === 'pull-image') {
              await mcpClient.pullImage(action.resourceName);
            } else if (action.kind === 'create-network') {
              await mcpClient.createNetwork(action.resourceName);
            } else if (action.kind === 'create-volume') {
              await mcpClient.createVolume(action.resourceName);
            } else if (action.kind === 'recreate-container') {
              const service = snapshot.desired.services.find((s) =>
                action.resourceName.includes(s.name),
              );
              if (!service) {
                throw new Error(
                  `Cannot recreate container "${action.resourceName}": no matching service in desired spec.`,
                );
              }
              const command = getRuntimeKeepaliveCommand(service.image);
              await mcpClient.createContainer({
                name: action.resourceName,
                image: service.image,
                ...(command ? { command } : {}),
                ports: service.ports,
                environment: service.environment,
                volumes: service.volumes,
                networks:
                  snapshot.desired.networks.length > 0
                    ? [snapshot.desired.networks[0]!]
                    : undefined,
              });
              await mcpClient.startContainer(action.resourceName);
            }
            actionsSucceeded.push(action);
          } catch (error) {
            actionsFailed.push({ action, error: getErrorMessage(error) });
          }
        }
      } finally {
        mcpClient.setAllowMutations(false);
      }
    }

    const status: RepairReport['status'] =
      actionsFailed.length === 0
        ? 'applied'
        : actionsSucceeded.length === 0
          ? 'failed'
          : 'partial';
    const observed = await mcpClient.observeActualState();
    return {
      report: { status, actionsAttempted, actionsSucceeded, actionsFailed },
      actual: observed,
    };
  }

  async cleanupPartialDeploy(
    mcpClient: DockerMcpGateway,
    journal: {
      createdContainers: string[];
      createdNetworks: string[];
      createdVolumes: string[];
    },
    trigger: CleanupReport['trigger'],
  ): Promise<CleanupReport> {
    const attempted: string[] = [];
    const succeeded: string[] = [];
    const failed: Array<{ resource: string; error: string }> = [];
    mcpClient.setAllowMutations(true);
    try {
      for (const name of [...journal.createdContainers].reverse()) {
        attempted.push('container:' + name);
        try {
          await mcpClient.stopContainer(name);
          await mcpClient.removeContainer(name);
          succeeded.push('container:' + name);
        } catch (error) {
          failed.push({ resource: 'container:' + name, error: getErrorMessage(error) });
        }
      }
      for (const name of [...journal.createdNetworks].reverse()) {
        attempted.push('network:' + name);
        try {
          await mcpClient.removeNetwork(name);
          succeeded.push('network:' + name);
        } catch (error) {
          failed.push({ resource: 'network:' + name, error: getErrorMessage(error) });
        }
      }
      for (const name of [...journal.createdVolumes].reverse()) {
        attempted.push('volume:' + name);
        try {
          await mcpClient.removeVolume(name);
          succeeded.push('volume:' + name);
        } catch (error) {
          failed.push({ resource: 'volume:' + name, error: getErrorMessage(error) });
        }
      }
    } finally {
      mcpClient.setAllowMutations(false);
    }
    return {
      trigger,
      attempted,
      succeeded,
      failed,
      leftovers: failed.map((entry) => entry.resource),
    };
  }

  async cleanupAttemptScope(
    mcpClient: DockerMcpGateway,
    attemptScope: AttemptScope,
  ): Promise<CleanupReport> {
    const attempted: string[] = [];
    const succeeded: string[] = [];
    const failed: Array<{ resource: string; error: string }> = [];

    mcpClient.setAllowMutations(true);
    try {
      // Remove containers created in this attempt scope
      const allContainers = await mcpClient.listContainers(true);
      const scopeContainers = allContainers.filter(
        (c) => c.name.startsWith(attemptScope.projectName + '-'),
      );
      for (const container of scopeContainers) {
        const resourceName = 'container:' + container.name;
        attempted.push(resourceName);
        try {
          await mcpClient.stopContainer(container.name);
          await mcpClient.removeContainer(container.name);
          succeeded.push(resourceName);
        } catch (error) {
          failed.push({ resource: resourceName, error: getErrorMessage(error) });
        }
      }

      // Remove networks created in this attempt scope
      const allNetworks = await mcpClient.listNetworks();
      const protectedNetworks = new Set(['bridge', 'host', 'none']);
      const specNetworks = await this.getSpecNetworksForScope(mcpClient, attemptScope);
      const scopeNetworks = allNetworks.filter(
        (n) =>
          !protectedNetworks.has(n.name) &&
          (specNetworks.includes(n.name) || n.name.startsWith(attemptScope.projectName + '-')),
      );
      for (const network of scopeNetworks) {
        const resourceName = 'network:' + network.name;
        attempted.push(resourceName);
        try {
          await mcpClient.removeNetwork(network.name);
          succeeded.push(resourceName);
        } catch (error) {
          failed.push({ resource: resourceName, error: getErrorMessage(error) });
        }
      }
    } finally {
      mcpClient.setAllowMutations(false);
    }

    return {
      trigger: 'deploy-failed',
      attempted,
      succeeded,
      failed,
      leftovers: failed.map((entry) => entry.resource),
    };
  }

  private async getSpecNetworksForScope(
    _mcpClient: DockerMcpGateway,
    _attemptScope: AttemptScope,
  ): Promise<string[]> {
    // In the current implementation, spec networks are derived from the approved action
    // which is available via the attempt scope's projectName. For simplicity, we return
    // an empty array and rely on the name-prefix filter. A more complete implementation
    // would store the spec alongside the attempt scope.
    return [];
  }
  private async writeComposeArtifact(
    targetPath: string,
    content: string,
  ): Promise<string> {
    const artifactDirectory = this.options.artifactDirectory ?? process.cwd();
    const outputPath = path.resolve(artifactDirectory, targetPath);

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, 'utf8');

    return outputPath;
  }
}

function verifyDestroy(
  project: string,
  desired: InfrastructureSpec | undefined,
  refs: RuntimeResourceRefs | undefined,
  actual: RuntimeActualState,
  removeVolumes: boolean,
): VerificationReport {
  const checkedAt = new Date().toISOString();
  const issues: string[] = [];
  const evidence: string[] = [];
  const expectedContainers = new Set(
    desired ? desired.services.map((s) => project + '-' + s.name) : (refs?.containers ?? []),
  );
  const expectedNetworks = new Set(desired ? desired.networks : (refs?.networks ?? []));
  const expectedVolumes = new Set(removeVolumes ? (refs?.volumes ?? []) : []);
  const protectedNetworks = new Set(['bridge', 'host', 'none']);

  for (const container of actual.containers) {
    if (expectedContainers.has(container.name) || container.name.startsWith(project + '-')) {
      issues.push(`Container "${container.name}" still present after destroy.`);
    }
  }
  for (const network of actual.networks) {
    if (protectedNetworks.has(network.name)) continue;
    if (expectedNetworks.has(network.name) || network.name.startsWith(project + '-')) {
      issues.push(`Network "${network.name}" still present after destroy.`);
    }
  }
  if (removeVolumes) {
    for (const volume of actual.volumes) {
      if (expectedVolumes.has(volume.name) || volume.name.startsWith(project + '-')) {
        issues.push(`Volume "${volume.name}" still present after destroy.`);
      }
    }
  }

  if (issues.length === 0) {
    evidence.push(
      'All expected project containers, networks, and volumes are absent after destroy.',
    );
  }

  const status: VerificationReport['status'] = issues.length === 0 ? 'passed' : 'failed';
  return validateVerificationReport({
    status,
    scope: 'tool-runtime',
    checkedAt,
    issues,
    evidence,
    errorReason:
      issues.length > 0
        ? 'Destroy verification found ' + String(issues.length) + ' remaining resource(s).'
        : null,
    revisionHint:
      issues.length > 0
        ? 'Some resources could not be removed. Inspect Docker runtime and re-run destroy.'
        : null,
    confidence: issues.length === 0 ? 0.95 : 0.5,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
function buildOperationLabels(scope: AttemptScope): Record<string, string> {
  return {
    'app': 'infra-react-agent',
    'project': scope.projectName,
    'operationId': scope.operationId,
    'approvedActionId': scope.approvedActionId,
    'managed-by': 'infra-react-agent',
  };
}
