import type { GuardTelemetry, LlmPurpose } from '../domain/types.js';

export interface TokenUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface MetricsContext {
  enabled: boolean;
  metricsDir: string;
  operationId: string | null;
  scenarioId: string | null;
  runId: string | null;
  operationType: string | null;
  projectName: string | null;
  provider: string | null;
}

export interface LlmCallRecord {
  timestamp: string;
  operationId: string | null;
  scenarioId: string | null;
  runId: string | null;
  provider: string;
  model: string | null;
  purpose: LlmPurpose | null;
  schemaName: string | null;
  structured: boolean;
  latencyMs: number;
  usage?: TokenUsage;
  success: boolean;
  errorMessage: string | null;
  reason: string;
  contextFields: string[];
}

export interface PlannerAccuracyMetrics {
  firstPassCorrect: boolean;
  revisionCount: number;
  clarificationCount: number;
  finalStatus: string;
}

export interface OperationRecord {
  timestamp: string;
  operationId: string;
  scenarioId: string | null;
  runId: string | null;
  operationType: string;
  projectName: string | null;
  provider: string | null;
  latencyMs: number;
  success: boolean;
  errorMessage: string | null;
  tokenTotals: Required<TokenUsage>;
  llmCallCount: number;
  plannerAccuracy?: PlannerAccuracyMetrics;
  guardTelemetry?: GuardTelemetry;
  guardTriggerCount: number;
}

export interface ActiveOperationMetrics {
  enabled: boolean;
  operationId: string;
  scenarioId: string | null;
  runId: string | null;
  operationType: string;
  projectName: string | null;
  provider: string | null;
  startedAt: number;
  metricsDir: string;
}
