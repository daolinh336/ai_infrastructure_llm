export type ProviderName = 'stub' | 'openai' | 'gemini' | 'ollama';

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

export interface PlannedAgentRunResult {
  status: 'planned';
  plan: ExecutionPlan;
  observations: AgentObservation[];
  trace?: ReActStep[];
}

export interface ClarificationAgentRunResult {
  status: 'clarification';
  clarificationQuestion: string;
  observations: AgentObservation[];
  trace?: ReActStep[];
}

export type AgentRunResult = PlannedAgentRunResult | ClarificationAgentRunResult;

export interface StateSnapshot {
  desired: InfrastructureSpec;
  actual: {
    containers: string[];
    lastObservedAt: string | null;
  };
  desiredStateSavedAt?: string | null;
  lastAppliedAt: string | null;
}
