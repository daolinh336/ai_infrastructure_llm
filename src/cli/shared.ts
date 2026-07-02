import { stdin as input, stdout as output } from 'node:process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import type { ReActAgent } from '../agent/react-agent.js';
import { isSecretLikeKey, type SecretResolutionResult, type ResolvedSecret } from '../compose/secret-resolver.js';
import { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import { toReplicaContainerNames } from '../execution/container-names.js';
import type { DockerPullRetryPolicy } from '../execution/execution-engine.js';
import { createApprovalResult } from '../execution/phase8-approval.js';
import type { DockerDoctorReport } from '../doctor/docker-doctor.js';
import type {
  ApprovalRequest,
  ClarificationAnswer,
  ApprovalDecision,
  UserFeedback,
  PlannerRevisionResult,
  SpecPatch,
  VerificationFinding,
  VerificationReport,
  DetailedDryRunPreview,
  DryRunPolicyFinding,
  ExecutionScheduleStep,
  PreflightReport,
  ProgressEvent,
  ProgressPhase,
  StaticGatewayMetrics,
  RuntimeActualState,
  RuntimeContainerObservation,
  InfrastructureStateSnapshot,
  VerifiedRuntimeSnapshot,
} from '../domain/types.js';
import { isProtectedDockerNetwork } from '../execution/protected-docker-resources.js';

const DEFAULT_DOCKER_MCP_REQUEST_TIMEOUT_MS = 120_000;

export function createDockerMcpGatewayFromEnv(): DockerMcpGateway {
  return new DockerMcpGateway({
    requestTimeoutMs: readPositiveIntegerEnv(
      'INFRA_DOCKER_MCP_REQUEST_TIMEOUT_MS',
      DEFAULT_DOCKER_MCP_REQUEST_TIMEOUT_MS,
    ),
  });
}

export function loadDockerPullRetryPolicyFromEnv(): Partial<DockerPullRetryPolicy> {
  return {
    maxAttempts: readPositiveIntegerEnv('INFRA_DOCKER_PULL_MAX_ATTEMPTS', 3),
    initialDelayMs: readNonNegativeIntegerEnv('INFRA_DOCKER_PULL_RETRY_INITIAL_DELAY_MS', 1_000),
    maxDelayMs: readNonNegativeIntegerEnv('INFRA_DOCKER_PULL_RETRY_MAX_DELAY_MS', 5_000),
    backoffFactor: readPositiveNumberEnv('INFRA_DOCKER_PULL_RETRY_BACKOFF_FACTOR', 2),
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function readNonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return value;
}

export function printStaticGatewayMetrics(metrics: StaticGatewayMetrics): void {
  console.log(chalk.cyan('Static validation metrics:'));
  console.log(`- intentAccepted: ${metrics.intentAccepted}`);
  console.log(`- intentRejected: ${metrics.intentRejected}`);
  console.log(`- unsafeRejected: ${metrics.unsafeRejected}`);
  console.log(`- clarificationRequired: ${metrics.clarificationRequired}`);
  console.log(`- schemaValidationPassed: ${metrics.schemaValidationPassed}`);
  console.log(`- schemaValidationFailed: ${metrics.schemaValidationFailed}`);
  console.log(`- securityBlocked: ${metrics.securityBlocked}`);
  console.log(`- resourceLimitBlocked: ${metrics.resourceLimitBlocked}`);
  console.log(`- imageWhitelistBlocked: ${metrics.imageWhitelistBlocked}`);
  console.log(
    `- runtimeCallsDuringStaticValidation: ${metrics.runtimeCallsDuringStaticValidation}`,
  );
  console.log(
    `- reactInvocationsAfterStaticValidationFailure: ${metrics.reactInvocationsAfterStaticValidationFailure}`,
  );
}

export function printObservations(observations: Array<{ source: string; message: string }>): void {
  console.log(chalk.cyan('Observations:'));
  for (const observation of observations) {
    console.log(`- [${observation.source}] ${observation.message}`);
  }
  console.log();
}

export function printRevisionPatchResults(result: PlannerRevisionResult): void {
  if (!result.patchPlan && !result.patchResults?.length) return;

  console.log(chalk.cyan('Revision patches:'));
  if (result.patchPlan) {
    console.log(`- explanation: ${result.patchPlan.explanation}`);
    if (result.patchPlan.ambiguities.length > 0) {
      console.log(`- ambiguities: ${result.patchPlan.ambiguities.join('; ')}`);
    }
  }
  for (const patchResult of result.patchResults ?? []) {
    const target = patchResult.matchedServiceNames.join(', ') || 'n/a';
    const status = patchResult.applied ? 'applied' : patchResult.blockedReason ? 'blocked' : 'skipped';
    console.log(`- ${patchResult.patch.op}: ${status}; target=${target}; reason=${patchResult.patch.reason}`);
    if (patchResult.blockedReason) {
      console.log(chalk.yellow(`  blocked: ${patchResult.blockedReason}`));
    }
  }
  console.log();
}

export function printTrace(
  trace: Array<{ id: string; phase: string; toolName: string | null; message: string }> | undefined,
): void {
  if (!trace?.length) {
    return;
  }

  console.log(chalk.cyan('ReAct trace:'));
  for (const step of trace) {
    const toolText = step.toolName ? ` via ${step.toolName}` : '';
    console.log(`- ${step.id} [${step.phase}${toolText}]: ${step.message}`);
  }
  console.log();
}

export function printDetailedDryRunPreview(
  preview: DetailedDryRunPreview,
  secretResolution?: SecretResolutionResult,
): void {
  console.log(chalk.cyan('Detailed dry-run preview:'));
  console.log(`Project: ${preview.projectName}`);
  console.log(`Services: ${preview.totalServices}`);
  console.log(`Container count if applied: ${preview.totalContainers}`);
  console.log(`Compose artifact target: ${preview.artifactTargetPath} (not written)`);
  console.log(
    `Compose artifact path if approved: ${path.resolve(preview.artifactTargetPath)}`,
  );
  console.log(
    `Runtime side effects: Docker called=${preview.dockerCalled}, MCP called=${preview.mcpCalled}, state saved=${preview.stateSaved}`,
  );
  console.log();

  console.log(chalk.cyan('Resources that would be created:'));
  console.log(`- Networks: ${preview.networks.join(', ') || 'none'}`);
  console.log(`- Volumes: ${preview.volumes.join(', ') || 'none'}`);
  console.log();

  console.log(chalk.cyan('Execution order:'));
  for (const step of preview.schedule.steps) {
    console.log(formatScheduleStep(step));
  }
  console.log();

  console.log(chalk.cyan('Dependency graph:'));
  for (const entry of preview.schedule.dependencyGraph) {
    console.log(
      `- ${entry.serviceName}: depends on ${entry.dependsOn.join(', ') || 'none'}; dependents ${entry.dependents.join(', ') || 'none'}`,
    );
  }
  console.log();

  const environmentPreviewResolution = secretResolution;

  console.log(chalk.cyan('Service details:'));
  for (const service of preview.services) {
    console.log(`- ${service.name} (${service.kind})`);
    console.log(`  image: ${service.image}`);
    console.log(`  replicas: ${service.replicas}`);
    console.log(`  depends on: ${service.dependsOn.join(', ') || 'none'}`);
    console.log(`  dependents: ${service.dependents.join(', ') || 'none'}`);
    console.log(`  ports: ${service.ports.join(', ') || 'none'}`);
    console.log(`  volumes: ${service.volumes.join(', ') || 'none'}`);
    console.log(`  environment keys: ${service.environmentKeys.join(', ') || 'none'}`);
    console.log(`  environment preview: ${formatEnvironmentPreview(service.environment, service.name, environmentPreviewResolution)}`);
    console.log(`  wait condition: ${service.waitCondition}`);
    console.log(
      `  readiness enforced now: ${service.readinessEnforced ? 'yes' : 'no, preview only'}`,
    );
    for (const warning of service.warnings.filter(isUserFacingServiceWarning)) {
      console.log(`  warning: ${warning}`);
    }
  }
  console.log();

  console.log(chalk.cyan('Policy findings:'));
  const visiblePolicyFindings = preview.policyFindings.filter((finding) =>
    isUserFacingPolicyFinding(finding, preview),
  );
  if (!visiblePolicyFindings.length) {
    console.log('- none');
  }
  for (const finding of visiblePolicyFindings) {
    const target = finding.resourceName ? ` (${finding.resourceName})` : '';
    console.log(`- [${finding.severity}] ${finding.code}${target}: ${finding.message}`);
  }
  console.log();

  console.log(chalk.cyan('Actions not performed:'));
  for (const action of preview.actionsNotPerformed) {
    console.log(`- ${action}`);
  }
  console.log();
}

function isUserFacingServiceWarning(warning: string): boolean {
  return /stateful databases must use isolated per-replica services and volumes/i.test(warning);
}

function isUserFacingPolicyFinding(
  finding: DryRunPolicyFinding,
  preview: DetailedDryRunPreview,
): boolean {
  switch (finding.code) {
    case 'auto-generated-secret':
    case 'env-secret-used':
    case 'secret-policy-auto-repaired':
    case 'weak-env-secret':
    case 'weak-hardcoded-secret':
      return true;
    case 'schedule-readiness-warning':
      return isTopologyDependencyWarning(finding.message);
    case 'replica-preview':
      return getFindingServiceKind(finding, preview) === 'database';
    case 'exposed-host-port':
      return isSensitiveHostPortFinding(finding, preview);
    default:
      return false;
  }
}

function isTopologyDependencyWarning(message: string): boolean {
  return (
    /must be healthy before backend service/i.test(message) ||
    /readiness is required before reverse proxy service/i.test(message) ||
    /dependency|depends on|topology/i.test(message)
  ) && !/planned wait condition|preview does not enforce runtime healthchecks/i.test(message);
}

function isSensitiveHostPortFinding(
  finding: DryRunPolicyFinding,
  preview: DetailedDryRunPreview,
): boolean {
  if (getFindingServiceKind(finding, preview) === 'database') {
    return true;
  }

  const ports = finding.message.match(/\d+/g)?.map(Number) ?? [];
  return ports.some((port) => SENSITIVE_HOST_PORTS.has(port));
}

function getFindingServiceKind(
  finding: DryRunPolicyFinding,
  preview: DetailedDryRunPreview,
): DetailedDryRunPreview['services'][number]['kind'] | null {
  if (!finding.resourceName) {
    return null;
  }

  return preview.services.find((service) => service.name === finding.resourceName)?.kind ?? null;
}

const SENSITIVE_HOST_PORTS = new Set([
  5432,
  3306,
  33060,
  27017,
  6379,
  9200,
  9300,
  5672,
  15672,
  9092,
]);

export function printPreflightReport(preflight: PreflightReport): void {
  const statusColor = preflight.status === 'passed' ? chalk.green : chalk.red;

  console.log(chalk.cyan('Phase 8 preflight:'));
  console.log(`Status: ${statusColor(preflight.status)}`);
  console.log(`Checked at: ${preflight.checkedAt}`);
  console.log(`Meta verifier: ${preflight.verificationReport.status}`);

  if (preflight.issues.length) {
    console.log(chalk.cyan('Preflight issues:'));
    for (const issue of preflight.issues) {
      console.log(`- ${issue}`);
    }
  }

  console.log(chalk.cyan('Preflight evidence:'));
  for (const item of preflight.evidence) {
    console.log(`- ${item}`);
  }
  console.log();
}

export async function requestRuntimeApproval(
  verificationReport: VerificationReport,
  attemptIndex: number,
  revisionPreview?: PlannerRevisionResult,
): Promise<ApprovalDecision> {
  console.log(chalk.cyan(`Deployment check (round ${attemptIndex}):`));
  console.log(`- Check status: ${verificationReport.status}`);
  if ((verificationReport.findings ?? []).length > 0) {
    console.log(chalk.yellow('- Problems found:'));
    for (const finding of verificationReport.findings ?? []) {
      console.log(chalk.yellow(`  - ${finding.code} [${finding.severity}] ${finding.resourceKind}${finding.resourceName ? `/${finding.resourceName}` : ''}`));
      console.log(chalk.gray(`    expected=${finding.expected ?? 'n/a'} actual=${finding.actual ?? 'n/a'} confidence=${finding.confidence}`));
    }
  }
  if (verificationReport.issues.length > 0) {
    console.log(chalk.yellow('- Reported issues:'));
    for (const issue of verificationReport.issues) {
      console.log(chalk.yellow(`  - ${issue}`));
    }
  }
  if (verificationReport.errorReason) {
    console.log(chalk.red('- Error: ' + verificationReport.errorReason));
  }
  if (verificationReport.revisionHint) {
    console.log(chalk.yellow('- Suggested fix: ' + verificationReport.revisionHint));
  }
  if (revisionPreview) {
    printRuntimeRevisionPreview(revisionPreview);
  }
  console.log(
    chalk.cyan(
      revisionPreview
        ? 'If you choose y, I will apply the shown revision and deploy again. Choose y / n / other.'
        : 'If you choose y, I will try the suggested fix and deploy again. Choose y / n / other.',
    ),
  );

  const readline = createInterface({ input, output });
  try {
    let choice: ApprovalDecision['choice'] | null = null;
    let userFeedback: UserFeedback | null = null;

    while (choice === null) {
      const answer = (
        await readline.question(
          chalk.yellow('Revise and re-deploy? [y]es / [n]o (cancel + cleanup) / [o]ther (provide additional feedback) '),
        )
      )
        .trim()
        .toLowerCase();
      const parsedChoice = parseApprovalPromptChoice(answer);
      if (parsedChoice === null) {
        printDontUnderstandPrompt();
        continue;
      }
      choice = parsedChoice;
      if (choice === 'other') {
        const feedbackText = (
          await readline.question(
            chalk.cyan('Describe what you want changed: '),
          )
        ).trim();
        if (feedbackText.length > 0) {
          userFeedback = {
            message: feedbackText,
            submittedAt: new Date().toISOString(),
          };
        }
      }
    }

    return { choice, userFeedback };
  } finally {
    readline.close();
  }
}

function printRuntimeRevisionPreview(result: PlannerRevisionResult): void {
  const patchResults = result.patchResults ?? [];
  if (patchResults.length === 0) return;

  console.log(chalk.cyan('- Planned revision if you choose y:'));
  for (const patchResult of patchResults) {
    const patch = patchResult.patch;
    const target = patchResult.matchedServiceNames.join(', ') || 'global';
    console.log(chalk.cyan(`  - ${patch.op} ${target}${describePreviewPatchChange(patch)}`));
  }
}

function describePreviewPatchChange(patch: SpecPatch): string {
  if (patch.op === 'replace-service-port') return ` ${patch.from ?? '*'} -> ${patch.to}`;
  if (patch.op === 'add-service-port') return ` +${patch.port}`;
  if (patch.op === 'remove-service-port') return ` -${patch.port ?? '*'}`;
  if (patch.op === 'set-service-replicas') return ` -> ${patch.replicas}`;
  if (patch.op === 'set-service-image') return ` -> ${patch.image}`;
  if (patch.op === 'rename-service') return ` -> ${patch.name}`;
  if (patch.op === 'set-project-name') return ` -> ${patch.name}`;
  if (patch.op === 'rename-network') return ` ${patch.from ?? '*'} -> ${patch.to}`;
  if (patch.op === 'set-networks') return ` -> ${patch.networks.join(', ')}`;
  if (patch.op === 'set-service-desired-status') return ` -> ${patch.desiredStatus}`;
  return '';
}

export async function requestRevisionClarification(
  revisionResult: PlannerRevisionResult,
): Promise<UserFeedback | null> {
  const contexts = revisionResult.clarificationContext ?? [];
  if (contexts.length === 0) return null;

  console.log(chalk.yellow('Deploy revision needs your confirmation before cleanup/redeploy.'));
  for (const context of contexts) {
    console.log(chalk.yellow(`- ${context.message}`));
    console.log(chalk.gray(`  reason: ${context.reason}`));
    context.choices.slice(0, 3).forEach((choice: { label: string; description: string }, index: number) => {
      console.log(chalk.cyan(`  ${index + 1}. ${choice.label}: ${choice.description}`));
    });
    if (context.allowOther) {
      console.log(chalk.cyan('  other. Describe a different change.'));
    }
  }

  const readline = createInterface({ input, output });
  try {
    while (true) {
      const answer = (
        await readline.question(
          chalk.yellow('Use suggested fix? [y]es / [n]o (cancel + cleanup) / [o]ther (describe a different change) '),
        )
      ).trim();

      const parsedChoice = parseApprovalPromptChoice(answer.toLowerCase());
      if (parsedChoice === null) {
        printDontUnderstandPrompt();
        continue;
      }

      if (parsedChoice === 'rejected') return null;

      const firstContext = contexts[0]!;
      if (parsedChoice === 'approved') {
        const allowChoice = firstContext.choices.find((choice) => /^allow:/i.test(choice.value)) ?? firstContext.choices[0];
        if (allowChoice) {
          return {
            message: `User selected ${allowChoice.value}`,
            submittedAt: new Date().toISOString(),
          };
        }
        return null;
      }

      const feedbackText = (
        await readline.question(chalk.cyan('Describe the change you want: '))
      ).trim();
      if (feedbackText.length === 0) return null;
      return {
        message: feedbackText,
        submittedAt: new Date().toISOString(),
      };
    }
  } finally {
    readline.close();
  }
}
export async function requestPlanningClarification(
  result: Extract<Awaited<ReturnType<ReActAgent['run']>>, { status: 'clarification' }>,
): Promise<ClarificationAnswer> {
  const uncertainty = result.uncertainties?.[0];
  if (!uncertainty) {
    throw new Error('Planning clarification requires at least one uncertainty.');
  }

  const readline = createInterface({ input, output });
  try {
    const answer = (
      await readline.question(
        chalk.yellow('Choose option number or type other for custom answer: '),
      )
    )
      .trim()
      .toLowerCase();

    let selectedChoiceId: string | null = null;
    let otherText: string | null = null;

    if (answer === 'other' || answer === 'o') {
      const typed = (await readline.question(chalk.cyan('Enter custom clarification: '))).trim();
      otherText = typed.length > 0 ? typed : null;
    } else {
      const matched = uncertainty.choices.find((choice) => choice.id === answer) ?? null;
      if (matched !== null) {
        selectedChoiceId = matched.id;
      } else {
        otherText = answer.length > 0 ? answer : null;
      }
    }

    return {
      uncertaintyId: uncertainty.id,
      selectedChoiceId,
      otherText,
      submittedAt: new Date().toISOString(),
    };
  } finally {
    readline.close();
  }
}

export async function requestCliApproval(request: ApprovalRequest): Promise<{ approval: ReturnType<typeof createApprovalResult>; decision: ApprovalDecision }> {
  console.log(chalk.cyan('Approval request:'));
  console.log(`- action: ${request.action}`);
  console.log(`- target: ${request.artifactTargetPath}`);
  console.log(`- compose hash: ${request.composePreviewSha256}`);
  console.log(`- containers if later applied: ${request.totalContainers}`);
  console.log('- Phase 8 will not call Docker or MCP.');
  console.log();
  console.log(
    chalk.cyan(
      'Review this plan. Choose y to continue, n to stop, other to request changes.',
    ),
  );

  const readline = createInterface({ input, output });

  try {
    let choice: ApprovalDecision['choice'] | null = null;
    let userFeedback: UserFeedback | null = null;

    while (choice === null) {
      const answer = (
        await readline.question(
          chalk.yellow('Approve writing docker-compose.yaml? [y]es / [n]o / [o]ther (request changes) '),
        )
      )
        .trim()
        .toLowerCase();
      const parsedChoice = parseApprovalPromptChoice(answer);
      if (parsedChoice === null) {
        printDontUnderstandPrompt();
        continue;
      }
      choice = parsedChoice;
      if (choice === 'other') {
        const feedbackText = (
          await readline.question(
            chalk.cyan('Describe what you want changed: '),
          )
        ).trim();
        if (feedbackText.length > 0) {
          userFeedback = {
            message: feedbackText,
            submittedAt: new Date().toISOString(),
          };
        }
      }
    }

    const decision = choice === 'approved' ? 'approved' : 'rejected';
    const approval = createApprovalResult({
      request,
      decision,
      reason: choice === 'approved'
        ? 'Approved from CLI prompt.'
        : choice === 'other'
          ? 'Other: feedback provided for revision.'
          : 'Rejected from CLI prompt.',
    });

    return { approval, decision: { choice, userFeedback } };
  } finally {
    readline.close();
  }
}

export function parseApprovalPromptChoice(answer: string): ApprovalDecision['choice'] | null {
  if (answer === 'y' || answer === 'yes') return 'approved';
  if (answer === 'n' || answer === 'no') return 'rejected';
  if (answer === 'o' || answer === 'other') return 'other';
  return null;
}

function printDontUnderstandPrompt(): void {
  console.log(chalk.yellow('dont understand'));
  console.log(chalk.cyan('Choose y / n / other.'));
}

export function printDockerDoctorReport(report: DockerDoctorReport): void {
  const statusColor = report.status === 'passed' ? chalk.green : chalk.red;

  console.log(chalk.cyan('Docker doctor:'));
  console.log(`Status: ${statusColor(report.status)}`);
  console.log(`Checked at: ${report.checkedAt}`);
  console.log('Docker CLI checked: false (bypassed; Engine API is checked directly)');
  console.log(`Docker engine reachable: ${report.engineReachable}`);
  console.log();

  console.log(chalk.cyan('Commands executed:'));
  for (const command of report.commands) {
    console.log(`- ${command.command} ${command.args.join(' ')}: ${command.ok ? 'ok' : 'failed'}`);
    if (command.errorMessage) {
      console.log(`  error: ${command.errorMessage}`);
    }
  }
  console.log();

  if (report.issues.length) {
    console.log(chalk.cyan('Issues:'));
    for (const issue of report.issues) {
      console.log(`- ${issue}`);
    }
    console.log();
  }

  console.log(chalk.cyan('Evidence:'));
  for (const item of report.evidence) {
    console.log(`- ${item}`);
  }
  console.log();
}

export function formatScheduleStep(step: ExecutionScheduleStep): string {
  const waitText = step.waitCondition ? `; wait: ${step.waitCondition}` : '';
  const dependencyText = step.dependsOn.length ? `; waits for: ${step.dependsOn.join(', ')}` : '';
  const dependentText = step.dependents.length ? `; then allows: ${step.dependents.join(', ')}` : '';
  const replicaText = step.replicas && step.replicas > 1 ? `; replicas: ${step.replicas}` : '';

  return [
    `- ${step.order}. ${step.levelName}: ${step.action}`,
    dependencyText,
    dependentText,
    replicaText,
    waitText,
  ].join('');
}

export function formatEnvironmentPreview(
  environment: Record<string, string>,
  serviceName?: string,
  secretResolution?: SecretResolutionResult,
): string {
  const entries = Object.entries(environment);

  if (!entries.length) {
    return 'none';
  }

  const resolutionByService = new Map<string, Map<string, ResolvedSecret>>();
  for (const service of secretResolution?.services ?? []) {
    const byKey = new Map<string, ResolvedSecret>();
    for (const secret of service.secrets) {
      byKey.set(secret.key, secret);
    }
    resolutionByService.set(service.serviceName, byKey);
  }

  return entries
    .map(([key, value]) => {
      if (!isSecretLikeKey(key)) {
        return `${key}=${value}`;
      }
      const resolved = serviceName ? resolutionByService.get(serviceName)?.get(key) : undefined;
      const sourceText = resolved ? ` (${resolved.source})` : '';
      return `${key}=**********${sourceText}`;
    })
    .join(', ');
}

export function printGuardTelemetry(telemetry: import('../domain/types.js').GuardTelemetry): void {
  console.log(chalk.cyan('ReAct loop guard telemetry:'));
  console.log(`- Outcome: ${telemetry.outcome}${telemetry.blockReason ? ` (${telemetry.blockReason})` : ''}`);
  console.log(`- Iterations: ${telemetry.iterations}`);
  const counts = telemetry.perToolCounts.map((entry) => `${entry.tool}=${entry.count}${entry.capped ? ' (capped)' : ''}`).join(', ');
  console.log(`- Tool calls: ${counts || 'none'}`);
  if (telemetry.deltaHistory.length > 0) {
    console.log('- Delta history:');
    for (const entry of telemetry.deltaHistory) {
      console.log(`    iter ${entry.iteration}: hasDelta=${entry.hasDelta} specHash=${entry.specHash} issueCount=${entry.issueCount}`);
    }
  }
  if (telemetry.logFilePath) {
    console.log(chalk.gray(`- Loop log: ${telemetry.logFilePath}`));
  }
}

export function detectPreDeployConflicts(
  desired: import('../domain/types.js').InfrastructureSpec,
  actual: RuntimeActualState,
): string[] {
  const issues: string[] = [];
  const desiredContainerNames = desired.services.flatMap((service) =>
    toReplicaContainerNames(desired.projectName, service),
  );
  const actualContainersByName = new Map(actual.containers.map((container) => [container.name, container]));

  for (const name of desiredContainerNames) {
    if (actualContainersByName.has(name)) {
      issues.push(`Container name conflict: "${name}" already exists in Docker runtime.`);
    }
  }

  const usedHostPorts = new Map<string, RuntimeContainerObservation[]>();
  for (const container of actual.containers) {
    for (const port of container.ports ?? []) {
      const hostPort = port.split(':')[0]?.trim();
      if (!hostPort || !/^\d+$/.test(hostPort)) {
        continue;
      }
      const entries = usedHostPorts.get(hostPort) ?? [];
      entries.push(container);
      usedHostPorts.set(hostPort, entries);
    }
  }

  for (const service of desired.services) {
    for (const port of service.ports ?? []) {
      const hostPort = port.split(':')[0]?.trim();
      if (!hostPort || !/^\d+$/.test(hostPort)) {
        continue;
      }
      const conflicts = usedHostPorts.get(hostPort) ?? [];
      if (conflicts.length > 0) {
        issues.push(
          `Host port conflict: service "${service.name}" wants ${hostPort}, already used by ${conflicts.map((container) => container.name).join(', ')}.`,
        );
      }
    }
  }



  return [...new Set(issues)];
}

export function createConflictVerificationReport(issues: string[]): VerificationReport {
  const checkedAt = new Date().toISOString();
  const findings = issues.map(conflictIssueToFinding);
  const hasConflicts = findings.length > 0;
  return {
    status: hasConflicts ? 'failed' : 'passed',
    scope: 'tool-runtime',
    checkedAt,
    issues: findings.map((finding) => finding.evidence[0] ?? `${finding.code}: conflict detected.`),
    findings,
    evidence: [hasConflicts ? 'Pre-deploy runtime scan found container or host-port conflicts.' : 'Pre-deploy runtime scan found no blocking conflicts.'],
    errorReason: hasConflicts ? 'Pre-deploy conflict detection blocked unsafe deployment.' : null,
    revisionHint: hasConflicts ? 'Pick different project/container names or host ports, then retry deployment.' : null,
    confidence: hasConflicts ? 0.98 : 0.95,
  };
}

function conflictIssueToFinding(issue: string): VerificationFinding {
  const containerName = /Container name conflict: "([^"]+)"/.exec(issue)?.[1] ?? null;
  if (containerName) {
    return {
      code: 'CONTAINER_NAME_CONFLICT',
      severity: 'blocker',
      resourceKind: 'container',
      resourceName: containerName,
      expected: 'container name available',
      actual: 'already exists',
      evidence: [issue],
      confidence: 0.98,
      suggestedAction: { action: 'auto-revise', summary: 'Add a safe project suffix before deployment.' },
      requiresUserInput: false,
    };
  }


  const portMatch = /Host port conflict: service "([^"]+)" wants (\d+)/.exec(issue);
  return {
    code: 'HOST_PORT_CONFLICT',
    severity: 'blocker',
    resourceKind: 'port',
    resourceName: portMatch?.[1] ?? null,
    expected: portMatch?.[2] ?? null,
    actual: 'already used',
    evidence: [issue],
    confidence: 0.98,
    suggestedAction: { action: 'auto-revise', summary: 'Choose the next safe available host port before deployment.' },
    requiresUserInput: false,
  };
}

export function collectDestroyAllTargets(
  state: InfrastructureStateSnapshot | null,
  projectStates: InfrastructureStateSnapshot[],
  actual: RuntimeActualState,
  removeVolumes: boolean,
): {
  projects: string[];
  containers: string[];
  networks: string[];
  volumes: string[];
  } {
  const projects = new Set<string>();
  const containers = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>();
  const addSnapshotTargets = (snapshot: VerifiedRuntimeSnapshot | null | undefined): void => {
    if (!snapshot) {
      return;
    }
    projects.add(snapshot.desired.projectName);
    const expectedContainers = new Set(
      snapshot.desired.services.flatMap((service) => toReplicaContainerNames(snapshot.desired.projectName, service)),
    );
    const expectedNetworks = new Set(snapshot.desired.networks);
    const expectedVolumes = new Set(snapshot.desired.volumes);

    for (const name of snapshot.resourceRefs?.containers ?? [...expectedContainers]) {
      if (name.startsWith(snapshot.desired.projectName + '-') || expectedContainers.has(name)) {
        containers.add(name);
      }
    }
    for (const name of expectedContainers) {
      containers.add(name);
    }
    for (const name of snapshot.resourceRefs?.networks ?? snapshot.desired.networks) {
      if (!isProtectedDockerNetwork(name) && (name.startsWith(snapshot.desired.projectName + '-') || expectedNetworks.has(name))) {
        networks.add(name);
      }
    }
    for (const name of expectedNetworks) {
      if (!isProtectedDockerNetwork(name)) {
        networks.add(name);
      }
    }
    if (removeVolumes) {
      for (const name of snapshot.resourceRefs?.volumes ?? snapshot.desired.volumes) {
        if (name.startsWith(snapshot.desired.projectName + '-') || expectedVolumes.has(name)) {
          volumes.add(name);
        }
      }
      for (const name of expectedVolumes) {
        volumes.add(name);
      }
    }
  };

  addSnapshotTargets(state?.current ?? null);
  if (state?.pendingPreview?.desired) {
    projects.add(state.pendingPreview.desired.projectName);
  }
  for (const projectState of projectStates) {
    addSnapshotTargets(projectState.current ?? null);
    if (projectState.pendingPreview?.desired) {
      projects.add(projectState.pendingPreview.desired.projectName);
    }
  }

  for (const project of projects) {
    for (const container of actual.containers) {
      if (container.name.startsWith(project + '-')) {
        containers.add(container.name);
      }
    }
    for (const network of actual.networks) {
      if (!isProtectedDockerNetwork(network.name) && network.name.startsWith(project + '-')) {
        networks.add(network.name);
      }
    }
    if (removeVolumes) {
      for (const volume of actual.volumes) {
        if (volume.name.startsWith(project + '-')) {
          volumes.add(volume.name);
        }
      }
    }
  }

  return {
    projects: [...projects].sort(),
    containers: [...containers].sort(),
    networks: [...networks].sort(),
    volumes: [...volumes].sort(),
  };
}

export function loadLocalEnvFile(): void {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isMissingDockerResourceError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('http code 404') || message.includes('no such container') || message.includes('no such network') || message.includes('no such volume');
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function isCommanderDisplayExitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'exitCode' in error &&
    error.exitCode === 0
  );
}

export function createProgressPrinter(): (event: ProgressEvent) => void {
  const counts = new Map<ProgressPhase, number>();
  let headerPrinted = false;

  return (event: ProgressEvent) => {
    if (!headerPrinted) {
      console.log(chalk.cyan('Progress:'));
      headerPrinted = true;
    }

    const nextCount = (counts.get(event.phase) ?? 0) + 1;
    counts.set(event.phase, nextCount);

    const toolText = event.toolName ? ` via ${event.toolName}` : '';
    console.log(
      chalk.gray(`- ${event.phase}${nextCount}${toolText}: ${event.message}`),
    );
  };
}

export function createProgressFileLogger(logPath = path.resolve(process.cwd(), 'agent-trace.log')): (event: ProgressEvent) => void {
  const counts = new Map<ProgressPhase, number>();

  writeFileSync(
    logPath,
    [`# Agent trace log`, `startedAt: ${new Date().toISOString()}`, ''].join('\n'),
    'utf8',
  );

  return (event: ProgressEvent) => {
    const nextCount = (counts.get(event.phase) ?? 0) + 1;
    counts.set(event.phase, nextCount);

    const toolText = event.toolName ? ` via ${event.toolName}` : '';
    appendFileSync(
      logPath,
      `- ${event.phase}${nextCount}${toolText}: ${event.message}\n`,
      'utf8',
    );
  };
}
