import { createHash } from 'node:crypto';
import {
  validateActionClassification,
  validateApprovalRequest,
  validateApprovalResult,
  validateApprovedAction,
  validateDetailedDryRunPreview,
  validateExecutionPlan,
  validateInfrastructureSpec,
  validatePreflightReport,
  validateVerificationReport,
} from '../domain/schemas.js';
import type {
  ActionClassification,
  ApprovalRequest,
  ApprovalResult,
  ApprovedAction,
  DetailedDryRunPreview,
  DryRunPolicyFinding,
  PendingPreviewState,
  PreflightReport,
  VerificationReport,
} from '../domain/types.js';

export interface Phase8PreviewBundle {
  composeYaml: string;
  pendingPreview: PendingPreviewState;
  dryRunPreview: DetailedDryRunPreview | null;
}

export interface ApprovalGate {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}

export function classifyPhase8ApplyAction(): ActionClassification {
  return validateActionClassification({
    capability: 'compose-artifact-write',
    risk: 'artifact-write',
    summary:
      'Write the reviewed Docker Compose artifact and persist an ApprovedAction; do not call Docker or MCP.',
    requiresApproval: true,
    mutatesRuntime: false,
    writesArtifact: true,
    writesState: true,
    callsDocker: false,
    callsMcp: false,
  });
}

export function classifyDockerDeployAction(): ActionClassification {
  return validateActionClassification({
    capability: 'compose-artifact-write',
    risk: 'runtime-create',
    summary: 'Deploy the approved compose infrastructure to Docker via MCP; requires Phase 8 approval gate.',
    requiresApproval: true,
    mutatesRuntime: true,
    writesArtifact: false,
    writesState: true,
    callsDocker: true,
    callsMcp: true,
  });
}

export function runDockerPreflight(
  bundle: Phase8PreviewBundle,
  checkedAt = new Date().toISOString(),
): PreflightReport {
  const issues: string[] = [];
  const evidence: string[] = ['Docker preflight checks are read-only.'];

  if (!bundle.dryRunPreview) {
    issues.push('Dry-run preview is required before Docker deploy.');
  }

  if (!bundle.pendingPreview.approvedAction) {
    issues.push('ApprovedAction is required before Docker deploy.');
  }

  const status = issues.length ? 'failed' : 'passed';
  return validatePreflightReport({
    status,
    checkedAt,
    issues,
    evidence,
    policyFindings: bundle.dryRunPreview?.policyFindings ?? [],
    verificationReport: validateVerificationReport({
      status: status === 'passed' ? 'passed' : 'failed',
      scope: 'meta-preflight',
      checkedAt,
      issues,
      evidence,
      errorReason: issues.length ? 'Docker preflight failed.' : null,
      revisionHint: issues.length ? 'Ensure dry-run and approval gate pass before deploy.' : null,
      confidence: status === 'passed' ? 0.9 : 0.2,
    }),
  });
}

export function runPhase8Preflight(
  bundle: Phase8PreviewBundle,
  checkedAt = new Date().toISOString(),
): PreflightReport {
  const metaReport = runMetaVerification(bundle, checkedAt);
  const dryRunPreview = bundle.dryRunPreview;
  const issues = [...metaReport.issues];
  const evidence = [
    ...metaReport.evidence,
    'Phase 8 preflight is read-only and does not call Docker or MCP.',
  ];
  const policyFindings: DryRunPolicyFinding[] = dryRunPreview?.policyFindings ?? [];

  if (!dryRunPreview) {
    issues.push('Dry-run preview is required before approval.');
  } else {
    if (dryRunPreview.schedule.steps.length === 0) {
      issues.push('Dependency schedule is required before approval.');
    }

    if (policyFindings.length === 0) {
      issues.push('Policy evidence is required before approval.');
    }

    if (dryRunPreview.artifactWritten) {
      issues.push('Dry-run preview must not have written the compose artifact.');
    }

    if (dryRunPreview.stateSaved) {
      issues.push('Dry-run preview must not have saved state before approval.');
    }

    if (dryRunPreview.dockerCalled) {
      issues.push('Dry-run preview must not call Docker.');
    }

    if (dryRunPreview.mcpCalled) {
      issues.push('Dry-run preview must not call MCP.');
    }
  }

  const status = issues.length ? 'failed' : 'passed';
  const verificationReport =
    metaReport.status === 'passed' && status === 'failed'
      ? validateVerificationReport({
          ...metaReport,
          status: 'failed',
          issues,
          errorReason: 'Phase 8 preflight failed.',
          revisionHint: 'Regenerate a complete dry-run preview before approval.',
          confidence: 0.4,
        })
      : metaReport;

  return validatePreflightReport({
    status,
    checkedAt,
    issues,
    evidence,
    policyFindings,
    verificationReport,
  });
}

export function buildApprovalRequest(input: {
  pendingPreview: PendingPreviewState;
  dryRunPreview: DetailedDryRunPreview;
  classification: ActionClassification;
  preflight: PreflightReport;
  requestedAt?: string;
}): ApprovalRequest {
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  const request = validateApprovalRequest({
    id: `approval-request-${toStableId(input.pendingPreview.id)}-${toStableId(requestedAt)}`,
    requestedAt,
    action: 'write-compose-artifact',
    request: input.pendingPreview.request,
    planSummary: input.pendingPreview.plan.summary,
    classification: input.classification,
    artifactTargetPath: input.pendingPreview.composeArtifact.targetPath,
    composePreviewSha256: input.pendingPreview.composeArtifact.previewSha256,
    totalContainers: input.dryRunPreview.totalContainers,
    policyFindings: input.dryRunPreview.policyFindings,
    preflight: input.preflight,
  });

  return request;
}

export function createApprovalResult(input: {
  request: ApprovalRequest;
  decision: ApprovalResult['decision'];
  reason?: string | null;
  respondedAt?: string;
}): ApprovalResult {
  const respondedAt = input.respondedAt ?? new Date().toISOString();

  return validateApprovalResult({
    id: `approval-${toStableId(input.request.id)}-${toStableId(respondedAt)}`,
    requestId: input.request.id,
    decision: input.decision,
    respondedAt,
    approvedBy: 'cli-user',
    reason: input.reason ?? null,
  });
}

export function buildApprovedAction(input: {
  pendingPreview: PendingPreviewState;
  dryRunPreview: DetailedDryRunPreview;
  approvalRequest: ApprovalRequest;
  approval: ApprovalResult;
  preflight: PreflightReport;
  classification: ActionClassification;
}): ApprovedAction {
  if (input.approval.requestId !== input.approvalRequest.id) {
    throw new Error('Approval result does not match approval request.');
  }

  if (input.approval.decision !== 'approved') {
    throw new Error('ApprovedAction requires an approved approval result.');
  }

  const composeArtifact = {
    ...input.pendingPreview.composeArtifact,
    written: true,
    writtenAt: input.approval.respondedAt,
  };

  return validateApprovedAction({
    id: `approved-action-${toStableId(input.approval.id)}`,
    action: 'write-compose-artifact',
    request: input.pendingPreview.request,
    classification: input.classification,
    approval: input.approval,
    approvalMarker: {
      type: 'phase8-human-approval',
      approvalId: input.approval.id,
      approvedAt: input.approval.respondedAt,
      approvedBy: 'cli-user',
    },
    validatedSpec: input.pendingPreview.desired,
    composeArtifact,
    dependencySchedule: input.dryRunPreview.schedule,
    preflight: input.preflight,
    policyFindings: input.dryRunPreview.policyFindings,
    dockerCalled: false,
    mcpCalled: false,
    runtimeMutation: false,
  });
}

function runMetaVerification(
  bundle: Phase8PreviewBundle,
  checkedAt: string,
): VerificationReport {
  const issues: string[] = [];
  const evidence: string[] = [];

  try {
    validateExecutionPlan(bundle.pendingPreview.plan);
    evidence.push('ExecutionPlan schema passed.');
  } catch (error) {
    issues.push(`ExecutionPlan schema failed: ${getErrorMessage(error)}`);
  }

  try {
    validateInfrastructureSpec(bundle.pendingPreview.desired);
    evidence.push('InfrastructureSpec schema passed.');
  } catch (error) {
    issues.push(`InfrastructureSpec schema failed: ${getErrorMessage(error)}`);
  }

  if (!sameJson(bundle.pendingPreview.desired, bundle.pendingPreview.plan.spec)) {
    issues.push('Pending desired spec must match plan.spec.');
  } else {
    evidence.push('Pending desired spec matches plan.spec.');
  }

  if (bundle.pendingPreview.composeArtifact.previewContent !== bundle.composeYaml) {
    issues.push('Compose preview content must match the execution compose YAML.');
  } else {
    evidence.push('Compose preview content matches the execution compose YAML.');
  }

  const actualHash = createHash('sha256').update(bundle.composeYaml).digest('hex');
  if (bundle.pendingPreview.composeArtifact.previewSha256 !== actualHash) {
    issues.push('Compose preview SHA-256 must match the execution compose YAML.');
  } else {
    evidence.push('Compose preview hash matches the execution compose YAML.');
  }

  if (!bundle.dryRunPreview) {
    issues.push('Detailed dry-run preview is missing.');
  } else {
    try {
      validateDetailedDryRunPreview(bundle.dryRunPreview);
      evidence.push('Detailed dry-run preview schema passed.');
      verifyDryRunPreviewMatchesPending(bundle, issues, evidence);
    } catch (error) {
      issues.push(`Detailed dry-run preview schema failed: ${getErrorMessage(error)}`);
    }
  }

  const status = issues.length ? 'failed' : 'passed';

  return validateVerificationReport({
    status,
    scope: 'meta-preflight',
    checkedAt,
    issues,
    evidence,
    errorReason: issues.length ? 'Phase 8 meta verification failed.' : null,
    revisionHint: issues.length
      ? 'Regenerate the plan, compose preview, and dry-run preview from the same validated spec.'
      : null,
    confidence: issues.length ? 0.35 : 0.98,
  });
}

function verifyDryRunPreviewMatchesPending(
  bundle: Phase8PreviewBundle,
  issues: string[],
  evidence: string[],
): void {
  const preview = bundle.dryRunPreview;

  if (!preview) {
    return;
  }

  const spec = bundle.pendingPreview.desired;
  const expectedContainers = spec.services.reduce(
    (total, service) => total + (service.replicas ?? 1),
    0,
  );

  if (preview.projectName !== spec.projectName) {
    issues.push('Dry-run preview projectName must match the validated spec.');
  }

  if (preview.artifactTargetPath !== bundle.pendingPreview.composeArtifact.targetPath) {
    issues.push('Dry-run preview artifact target must match the compose artifact record.');
  }

  if (preview.composePreviewLineCount !== countNonEmptyLines(bundle.composeYaml)) {
    issues.push('Dry-run preview compose line count must match the rendered compose YAML.');
  }

  if (preview.totalServices !== spec.services.length) {
    issues.push('Dry-run preview service count must match the validated spec.');
  }

  if (preview.totalContainers !== expectedContainers) {
    issues.push('Dry-run preview container count must match the validated spec.');
  }

  if (!sameStringList(preview.networks, spec.networks)) {
    issues.push('Dry-run preview networks must match the validated spec.');
  }

  if (!sameStringList(preview.volumes, spec.volumes)) {
    issues.push('Dry-run preview volumes must match the validated spec.');
  }

  if (preview.schedule.projectName !== spec.projectName) {
    issues.push('Dependency schedule projectName must match the validated spec.');
  }

  if (!sameStringSet(preview.schedule.serviceStartOrder, spec.services.map((service) => service.name))) {
    issues.push('Dependency schedule serviceStartOrder must include every service once.');
  }

  for (const service of spec.services) {
    const previewService = preview.services.find((candidate) => candidate.name === service.name);

    if (!previewService) {
      issues.push(`Dry-run preview is missing service "${service.name}".`);
      continue;
    }

    if (previewService.kind !== service.kind) {
      issues.push(`Dry-run preview kind mismatch for service "${service.name}".`);
    }

    if (previewService.image !== service.image) {
      issues.push(`Dry-run preview image mismatch for service "${service.name}".`);
    }

    if (previewService.replicas !== (service.replicas ?? 1)) {
      issues.push(`Dry-run preview replica mismatch for service "${service.name}".`);
    }

    if (!sameStringList(previewService.ports, service.ports ?? [])) {
      issues.push(`Dry-run preview ports mismatch for service "${service.name}".`);
    }

    if (!sameStringList(previewService.volumes, service.volumes ?? [])) {
      issues.push(`Dry-run preview volumes mismatch for service "${service.name}".`);
    }

    if (!sameStringList(previewService.dependsOn, service.dependsOn ?? [])) {
      issues.push(`Dry-run preview dependencies mismatch for service "${service.name}".`);
    }
  }

  if (issues.length === 0) {
    evidence.push('Dry-run preview matches the validated spec, plan, compose artifact, and schedule.');
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function countNonEmptyLines(value: string): number {
  return value.trim() === '' ? 0 : value.trim().split(/\r?\n/).length;
}

function toStableId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
