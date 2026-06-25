export type ProviderName = 'stub' | 'openai' | 'gemini';

export type LlmPurpose = 'auxiliary' | 'react';

export type JsonSchema = Record<string, unknown>;

export interface CliOptions {
  dryRun: boolean;
  provider: ProviderName;
}

export interface UserCommand {
  raw: string;
}

export type InfrastructureIntent = 'create' | 'update' | 'status' | 'destroy' | 'drift';

export interface IntentClassification {
  scope: 'infrastructure' | 'out-of-scope' | 'unsafe';
  intent: InfrastructureIntent | null;
  reason: string;
}

export interface DraftServiceQuery {
  name: string | null;
  image: string | null;
  port: number | null;
  replicas: number | null;
  requestedMounts: string[];
  privileged: boolean | null;
  networkMode: string | null;
  pidMode: string | null;
  ipcMode: string | null;
  cpu: number | null;
  memoryGb: number | null;
}

export interface DraftQuery {
  raw: string;
  normalizedPrompt: string;
  intent: InfrastructureIntent;
  services: DraftServiceQuery[];
  destructive: boolean;
  missingInformation: string[];
}

export interface StaticResourceEstimate {
  totalContainers: number;
  maxCpu: number | null;
  maxMemoryGb: number | null;
}

export interface ValidatedQuery {
  raw: string;
  normalizedPrompt: string;
  intent: InfrastructureIntent;
  draft: DraftQuery;
  riskFlags: string[];
  securityFindings: string[];
  resourceEstimate: StaticResourceEstimate;
  clarificationRequired: boolean;
  clarificationQuestion: string | null;
}

export interface RequestMetadata {
  raw: string;
  normalizedPrompt: string;
  intent: InfrastructureIntent;
}

export interface StaticGatewayMetrics {
  intentAccepted: number;
  intentRejected: number;
  unsafeRejected: number;
  clarificationRequired: number;
  schemaValidationPassed: number;
  schemaValidationFailed: number;
  securityBlocked: number;
  resourceLimitBlocked: number;
  imageWhitelistBlocked: number;
  runtimeCallsDuringStaticValidation: number;
  reactInvocationsAfterStaticValidationFailure: number;
}

export type ProgressPhase = 'cli' | 'static' | 'plan' | 'acting' | 'observe' | 'execution';

export interface ProgressEvent {
  phase: ProgressPhase;
  message: string;
  toolName?: string;
}

export type ProgressReporter = (event: ProgressEvent) => void;

export interface InfrastructureService {
  kind: 'reverse-proxy' | 'backend' | 'database';
  name: string;
  image: string;
  replicas?: number;
  ports?: string[];
  environment?: Record<string, string>;
  dependsOn?: string[];
  volumes?: string[];
}

export interface InfrastructureSpec {
  projectName: string;
  services: InfrastructureService[];
  networks: string[];
  volumes: string[];
}

export interface PlanStep {
  id: string;
  description: string;
  action: 'generate-compose' | 'write-state' | 'deploy-compose' | 'inspect-drift';
  dependsOn?: string[];
}

export interface ExecutionPlan {
  summary: string;
  spec: InfrastructureSpec;
  assumptions: string[];
  steps: PlanStep[];
}

export type ExecutionScheduleStepKind =
  | 'create-resource'
  | 'start-service'
  | 'wait-until-ready';

export type ExecutionScheduleResourceType = 'network' | 'volume' | 'service';

export interface DependencyGraphEntry {
  serviceName: string;
  dependsOn: string[];
  dependents: string[];
}

export interface ExecutionScheduleStep {
  order: number;
  level: number;
  levelName: string;
  kind: ExecutionScheduleStepKind;
  resourceType: ExecutionScheduleResourceType;
  resourceName: string;
  action: string;
  dependsOn: string[];
  dependents: string[];
  waitCondition: string | null;
  readinessEnforced: boolean;
  serviceKind?: InfrastructureService['kind'];
  image?: string;
  replicas?: number;
  ports?: string[];
  volumes?: string[];
}

export interface DependencyAwareExecutionSchedule {
  projectName: string;
  steps: ExecutionScheduleStep[];
  dependencyGraph: DependencyGraphEntry[];
  serviceStartOrder: string[];
  destroyOrder: string[];
  warnings: string[];
}

export interface DryRunServiceImpact {
  name: string;
  kind: InfrastructureService['kind'];
  image: string;
  replicas: number;
  ports: string[];
  volumes: string[];
  environmentKeys: string[];
  environment: Record<string, string>;
  dependsOn: string[];
  dependents: string[];
  waitCondition: string;
  readinessEnforced: boolean;
  warnings: string[];
}

export interface DryRunPolicyFinding {
  severity: 'info' | 'warning' | 'blocker';
  code: string;
  message: string;
  resourceName: string | null;
  resourceType: ExecutionScheduleResourceType | null;
}

export interface DetailedDryRunPreview {
  projectName: string;
  artifactTargetPath: string;
  artifactWritten: false;
  stateSaved: false;
  dockerCalled: boolean;
  mcpCalled: boolean;
  composePreviewLineCount: number;
  totalServices: number;
  totalContainers: number;
  networks: string[];
  volumes: string[];
  services: DryRunServiceImpact[];
  schedule: DependencyAwareExecutionSchedule;
  policyFindings: DryRunPolicyFinding[];
  actionsNotPerformed: string[];
}

export type ActionRisk =
  | 'read-only'
  | 'state-write'
  | 'artifact-write'
  | 'runtime-create'
  | 'runtime-destroy';

export interface ActionClassification {
  capability: 'compose-artifact-write';
  risk: ActionRisk;
  summary: string;
  requiresApproval: boolean;
  mutatesRuntime: boolean;
  writesArtifact: boolean;
  writesState: boolean;
  callsDocker: boolean;
  callsMcp: boolean;
}

export interface VerificationReport {
  status: 'passed' | 'failed' | 'uncertain';
  scope: 'meta-preflight' | 'tool-runtime';
  checkedAt: string;
  issues: string[];
  evidence: string[];
  errorReason: string | null;
  revisionHint: string | null;
  confidence: number;
}

export interface PreflightReport {
  status: 'passed' | 'failed';
  checkedAt: string;
  issues: string[];
  evidence: string[];
  policyFindings: DryRunPolicyFinding[];
  verificationReport: VerificationReport;
}

export interface ApprovalRequest {
  id: string;
  requestedAt: string;
  action: 'write-compose-artifact';
  request: RequestMetadata;
  planSummary: string;
  classification: ActionClassification;
  artifactTargetPath: string;
  composePreviewSha256: string;
  totalContainers: number;
  policyFindings: DryRunPolicyFinding[];
  preflight: PreflightReport;
}

export interface ApprovalResult {
  id: string;
  requestId: string;
  decision: 'approved' | 'rejected';
  respondedAt: string;
  approvedBy: 'cli-user';
  reason: string | null;
}

export interface ApprovalMarker {
  type: 'phase8-human-approval';
  approvalId: string;
  approvedAt: string;
  approvedBy: 'cli-user';
}

export interface ApprovedAction {
  id: string;
  action: 'write-compose-artifact';
  request: RequestMetadata;
  classification: ActionClassification;
  approval: ApprovalResult;
  approvalMarker: ApprovalMarker;
  validatedSpec: InfrastructureSpec;
  composeArtifact: ComposeArtifactRecord;
  dependencySchedule: DependencyAwareExecutionSchedule;
  preflight: PreflightReport;
  policyFindings: DryRunPolicyFinding[];
  dockerCalled: boolean;
  mcpCalled: boolean;
  runtimeMutation: boolean;
}

export interface ContainerCreateSpec {
  name: string;
  image: string;
  ports: string[] | undefined;
  environment: Record<string, string> | undefined;
  volumes: string[] | undefined;
  networks: string[] | undefined;
}

export interface DockerDeployResult {
  networksCreated: string[];
  imagesPulled: string[];
  containersStarted: Array<{ name: string; id: string }>;
  startedAt: string;
}

export interface RuntimeResourceRefs {
  projectName: string;
  containers: string[];
  networks: string[];
  volumes: string[];
  images: string[];
}

export type DriftSeverity = 'minor' | 'major' | 'risky' | 'unknown';

export type DriftFindingKind =
  | 'missing-container'
  | 'stopped-container'
  | 'image-mismatch'
  | 'port-mismatch'
  | 'missing-network'
  | 'missing-volume'
  | 'missing-image'
  | 'extra-project-resource'
  | 'uncertain-runtime-evidence';

export interface DriftFinding {
  kind: DriftFindingKind;
  severity: DriftSeverity;
  resourceType: 'container' | 'network' | 'volume' | 'image' | 'runtime';
  resourceName: string;
  message: string;
  expected: string | null;
  actual: string | null;
  autoRepairable: boolean;
}

export interface DriftReport {
  status: 'none' | 'drifted' | 'uncertain';
  checkedAt: string;
  projectName: string;
  findings: DriftFinding[];
  summary: string;
}

export interface RepairAction {
  kind: 'start-container' | 'recreate-container' | 'pull-image' | 'create-network' | 'create-volume';
  resourceName: string;
  risk: 'safe' | 'approval-required';
  reason: string;
}

export interface RepairPlan {
  projectName: string;
  findings: DriftFinding[];
  actions: RepairAction[];
  requiresApproval: boolean;
  autoRepairable: boolean;
}

export interface RepairReport {
  status: 'applied' | 'rejected' | 'failed' | 'partial';
  actionsAttempted: RepairAction[];
  actionsSucceeded: RepairAction[];
  actionsFailed: Array<{ action: RepairAction; error: string }>;
}

export interface CleanupReport {
  trigger: 'deploy-failed' | 'repair-failed';
  attempted: string[];
  succeeded: string[];
  failed: Array<{ resource: string; error: string }>;
  leftovers: string[];
}

export class DockerMutationSafetyError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message?: string) {
    super(message ?? `Docker MCP mutation '${toolName}' requires allowMutations=true`);
    this.name = 'DockerMutationSafetyError';
    this.toolName = toolName;
  }
}

export interface AgentObservation {
  source: string;
  message: string;
}

export interface ReActReasoningOutput {
  summary: string;
  nextAction: 'continue_planning' | 'ask_user' | 'stop';
  rationale: string;
  safetyNotes: string[];
}

export interface ReActStep {
  id: string;
  phase: 'reason' | 'act' | 'observe';
  message: string;
  toolName: string | null;
}

export interface AgentToolResult {
  ok: boolean;
  observation: string;
  data: unknown;
}

export interface AgentTool {
  name: string;
  description: string;
  invoke(input: unknown): Promise<AgentToolResult>;
}

export interface GuardToolCallCount {
  tool: string;
  count: number;
  capped: boolean;
}

export interface GuardDeltaEntry {
  iteration: number;
  hasDelta: boolean;
  specHash: string;
  issueCount: number;
  stepHash: string;
}

export interface GuardTelemetry {
  iterations: number;
  outcome: 'converged' | 'blocked';
  blockReason: string | null;
  perToolCounts: GuardToolCallCount[];
  deltaHistory: GuardDeltaEntry[];
  logFilePath: string | null;
}

export interface PlannedAgentRunResult {
  status: 'planned';
  request: RequestMetadata;
  plan: ExecutionPlan;
  observations: AgentObservation[];
  trace?: ReActStep[];
  guardTelemetry?: GuardTelemetry;
}

export interface ClarificationAgentRunResult {
  status: 'clarification';
  clarificationQuestion: string;
  observations: AgentObservation[];
  trace?: ReActStep[];
  guardTelemetry?: GuardTelemetry;
}

export interface BlockedAgentRunResult {
  status: 'blocked';
  blockReason: string;
  iterations: number;
  guardTelemetry: GuardTelemetry;
  observations: AgentObservation[];
  trace?: ReActStep[];
}

export type AgentRunResult =
  | PlannedAgentRunResult
  | ClarificationAgentRunResult
  | BlockedAgentRunResult;

export type RuntimeObservationSource =
  | 'not-observed'
  | 'mcp-readonly'
  | 'runtime-adapter'
  | 'legacy-placeholder';

export interface RuntimeContainerObservation {
  name: string;
  image: string | null;
  status: string | null;
  ports: string[];
}

export interface RuntimeNamedResourceObservation {
  name: string;
  status: string | null;
}

export interface RuntimeImageObservation {
  reference: string;
  id: string | null;
  status: string | null;
}

export interface RuntimeActualState {
  source: RuntimeObservationSource;
  containers: RuntimeContainerObservation[];
  networks: RuntimeNamedResourceObservation[];
  volumes: RuntimeNamedResourceObservation[];
  images: RuntimeImageObservation[];
  lastObservedAt: string | null;
}

export interface ComposeArtifactRecord {
  targetPath: string;
  previewContent: string;
  previewSha256: string;
  lineCount: number;
  written: boolean;
  writtenAt: string | null;
}

export interface VerificationState {
  status: 'not-run' | 'passed' | 'failed' | 'uncertain';
  scope: 'preview' | 'runtime';
  checkedAt: string | null;
  summary: string;
  issues: string[];
  evidence: string[];
}

export interface PendingPreviewState {
  id: string;
  request: RequestMetadata;
  desired: InfrastructureSpec;
  plan: ExecutionPlan;
  composeArtifact: ComposeArtifactRecord;
  dryRunPreview: DetailedDryRunPreview | null;
  observations: AgentObservation[];
  trace: ReActStep[];
  verification: VerificationState;
  createdAt: string;
  acceptedAt: string | null;
  approval?: ApprovalResult | null;
  approvedAction?: ApprovedAction | null;
}

export interface VerifiedRuntimeSnapshot {
  id: string;
  request: RequestMetadata;
  desired: InfrastructureSpec;
  composeArtifact: ComposeArtifactRecord;
  actual: RuntimeActualState;
  verification: VerificationState;
  verificationReport?: VerificationReport;
  driftReport?: DriftReport | null;
  repairReport?: RepairReport | null;
  cleanupReport?: CleanupReport | null;
  resourceRefs?: RuntimeResourceRefs;
  observedAt?: string;
  operation?: 'deploy' | 'repair' | 'destroy' | 'sync';
  approvedAt: string | null;
  appliedAt: string | null;
  savedAt: string;
}

export interface StateOperationRecord {
  id: string;
  type:
    | 'pending-preview-saved'
    | 'approval-rejected'
    | 'approved-action-created'
    | 'compose-artifact-written'
    | 'verified-runtime-saved'
    | 'legacy-state-migrated'
    | 'repair-rejected'
    | 'drift-observed';
  projectName: string;
  request: RequestMetadata | null;
  summary: string;
  createdAt: string;
}

export interface InfrastructureStateSnapshot {
  schemaVersion: 1;
  current: VerifiedRuntimeSnapshot | null;
  pendingPreview: PendingPreviewState | null;
  history: StateOperationRecord[];
}

export interface LegacyStateSnapshot {
  desired: InfrastructureSpec;
  actual: {
    containers: string[];
    lastObservedAt: string | null;
  };
  desiredStateSavedAt?: string | null;
  lastAppliedAt: string | null;
}

export interface TopologyIssue {
  severity: 'error' | 'warning';
  message: string;
  affectedServices: string[];
  suggestion: string;
}

export interface TopologyValidationResult {
  valid: boolean;
  issues: TopologyIssue[];
}

