import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getMetricsDir } from '../src/metrics/metrics.js';
import { writeMentorFinalReport } from './mentor-final-report.js';

interface MainStep {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'H' | 'I' | 'J';
  scenarioId: string;
  title: string;
  operationType: string;
  args: string[];
  input?: string;
  timeoutMs?: number;
  runOnce?: boolean;
  requiresDestroyAll?: boolean;
}

interface MainResult {
  id: MainStep['id'];
  runIndex: number;
  title: string;
  exitCode: number | null;
  latencyMs: number;
  status: 'passed' | 'failed' | 'skipped';
  logPath: string | null;
  reason: string | null;
}

const args = process.argv.slice(2);
const runs = readNumberArg('--runs', 3);
const provider = readStringArg('--provider', process.env.INFRA_AGENT_PROVIDER ?? 'openai');
const projectBase = normalizeProjectName(readStringArg('--prjName', 'web-stack'));
const runId = readStringArg('--run-id', `mentor-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const includeDestroyAll = args.includes('--include-destroy-all') || args.includes('--confirm-destroy-all');
const metricsDir = getMetricsDir();
const reportDir = path.join(metricsDir, 'mentor-suite', runId, 'main');
await mkdir(reportDir, { recursive: true });

console.log(`[mentor-main] runId=${runId}`);
console.log(`[mentor-main] projectBase=${projectBase}`);
console.log(`[mentor-main] provider=${provider}`);
console.log(`[mentor-main] runs=${runs}`);
console.log('[main] This runner executes A/B/C/D/E/H/I/J only. Run F/G later with demo:drift-sync using the same --run-id.');

const results: MainResult[] = [];
for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
  const projectName = runs === 1 ? projectBase : `${projectBase}-${runIndex}`;
  console.log(`\n[mentor-main] Run ${runIndex}/${runs}, project=${projectName}`);
  for (const step of buildSteps(projectName)) {
    if (step.requiresDestroyAll && !includeDestroyAll) {
      results.push({ id: step.id, runIndex, title: step.title, status: 'skipped', exitCode: null, latencyMs: 0, logPath: null, reason: 'Skipped by destroy-all guard. Use --include-destroy-all.' });
      continue;
    }
    if (step.runOnce && runIndex > 1) {
      results.push({ id: step.id, runIndex, title: step.title, status: 'skipped', exitCode: null, latencyMs: 0, logPath: null, reason: 'Run once scenario; already executed in run 1.' });
      continue;
    }
    results.push(await runStep(step, runIndex, projectName));
  }
}

await writeFile(path.join(reportDir, 'main-results.json'), JSON.stringify({ runId, provider, projectBase, runs, includeDestroyAll, results }, null, 2), 'utf8');
const report = await writeMentorFinalReport({
  runId,
  projectName: projectBase,
  provider,
  runs,
  notes: [
    'Main runner executed A/B/C/D/E/H/I/J. F/G are intentionally excluded so the user can manually create drift and then run demo:drift-sync with the same run-id.',
    includeDestroyAll ? 'Destroy-all scenario J was included.' : 'Destroy-all scenario J was skipped by guard. Use --include-destroy-all to include it.',
  ],
});
console.log(`\nPartial/final mentor report: ${report.summaryPath}`);
console.log(`Latest mentor report: ${report.latestPath}`);
console.log(`Run F/G next after you manually deploy and drift a project, for example: npm run demo:drift-sync -- --prjName ${projectBase} --provider ${provider} --run-id ${runId}`);

function buildSteps(projectName: string): MainStep[] {
  const createPrompt = 'Create a web application with nginx reverse proxy, 2 node:20-alpine backend replicas, and postgres:16 database with persistent storage';
  return [
    { id: 'A', scenarioId: 'mentor-A', title: 'Dry-run web stack', operationType: 'dry-run', args: ['plan', createPrompt, '--prjName', projectName, '--provider', provider, '--dry-run'], timeoutMs: 5 * 60_000 },
    { id: 'B', scenarioId: 'mentor-B', title: 'Deploy via Docker MCP', operationType: 'deploy', args: ['plan', createPrompt, '--prjName', projectName, '--provider', provider, '--deploy'], input: 'y\nn\n', timeoutMs: 10 * 60_000 },
    { id: 'C', scenarioId: 'mentor-C', title: 'Reject approval', operationType: 'deploy', args: ['plan', createPrompt, '--prjName', `${projectName}-reject`, '--provider', provider, '--deploy'], input: 'n\n', timeoutMs: 5 * 60_000 },
    { id: 'D', scenarioId: 'mentor-D', title: 'Docker/MCP doctor', operationType: 'doctor', args: ['doctor', '--docker'], timeoutMs: 2 * 60_000 },
    { id: 'E', scenarioId: 'mentor-E', title: 'Verified status', operationType: 'status', args: ['status', '--prjName', projectName], timeoutMs: 2 * 60_000 },
    { id: 'H', scenarioId: 'mentor-H', title: 'Adjust replicas', operationType: 'deploy', args: ['plan', 'Scale backend to 3 replicas', '--prjName', projectName, '--provider', provider, '--adjust'], input: 'y\nn\n', timeoutMs: 10 * 60_000 },
    { id: 'I', scenarioId: 'mentor-I', title: 'Destroy project', operationType: 'destroy', args: ['destroy', '--project', projectName, '--yes'], timeoutMs: 5 * 60_000 },
    { id: 'J', scenarioId: 'mentor-J', title: 'Destroy-all managed', operationType: 'destroy-all', args: ['destroy-all', '--yes'], timeoutMs: 5 * 60_000, runOnce: true, requiresDestroyAll: true },
  ];
}

async function runStep(step: MainStep, runIndex: number, projectName: string): Promise<MainResult> {
  const operationId = randomUUID();
  const logPath = path.join(reportDir, `${runIndex}-${step.id}-${slug(step.title)}.log`);
  const started = performance.now();
  console.log(`\n[${step.id}] ${step.title}`);
  const runOptions = {
    timeoutMs: step.timeoutMs ?? 5 * 60_000,
    operationId,
    scenarioId: step.scenarioId,
    operationType: step.operationType,
    projectName,
    logPath,
    ...(step.input !== undefined ? { input: step.input } : {}),
  };
  const result = await runCli(step.args, runOptions);
  const latencyMs = Math.round(performance.now() - started);
  const status = result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed';
  const reason = status === 'passed' ? null : [result.exitCode === 0 ? null : `exitCode=${result.exitCode}`, result.timedOut ? 'timed out' : null].filter(Boolean).join('; ');
  console.log(`[${step.id}] ${status.toUpperCase()} (${latencyMs} ms)${reason ? ` - ${reason}` : ''}`);
  return { id: step.id, runIndex, title: step.title, exitCode: result.exitCode, latencyMs, status, logPath, reason };
}

async function runCli(cliArgs: string[], options: {
  input?: string;
  timeoutMs: number;
  operationId: string;
  scenarioId: string;
  operationType: string;
  projectName: string;
  logPath: string;
}): Promise<{ exitCode: number | null; timedOut: boolean }> {
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
        INFRA_METRICS_PROJECT_NAME: options.projectName,
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
      resolve({ exitCode: code, timedOut });
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
