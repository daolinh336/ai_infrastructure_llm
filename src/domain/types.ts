export type ProviderName = 'openai' | 'gemini' | 'ollama';

export interface CliOptions {
  dryRun: boolean;
  provider: ProviderName;
}

export interface UserCommand {
  raw: string;
}

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
  steps: PlanStep[];
}

export interface AgentObservation {
  source: string;
  message: string;
}

export interface AgentRunResult {
  plan: ExecutionPlan;
  observations: AgentObservation[];
}

export interface StateSnapshot {
  desired: InfrastructureSpec;
  actual: {
    containers: string[];
    lastObservedAt: string | null;
  };
  lastAppliedAt: string | null;
}
