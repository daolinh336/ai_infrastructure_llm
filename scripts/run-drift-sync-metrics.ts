import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getMetricsDir, readLlmCallRecords, readOperationRecords, sumTokenUsage } from '../src/metrics/metrics.js';
import type { LlmCallRecord, OperationRecord, TokenUsage } from '../src/metrics/types.js';
import { writeMentorFinalReport } from './mentor-final-report.js';

interface DriftStepResult {
  id: 'F' | 'G';
  title: string;
  status: 'passed' | 'failed';
  operationType: 'drift' | 'sync';
  exitCode: number | null;
  latencyMs: number;
  command: string;
  reason: string | null;
  logPath: string;
  operationMetrics: OperationRecord[];
  llmCalls: LlmCallRecord[];
  tokenTotals: Required<TokenUsage>;
}

const args = process.argv.slice(2);
const projectName = normalizeProjectName(readStringArg('--prjName', 'web-stack'));
const provider = readStringArg('--provider', process.env.INFRA_AGENT_PROVIDER ?? 'openai');
const runId = readStringArg('--run-id', `mentor-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const runs = readNumberArg('--runs', 3);
const autoDrift = args.includes('--auto-drift');
const pauseBeforeCheck = args.includes('--pause');
const metricsDir = getMetricsDir();
const reportDir = path.join(metricsDir, 'drift-sync', runId);

await mkdir(reportDir, { recursive: true });
console.log(`[drift-sync] runId=${runId}`);
console.log(`[drift-sync] project=${projectName}`);
console.log(`[drift-sync] provider=${provider}`);
console.log('[drift-sync] Precondition: deploy the project and create drift manually before running this script.');
console.log('[drift-sync] Default behavior: no deploy and no auto-drift; only detect F then sync G.');

if (autoDrift) {
  await induceExternalDrift(projectName);
} else if (pauseBeforeCheck) {
  await pauseForManualDrift(projectName);
}

const results: DriftStepResult[] = [];
results.push(await runScenarioF());

console.log('\n[drift-sync] Scenario F finished. Running scenario G sync automatically.');
results.push(await runScenarioG());
const reportPaths = await writeReports(results);
const finalReport = await writeMentorFinalReport({
  runId,
  projectName,
  provider,
  runs,
  notes: [
    'F/G runner executed after the user manually deployed the project and manually introduced runtime drift.',
    autoDrift ? 'auto-drift option was used.' : pauseBeforeCheck ? 'pause option was used before drift check.' : 'pre-created external drift mode was used.',
  ],
});
console.log(`\nDrift/sync summary: ${reportPaths.summaryPath}`);
console.log(`Drift/sync JSON: ${reportPaths.jsonPath}`);
console.log(`Final mentor report: ${finalReport.summaryPath}`);
console.log(`Latest mentor report: ${finalReport.latestPath}`);
console.log(`Full logs: ${reportDir}`);

async function runScenarioF(): Promise<DriftStepResult> {
  return runCliStep({
    id: 'F',
    title: 'Drift outside the system',
    operationType: 'drift',
    args: ['status', '--prjName', projectName, '--drift', '--repair'],
    input: 'n\n',
    passPatterns: [/drift|missing|mismatch|repair|Choose drift resolution/i, /Repair rejected|No Docker mutation|No drift detected/i],
  });
}

async function runScenarioG(): Promise<DriftStepResult> {
  return runCliStep({
    id: 'G',
    title: 'Sync desired state from actual runtime',
    operationType: 'sync',
    args: ['status', '--prjName', projectName, '--drift', '--repair'],
    input: 's\n',
    passPatterns: [/sync|Docker -> SQLite|desired state|No drift detected/i, /SQLite|snapshot|state|nothing to repair/i],
  });
}

async function runCliStep(step: {
  id: 'F' | 'G';
  title: string;
  operationType: 'drift' | 'sync';
  args: string[];
  input: string;
  passPatterns: RegExp[];
}): Promise<DriftStepResult> {
  const operationId = randomUUID();
  const scenarioId = `mentor-${step.id}`;
  const logPath = path.join(reportDir, `${step.id}-${slug(step.title)}.log`);
  const command = `${process.execPath} ./node_modules/tsx/dist/cli.mjs src/cli/index.ts ${step.args.map(shellQuote).join(' ')}`;
  console.log(`\n[${step.id}] ${step.title}`);
  console.log(`[${step.id}] ${command}`);

  const started = performance.now();
  const childResult = await runCli(step.args, {
    input: step.input,
    timeoutMs: 5 * 60_000,
    operationId,
    scenarioId,
    operationType: step.operationType,
    logPath,
  });
  const latencyMs = Math.round(performance.now() - started);
  const patternsOk = step.passPatterns.every((pattern) => pattern.test(childResult.output));
  const status = childResult.exitCode === 0 && patternsOk ? 'passed' : 'failed';
  const reason = status === 'passed'
    ? null
    : [
        childResult.exitCode === 0 ? null : `exitCode=${childResult.exitCode}`,
        patternsOk ? null : 'expected drift/sync output markers were not all found',
        childResult.timedOut ? 'timed out' : null,
      ].filter(Boolean).join('; ');
  const { operationMetrics, llmCalls } = await collectStepMetrics(scenarioId, operationId);
  const result: DriftStepResult = {
    id: step.id,
    title: step.title,
    status,
    operationType: step.operationType,
    exitCode: childResult.exitCode,
    latencyMs,
    command,
    reason,
    logPath,
    operationMetrics,
    llmCalls,
    tokenTotals: sumTokenUsage(llmCalls.map((call) => call.usage)),
  };
  console.log(`[${step.id}] ${result.status.toUpperCase()} (${latencyMs} ms)${reason ? ` - ${reason}` : ''}`);
  return result;
}

async function runCli(cliArgs: string[], options: {
  input: string;
  timeoutMs: number;
  operationId: string;
  scenarioId: string;
  operationType: string;
  logPath: string;
}): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ['./node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', ...cliArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        INFRA_METRICS: '1',
        INFRA_METRICS_OPERATION_ID: options.operationId,
        INFRA_METRICS_SCENARIO_ID: options.scenarioId,
        INFRA_METRICS_RUN_ID: runId,
        INFRA_METRICS_OPERATION_TYPE: options.operationType,
        INFRA_METRICS_PROJECT_NAME: projectName,
        INFRA_METRICS_PROVIDER: provider,
        INFRA_AGENT_PROVIDER: provider,
      },
    });

    let text = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      const value = chunk.toString();
      text += value;
      process.stdout.write(value);
    });
    child.stderr.on('data', (chunk) => {
      const value = chunk.toString();
      text += value;
      process.stderr.write(value);
    });
    child.on('error', (error) => {
      text += `\n[spawn error] ${error.message}\n`;
    });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      await writeFile(options.logPath, text, 'utf8');
      resolve({ exitCode: code, output: text, timedOut });
    });

    setTimeout(() => {
      child.stdin.write(options.input);
      child.stdin.end();
    }, 500);
  });
}

async function induceExternalDrift(project: string): Promise<void> {
  const candidates = [
    `${project}-backend-1`,
    `${project}-node-backend-1`,
    `${project}-node-1`,
    `${project}-app-1`,
    `${project}-backend`,
    `${project}-node-backend`,
    `${project}-node`,
    `${project}-app`,
  ];
  console.log(`[drift-sync] Auto drift: docker rm -f ${candidates.join(' ')}`);
  await new Promise<void>((resolve) => {
    const child = spawn('docker', ['rm', '-f', ...candidates], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', () => resolve());
    child.on('error', (error) => {
      console.log(`[drift-sync] Auto drift failed to start docker CLI: ${error.message}`);
      resolve();
    });
  });
}

async function pauseForManualDrift(project: string): Promise<void> {
  console.log('\n[manual drift step]');
  console.log('Create drift now in another terminal, for example remove one backend container:');
  console.log(`  docker rm -f ${project}-node-backend-1`);
  console.log('Other likely names if planner used a different service name:');
  console.log(`  docker rm -f ${project}-backend-1 ${project}-node-1 ${project}-app-1`);
  await waitForEnter('After creating drift, press Enter to run scenario F...');
}

async function waitForEnter(message: string): Promise<void> {
  const readline = createInterface({ input, output });
  try {
    await readline.question(message);
  } finally {
    readline.close();
  }
}

async function collectStepMetrics(scenarioId: string, operationId: string): Promise<{ operationMetrics: OperationRecord[]; llmCalls: LlmCallRecord[] }> {
  const [operations, calls] = await Promise.all([readOperationRecords(), readLlmCallRecords()]);
  return {
    operationMetrics: operations.filter((record) => record.runId === runId && (record.scenarioId === scenarioId || record.operationId === operationId)),
    llmCalls: calls.filter((call) => call.runId === runId && (call.scenarioId === scenarioId || call.operationId === operationId)),
  };
}

async function writeReports(results: DriftStepResult[]): Promise<{ summaryPath: string; jsonPath: string }> {
  const operations = results.flatMap((result) => result.operationMetrics);
  const calls = results.flatMap((result) => result.llmCalls);
  const tokens = sumTokenUsage(calls.map((call) => call.usage));
  const jsonPath = path.join(reportDir, 'drift-sync-results.json');
  await writeFile(jsonPath, JSON.stringify({
    runId,
    generatedAt: new Date().toISOString(),
    projectName,
    provider,
    autoDrift,
    results,
    summary: {
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      operationCount: operations.length,
      llmCallCount: calls.length,
      tokens,
    },
  }, null, 2), 'utf8');

  const summaryPath = path.join(reportDir, 'drift-sync-summary.md');
  const markdown = renderMarkdown(results, operations, calls, tokens);
  await writeFile(summaryPath, markdown, 'utf8');
  await writeFile(path.join(metricsDir, 'drift-sync-summary.md'), markdown, 'utf8');
  await writeFile(path.join(metricsDir, 'drift-sync-results.json'), await readFile(jsonPath, 'utf8'), 'utf8');
  return { summaryPath, jsonPath };
}

function renderMarkdown(results: DriftStepResult[], operations: OperationRecord[], calls: LlmCallRecord[], tokens: Required<TokenUsage>): string {
  const lines = [
    '# Drift + Sync Metrics (Scenarios F/G)',
    '',
    `- Run ID: \`${runId}\``,
    `- Project: \`${projectName}\``,
    `- Provider: \`${provider}\``,
    `- Drift mode: ${autoDrift ? 'auto docker rm -f' : pauseBeforeCheck ? 'manual pause before check' : 'pre-created external drift'}`,
    `- Result: ${results.filter((result) => result.status === 'passed').length}/${results.length} passed`,
    `- Total LLM calls: ${calls.length}`,
    `- Total tokens: ${tokens.totalTokens} (${tokens.inputTokens} input / ${tokens.outputTokens} output)`,
    '',
    '| ID | Scenario | Status | Latency ms | Exit | LLM calls | Tokens | Guard triggers | Evidence log |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];

  for (const result of results) {
    const guardTriggers = result.operationMetrics.reduce((sum, record) => sum + record.guardTriggerCount, 0);
    const relativeLog = path.relative(process.cwd(), result.logPath).replaceAll('\\', '/');
    lines.push(`| ${result.id} | ${escapeMd(result.title)} | ${statusIcon(result.status)} ${result.status} | ${result.latencyMs} | ${result.exitCode ?? ''} | ${result.llmCalls.length} | ${result.tokenTotals.totalTokens} | ${guardTriggers} | [log](${relativeLog}) |`);
  }

  lines.push('', '## Operation Metrics', '', '| Operation type | Count | Success | Avg latency ms | Avg LLM calls | Avg tokens | Guard triggers |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const [operationType, records] of groupBy(operations, (record) => record.operationType).entries()) {
    lines.push(`| ${operationType} | ${records.length} | ${records.filter((record) => record.success).length}/${records.length} | ${avg(records.map((record) => record.latencyMs))} | ${avg(records.map((record) => record.llmCallCount))} | ${avg(records.map((record) => record.tokenTotals.totalTokens ?? 0))} | ${records.reduce((sum, record) => sum + record.guardTriggerCount, 0)} |`);
  }
  if (operations.length === 0) lines.push('| _No operation metrics collected_ | 0 | 0/0 | 0 | 0 | 0 | 0 |');

  lines.push('', '## Notes', '');
  for (const result of results.filter((entry) => entry.reason)) {
    lines.push(`- **${result.id}**: ${escapeMd(result.reason ?? '')}`);
  }
  if (!results.some((entry) => entry.reason)) lines.push('- No failure notes.');
  return lines.join('\n') + '\n';
}

function readNumberArg(name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(args[index + 1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readStringArg(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function normalizeProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'web-stack';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function shellQuote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function statusIcon(status: DriftStepResult['status']): string {
  return status === 'passed' ? '✅' : '❌';
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

function escapeMd(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
