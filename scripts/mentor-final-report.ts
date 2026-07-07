import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { getMetricsDir, readLlmCallRecords, readOperationRecords, sumTokenUsage } from '../src/metrics/metrics.js';
import type { OperationRecord, TokenUsage } from '../src/metrics/types.js';

export async function writeMentorFinalReport(input: {
  runId: string;
  projectName: string;
  provider: string;
  runs: number;
  notes?: string[];
}): Promise<{ summaryPath: string; latestPath: string }> {
  const metricsDir = getMetricsDir();
  const [allOperations, allCalls] = await Promise.all([readOperationRecords(), readLlmCallRecords()]);
  const operations = allOperations.filter((record) => record.runId === input.runId);
  const calls = allCalls.filter((record) => record.runId === input.runId);
  const reportDir = path.join(metricsDir, 'mentor-suite', input.runId);
  await mkdir(reportDir, { recursive: true });

  const markdown = renderReport({ ...input, operations, totalTokens: sumTokenUsage(calls.map((call) => call.usage)) });
  const summaryPath = path.join(reportDir, 'final-mentor-metrics.md');
  const latestPath = path.join(metricsDir, 'final-mentor-metrics.md');
  await writeFile(summaryPath, markdown, 'utf8');
  await writeFile(latestPath, markdown, 'utf8');
  return { summaryPath, latestPath };
}

function renderReport(input: {
  runId: string;
  projectName: string;
  provider: string;
  runs: number;
  operations: OperationRecord[];
  totalTokens: Required<TokenUsage>;
  notes?: string[];
}): string {
  const operations = input.operations;
  const scenarioIds = ['mentor-A', 'mentor-B', 'mentor-C', 'mentor-D', 'mentor-E', 'mentor-F', 'mentor-G', 'mentor-H', 'mentor-I', 'mentor-J'];
  const operationTypes = ['dry-run', 'deploy', 'status', 'drift', 'destroy', 'doctor', 'destroy-all'];
  const lines = [
    '# Final Mentor Metrics Report',
    '',
    `- Run ID: \`${input.runId}\``,
    `- Project base name: \`${input.projectName}\``,
    `- Provider: \`${input.provider}\``,
    `- Configured repeats per scenario: ${input.runs}`,
    `- Metrics records collected: ${operations.length}`,
    `- Total tokens: ${input.totalTokens.totalTokens} (${input.totalTokens.inputTokens} input / ${input.totalTokens.outputTokens} output)`,
    '',
    '## Scenario Coverage',
    '',
    '| Scenario | Operation records | Success | Avg latency ms | Avg tokens/op | LLM calls/op | Guard triggers |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];

  for (const scenarioId of scenarioIds) {
    const records = operations.filter((record) => record.scenarioId === scenarioId);
    lines.push(`| ${scenarioLabel(scenarioId)} | ${records.length} | ${successText(records)} | ${avg(records.map((record) => record.latencyMs))} | ${avg(records.map((record) => record.tokenTotals.totalTokens ?? 0))} | ${avg(records.map((record) => record.llmCallCount))} | ${records.reduce((sum, record) => sum + record.guardTriggerCount, 0)} |`);
  }

  lines.push('', '## Planner Accuracy', '');
  lines.push('Planner accuracy is measured only for LLM planning operations that emit `plannerAccuracy`: dry-run/deploy/adjust/reject-approval planning paths.');
  lines.push('', '| Scenario | Planner runs | First-pass correct | Retry/revise needed | Avg revisions | Avg clarifications |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const scenarioId of scenarioIds) {
    const plannerRecords = operations.filter((record) => record.scenarioId === scenarioId && record.plannerAccuracy);
    const firstPass = plannerRecords.filter((record) => record.plannerAccuracy?.firstPassCorrect).length;
    const retry = plannerRecords.filter((record) => (record.plannerAccuracy?.revisionCount ?? 0) > 0 || (record.plannerAccuracy?.clarificationCount ?? 0) > 0).length;
    lines.push(`| ${scenarioLabel(scenarioId)} | ${plannerRecords.length} | ${firstPass}/${plannerRecords.length || 0} | ${retry} | ${avg(plannerRecords.map((record) => record.plannerAccuracy?.revisionCount ?? 0))} | ${avg(plannerRecords.map((record) => record.plannerAccuracy?.clarificationCount ?? 0))} |`);
  }

  lines.push('', '## End-to-End Latency by Operation Type', '');
  lines.push('| Operation type | Count | Success | Avg latency ms | Min latency ms | Max latency ms |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const type of operationTypes) {
    const records = operations.filter((record) => record.operationType === type);
    lines.push(`| ${type} | ${records.length} | ${successText(records)} | ${avg(records.map((record) => record.latencyMs))} | ${min(records.map((record) => record.latencyMs))} | ${max(records.map((record) => record.latencyMs))} |`);
  }

  lines.push('', '## Token Consumption by Operation Type', '');
  lines.push('| Operation type | Count | Avg tokens/op | Avg input tokens/op | Avg output tokens/op | Total tokens |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const type of operationTypes) {
    const records = operations.filter((record) => record.operationType === type);
    lines.push(`| ${type} | ${records.length} | ${avg(records.map((record) => record.tokenTotals.totalTokens ?? 0))} | ${avg(records.map((record) => record.tokenTotals.inputTokens ?? 0))} | ${avg(records.map((record) => record.tokenTotals.outputTokens ?? 0))} | ${records.reduce((sum, record) => sum + (record.tokenTotals.totalTokens ?? 0), 0)} |`);
  }

  lines.push('', '## Closed-loop Guard Triggers', '');
  lines.push('| Group | Count | Guard triggers |');
  lines.push('|---|---:|---:|');
  for (const type of operationTypes) {
    const records = operations.filter((record) => record.operationType === type);
    lines.push(`| operation:${type} | ${records.length} | ${records.reduce((sum, record) => sum + record.guardTriggerCount, 0)} |`);
  }
  for (const scenarioId of scenarioIds) {
    const records = operations.filter((record) => record.scenarioId === scenarioId);
    lines.push(`| scenario:${scenarioLabel(scenarioId)} | ${records.length} | ${records.reduce((sum, record) => sum + record.guardTriggerCount, 0)} |`);
  }

  lines.push('', '## Notes', '');
  if (input.notes?.length) {
    for (const note of input.notes) lines.push(`- ${escapeMd(note)}`);
  } else {
    lines.push('- No additional notes.');
  }

  lines.push('', '## How to interpret this report', '');
  lines.push('- `First-pass correct` means the planner produced a valid final spec without revision/clarification.');
  lines.push('- `Retry/revise needed` counts planning runs where revision or clarification was required.');
  lines.push('- `Latency` is measured end-to-end at CLI operation level.');
  lines.push('- `Token consumption` is summed from LLM API response usage metadata.');
  lines.push('- `Guard triggers` counts closed-loop guard activity captured during real runs.');

  return lines.join('\n') + '\n';
}

function scenarioLabel(id: string): string {
  const labels: Record<string, string> = {
    'mentor-A': 'A Dry-run web stack',
    'mentor-B': 'B Deploy via Docker MCP',
    'mentor-C': 'C Reject approval',
    'mentor-D': 'D Docker/MCP doctor',
    'mentor-E': 'E Verified status',
    'mentor-F': 'F Drift detection',
    'mentor-G': 'G Sync desired from runtime',
    'mentor-H': 'H Adjust replicas',
    'mentor-I': 'I Destroy project',
    'mentor-J': 'J Destroy-all managed',
  };
  return labels[id] ?? id;
}

function successText(records: OperationRecord[]): string {
  if (records.length === 0) return '0/0';
  return `${records.filter((record) => record.success).length}/${records.length}`;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function min(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.min(...values);
}

function max(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function escapeMd(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
