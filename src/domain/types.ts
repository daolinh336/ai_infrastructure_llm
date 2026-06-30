export type ProviderName = 'openai' | 'gemini';

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

export type ProgressPhase = 'cli' | 'gate' | 'static' | 'plan' | 'acting' | 'observe' | 'execution';

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
  desiredStatus?: 'running' | 'stopped';
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

export type FindingCode =
  | 'HOST_PORT_CONFLICT'
  | 'REPLICA_PORT_BIND_CONFLICT'
  | 'CONTAINER_NAME_CONFLICT'
  | 'PROJECT_NAME_CONFLICT'
  | 'NETWORK_NAME_CONFLICT'
  | 'VOLUME_NAME_CONFLICT'
  | 'MOUNT_DENIED'
  | 'ENV_INVALID'
  | 'MISSING_CONTAINER'
  | 'CONTAINER_NOT_RUNNING'
  | 'CONTAINER_UNHEALTHY'
  | 'HEALTHCHECK_FAILED'
  | 'IMAGE_MISMATCH'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_PULL_FAILED'
  | 'PORT_MISMATCH'
  | 'NETWORK_MISMATCH'
  | 'VOLUME_MISMATCH'
  | 'DEPENDENCY_NOT_READY'
  | 'DOCKER_PERMISSION_DENIED'
  | 'MCP_TOOL_ERROR'
  | 'RUNTIME_DRIFT'
  | 'RUNTIME_OBSERVATION_UNCERTAIN'
  | 'UNKNOWN_RUNTIME_ERROR';

export type VerificationSeverity = 'info' | 'warning' | 'error' | 'blocker';

export interface SuggestedResolution {
  action: 'auto-revise' | 'ask-user' | 'repair-runtime' | 'retry-observe' | 'manual-check';
  summary: string;
  choices?: ClarificationChoice[];
}

export interface VerificationFinding {
  code: FindingCode;
  severity: VerificationSeverity;
  resourceKind: 'container' | 'service' | 'image' | 'network' | 'volume' | 'port' | 'runtime';
  resourceName: string | null;
  expected: string | null;
  actual: string | null;
  evidence: string[];
  confidence: number;
  suggestedAction: SuggestedResolution | null;
  requiresUserInput: boolean;
}

export type PlannerRevisionDecision =
  | 'auto-revised'
  | 'needs-user-input'
  | 'no-safe-resolution';

export interface VerificationReport {
  status: 'passed' | 'failed' | 'uncertain';
  scope: 'meta-preflight' | 'tool-runtime';
  checkedAt: string;
  issues: string[];
  findings?: VerificationFinding[];
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
  operationId?: string;
}

export interface ContainerCreateSpec {
  name: string;
  image: string;
  command?: string[];
  ports: string[] | undefined;
  environment: Record<string, string> | undefined;
  volumes: string[] | undefined;
  networks: string[] | undefined;
  labels?: Record<string, string>;
}

export interface DockerDeployResult {
  networksCreated: string[];
  imagesPulled: string[];
  containersStarted: Array<{ name: string; id: string }>;
  startedAt: string;
}

export interface RuntimeResourceRefs {
  projectName: string;
  operationId?: string;
  containers: string[];
  networks: string[];
  volumes: string[];
  images: string[];
}

export type DriftSeverity = 'minor' | 'major' | 'risky' | 'unknown';

export type DriftFindingKind =
  | 'missing-container'
  | 'stopped-container'
  | 'running-container'
  | 'image-mismatch'
  | 'port-mismatch'
  | 'env-mismatch'
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
  kind: 'start-container' | 'stop-container' | 'recreate-container' | 'pull-image' | 'create-network' | 'create-volume';
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

export interface UserFeedback {
  message: string;
  submittedAt: string;
}

export type PlanningUncertaintySeverity = 'info' | 'warning' | 'blocking';

export type PlanningUncertaintyField =
  | 'services[].dependsOn'
  | 'services[].ports'
  | 'services[].image'
  | 'services[].volumes'
  | 'topology';

export interface ClarificationChoice {
  id: string;
  label: string;
  description: string;
  value: string;
}

export interface PlanningUncertainty {
  id: string;
  severity: PlanningUncertaintySeverity;
  field: PlanningUncertaintyField;
  message: string;
  reason: string;
  affectedServices: string[];
  choices: ClarificationChoice[];
  allowOther: boolean;
}

export interface ClarificationAnswer {
  uncertaintyId: string;
  selectedChoiceId: string | null;
  otherText: string | null;
  submittedAt: string;
}

export interface PlanningClarificationContext {
  query: ValidatedQuery;
  spec: InfrastructureSpec;
  assumptions: string[];
  uncertainties: PlanningUncertainty[];
}

export interface RevisionObservation {
  verificationReport: VerificationReport | null;
  userFeedback: UserFeedback | null;
  driftSummary: string | null;
}

export interface RuntimeIssueReport {
  status: 'failed' | 'blocked' | 'error' | 'drift';
  phase:
    | 'pre-deploy'
    | 'deploy'
    | 'start-container'
    | 'post-deploy-verify'
    | 'observe'
    | 'cleanup';
  checkedAt: string;
  projectName: string;
  attemptIndex: number;
  desiredSpec: InfrastructureSpec;
  issues: VerificationFinding[];
  rawError?: {
    message: string;
    source: 'docker-mcp' | 'docker-engine' | 'verifier' | 'cli' | 'unknown';
    code?: string;
  };
  actualState?: RuntimeActualState | null;
  composePreview?: {
    yaml: string;
    sha256: string;
  };
  cleanup?: CleanupReport | null;
}

export type FeedbackIntentName =
  | 'change-port'
  | 'change-name'
  | 'change-replicas'
  | 'change-image'
  | 'change-env'
  | 'remove-env'
  | 'change-volume'
  | 'remove-volume'
  | 'change-dependency'
  | 'remove-dependency'
  | 'change-network'
  | 'rename-network'
  | 'set-networks'
  | 'add-service'
  | 'remove-service'
  | 'rename-service'
  | 'change-status'
  | 'change-project'
  | 'remove-exposure'
  | 'yaml-edit-intent'
  | 'retry-as-is'
  | 'cancel'
  | 'unknown';

export interface FeedbackIntent {
  source: 'user-other-feedback';
  rawText: string;
  intent: FeedbackIntentName;
  target?: {
    resourceKind?: 'project' | 'service' | 'container' | 'port' | 'image' | 'volume' | 'network' | 'environment';
    serviceSelector?: ServiceSelector;
    currentValue?: string;
  };
  desiredChange?: {
    hostPort?: number;
    containerPort?: number;
    name?: string;
    replicas?: number;
    image?: string;
    environment?: Record<string, string>;
    volumes?: string[];
    networks?: string[];
    dependencies?: string[];
    desiredStatus?: NonNullable<InfrastructureService['desiredStatus']>;
    service?: InfrastructureService;
    yamlFragment?: string;
  };
  confidence: number;
  ambiguities: string[];
  requiresUserInput: boolean;
}

export interface ServiceSelector {
  targetKind?: 'service' | 'replica-group';
  name?: string;
  nameLike?: string;
  kind?: InfrastructureService['kind'];
  imageFamily?: string;
  exposesHostPort?: boolean;
  dependsOn?: string;
  dependentOf?: string;
}

export type SpecPatch =
  | {
      op: 'set-service-replicas';
      target: ServiceSelector;
      replicas: number;
      reason: string;
    }
  | {
      op: 'replace-service-port';
      target: ServiceSelector;
      to: string;
      from?: string;
      reason: string;
    }
  | {
      op: 'add-service-port';
      target: ServiceSelector;
      port: string;
      reason: string;
    }
  | {
      op: 'remove-service-port';
      target: ServiceSelector;
      port?: string;
      reason: string;
    }
  | {
      op: 'set-service-image';
      target: ServiceSelector;
      image: string;
      reason: string;
    }
  | {
      op: 'add-service';
      service: InfrastructureService;
      reason: string;
    }
  | {
      op: 'remove-service';
      target: ServiceSelector;
      reason: string;
    }
  | {
      op: 'rename-service';
      target: ServiceSelector;
      name: string;
      reason: string;
    }
  | {
      op: 'set-service-env';
      target: ServiceSelector;
      key: string;
      value: string;
      reason: string;
    }
  | {
      op: 'remove-service-env';
      target: ServiceSelector;
      key: string;
      reason: string;
    }
  | {
      op: 'add-service-volume';
      target: ServiceSelector;
      volume: string;
      reason: string;
    }
  | {
      op: 'remove-service-volume';
      target: ServiceSelector;
      volume: string;
      reason: string;
    }
  | {
      op: 'add-service-dependency';
      target: ServiceSelector;
      dependencyName: string;
      reason: string;
    }
  | {
      op: 'remove-service-dependency';
      target: ServiceSelector;
      dependencyName: string;
      reason: string;
    }
  | {
      op: 'set-service-desired-status';
      target: ServiceSelector;
      desiredStatus: NonNullable<InfrastructureService['desiredStatus']>;
      reason: string;
    }
  | {
      op: 'set-project-name';
      name: string;
      reason: string;
    }
  | {
      op: 'rename-network';
      from?: string;
      to: string;
      reason: string;
    }
  | {
      op: 'set-networks';
      networks: string[];
      reason: string;
    };

export interface SpecPatchPlan {
  patches: SpecPatch[];
  explanation: string;
  assumptions: string[];
  ambiguities: string[];
  requiresUserInput: boolean;
  confidence: number;
}

export interface ResolvedSpecPatchResult {
  patch: SpecPatch;
  matchedServiceNames: string[];
  applied: boolean;
  blockedReason: string | null;
}

export interface PlannerRevisionRequest {
  desiredSpec: InfrastructureSpec;
  currentPlan?: ExecutionPlan;
  runtimeIssueReport?: RuntimeIssueReport;
  feedbackIntent?: FeedbackIntent | null;
  revisionObservation: RevisionObservation;
  stateSnapshot: InfrastructureStateSnapshot | null;
  resourceRefs?: RuntimeResourceRefs;
  attemptIndex: number;
}

export interface PlannerRevisionResult {
  revisedSpec: InfrastructureSpec;
  revisionSummary: string;
  assumptions: string[];
  revisionDecision?: PlannerRevisionDecision;
  clarificationContext?: PlanningUncertainty[];
  patchPlan?: SpecPatchPlan;
  patchResults?: ResolvedSpecPatchResult[];
}

export interface RevisionHistoryRecord {
  attemptIndex: number;
  revisionDecision: PlannerRevisionDecision;
  revisionSummary: string;
  findings: VerificationFinding[];
  userFeedback: UserFeedback | null;
  createdAt: string;
}

export interface AttemptScope {
  operationId: string;
  approvedActionId: string;
  projectName: string;
  attemptIndex: number;
  createdAt: string;
}

export type ApprovalChoice = 'approved' | 'rejected' | 'other';

export interface ApprovalDecision {
  choice: ApprovalChoice;
  userFeedback: UserFeedback | null;
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
  clarificationChoices?: ClarificationChoice[];
  allowOther?: boolean;
  uncertainties?: PlanningUncertainty[];
  clarificationContext?: PlanningClarificationContext;
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
  | 'runtime-adapter';

export interface RuntimeContainerObservation {
  name: string;
  image: string | null;
  status: string | null;
  ports: string[];
  environment?: Record<string, string> | null;
  healthStatus?: string | null;
  restartCount?: number | null;
  exitCode?: number | null;
  logSnippet?: string | null;
}

export interface RuntimeContainerSummary {
  name: string;
  image: string | null;
  status: string | null;
  ports: string[];
  networks: string[];
  mountDestinations: string[];
  restartPolicy: string | null;
  healthStatus: string | null;
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
  revisionHistory?: RevisionHistoryRecord[];
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
    | 'legacy-state-migrated'
    | 'approval-rejected'
    | 'approved-action-created'
    | 'compose-artifact-written'
    | 'verified-runtime-saved'
    | 'repair-rejected'
    | 'drift-observed'
    | 'destroy-all-executed';
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
