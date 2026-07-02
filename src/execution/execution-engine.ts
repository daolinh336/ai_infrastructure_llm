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
import { repairExposedSecrets } from '../compose/secret-policy-repair.js';
import { writeGeneratedSecretsFile } from '../compose/generated-secrets-writer.js';
import { validateAgentRunResult } from '../domain/schemas.js';
import { namespaceInfrastructureSpec } from '../domain/project-identity.js';
import {
  getContainerVolumeMountsForReplica,
  normalizeStatefulDatabaseReplicaVolumes,
} from '../domain/stateful-database-volumes.js';
import {
  createPendingPreviewState,
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
  classifyDeployApprovalAction,
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
import { toReplicaContainerNames } from './container-names.js';
import { isProtectedDockerNetwork } from './protected-docker-resources.js';
import { isTrustedImageReference } from '../domain/supported-images.js';

export interface ExecutionResult {
  composeYaml: string;
  dryRunPreview: DetailedDryRunPreview;
  pendingPreview: PendingPreviewState;
  secretResolution?: SecretResolutionResult;
}

export interface DeployExecutionResult extends ExecutionResult {
  classification: ActionClassification;
  preflight: PreflightReport;
  approvalRequest: ApprovalRequest | null;
  approval: ApprovalResult | null;
  approvedAction: ApprovedAction | null;
  composeArtifactPath: string | null;
  generatedSecretsPath?: string | null;
}

export interface DeployPreparationResult extends ExecutionResult {
  classification: ActionClassification;
  preflight: PreflightReport;
  approvalRequest: ApprovalRequest | null;
}

export interface DestroyResult {
  containersRemoved: string[];
  networksRemoved: string[];
  volumesRemoved: string[];
  removalErrors: string[];
  actual: RuntimeActualState;
  verificationReport: VerificationReport;
}

export interface ExecutionEngineOptions {
  stateStore?: StateStoreOptions;
  artifactDirectory?: string;
  dockerPullRetry?: Partial<DockerPullRetryPolicy>;
}

export interface DockerPullRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export interface DockerPullRetryAttempt {
  image: string;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  error: string;
}

const DEFAULT_DOCKER_PULL_RETRY_POLICY: DockerPullRetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 5_000,
  backoffFactor: 2,
};

export class ExecutionEngine {
  constructor(private readonly options: ExecutionEngineOptions = {}) {}

  async dryRun(result: AgentRunResult): Promise<ExecutionResult> {
    const validResult = validateAgentRunResult(result);
    if (validResult.status !== 'planned') {
      throw new Error('Execution requires a planned agent result.');
    }

    const secretResolution = resolveSecrets(validResult.plan.spec);
    const secretRepair = repairExposedSecrets(secretResolution.updatedSpec, secretResolution);
    const resolvedPlan = {
      ...validResult.plan,
      spec: namespaceInfrastructureSpec(normalizeStatefulDatabaseReplicaVolumes(secretRepair.updatedSpec)),
    };

    const composeYaml = renderCompose(resolvedPlan.spec);
    const schedule = buildDependencyAwareExecutionSchedule(resolvedPlan.spec);
    const dryRunPreview = buildDetailedDryRunPreview(
      resolvedPlan,
      composeYaml,
      schedule,
      secretResolution,
      secretRepair,
    );
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

  async deploy(
    result: AgentRunResult,
    approvalGate: ApprovalGate,
  ): Promise<DeployExecutionResult> {
    const preparation = await this.prepareDeploy(result);

    if (!preparation.approvalRequest) {
      return {
        ...preparation,
        approval: null,
        approvedAction: null,
        composeArtifactPath: null,
      };
    }

    const approval = await approvalGate.requestApproval(preparation.approvalRequest);
    return this.completeDeploy(preparation, approval);
  }

  async prepareDeploy(result: AgentRunResult): Promise<DeployPreparationResult> {
    const executionResult = await this.dryRun(result);
    const classification = classifyDeployApprovalAction();
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

  async completeDeploy(
    preparation: DeployPreparationResult,
    approval: ApprovalResult,
  ): Promise<DeployExecutionResult> {
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
    await preflightDockerMcpMutationCapabilities(dockerMcpClient, [
      'pullImage',
      'createContainer',
      'startContainer',
      'stopContainer',
      'removeContainer',
      'createNetwork',
      'removeNetwork',
      'createVolume',
      'removeVolume',
    ]);

    const spec = normalizeStatefulDatabaseReplicaVolumes(approvedAction.validatedSpec);
    const unsupportedImages = spec.services.filter((service) => !isTrustedImageReference(service.image));
    if (unsupportedImages.length > 0) {
      throw new Error(
        'Unsupported trusted image catalog reference(s): ' +
          unsupportedImages.map((service) => `${service.name}=${service.image}`).join(', '),
      );
    }
    const replicatedServicesWithPorts = spec.services.filter(
      (service) => (service.replicas ?? 1) > 1 && (service.ports?.length ?? 0) > 0,
    );
    if (replicatedServicesWithPorts.length > 0) {
      throw new Error(
        'Replicated services cannot publish fixed host ports during direct Docker deploy: ' +
          replicatedServicesWithPorts
            .map((service) => service.name + ' (' + (service.ports ?? []).join(', ') + ')')
            .join(', '),
      );
    }
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
    const attemptedContainers: string[] = [];
    const createdVolumes: string[] = [];

    dockerMcpClient.setAllowMutations(true);
    try {
      // All-or-nothing guard: do not mutate pre-existing stopped containers.
      // If a desired container already exists but is not running, starting it
      // would change state that was not created by this deployment attempt.
      const existingContainers = await dockerMcpClient.listContainers(true);
      const desiredContainerNames = new Set(
        spec.services.flatMap((service) => toReplicaContainerNames(spec.projectName, service)),
      );
      const staleProjectContainers = existingContainers.filter((container) =>
        container.name.startsWith(spec.projectName + '-') && !desiredContainerNames.has(container.name),
      );
      for (const container of staleProjectContainers) {
        await dockerMcpClient.stopContainer(container.name);
        await dockerMcpClient.removeContainer(container.name);
      }
      const blockedExistingContainers = spec.services
        .flatMap((service) => toReplicaContainerNames(spec.projectName, service))
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

      // Step 2: Create volumes
      const existingVolumes = await dockerMcpClient.listVolumes();
      for (const volume of spec.volumes) {
        if (existingVolumes.some((existing) => existing.name === volume)) {
          continue;
        }
        await dockerMcpClient.createVolume(volume, labels);
        createdVolumes.push(volume);
      }

      // Step 3: Pull images
      const uniqueImages = [...new Set(spec.services.map((s) => s.image))];
      for (const image of uniqueImages) {
        await this.pullImageWithRetry(dockerMcpClient, image);
        imagesPulled.push(image);
      }

      // Step 4: Create and start containers in dependency order
      for (const step of schedule.steps) {
        if (step.kind !== 'start-service') continue;

        const service = spec.services.find((s) => s.name === step.resourceName);
        if (!service) continue;

        const command = getRuntimeKeepaliveCommand(service.image);
        for (const [replicaIndex, containerName] of toReplicaContainerNames(spec.projectName, service).entries()) {
          const containerSpec: import('../domain/types.js').ContainerCreateSpec = {
            name: containerName,
            image: service.image,
            ...(command ? { command } : {}),
            ports: service.ports,
            environment: service.environment,
            volumes: getContainerVolumeMountsForReplica(service, replicaIndex),
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

          attemptedContainers.push(containerSpec.name);
          const containerId = await dockerMcpClient.createContainer(containerSpec);
          createdContainers.push(containerSpec.name);
          await dockerMcpClient.startContainer(containerSpec.name);
          containersStarted.push({ name: containerSpec.name, id: containerId });
        }
      }
    } catch (error) {
      const cleanupReport = await this.cleanupPartialDeploy(
        dockerMcpClient,
        { createdContainers: [...new Set([...createdContainers, ...attemptedContainers])], createdNetworks, createdVolumes },
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
    await preflightDockerMcpMutationCapabilities(mcpClient, [
      'stopContainer',
      'removeContainer',
      'removeNetwork',
      ...(options.removeVolumes ? ['removeVolume'] : []),
    ]);
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
    const removalErrors: string[] = [];

    mcpClient.setAllowMutations(true);
    try {
      const expectedContainers = new Set(
        desired?.services.flatMap((service) => toReplicaContainerNames(project, service)) ?? [],
      );
      const projectContainers = actual.containers.filter(
        (container) =>
          container.name.startsWith(project + '-') ||
          expectedContainers.has(container.name) ||
          ((refs?.containers.includes(container.name) ?? false) && expectedContainers.has(container.name)),
      );
      for (const container of projectContainers) {
        try {
          await mcpClient.stopContainer(container.name);
          await mcpClient.removeContainer(container.name);
          containersRemoved.push(container.name);
        } catch (error) {
          removalErrors.push(`Container "${container.name}" could not be removed: ${getErrorMessage(error)}`);
        }
      }

      const expectedNetworks = new Set(desired?.networks ?? []);
      const projectNetworks = actual.networks.filter(
        (network) =>
          !isProtectedDockerNetwork(network.name) &&
          (network.name.startsWith(project + '-') ||
            (desired?.networks.includes(network.name) ?? false) ||
            ((refs?.networks.includes(network.name) ?? false) && expectedNetworks.has(network.name))),
      );
      for (const network of projectNetworks) {
        try {
          await mcpClient.removeNetwork(network.name);
          networksRemoved.push(network.name);
        } catch (error) {
          removalErrors.push(`Network "${network.name}" could not be removed: ${getErrorMessage(error)}`);
        }
      }

      if (options.removeVolumes) {
        const expectedVolumes = new Set(desired?.volumes ?? []);
        const projectVolumes = actual.volumes.filter(
          (volume) =>
            volume.name.startsWith(project + '-') ||
            (desired?.volumes.includes(volume.name) ?? false) ||
            ((refs?.volumes.includes(volume.name) ?? false) && expectedVolumes.has(volume.name)),
        );
        for (const volume of projectVolumes) {
          try {
            await mcpClient.removeVolume(volume.name);
            volumesRemoved.push(volume.name);
          } catch (error) {
            removalErrors.push(`Volume "${volume.name}" could not be removed: ${getErrorMessage(error)}`);
          }
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
      removalErrors,
    );
    return {
      containersRemoved,
      networksRemoved,
      volumesRemoved,
      removalErrors,
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
    await preflightDockerMcpReadCapabilities(mcpClient);
    const desired = snapshot.desired;
    const containerNames = desired.services.flatMap((service) =>
      toReplicaContainerNames(desired.projectName, service),
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
    await preflightDockerMcpMutationCapabilities(mcpClient, repairActionsToOperations(actions));

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
              await this.pullImageWithRetry(mcpClient, action.resourceName);
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
                volumes: getContainerVolumeMountsForReplica(
                  service,
                  replicaIndexFromContainerName(action.resourceName),
                ),
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
      const specNetworks = await this.getSpecNetworksForScope(mcpClient, attemptScope);
      const scopeNetworks = allNetworks.filter(
        (n) =>
          !isProtectedDockerNetwork(n.name) &&
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

  private async pullImageWithRetry(
    mcpClient: DockerMcpGateway,
    image: string,
  ): Promise<void> {
    const policy = resolveDockerPullRetryPolicy(this.options.dockerPullRetry);
    const failures: DockerPullRetryAttempt[] = [];

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      try {
        await mcpClient.pullImage(image);
        return;
      } catch (error) {
        const message = getErrorMessage(error);
        const retryable = isRetryableDockerPullError(message);
        failures.push({ image, attempt, maxAttempts: policy.maxAttempts, retryable, error: message });

        if (!retryable || attempt >= policy.maxAttempts) {
          throw new Error(buildDockerPullFailureMessage(image, failures));
        }

        await sleep(getDockerPullRetryDelayMs(policy, attempt));
      }
    }
  }
}

function verifyDestroy(
  project: string,
  desired: InfrastructureSpec | undefined,
  refs: RuntimeResourceRefs | undefined,
  actual: RuntimeActualState,
  removeVolumes: boolean,
  removalErrors: string[] = [],
): VerificationReport {
  const checkedAt = new Date().toISOString();
  const issues: string[] = [...removalErrors];
  const evidence: string[] = [];
  const expectedContainers = new Set(
    desired ? desired.services.map((s) => project + '-' + s.name) : (refs?.containers ?? []),
  );
  const expectedNetworks = new Set(desired ? desired.networks : (refs?.networks ?? []));
  const expectedVolumes = new Set(removeVolumes ? (refs?.volumes ?? []) : []);

  for (const container of actual.containers) {
    if (expectedContainers.has(container.name) || container.name.startsWith(project + '-')) {
      issues.push(`Container "${container.name}" still present after destroy.`);
    }
  }
  for (const network of actual.networks) {
    if (isProtectedDockerNetwork(network.name)) continue;
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

function resolveDockerPullRetryPolicy(
  override: Partial<DockerPullRetryPolicy> | undefined,
): DockerPullRetryPolicy {
  const merged = { ...DEFAULT_DOCKER_PULL_RETRY_POLICY, ...override };
  return {
    maxAttempts: Math.max(1, Math.floor(merged.maxAttempts)),
    initialDelayMs: Math.max(0, Math.floor(merged.initialDelayMs)),
    maxDelayMs: Math.max(0, Math.floor(merged.maxDelayMs)),
    backoffFactor: Math.max(1, merged.backoffFactor),
  };
}

function isRetryableDockerPullError(message: string): boolean {
  const normalized = message.toLowerCase();
  const nonRetryableSignals = [
    'pull access denied',
    'access denied',
    'authentication required',
    'authorization failed',
    'unauthorized',
    'not found',
    'manifest unknown',
    'invalid reference format',
    'name unknown',
    'repository does not exist',
  ];
  if (nonRetryableSignals.some((signal) => normalized.includes(signal))) {
    return false;
  }

  const retryableSignals = [
    'timed out',
    'timeout',
    'deadline exceeded',
    'temporary failure',
    'connection reset',
    'connection refused',
    'connection closed',
    'network is unreachable',
    'no route to host',
    'tls handshake timeout',
    'too many requests',
    'rate limit',
    '429',
    '503',
    '502',
    '504',
    'econnreset',
    'etimedout',
    'eai_again',
  ];
  return retryableSignals.some((signal) => normalized.includes(signal));
}

function getDockerPullRetryDelayMs(policy: DockerPullRetryPolicy, attempt: number): number {
  const rawDelay = policy.initialDelayMs * policy.backoffFactor ** (attempt - 1);
  return Math.min(policy.maxDelayMs, Math.floor(rawDelay));
}

function buildDockerPullFailureMessage(
  image: string,
  failures: ReadonlyArray<DockerPullRetryAttempt>,
): string {
  const lastFailure = failures[failures.length - 1];
  const retryableAttempts = failures.filter((failure) => failure.retryable).length;
  const reason = lastFailure?.retryable
    ? 'retryable pull error persisted after configured attempts'
    : 'non-retryable pull error';
  const history = failures
    .map((failure) =>
      `attempt ${failure.attempt}/${failure.maxAttempts}: ${failure.error}`,
    )
    .join('; ');

  return (
    `Docker image pull failed for "${image}" (${reason}; retryable attempts: ` +
    `${retryableAttempts}). ${history}`
  );
}

function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function preflightDockerMcpReadCapabilities(mcpClient: DockerMcpGateway): Promise<void> {
  const candidate = mcpClient as DockerMcpGateway & {
    preflightReadCapabilities?: () => Promise<unknown>;
  };
  if (typeof candidate.preflightReadCapabilities === 'function') {
    await candidate.preflightReadCapabilities();
  }
}

async function preflightDockerMcpMutationCapabilities(
  mcpClient: DockerMcpGateway,
  operations: ReadonlyArray<string>,
): Promise<void> {
  const candidate = mcpClient as DockerMcpGateway & {
    preflightMutationCapabilities?: (operations: ReadonlyArray<string>) => Promise<unknown>;
  };
  if (typeof candidate.preflightMutationCapabilities === 'function') {
    await candidate.preflightMutationCapabilities([...new Set(operations)]);
  }
}

function repairActionsToOperations(actions: ReadonlyArray<RepairAction>): string[] {
  const operations: string[] = [];
  for (const action of actions) {
    if (action.kind === 'start-container') operations.push('startContainer');
    if (action.kind === 'stop-container') operations.push('stopContainer');
    if (action.kind === 'pull-image') operations.push('pullImage');
    if (action.kind === 'create-network') operations.push('createNetwork');
    if (action.kind === 'create-volume') operations.push('createVolume');
    if (action.kind === 'recreate-container') operations.push('createContainer', 'startContainer');
  }
  return operations;
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

function replicaIndexFromContainerName(containerName: string): number {
  const match = containerName.match(/-(\d+)$/);
  if (!match) return 0;
  return Math.max(Number(match[1]) - 1, 0);
}

