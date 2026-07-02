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
  RevisionObservation,
  RuntimeIssueReport,
  RuntimeActualState,
  UserFeedback,
  VerificationFinding,
  VerificationReport,
} from '../domain/types.js';
import { validateInfrastructureSpec, validateVerificationReport } from '../domain/schemas.js';
import type { ExecutionEngine } from '../execution/execution-engine.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import { buildDriftReport } from '../execution/drift-detector.js';
import { toReplicaContainerNames } from '../execution/container-names.js';
import {
  createConflictVerificationReport,
  detectPreDeployConflicts,
} from './shared.js';

const MAX_REVISION_CLARIFICATION_ROUNDS = 3;

export interface ClosedLoopAgentPort {
  verifyAfterApply(plan: ExecutionPlan, mcpClient: DockerMcpGateway): Promise<VerificationReport>;
  reviseFromFeedback(request: PlannerRevisionRequest): Promise<{
    revisedSpec: ApprovedAction['validatedSpec'];
    revisionSummary: string;
    assumptions: string[];
    revisionDecision?: RevisionHistoryRecord['revisionDecision'];
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
  requestRuntimeApproval(report: VerificationReport, attemptIndex: number): Promise<ApprovalDecision>;
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

  while (true) {
    const preDeployActual = await options.mcpClient.observeActualState();
    const preDeployConflicts = detectPreDeployConflicts(
      currentApprovedAction.validatedSpec,
      preDeployActual,
    );
    if (preDeployConflicts.length > 0) {
      attemptIndex += 1;
      const conflictReport = createConflictVerificationReport(preDeployConflicts);
      const resourceRefs = buildResourceRefs(currentApprovedAction.validatedSpec.projectName, preDeployActual, currentApprovedAction.validatedSpec);
      const guardOutcome = tickGuard(options.closedLoopGuard, currentApprovedAction, conflictReport);
      if (guardOutcome === 'guard-stopped') {
        return { status: 'guard-stopped', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
      }

      const revisionRequest: PlannerRevisionRequest = {
        desiredSpec: currentApprovedAction.validatedSpec,
        revisionObservation: {
          verificationReport: conflictReport,
          userFeedback: null,
          driftSummary: null,
        },
        stateSnapshot: null,
        resourceRefs,
        attemptIndex,
      };
      const initialRevisionResult = await options.agent.reviseFromFeedback(revisionRequest);
      const revisionResolution = await resolveRevisionWithClarifications(
        options,
        revisionRequest,
        initialRevisionResult,
      );
      const revisionResult = withExpectedProjectName(
        revisionResolution.revisionResult,
        currentApprovedAction.validatedSpec.projectName,
      );
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
      log('Pre-deploy conflict revised before Docker mutation.');
      continue;
    }

    let deployResult: Awaited<ReturnType<ClosedLoopEnginePort['deployWithDocker']>>;
    try {
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

      const runtimeDecision = await options.requestRuntimeApproval(verificationReport, attemptIndex);
      if (runtimeDecision.choice === 'rejected') {
        return { status: 'rejected', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
      }

      const revisionObservation: RevisionObservation = {
        verificationReport,
        userFeedback: runtimeDecision.userFeedback,
        driftSummary: null,
      };
      const revisionRequest: PlannerRevisionRequest = {
        desiredSpec: currentApprovedAction.validatedSpec,
        currentPlan,
        runtimeIssueReport,
        revisionObservation,
        stateSnapshot: null,
        resourceRefs: buildResourceRefs(currentApprovedAction.validatedSpec.projectName, preDeployActual, currentApprovedAction.validatedSpec),
        attemptIndex,
      };
      const initialRevisionResult = await options.agent.reviseFromFeedback(revisionRequest);
      const revisionResolution = await resolveRevisionWithClarifications(
        options,
        revisionRequest,
        initialRevisionResult,
      );
      const revisionResult = withExpectedProjectName(
        revisionResolution.revisionResult,
        currentApprovedAction.validatedSpec.projectName,
      );
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
      log('Deploy error normalized into runtime issue report; revised before redeploy.');
      continue;
    }
    const verificationReport = await options.agent.verifyAfterApply(currentPlan, options.mcpClient);
    const containerNames = currentApprovedAction.validatedSpec.services.flatMap((service) =>
      toReplicaContainerNames(currentApprovedAction.validatedSpec.projectName, service),
    );
    const actualState = await options.mcpClient.observeActualStateWithInspect({ containerNames });
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

    const runtimeDecision = await options.requestRuntimeApproval(verificationReport, attemptIndex);
    if (runtimeDecision.choice === 'rejected') {
      await options.engine.cleanupAttemptScope(options.mcpClient, deployResult.attemptScope);
      return { status: 'rejected', attempts: attemptIndex, revisionHistory, currentApprovedAction, currentPlan };
    }

    const revisionObservation: RevisionObservation = {
      verificationReport,
      userFeedback: runtimeDecision.userFeedback,
      driftSummary: driftReport.status !== 'none' ? driftReport.summary : null,
    };
    const revisionRequest: PlannerRevisionRequest = {
      desiredSpec: currentApprovedAction.validatedSpec,
      revisionObservation,
      stateSnapshot: null,
      resourceRefs,
      attemptIndex,
    };
    const initialRevisionResult = await options.agent.reviseFromFeedback(revisionRequest);
    const revisionResolution = await resolveRevisionWithClarifications(
      options,
      revisionRequest,
      initialRevisionResult,
    );
    const revisionResult = withExpectedProjectName(
      revisionResolution.revisionResult,
      currentApprovedAction.validatedSpec.projectName,
    );
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
    log(`Attempt ${attemptIndex} post-deploy verification failed; cleaned up and revised before redeploy.`);
  }
}

async function resolveRevisionWithClarifications(
  options: Pick<ClosedLoopDeployOptions, 'agent' | 'requestRevisionClarification'>,
  revisionRequest: PlannerRevisionRequest,
  initialRevisionResult: RevisionResult,
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
    if (clarificationFeedback === null) {
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
    });
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

  if (/manifest .*not found|pull access denied|image .*not found|No such image/i.test(message)) {
    const service = inferServiceFromImageError(message, desiredSpec);
    return {
      code: 'IMAGE_PULL_FAILED',
      severity: 'error',
      resourceKind: 'image',
      resourceName: service?.name ?? null,
      expected: service?.image ?? null,
      actual: 'image pull failed',
      evidence: [`Image pull failed during deploy: ${message}`],
      confidence: service ? 0.9 : 0.78,
      suggestedAction: { action: 'ask-user', summary: 'Provide a reachable image or credentials before redeploying.' },
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
