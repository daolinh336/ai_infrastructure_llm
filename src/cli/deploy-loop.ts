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
  RuntimeActualState,
  UserFeedback,
  VerificationReport,
} from '../domain/types.js';
import type { ExecutionEngine } from '../execution/execution-engine.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import { buildDriftReport } from '../execution/drift-detector.js';
import {
  createConflictVerificationReport,
  detectPreDeployConflicts,
} from './shared.js';

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
}

export async function runClosedLoopDeploy(options: ClosedLoopDeployOptions): Promise<ClosedLoopDeployResult> {
  let currentApprovedAction = options.approvedAction;
  let currentPlan = options.plan;
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
      const resourceRefs = buildResourceRefs(currentApprovedAction.validatedSpec.projectName, preDeployActual);
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
      let revisionFeedback = revisionRequest.revisionObservation.userFeedback;
      let revisionResult = await options.agent.reviseFromFeedback(revisionRequest);
      if (revisionResult.revisionDecision === 'needs-user-input') {
        const clarificationFeedback = await options.requestRevisionClarification(revisionResult);
        if (clarificationFeedback) {
          revisionFeedback = clarificationFeedback;
          revisionResult = await options.agent.reviseFromFeedback({
            ...revisionRequest,
            revisionObservation: {
              ...revisionRequest.revisionObservation,
              userFeedback: clarificationFeedback,
            },
          });
        }
      }
      revisionHistory.push({
        attemptIndex,
        revisionDecision: revisionResult.revisionDecision ?? 'auto-revised',
        revisionSummary: revisionResult.revisionSummary,
        findings: conflictReport.findings ?? [],
        userFeedback: revisionFeedback,
        createdAt: new Date().toISOString(),
      });
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

    const deployResult = await options.engine.deployWithDocker(currentApprovedAction, options.mcpClient);
    const verificationReport = await options.agent.verifyAfterApply(currentPlan, options.mcpClient);
    const containerNames = currentApprovedAction.validatedSpec.services.map(
      (service) => currentApprovedAction.validatedSpec.projectName + '-' + service.name.replace(/[_\s]+/g, '-'),
    );
    const actualState = await options.mcpClient.observeActualStateWithInspect({ containerNames });
    const resourceRefs = buildResourceRefs(currentApprovedAction.validatedSpec.projectName, actualState);
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
      return { status: 'passed', attempts: attemptIndex + 1, revisionHistory, currentApprovedAction, currentPlan };
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

    let revisionObservation: RevisionObservation = {
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
    let revisionResult = await options.agent.reviseFromFeedback(revisionRequest);
    if (revisionResult.revisionDecision === 'needs-user-input' && runtimeDecision.userFeedback === null) {
      const clarificationFeedback = await options.requestRevisionClarification(revisionResult);
      if (clarificationFeedback) {
        revisionObservation = { ...revisionObservation, userFeedback: clarificationFeedback };
        revisionResult = await options.agent.reviseFromFeedback({ ...revisionRequest, revisionObservation });
      }
    }
    revisionHistory.push({
      attemptIndex,
      revisionDecision: revisionResult.revisionDecision ?? 'auto-revised',
      revisionSummary: revisionResult.revisionSummary,
      findings: verificationReport.findings ?? [],
      userFeedback: revisionObservation.userFeedback,
      createdAt: new Date().toISOString(),
    });
    await options.engine.cleanupAttemptScope(options.mcpClient, deployResult.attemptScope);
    currentPlan = {
      ...currentPlan,
      spec: revisionResult.revisedSpec,
      assumptions: [...currentPlan.assumptions, ...revisionResult.assumptions],
    };
    currentApprovedAction = { ...currentApprovedAction, validatedSpec: revisionResult.revisedSpec };
    log('Post-deploy verification failed; cleaned up and revised before redeploy.');
  }
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
