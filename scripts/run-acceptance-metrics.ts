import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getMetricsDir, readLlmCallRecords, readOperationRecords, sumTokenUsage } from '../src/metrics/metrics.js';
import type { LlmCallRecord, OperationRecord, TokenUsage } from '../src/metrics/types.js';

interface AcceptanceStep {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';
  title: string;
  objective: string;
  operationType: string;
  kind: 'cli' | 'external' | 'skip';
  args?: string[];
  input?: string;
  timeoutMs?: number;
  requiresRuntime?: boolean;
  requiresDestroyAll?: boolean;
  passPatterns?: RegExp[];
  allowNonZeroExit?: boolean;
  setup?: () => Promise<void>;
}

interface StepResult {
  id: AcceptanceStep['id'];
  title: string;
  objective: string;
  operationType: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  latencyMs: number;
  command: string;
  reason: string | null;
  logPath: string | null;
  operationMetrics: OperationRecord[];
  llmCalls: LlmCallRecord[];
  tokenTotals: Required<TokenUsage>;
}

const args = process.argv.slice(2);
const provider = readStringArg('--provider', process.env.INFRA_AGENT_PROVIDER ?? 'openai');
const projectName = normalizeProjectName(readStringArg('--prjName', 'web-stack-acceptance'));
const full = args.includes('--full');
const includeRuntime = full || args.includes('--include-runtime');
const includeDestroyAll = args.includes('--include-destroy-all') || args.includes('--confirm-destroy-all');
const runId = readStringArg('--run-id', `acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const metricsDir = getMetricsDir();
const reportDir = path.join(metricsDir, 'acceptance', runId);
const safeModeNote = includeRuntime
  ? 'Runtime mode enabled: deploy/status/drift/adjust/destroy steps may mutate Docker resources through the app approval gates.'
  : 'Safe mode: runtime/destructive steps are skipped. Use --full to run deploy/status/drift/adjust/destroy and --include-destroy-all to include J.';

await mkdir(reportDir, { recursive: true });
console.log(`[acceptance] runId=${runId}`);
console.log(`[acceptance] project=${projectName}`);
console.log(`[acceptance] provider=${provider}`);
console.log(`[acceptance] ${safeModeNote}`);

const steps = buildSteps(projectName);
const results: StepResult[] = [];

for (const step of steps) {
  if (step.requiresRuntime && !includeRuntime) {
    results.push(await skippedResult(step, 'Skipped because runtime mode is disabled. Re-run with --full or --include-runtime.'));
    continue;
  }
  if (step.requiresDestroyAll && !includeDestroyAll) {
    results.push(await skippedResult(step, 'Skipped by destructive guard. Re-run with --include-destroy-all to execute destroy-all.'));
    continue;
  }

  console.log(`\n[${step.id}] ${step.title}`);
  if (step.setup) {
    try {
      await step.setup();
    } catch (error) {
      results.push(await failedSetupResult(step, getErrorMessage(error)));
      continue;
    }
  }

  const result = await runStep(step);
  results.push(result);
  console.log(`[${step.id}] ${result.status.toUpperCase()} (${result.latencyMs} ms)${result.reason ? ` - ${result.reason}` : ''}`);
}

const reportPaths = await writeAcceptanceReports(results);
console.log(`\nAcceptance summary: ${reportPaths.summaryPath}`);
console.log(`Acceptance JSON: ${reportPaths.jsonPath}`);
console.log(`Full logs: ${reportDir}`);

function buildSteps(project: string): AcceptanceStep[] {
  const createPrompt = 'Create a web application with nginx reverse proxy, 2 node:20-alpine backend replicas, and postgres:16 database with persistent storage';
  return [
    {
      id: 'A',
      title: 'Dry-run web stack ba tầng',
      objective: 'Validate that the planner creates the three-tier topology without Docker mutation.',
      operationType: 'dry-run',
      kind: 'cli',
      args: ['plan', createPrompt, '--prjName', project, '--provider', provider, '--dry-run'],
      passPatterns: [/Dry-run|preview|compose/i, /nginx|reverse proxy/i, /postgres|database/i, /backend|node/i],
    },
    {
      id: 'B',
      title: 'Deploy thật qua Docker MCP',
      objective: 'Validate approval-gated deploy through Docker MCP and verified snapshot persistence.',
      operationType: 'deploy',
      kind: 'cli',
      args: ['plan', createPrompt, '--prjName', project, '--provider', provider, '--deploy'],
      input: 'y\nn\n',
      timeoutMs: 8 * 60_000,
      requiresRuntime: true,
      passPatterns: [/approval|Approve writing docker-compose/i, /Docker deployment completed|verified runtime|SQLite state/i],
    },
    {
      id: 'C',
      title: 'Từ chối approval',
      objective: 'Validate that rejecting approval stops mutation and does not save deployment success.',
      operationType: 'approval-reject',
      kind: 'cli',
      args: ['plan', createPrompt, '--prjName', `${project}-reject`, '--provider', provider, '--deploy'],
      input: 'n\n',
      timeoutMs: 5 * 60_000,
      requiresRuntime: true,
      passPatterns: [/Approval rejected|No Docker, MCP, or runtime mutation|No deployment state was saved/i],
    },
    {
      id: 'D',
      title: 'Docker daemon hoặc MCP plugin không sẵn sàng',
      objective: 'Validate that environment/preflight readiness is reported at the doctor layer.',
      operationType: 'doctor',
      kind: 'cli',
      args: ['doctor', '--docker'],
      allowNonZeroExit: true,
      passPatterns: [/Docker doctor:/i, /Docker engine reachable|Status:/i],
    },
    {
      id: 'E',
      title: 'Xem trạng thái verified',
      objective: 'Validate that status reads the verified project snapshot and scoped runtime state.',
      operationType: 'status',
      kind: 'cli',
      args: ['status', '--prjName', project],
      requiresRuntime: true,
      passPatterns: [/project|Project/i, new RegExp(project, 'i'), /service|container|desired|actual|snapshot/i],
    },
    {
      id: 'H',
      title: 'Adjust replicas trên project đã verified',
      objective: 'Validate adjust path for scaling backend replicas on an existing verified project.',
      operationType: 'adjust',
      kind: 'cli',
      args: ['plan', 'Scale backend to 3 replicas', '--prjName', project, '--provider', provider, '--adjust'],
      input: 'y\nn\n',
      timeoutMs: 8 * 60_000,
      requiresRuntime: true,
      passPatterns: [/adjust|replica|Scale/i, /Docker deployment completed|verified runtime|SQLite state/i],
    },
    {
      id: 'F',
      title: 'Drift xảy ra ngoài hệ thống',
      objective: 'Validate detection of runtime mismatch after an external Docker mutation.',
      operationType: 'drift',
      kind: 'cli',
      args: ['status', '--prjName', project, '--drift', '--repair'],
      input: 'n\n',
      requiresRuntime: true,
      setup: () => induceExternalDrift(project),
      passPatterns: [/drift|missing|mismatch|repair/i, /Repair rejected|No Docker mutation|Choose drift resolution/i],
    },
    {
      id: 'G',
      title: 'Sync desired state theo runtime thực tế',
      objective: 'Validate controlled sync from actual runtime to SQLite desired state with audit output.',
      operationType: 'sync',
      kind: 'cli',
      args: ['status', '--prjName', project, '--drift', '--repair'],
      input: 's\n',
      requiresRuntime: true,
      passPatterns: [/sync|Docker -> SQLite|desired state/i, /SQLite|snapshot|state/i],
    },
    {
      id: 'I',
      title: 'Destroy project cụ thể',
      objective: 'Validate scoped destructive cleanup for one managed project after preview/approval.',
      operationType: 'destroy',
      kind: 'cli',
      args: ['destroy', '--project', project, '--yes'],
      timeoutMs: 5 * 60_000,
      requiresRuntime: true,
      passPatterns: [/Destroy preview/i, /Destroy completed|Post-destroy verification|SQLite state cleared/i],
    },
    {
      id: 'J',
      title: 'Destroy-all trong môi trường managed',
      objective: 'Validate strict managed-scope destroy-all reset without relying on broad name patterns.',
      operationType: 'destroy-all',
      kind: 'cli',
      args: ['destroy-all', '--yes'],
      timeoutMs: 5 * 60_000,
      requiresRuntime: true,
      requiresDestroyAll: true,
      passPatterns: [/Destroy all preview/i, /No managed Docker resources|Destroy-all completed|SQLite state updated/i],
    },
  ];
}

async function runStep(step: AcceptanceStep): Promise<StepResult> {
  const started = performance.now();
  const operationId = randomUUID();
  const scenarioId = `acceptance-${step.id}`;
  const logPath = path.join(reportDir, `${step.id}-${slug(step.title)}.log`);
  const command = step.kind === 'cli'
    ? `${process.execPath} ./node_modules/tsx/dist/cli.mjs src/cli/index.ts ${(step.args ?? []).map(shellQuote).join(' ')}`
    : step.args?.join(' ') ?? step.kind;

  const runOptions = {
    timeoutMs: step.timeoutMs ?? 4 * 60_000,
    operationId,
    scenarioId,
    operationType: step.operationType,
    logPath,
    ...(step.input !== undefined ? { input: step.input } : {}),
  };
  const childResult = await runCli(step.args ?? [], runOptions);

  const latencyMs = Math.round(performance.now() - started);
  const output = childResult.output;
  const exitOk = childResult.exitCode === 0 || Boolean(step.allowNonZeroExit);
  const patternsOk = (step.passPatterns ?? []).every((pattern) => pattern.test(output));
  const status = exitOk && patternsOk ? 'passed' : 'failed';
  const reason = status === 'passed'
    ? null
    : [
        exitOk ? null : `exitCode=${childResult.exitCode}`,
        patternsOk ? null : 'expected output markers were not all found',
        childResult.timedOut ? 'timed out' : null,
      ].filter(Boolean).join('; ');

  const { operationMetrics, llmCalls } = await collectStepMetrics(scenarioId, operationId);
  return {
    id: step.id,
    title: step.title,
    objective: step.objective,
    operationType: step.operationType,
    status,
    exitCode: childResult.exitCode,
    latencyMs,
    command,
    reason,
    logPath,
    operationMetrics,
    llmCalls,
    tokenTotals: sumTokenUsage(llmCalls.map((call) => call.usage)),
  };
}

async function runCli(cliArgs: string[], options: {
  input?: string;
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

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      output += `\n[spawn error] ${error.message}\n`;
    });
    child.on('exit', async (code) => {
      clearTimeout(timer);
      await writeFile(options.logPath, output, 'utf8');
      resolve({ exitCode: code, output, timedOut });
    });

    if (options.input) {
      setTimeout(() => {
        child.stdin.write(options.input);
        child.stdin.end();
      }, 500);
    } else {
      child.stdin.end();
    }
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
  console.log(`[drift] trying external Docker removal for: ${candidates.join(', ')}`);
  await new Promise<void>((resolve) => {
    const child = spawn('docker', ['rm', '-f', ...candidates], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('exit', () => resolve());
    child.on('error', (error) => {
      console.log(`[drift] docker CLI removal attempt failed: ${error.message}`);
      resolve();
    });
  });
}

async function skippedResult(step: AcceptanceStep, reason: string): Promise<StepResult> {
  return {
    id: step.id,
    title: step.title,
    objective: step.objective,
    operationType: step.operationType,
    status: 'skipped',
    exitCode: null,
    latencyMs: 0,
    command: step.args?.join(' ') ?? step.kind,
    reason,
    logPath: null,
    operationMetrics: [],
    llmCalls: [],
    tokenTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

async function failedSetupResult(step: AcceptanceStep, reason: string): Promise<StepResult> {
  return {
    id: step.id,
    title: step.title,
    objective: step.objective,
    operationType: step.operationType,
    status: 'failed',
    exitCode: null,
    latencyMs: 0,
    command: step.args?.join(' ') ?? step.kind,
    reason: `setup failed: ${reason}`,
    logPath: null,
    operationMetrics: [],
    llmCalls: [],
    tokenTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
}

async function collectStepMetrics(scenarioId: string, operationId: string): Promise<{ operationMetrics: OperationRecord[]; llmCalls: LlmCallRecord[] }> {
  const [operations, calls] = await Promise.all([readOperationRecords(), readLlmCallRecords()]);
  return {
    operationMetrics: operations.filter((record) => record.runId === runId && (record.scenarioId === scenarioId || record.operationId === operationId)),
    llmCalls: calls.filter((call) => call.runId === runId && (call.scenarioId === scenarioId || call.operationId === operationId)),
  };
}

async function writeAcceptanceReports(stepResults: StepResult[]): Promise<{ summaryPath: string; jsonPath: string }> {
  const allOperations = stepResults.flatMap((result) => result.operationMetrics);
  const allCalls = stepResults.flatMap((result) => result.llmCalls);
  const aggregateTokens = sumTokenUsage(allCalls.map((call) => call.usage));
  const passed = stepResults.filter((result) => result.status === 'passed').length;
  const failed = stepResults.filter((result) => result.status === 'failed').length;
  const skipped = stepResults.filter((result) => result.status === 'skipped').length;

  const jsonPath = path.join(reportDir, 'acceptance-results.json');
  await writeFile(jsonPath, JSON.stringify({
    runId,
    generatedAt: new Date().toISOString(),
    provider,
    projectName,
    includeRuntime,
    includeDestroyAll,
    summary: {
      total: stepResults.length,
      passed,
      failed,
      skipped,
      passRate: stepResults.length > 0 ? passed / stepResults.length : 0,
      operationCount: allOperations.length,
      llmCallCount: allCalls.length,
      tokens: aggregateTokens,
    },
    results: stepResults,
  }, null, 2), 'utf8');

  const summaryPath = path.join(reportDir, 'acceptance-summary.md');
  await writeFile(summaryPath, renderMarkdown(stepResults, allOperations, allCalls, aggregateTokens), 'utf8');
  const latestSummaryPath = path.join(metricsDir, 'acceptance-summary.md');
  const latestJsonPath = path.join(metricsDir, 'acceptance-results.json');
  await writeFile(latestSummaryPath, await readFile(summaryPath, 'utf8'), 'utf8');
  await writeFile(latestJsonPath, await readFile(jsonPath, 'utf8'), 'utf8');
  return { summaryPath, jsonPath };
}

function renderMarkdown(stepResults: StepResult[], operations: OperationRecord[], calls: LlmCallRecord[], tokens: Required<TokenUsage>): string {
  const passed = stepResults.filter((result) => result.status === 'passed').length;
  const failed = stepResults.filter((result) => result.status === 'failed').length;
  const skipped = stepResults.filter((result) => result.status === 'skipped').length;
  const lines = [
    '# Acceptance Demo Metrics A-J',
    '',
    `- Run ID: \`${runId}\``,
    `- Project: \`${projectName}\``,
    `- Provider: \`${provider}\``,
    `- Runtime mode: ${includeRuntime ? 'enabled' : 'disabled'}`,
    `- Destroy-all included: ${includeDestroyAll ? 'yes' : 'no'}`,
    `- Result: ${passed}/${stepResults.length} passed, ${failed} failed, ${skipped} skipped`,
    `- Total LLM calls: ${calls.length}`,
    `- Total tokens: ${tokens.totalTokens} (${tokens.inputTokens} input / ${tokens.outputTokens} output)`,
    '',
    '## Scenario Results',
    '',
    '| ID | Scenario | Status | Latency ms | Exit | LLM calls | Tokens | Guard triggers | Evidence log |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];

  for (const result of stepResults) {
    const opGuard = result.operationMetrics.reduce((sum, record) => sum + record.guardTriggerCount, 0);
    const relativeLog = result.logPath ? path.relative(process.cwd(), result.logPath).replaceAll('\\', '/') : '';
    lines.push(`| ${result.id} | ${escapeMd(result.title)} | ${statusIcon(result.status)} ${result.status} | ${result.latencyMs} | ${result.exitCode ?? ''} | ${result.llmCalls.length} | ${result.tokenTotals.totalTokens} | ${opGuard} | ${relativeLog ? `[log](${relativeLog})` : result.reason ?? ''} |`);
  }

  lines.push('', '## Mentor-style Metrics by Operation Type', '', '| Operation type | Count | Success | Avg latency ms | Avg LLM calls | Avg tokens | First-pass correct | Retry/revise | Guard triggers |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [operationType, records] of groupBy(operations, (record) => record.operationType).entries()) {
    const success = records.filter((record) => record.success).length;
    const firstPassDenom = records.filter((record) => record.plannerAccuracy).length;
    const firstPass = records.filter((record) => record.plannerAccuracy?.firstPassCorrect).length;
    const revise = records.filter((record) => (record.plannerAccuracy?.revisionCount ?? 0) > 0 || (record.plannerAccuracy?.clarificationCount ?? 0) > 0).length;
    lines.push(`| ${operationType} | ${records.length} | ${success}/${records.length} | ${avg(records.map((record) => record.latencyMs))} | ${avg(records.map((record) => record.llmCallCount))} | ${avg(records.map((record) => record.tokenTotals.totalTokens ?? 0))} | ${firstPassDenom ? `${firstPass}/${firstPassDenom}` : 'n/a'} | ${revise} | ${records.reduce((sum, record) => sum + record.guardTriggerCount, 0)} |`);
  }
  if (operations.length === 0) lines.push('| _No operation metrics collected_ | 0 | 0/0 | 0 | 0 | 0 | n/a | 0 | 0 |');

  lines.push('', '## Notes / Fail Reasons', '');
  for (const result of stepResults.filter((entry) => entry.reason)) {
    lines.push(`- **${result.id} ${escapeMd(result.title)}**: ${escapeMd(result.reason ?? '')}`);
  }
  if (!stepResults.some((entry) => entry.reason)) lines.push('- No failure or skip notes.');

  lines.push('', '## Commands', '');
  for (const result of stepResults) {
    lines.push(`- **${result.id}**: \`${escapeMd(result.command)}\``);
  }

  return lines.join('\n') + '\n';
}

function readStringArg(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function normalizeProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'web-stack-acceptance';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function shellQuote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusIcon(status: StepResult['status']): string {
  if (status === 'passed') return '✅';
  if (status === 'failed') return '❌';
  return '⏭️';
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

