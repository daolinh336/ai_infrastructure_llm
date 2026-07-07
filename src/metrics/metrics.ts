import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GuardTelemetry } from '../domain/types.js';
import type {
  ActiveOperationMetrics,
  LlmCallRecord,
  MetricsContext,
  OperationRecord,
  PlannerAccuracyMetrics,
  TokenUsage,
} from './types.js';

export function isMetricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.INFRA_METRICS?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function getMetricsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.INFRA_METRICS_DIR?.trim() || path.join('state', 'metrics'));
}

export function getMetricsContext(env: NodeJS.ProcessEnv = process.env): MetricsContext {
  return {
    enabled: isMetricsEnabled(env),
    metricsDir: getMetricsDir(env),
    operationId: emptyToNull(env.INFRA_METRICS_OPERATION_ID),
    scenarioId: emptyToNull(env.INFRA_METRICS_SCENARIO_ID),
    runId: emptyToNull(env.INFRA_METRICS_RUN_ID),
    operationType: emptyToNull(env.INFRA_METRICS_OPERATION_TYPE),
    projectName: emptyToNull(env.INFRA_METRICS_PROJECT_NAME),
    provider: emptyToNull(env.INFRA_METRICS_PROVIDER),
  };
}

export function startOperationMetrics(input: {
  operationType: string;
  projectName?: string | null;
  provider?: string | null;
  scenarioId?: string | null;
  runId?: string | null;
  operationId?: string | null;
  env?: NodeJS.ProcessEnv;
}): ActiveOperationMetrics {
  const env = input.env ?? process.env;
  const operationId = input.operationId ?? emptyToNull(env.INFRA_METRICS_OPERATION_ID) ?? randomUUID();
  const scenarioId = input.scenarioId ?? emptyToNull(env.INFRA_METRICS_SCENARIO_ID);
  const runId = input.runId ?? emptyToNull(env.INFRA_METRICS_RUN_ID);
  const projectName = input.projectName ?? emptyToNull(env.INFRA_METRICS_PROJECT_NAME);
  const provider = input.provider ?? emptyToNull(env.INFRA_METRICS_PROVIDER);
  const enabled = isMetricsEnabled(env);

  if (enabled) {
    env.INFRA_METRICS_OPERATION_ID = operationId;
    env.INFRA_METRICS_OPERATION_TYPE = input.operationType;
    if (scenarioId) env.INFRA_METRICS_SCENARIO_ID = scenarioId;
    if (runId) env.INFRA_METRICS_RUN_ID = runId;
    if (projectName) env.INFRA_METRICS_PROJECT_NAME = projectName;
    if (provider) env.INFRA_METRICS_PROVIDER = provider;
  }

  return {
    enabled,
    operationId,
    scenarioId,
    runId,
    operationType: input.operationType,
    projectName,
    provider,
    startedAt: performance.now(),
    metricsDir: getMetricsDir(env),
  };
}

export async function finishOperationMetrics(
  active: ActiveOperationMetrics,
  result: {
    success: boolean;
    errorMessage?: string | null;
    plannerAccuracy?: PlannerAccuracyMetrics;
    guardTelemetry?: GuardTelemetry;
  },
): Promise<void> {
  if (!active.enabled) return;
  const calls = await readLlmCallRecords(active.metricsDir);
  const matchingCalls = calls.filter((call) => call.operationId === active.operationId);
  const record: OperationRecord = {
    timestamp: new Date().toISOString(),
    operationId: active.operationId,
    scenarioId: active.scenarioId,
    runId: active.runId,
    operationType: active.operationType,
    projectName: active.projectName,
    provider: active.provider,
    latencyMs: Math.round(performance.now() - active.startedAt),
    success: result.success,
    errorMessage: result.errorMessage ?? null,
    tokenTotals: sumTokenUsage(matchingCalls.map((call) => call.usage)),
    llmCallCount: matchingCalls.length,
    ...(result.plannerAccuracy ? { plannerAccuracy: result.plannerAccuracy } : {}),
    ...(result.guardTelemetry ? { guardTelemetry: result.guardTelemetry } : {}),
    guardTriggerCount: getGuardTriggerCount(result.guardTelemetry),
  };
  await appendJsonLine(path.join(active.metricsDir, 'operations.jsonl'), record);
}

export async function recordLlmCall(record: Omit<LlmCallRecord, 'timestamp' | 'operationId' | 'scenarioId' | 'runId'>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const context = getMetricsContext(env);
  if (!context.enabled) return;
  await appendJsonLine(path.join(context.metricsDir, 'llm-calls.jsonl'), {
    timestamp: new Date().toISOString(),
    operationId: context.operationId,
    scenarioId: context.scenarioId,
    runId: context.runId,
    ...record,
  });
}

export function describeLlmCall(schemaName: string | null, structured: boolean): { reason: string; contextFields: string[] } {
  switch (schemaName) {
    case 'intent_classification':
      return { reason: 'Gate the raw user request before infrastructure planning starts.', contextFields: ['rawPrompt'] };
    case 'draft_query':
      return { reason: 'Parse the accepted prompt into a DraftQuery that deterministic validators can check.', contextFields: ['rawPrompt', 'intent'] };
    case 'react_reasoning_output':
      return { reason: 'Produce structured ReAct reasoning about topology, dependencies, assumptions, and risks before internal tools build the spec.', contextFields: ['validatedQuery', 'draftServices', 'riskFlags', 'securityFindings', 'resourceEstimate'] };
    case 'feedback_intent':
      return { reason: 'Classify free-form user feedback into a typed revision intent without mutating the spec directly.', contextFields: ['projectName', 'serviceCatalog', 'runtimeIssueReport', 'runtimeRefs', 'issues', 'findings'] };
    case 'spec_patch_plan':
      return { reason: 'Convert validated feedback or verifier observations into typed InfrastructureSpec patches.', contextFields: ['projectName', 'logicalServiceCatalog', 'physicalServiceCatalog', 'verifierObservation', 'services', 'networks', 'volumes', 'issues', 'findings'] };
    default:
      return { reason: structured ? 'Request structured model output for an agent or gateway step.' : 'Request unstructured model output.', contextFields: structured ? ['schemaName', 'purpose'] : ['system', 'user'] };
  }
}

export async function writeMetricsReports(metricsDir: string = getMetricsDir()): Promise<{ summaryPath: string; llmReportPath: string }> {
  const [operations, calls] = await Promise.all([readOperationRecords(metricsDir), readLlmCallRecords(metricsDir)]);
  const summaryPath = path.join(metricsDir, 'demo-summary.md');
  const llmReportPath = path.join(metricsDir, 'llm-call-report.md');
  await mkdir(metricsDir, { recursive: true });
  await writeFile(summaryPath, renderDemoSummary(operations), 'utf8');
  await writeFile(llmReportPath, renderLlmCallReport(calls), 'utf8');
  return { summaryPath, llmReportPath };
}

export async function readLlmCallRecords(metricsDir: string = getMetricsDir()): Promise<LlmCallRecord[]> {
  return readJsonLines<LlmCallRecord>(path.join(metricsDir, 'llm-calls.jsonl'));
}

export async function readOperationRecords(metricsDir: string = getMetricsDir()): Promise<OperationRecord[]> {
  return readJsonLines<OperationRecord>(path.join(metricsDir, 'operations.jsonl'));
}

export function sumTokenUsage(usages: Array<TokenUsage | undefined>): Required<TokenUsage> {
  return usages.reduce<Required<TokenUsage>>(
    (total, usage) => ({
      inputTokens: (total.inputTokens ?? 0) + (usage?.inputTokens ?? 0),
      outputTokens: (total.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
      totalTokens: (total.totalTokens ?? 0) + (usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))),
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

export function getGuardTriggerCount(telemetry: GuardTelemetry | undefined): number {
  if (!telemetry) return 0;
  return telemetry.iterations + telemetry.perToolCounts.reduce((sum, entry) => sum + entry.count, 0);
}

function renderDemoSummary(operations: OperationRecord[]): string {
  const groups = groupBy(operations, (operation) => operation.scenarioId ?? 'manual');
  const lines = [
    '# Demo Metrics Summary',
    '',
    '| Scenario | Runs | First-pass correct | Retry/revise | Avg dry-run ms | Avg deploy ms | Avg status ms | Avg drift ms | Avg destroy ms | Avg tokens/op | Guard triggers |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [scenario, records] of groups.entries()) {
    const dryRuns = records.filter((record) => record.operationType === 'dry-run');
    const denominator = dryRuns.length || records.length;
    lines.push(`| ${scenario} | ${new Set(records.map((record) => record.runId ?? record.operationId)).size} | ${dryRuns.filter((record) => record.plannerAccuracy?.firstPassCorrect).length}/${denominator} | ${dryRuns.filter((record) => (record.plannerAccuracy?.revisionCount ?? 0) > 0 || (record.plannerAccuracy?.clarificationCount ?? 0) > 0).length} | ${avgLatency(records, 'dry-run')} | ${avgLatency(records, 'deploy')} | ${avgLatency(records, 'status')} | ${avgLatency(records, 'drift')} | ${avgLatency(records, 'destroy')} | ${avg(records.map((record) => record.tokenTotals.totalTokens ?? 0))} | ${records.reduce((sum, record) => sum + record.guardTriggerCount, 0)} |`);
  }
  if (operations.length === 0) lines.push('| _No metrics yet_ | 0 | 0/0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
  return lines.join('\n') + '\n';
}

function renderLlmCallReport(calls: LlmCallRecord[]): string {
  const lines = [
    '# LLM Call Trace Report',
    '',
    'Normal create-plan path is expected to call LLM 3 times when no clarification or revision is needed: intent_classification, draft_query, and react_reasoning_output.',
    'Status, drift, and destroy do not call LLM by default; revision/adjust/repair paths may add feedback_intent and spec_patch_plan calls.',
    '',
    '| Operation | Scenario | Run | Schema | Reason | Context Fields | Success | Latency ms | Tokens |',
    '|---|---|---|---|---|---|---:|---:|---:|',
  ];
  for (const call of calls) {
    lines.push(`| ${call.operationId ?? 'none'} | ${call.scenarioId ?? 'manual'} | ${call.runId ?? 'manual'} | ${call.schemaName ?? 'unstructured'} | ${escapeMd(call.reason)} | ${escapeMd(call.contextFields.join(', '))} | ${call.success ? '1' : '0'} | ${call.latencyMs} | ${call.usage?.totalTokens ?? 0} |`);
  }
  if (calls.length === 0) lines.push('| _No LLM calls yet_ | manual | manual | none | Metrics have not been collected. | none | 0 | 0 | 0 |');
  return lines.join('\n') + '\n';
}

function avgLatency(records: OperationRecord[], operationType: string): number {
  return avg(records.filter((record) => record.operationType === operationType).map((record) => record.latencyMs));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = result.get(key) ?? [];
    group.push(item);
    result.set(key, group);
  }
  return result;
}

async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(value) + '\n', 'utf8');
}

async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const text = await readFile(filePath, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function escapeMd(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
