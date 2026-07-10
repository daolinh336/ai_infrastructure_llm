import { ClosedLoopGuard, ClosedLoopGuardError } from '../agent/closed-loop-guard.js';
import { hashSpec } from '../agent/loop-guard.js';
import { buildResourceRefs } from '../agent/standard-verifier-agent.js';
import type {
  ApprovalDecision,
  ApprovedAction,
  CleanupReport,
  ExecutionPlan,
  PlannerRevisionRequest,
  RevisionHistoryRecord,
  RuntimeIssueReport,
  RuntimeActualState,
  SpecPatchPlan,
  UserFeedback,
  VerificationFinding,
  VerificationReport,
  ResolvedSpecPatchResult,
  ProgressReporter,
} from '../domain/types.js';
import { validateInfrastructureSpec, validateVerificationReport } from '../domain/schemas.js';
import type { ExecutionEngine } from '../execution/execution-engine.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import { createPlannerRuntimeReader, type PlannerRuntimeReader } from '../execution/runtime-environment-reader.js';
import { buildDriftReport } from '../execution/drift-detector.js';
import { toReplicaContainerNames } from '../execution/container-names.js';
import { scopeRuntimeActualStateToSpec } from '../domain/runtime-state-scope.js';
import {
  createConflictVerificationReport,
  detectPreDeployConflicts,
} from './shared.js';
import { getTrustedReplacementImages, type TrustedImageRole } from '../domain/supported-images.js';

const MAX_REVISION_CLARIFICATION_ROUNDS = 3;

export interface ClosedLoopAgentPort {
  verifyAfterApply(plan: ExecutionPlan, mcpClient: DockerMcpGateway): Promise<VerificationReport>;
  reviseFromFeedback(request: PlannerRevisionRequest, runtimeReader?: PlannerRuntimeReader): Promise<{
    revisedSpec: ApprovedAction['validatedSpec'];
    revisionSummary: string;
    assumptions: string[];
    revisionDecision?: RevisionHistoryRecord['revisionDecision'];
    patchPlan?: SpecPatchPlan;
    patchResults?: ResolvedSpecPatchResult[];
    clarificationContext?: import('../domain/types.js').PlanningUncertainty[];
  }>;
}

export interface ClosedLoopEnginePort {
  deployWithDocker(
    approvedAction: ApprovedAction,
    mcpClient: DockerMcpGateway,
  ): ReturnType<ExecutionEngine['deployWithDocker']>;
  cleanupAttemptScope(
    mcpClient: DockerMcpGateway,
    attemptScope: Awaited<ReturnType<ExecutionEngine['deployWithDocker']>>['attemptScope'],
  ): Promise<CleanupReport>;
}

export interface ClosedLoopDeployOptions {
  agent: ClosedLoopAgentPort;
  engine: ClosedLoopEnginePort;
  mcpClient: DockerMcpGateway;
  closedLoopGuard: ClosedLoopGuard;
  approvedAction: ApprovedAction;
  plan: ExecutionPlan;
  requestRuntimeApproval(report: VerificationReport, attemptIndex: number, revisionPreview?: RevisionResult): Promise<ApprovalDecision>;
  requestRevisionClarification(revisionResult: Awaited<ReturnType<ClosedLoopAgentPort['reviseFromFeedback']>>): Promise<UserFeedback | null>;
  saveVerifiedRuntimeSnapshot(input: {
    approvedAction: ApprovedAction;
    actual: RuntimeActualState;
    verificationReport: VerificationReport;
    operation: 'deploy';
    resourceRefs: ReturnType<typeof buildResourceRefs>;
    driftReport: ReturnType<typeof buildDriftReport>;
    revisionHistory: RevisionHistoryRecord[];
  }): Promise<unknown>;
  log?: (message: string) => void;
  progress?: ProgressReporter;
}

export interface ClosedLoopDeployResult {
  status: 'passed' | 'rejected' | 'guard-stopped' | 'failed';
  attempts: number;
  revisionHistory: RevisionHistoryRecord[];
  currentApprovedAction: ApprovedAction;
  currentPlan: ExecutionPlan;
  successfulDeployResult?: Awaited<ReturnType<ClosedLoopEnginePort['deployWithDocker']>>;
  failureReason?: string;
}

type RevisionResult = Awaited<ReturnType<ClosedLoopAgentPort['reviseFromFeedback']>>;

type RevisionResolutionResult =
  | { status: 'resolved'; revisionResult: RevisionResult; userFeedback: UserFeedback | null }
  | { status: 'blocked'; revisionResult: RevisionResult; userFeedback: UserFeedback | null; reason: string }
  | { status: 'rejected'; revisionResult: RevisionResult; userFeedback: UserFeedback | null; reason: string };

export async function runClosedLoopDeploy(options: ClosedLoopDeployOptions): Promise<ClosedLoopDeployResult> {
  let currentApprovedAction = options.approvedAction;
  let currentPlan = {
    ...options.plan,
    spec: currentApprovedAction.validatedSpec,
  };
  let attemptIndex = 0;
  const revisionHistory: RevisionHistoryRecord[] = [];
  const log = options.log ?? (() => undefined);
  const progress = options.progress ?? (() => undefined);
  const plannerRuntimeReader = createPlannerRuntimeReader(options.mcpClient);

  while (true) {
    progress({ phase: 'observe', message: 'Scanning Docker runtime before deploy...', toolName: 'observeActualState' });
    const preDeployActual = await options.mcpClient.observeActualState();
    const preDeployConflicts = detectPreDeployConflicts(
      currentApprovedAction.validatedSpec,
      preDeployActual,
    );
    if (preDeployConflicts.length > 0) {
      progress({ phase: 'execution', message: 'Pre-deploy conflicts found; asking planner for a safe revision.' });
      attemptIndex += 1;
      const conflictReport = createConflictVerificationReport(preDeployConflicts);
      const resourceRefs = buildResourceRefs(currentApprovedAction.validatedSpec.projectName, preDeployActual, currentApprovedAction.validatedSpec);
      const guardOutcome = tickGuard(options.closedLoopGuard, currentApprovedAction, conflictReport);
      if (guardOutcome === 'guard-stopped') {
        return { status: 'guard-stopped', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
      }

      const revisionRequest: PlannerRevisionRequest = {
        desiredSpec: currentApprovedAction.validatedSpec,
        currentPlan,
        revisionHistory: [...revisionHistory],
        revisionObservation: {
          verificationReport: conflictReport,
          userFeedback: null,
          driftSummary: null,
        },
        stateSnapshot: null,
        resourceRefs,
        attemptIndex,
      };
      const initialRevisionResult = await options.agent.reviseFromFeedback(revisionRequest, plannerRuntimeReader);

      const runtimeDecision = await options.requestRuntimeApproval(conflictReport, attemptIndex, initialRevisionResult);
      if (runtimeDecision.choice === 'rejected') {
        return { status: 'rejected', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
      }

      const requestedRevision = runtimeDecision.userFeedback == null
        ? initialRevisionResult
        : await options.agent.reviseFromFeedback({
          ...revisionRequest,
          revisionObservation: {
            ...revisionRequest.revisionObservation,
            userFeedback: runtimeDecision.userFeedback,
          },
        }, plannerRuntimeReader);
      const requestedRevisionRequest = runtimeDecision.userFeedback == null
        ? revisionRequest
        : {
          ...revisionRequest,
          revisionObservation: {
            ...revisionRequest.revisionObservation,
            userFeedback: runtimeDecision.userFeedback,
          },
        };
      const revisionResolution = runtimeDecision.choice === 'approved' && isConcreteRevision(requestedRevision, currentApprovedAction.validatedSpec)
        ? { status: 'resolved' as const, revisionResult: requestedRevision, userFeedback: runtimeDecision.userFeedback }
        : await resolveRevisionWithClarifications(
        options,
        requestedRevisionRequest,
        requestedRevision,
        plannerRuntimeReader,
      );
      const revisionResult = withExpectedProjectName(
        revisionResolution.revisionResult,
        currentApprovedAction.validatedSpec.projectName,
      );
      const previousSpec = currentApprovedAction.validatedSpec;
      revisionHistory.push({
        attemptIndex,
        revisionDecision: revisionResult.revisionDecision ?? 'auto-revised',
        revisionSummary: revisionResult.revisionSummary,
        findings: conflictReport.findings ?? [],
        userFeedback: revisionResolution.userFeedback,
        createdAt: new Date().toISOString(),
      });
      if (revisionResolution.status === 'blocked' || revisionResolution.status === 'rejected') {
        log(revisionResolution.reason);
        return { status: revisionResolution.status === 'rejected' ? 'rejected' : 'failed', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan, failureReason: revisionResolution.reason };
      }
      currentPlan = {
        ...currentPlan,
        spec: revisionResult.revisedSpec,
        assumptions: [...currentPlan.assumptions, ...revisionResult.assumptions],
      };
      currentApprovedAction = {
        ...currentApprovedAction,
        validatedSpec: revisionResult.revisedSpec,
      };
      logPlannerRevision(log, revisionResult, previousSpec);
      log('Pre-deploy conflict revised before Docker mutation.');
      continue;
    }

    let deployResult: Awaited<ReturnType<ClosedLoopEnginePort['deployWithDocker']>>;
    try {
      progress({ phase: 'execution', message: 'Applying approved Docker plan...' });
      deployResult = await options.engine.deployWithDocker(currentApprovedAction, options.mcpClient);
    } catch (error) {
      attemptIndex += 1;
      const runtimeIssueReport = createDeployErrorRuntimeIssueReport(
        error,
        currentApprovedAction.validatedSpec,
        preDeployActual,
        attemptIndex,
      );
      const verificationReport = runtimeIssueReportToVerificationReport(runtimeIssueReport);
      const guardOutcome = tickGuard(options.closedLoopGuard, currentApprovedAction, verificationReport);
      if (guardOutcome === 'guard-stopped') {
        return { status: 'guard-stopped', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
      }

      const revisionRequest: PlannerRevisionRequest = {
        desiredSpec: currentApprovedAction.validatedSpec,
        currentPlan,
        runtimeIssueReport,
        revisionHistory: [...revisionHistory],
        revisionObservation: {
          verificationReport,
          userFeedback: null,
          driftSummary: null,
        },
        stateSnapshot: null,
        resourceRefs: buildResourceRefs(currentApprovedAction.validatedSpec.projectName, preDeployActual, currentApprovedAction.validatedSpec),
        attemptIndex,
      };
      const initialRevisionResult = await options.agent.reviseFromFeedback(revisionRequest, plannerRuntimeReader);

      const runtimeDecision = await options.requestRuntimeApproval(verificationReport, attemptIndex, initialRevisionResult);
      if (runtimeDecision.choice === 'rejected') {
        return { status: 'rejected', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
      }

      const requestedRevision = runtimeDecision.userFeedback == null
        ? initialRevisionResult
        : await options.agent.reviseFromFeedback({
          ...revisionRequest,
          revisionObservation: {
            ...revisionRequest.revisionObservation,
            userFeedback: runtimeDecision.userFeedback,
          },
        }, plannerRuntimeReader);
      const requestedRevisionRequest = runtimeDecision.userFeedback == null
        ? revisionRequest
        : {
          ...revisionRequest,
          revisionObservation: {
            ...revisionRequest.revisionObservation,
            userFeedback: runtimeDecision.userFeedback,
          },
        };
      const revisionResolution = runtimeDecision.choice === 'approved' && isConcreteRevision(requestedRevision, currentApprovedAction.validatedSpec)
        ? { status: 'resolved' as const, revisionResult: requestedRevision, userFeedback: runtimeDecision.userFeedback }
        : await resolveRevisionWithClarifications(
        options,
        requestedRevisionRequest,
        requestedRevision,
        plannerRuntimeReader,
      );
      const revisionResult = withExpectedProjectName(
        revisionResolution.revisionResult,
        currentApprovedAction.validatedSpec.projectName,
      );
      const previousSpec = currentApprovedAction.validatedSpec;
      revisionHistory.push({
        attemptIndex,
        revisionDecision: revisionResult.revisionDecision ?? 'auto-revised',
        revisionSummary: revisionResult.revisionSummary,
        findings: verificationReport.findings ?? [],
        userFeedback: revisionResolution.userFeedback,
        createdAt: new Date().toISOString(),
      });
      if (revisionResolution.status === 'blocked' || revisionResolution.status === 'rejected') {
        log(revisionResolution.reason);
        return { status: revisionResolution.status === 'rejected' ? 'rejected' : 'failed', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan, failureReason: revisionResolution.reason };
      }
      currentPlan = {
        ...currentPlan,
        spec: revisionResult.revisedSpec,
        assumptions: [...currentPlan.assumptions, ...revisionResult.assumptions],
      };
      currentApprovedAction = { ...currentApprovedAction, validatedSpec: revisionResult.revisedSpec };
      logPlannerRevision(log, revisionResult, previousSpec);
      log('Deploy error normalized into runtime issue report; revised before redeploy.');
      continue;
    }
    progress({ phase: 'observe', message: 'Verifying deployed containers...', toolName: 'verifyAfterApply' });
    const verificationReport = await options.agent.verifyAfterApply(currentPlan, options.mcpClient);
    const containerNames = currentApprovedAction.validatedSpec.services.flatMap((service) =>
      toReplicaContainerNames(currentApprovedAction.validatedSpec.projectName, service),
    );
    progress({ phase: 'observe', message: 'Reading container inspect details...', toolName: 'observeActualStateWithInspect' });
    const observedActualState = await options.mcpClient.observeActualStateWithInspect({ containerNames });
    const actualState = scopeRuntimeActualStateToSpec(observedActualState, currentApprovedAction.validatedSpec);
    const resourceRefs = buildResourceRefs(currentApprovedAction.validatedSpec.projectName, actualState, currentApprovedAction.validatedSpec);
    const driftReport = buildDriftReport(currentApprovedAction.validatedSpec, actualState);

    if (verificationReport.status === 'passed') {
      await options.saveVerifiedRuntimeSnapshot({
        approvedAction: currentApprovedAction,
        actual: actualState,
        verificationReport,
        operation: 'deploy',
        resourceRefs,
        driftReport,
        revisionHistory,
      });
      return {
        status: 'passed',
        attempts: attemptIndex + 1,
        revisionHistory,
        currentApprovedAction,
        currentPlan,
        successfulDeployResult: deployResult,
      };
    }

    attemptIndex += 1;
    const guardOutcome = tickGuard(options.closedLoopGuard, currentApprovedAction, verificationReport);
    if (guardOutcome === 'guard-stopped') {
      await options.engine.cleanupAttemptScope(options.mcpClient, deployResult.attemptScope);
      return { status: 'guard-stopped', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
    }

    const revisionRequest: PlannerRevisionRequest = {
      desiredSpec: currentApprovedAction.validatedSpec,
      currentPlan,
      revisionHistory: [...revisionHistory],
      revisionObservation: {
        verificationReport,
        userFeedback: null,
        driftSummary: driftReport.status !== 'none' ? driftReport.summary : null,
      },
      stateSnapshot: null,
      resourceRefs,
      attemptIndex,
    };
    const initialRevisionResult = await options.agent.reviseFromFeedback(revisionRequest, plannerRuntimeReader);

    const runtimeDecision = await options.requestRuntimeApproval(verificationReport, attemptIndex, initialRevisionResult);
    if (runtimeDecision.choice === 'rejected') {
      await options.engine.cleanupAttemptScope(options.mcpClient, deployResult.attemptScope);
      return { status: 'rejected', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
    }

    const requestedRevision = runtimeDecision.userFeedback == null
      ? initialRevisionResult
      : await options.agent.reviseFromFeedback({
        ...revisionRequest,
        revisionObservation: {
          ...revisionRequest.revisionObservation,
          userFeedback: runtimeDecision.userFeedback,
        },
      }, plannerRuntimeReader);
    const requestedRevisionRequest = runtimeDecision.userFeedback == null
      ? revisionRequest
      : {
        ...revisionRequest,
        revisionObservation: {
          ...revisionRequest.revisionObservation,
          userFeedback: runtimeDecision.userFeedback,
        },
      };
    const revisionResolution = runtimeDecision.choice === 'approved' && isConcreteRevision(requestedRevision, currentApprovedAction.validatedSpec)
      ? { status: 'resolved' as const, revisionResult: requestedRevision, userFeedback: runtimeDecision.userFeedback }
      : await resolveRevisionWithClarifications(
      options,
      requestedRevisionRequest,
      requestedRevision,
      plannerRuntimeReader,
    );
    const revisionResult = withExpectedProjectName(
      revisionResolution.revisionResult,
      currentApprovedAction.validatedSpec.projectName,
    );
    const previousSpec = currentApprovedAction.validatedSpec;
    revisionHistory.push({
      attemptIndex,
      revisionDecision: revisionResult.revisionDecision ?? 'auto-revised',
      revisionSummary: revisionResult.revisionSummary,
      findings: verificationReport.findings ?? [],
      userFeedback: revisionResolution.userFeedback,
      createdAt: new Date().toISOString(),
    });
    await options.engine.cleanupAttemptScope(options.mcpClient, deployResult.attemptScope);
    if (revisionResolution.status === 'blocked' || revisionResolution.status === 'rejected') {
        log(revisionResolution.reason);
        return { status: revisionResolution.status === 'rejected' ? 'rejected' : 'failed', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan, failureReason: revisionResolution.reason };
    }
    currentPlan = {
      ...currentPlan,
      spec: revisionResult.revisedSpec,
      assumptions: [...currentPlan.assumptions, ...revisionResult.assumptions],
    };
    currentApprovedAction = { ...currentApprovedAction, validatedSpec: revisionResult.revisedSpec };
    logPlannerRevision(log, revisionResult, previousSpec);
    log(`Attempt ${attemptIndex} post-deploy verification failed; cleaned up and revised before redeploy.`);
  }
}

async function resolveRevisionWithClarifications(
  options: Pick<ClosedLoopDeployOptions, 'agent' | 'requestRevisionClarification'>,
  revisionRequest: PlannerRevisionRequest,
  initialRevisionResult: RevisionResult,
  runtimeReader: PlannerRuntimeReader,
): Promise<RevisionResolutionResult> {
  let revisionResult = initialRevisionResult;
  let userFeedback = revisionRequest.revisionObservation.userFeedback;

  for (let round = 0; revisionResult.revisionDecision === 'needs-user-input'; round += 1) {
    if (round >= MAX_REVISION_CLARIFICATION_ROUNDS) {
      return {
        status: 'blocked',
        revisionResult,
        userFeedback,
        reason: `Planner still needs user input after ${MAX_REVISION_CLARIFICATION_ROUNDS} clarification round(s); stopping deploy loop.`,
      };
    }

    const clarificationFeedback = await options.requestRevisionClarification(revisionResult);
    if (clarificationFeedback == null) {
      return {
        status: 'rejected',
        revisionResult,
        userFeedback,
        reason: 'User cancelled revision; deploy loop stopped.',
      };
    }

    userFeedback = clarificationFeedback;
    revisionResult = await options.agent.reviseFromFeedback({
      ...revisionRequest,
      revisionObservation: {
        ...revisionRequest.revisionObservation,
        userFeedback: clarificationFeedback,
      },
    }, runtimeReader);
  }

  return { status: 'resolved', revisionResult, userFeedback };
}

function tickGuard(
  closedLoopGuard: ClosedLoopGuard,
  approvedAction: ApprovedAction,
  report: VerificationReport,
): 'ok' | 'guard-stopped' {
  try {
    closedLoopGuard.tick(
      hashSpec(approvedAction.validatedSpec),
      ClosedLoopGuard.failureSignature(report.issues),
    );
    return 'ok';
  } catch (error) {
    if (error instanceof ClosedLoopGuardError) return 'guard-stopped';
    throw error;
  }
}

function withExpectedProjectName(
  revisionResult: RevisionResult,
  expectedProjectName: string,
): RevisionResult {
  if (revisionResult.revisedSpec.projectName === expectedProjectName) {
    return revisionResult;
  }

  return {
    ...revisionResult,
    revisedSpec: validateInfrastructureSpec({
      ...revisionResult.revisedSpec,
      projectName: expectedProjectName,
    }),
  };
}

function isConcreteRevision(revisionResult: RevisionResult, previousSpec: ApprovedAction['validatedSpec']): boolean {
  const normalizedRevision = withExpectedProjectName(revisionResult, previousSpec.projectName);
  return hashSpec(normalizedRevision.revisedSpec) !== hashSpec(previousSpec);
}

function createDeployErrorRuntimeIssueReport(
  error: unknown,
  desiredSpec: ApprovedAction['validatedSpec'],
  actualState: RuntimeActualState,
  attemptIndex: number,
): RuntimeIssueReport {
  const message = getErrorMessage(error);
  const checkedAt = new Date().toISOString();
  const finding = classifyDeployError(message, desiredSpec);
  return {
    status: 'error',
    phase: 'deploy',
    checkedAt,
    projectName: desiredSpec.projectName,
    attemptIndex,
    desiredSpec,
    issues: [finding],
    rawError: {
      message,
      source: message.includes('MCP tool error') ? 'docker-mcp' : message.includes('HTTP code') ? 'docker-engine' : 'unknown',
    },
    actualState,
    cleanup: null,
  };
}

function runtimeIssueReportToVerificationReport(report: RuntimeIssueReport): VerificationReport {
  return validateVerificationReport({
    status: 'failed',
    scope: 'tool-runtime',
    checkedAt: report.checkedAt,
    issues: report.issues.map((finding) => finding.evidence[0] ?? `${finding.code}: runtime issue detected.`),
    findings: report.issues,
    evidence: [
      `Runtime ${report.phase} produced a non-success result and was normalized for planner revision.`,
      ...(report.rawError ? [`Raw runtime error: ${report.rawError.message}`] : []),
    ],
    errorReason: 'Runtime deploy failed before successful verification.',
    revisionHint: 'Revise desired spec from runtime report or provide other feedback, then redeploy.',
    confidence: 0.92,
  });
}

function logPlannerRevision(
  log: (message: string) => void,
  revisionResult: Awaited<ReturnType<ClosedLoopAgentPort['reviseFromFeedback']>>,
  previousSpec?: ApprovedAction['validatedSpec'],
): void {
  log('Planner revision decision: ' + (revisionResult.revisionDecision ?? 'auto-revised'));
  log('Planner revision source: ' + describePlannerRevisionSource(revisionResult));
  log('Planner revision summary: ' + revisionResult.revisionSummary);
  const patchResults = revisionResult.patchResults ?? [];
  if (patchResults.length > 0) {
    log('Planner patches:');
    for (const result of patchResults) {
      const patch = result.patch;
      const target = result.matchedServiceNames.length > 0 ? result.matchedServiceNames.join(', ') : describePatchTarget(patch);
      log(`- ${patch.op} ${target}${describePatchChange(patch)} -> ${result.applied ? 'applied' : 'skipped'}; reason=${patch.reason}${result.blockedReason ? ' (blocked: ' + result.blockedReason + ')' : ''}`);
    }
  } else if ((revisionResult.patchPlan?.patches.length ?? 0) > 0) {
    log('Planner patches (planned; no resolution details returned):');
    for (const patch of revisionResult.patchPlan?.patches ?? []) {
      log(`- ${patch.op} ${describePatchTarget(patch)}${describePatchChange(patch)}; reason=${patch.reason}`);
    }
  } else {
    log('Planner patches: none reported by planner.');
  }

  if (previousSpec) {
    const changes = describeSpecChanges(previousSpec, revisionResult.revisedSpec);
    if (changes.length > 0) {
      log('Planner resulting spec changes:');
      for (const change of changes) log(`- ${change}`);
    } else {
      log('Planner resulting spec changes: none.');
    }
  }
}

function describePlannerRevisionSource(
  revisionResult: Awaited<ReturnType<ClosedLoopAgentPort['reviseFromFeedback']>>,
): string {
  const assumptions = revisionResult.assumptions.join('\n');
  if (/LLM revision request sent to structured provider with schema spec_patch_plan/.test(assumptions)) {
    return 'llm-structured-spec-patch-plan';
  }
  if (/LLM revision request failed or returned invalid structured output/.test(assumptions)) {
    return 'llm-structured-spec-patch-plan-failed';
  }
  if (/deterministic fallback patch\(es\)/i.test(assumptions)) {
    return 'deterministic-fallback';
  }
  return 'planner-local-validation';
}

function describePatchTarget(patch: SpecPatchPlan['patches'][number]): string {
  if ('target' in patch) {
    const selector = patch.target;
    if (selector.name) return selector.name;
    if (selector.nameLike) return `nameLike=${selector.nameLike}`;
    if (selector.kind) return `kind=${selector.kind}`;
    if (selector.imageFamily) return `imageFamily=${selector.imageFamily}`;
    if (selector.exposesHostPort) return 'exposesHostPort=true';
    if (selector.dependsOn) return `dependsOn=${selector.dependsOn}`;
    if (selector.dependentOf) return `dependentOf=${selector.dependentOf}`;
  }
  if ('service' in patch) return patch.service.name;
  return 'global';
}

function describeSpecChanges(
  before: ApprovedAction['validatedSpec'],
  after: ApprovedAction['validatedSpec'],
): string[] {
  const changes: string[] = [];
  if (before.projectName !== after.projectName) {
    changes.push(`projectName: ${before.projectName} -> ${after.projectName}`);
  }

  const beforeServices = new Map(before.services.map((service) => [service.name, service]));
  const afterServices = new Map(after.services.map((service) => [service.name, service]));

  for (const [name, service] of beforeServices) {
    if (!afterServices.has(name)) changes.push(`service ${name}: removed (${service.image})`);
  }
  for (const [name, service] of afterServices) {
    const previous = beforeServices.get(name);
    if (!previous) {
      changes.push(`service ${name}: added (${service.image}${formatPortsForDiff(service.ports)})`);
      continue;
    }
    if (previous.image !== service.image) changes.push(`service ${name} image: ${previous.image} -> ${service.image}`);
    if ((previous.replicas ?? 1) !== (service.replicas ?? 1)) changes.push(`service ${name} replicas: ${previous.replicas ?? 1} -> ${service.replicas ?? 1}`);
    if (!sameStringList(previous.ports ?? [], service.ports ?? [])) changes.push(`service ${name} ports: ${formatListForDiff(previous.ports ?? [])} -> ${formatListForDiff(service.ports ?? [])}`);
    if (previous.desiredStatus !== service.desiredStatus) changes.push(`service ${name} desiredStatus: ${previous.desiredStatus ?? 'running'} -> ${service.desiredStatus ?? 'running'}`);
  }

  if (!sameStringList(before.networks, after.networks)) changes.push(`networks: ${formatListForDiff(before.networks)} -> ${formatListForDiff(after.networks)}`);
  if (!sameStringList(before.volumes, after.volumes)) changes.push(`volumes: ${formatListForDiff(before.volumes)} -> ${formatListForDiff(after.volumes)}`);
  return changes;
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatListForDiff(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function formatPortsForDiff(ports: string[] | undefined): string {
  return ports && ports.length > 0 ? ` ports ${ports.join(', ')}` : '';
}

function describePatchChange(patch: SpecPatchPlan['patches'][number]): string {
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

function classifyDeployError(
  message: string,
  desiredSpec: ApprovedAction['validatedSpec'],
): VerificationFinding {
  const bindMatch = /Bind for [^:]+:(\d+) failed: port is already allocated/i.exec(message)
    ?? /port (\d+) is already allocated/i.exec(message);
  if (bindMatch) {
    const hostPort = bindMatch[1]!;
    const service = desiredSpec.services.find((candidate) =>
      (candidate.ports ?? []).some((port) => port.split(':')[0]?.trim() === hostPort),
    ) ?? inferServiceFromErrorEndpoint(message, desiredSpec);
    return {
      code: 'HOST_PORT_CONFLICT',
      severity: 'blocker',
      resourceKind: 'port',
      resourceName: service?.name ?? null,
      expected: hostPort,
      actual: 'already allocated',
      evidence: [
        `Host port conflict: service "${service?.name ?? 'unknown'}" wants ${hostPort}, but Docker reported it is already allocated.`,
      ],
      confidence: service ? 0.96 : 0.86,
      suggestedAction: { action: 'auto-revise', summary: 'Choose another host port before redeploying.' },
      requiresUserInput: false,
    };
  }

  const pullFailureClass = classifyImagePullFailure(message);
  if (pullFailureClass !== null) {
    const service = inferServiceFromImageError(message, desiredSpec);
    const replacements = service
      ? getTrustedReplacementImages(service.image, service.kind as TrustedImageRole, pullFailureClass !== 'auth')
      : [];
    const choices = replacements.slice(0, 3).map((image, index) => ({
      id: String(index + 1),
      label: 'Use ' + image,
      description: 'Rebuild the affected service with trusted ' + service?.kind + ' image ' + image + '.',
      value: 'use ' + image,
    }));
    return {
      code: 'IMAGE_PULL_FAILED',
      severity: 'error',
      resourceKind: 'image',
      resourceName: service?.name ?? null,
      expected: service?.image ?? null,
      actual: 'image pull failed: ' + pullFailureClass,
      evidence: [
        `Image pull failed during deploy (${pullFailureClass}): ${message}`,
        replacements.length > 0
          ? `Trusted replacement candidates: ${replacements.join(', ')}`
          : 'No trusted equivalent image is available for this service role.',
      ],
      confidence: service ? 0.9 : 0.78,
      suggestedAction: {
        action: 'ask-user',
        summary: replacements.length > 0
          ? 'Choose a trusted replacement image, provide another image, or cancel deployment.'
          : 'No trusted equivalent image is available; provide another trusted image or cancel deployment.',
        ...(choices.length > 0 ? { choices } : {}),
      },
      requiresUserInput: true,
    };
  }

  if (/permission denied|access denied|operation not permitted/i.test(message)) {
    return {
      code: 'DOCKER_PERMISSION_DENIED',
      severity: 'blocker',
      resourceKind: 'runtime',
      resourceName: null,
      expected: 'docker operation allowed',
      actual: 'permission denied',
      evidence: [`Docker permission denied during deploy: ${message}`],
      confidence: 0.85,
      suggestedAction: { action: 'ask-user', summary: 'Change runtime permissions or revise unsafe mounts/ports.' },
      requiresUserInput: true,
    };
  }

  return {
    code: message.includes('MCP tool error') ? 'MCP_TOOL_ERROR' : 'UNKNOWN_RUNTIME_ERROR',
    severity: 'error',
    resourceKind: 'runtime',
    resourceName: null,
    expected: 'deploy success',
    actual: 'deploy error',
    evidence: [`Runtime deploy error: ${message}`],
    confidence: 0.65,
    suggestedAction: { action: 'ask-user', summary: 'Provide other feedback or cancel deployment.' },
    requiresUserInput: true,
  };
}

function classifyImagePullFailure(message: string): 'auth' | 'not-found' | 'transient' | 'rate-limit' | 'unsupported' | null {
  if (!/pull|image|manifest|repository|registry|Unsupported trusted image catalog/i.test(message)) return null;
  if (/Unsupported trusted image catalog/i.test(message)) return 'unsupported';
  if (/unauthorized|authentication required|authorization failed|pull access denied|access denied/i.test(message)) return 'auth';
  if (/too many requests|rate limit|\b429\b/i.test(message)) return 'rate-limit';
  if (/manifest .*not found|manifest unknown|image .*not found|No such image|repository does not exist|name unknown|not found/i.test(message)) return 'not-found';
  if (/timed out|timeout|deadline exceeded|temporary failure|connection reset|connection refused|connection closed|network is unreachable|no route to host|tls handshake timeout|\b50[234]\b|econnreset|etimedout|eai_again/i.test(message)) return 'transient';
  return null;
}

function inferServiceFromErrorEndpoint(
  message: string,
  desiredSpec: ApprovedAction['validatedSpec'],
): ApprovedAction['validatedSpec']['services'][number] | null {
  const endpoint = /endpoint\s+([A-Za-z0-9_.-]+)/i.exec(message)?.[1] ?? '';
  if (!endpoint) return null;
  return desiredSpec.services.find((service) => endpoint.includes(service.name)) ?? null;
}

function inferServiceFromImageError(
  message: string,
  desiredSpec: ApprovedAction['validatedSpec'],
): ApprovedAction['validatedSpec']['services'][number] | null {
  return desiredSpec.services.find((service) => message.includes(service.image)) ?? null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
