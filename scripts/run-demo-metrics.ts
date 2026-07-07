import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeMetricsReports } from '../src/metrics/metrics.js';

interface Scenario {
  id: string;
  prompt: string;
}

const scenarios: Scenario[] = [
  { id: 'nginx-static', prompt: 'Create an nginx static web service exposed on port 8080' },
  { id: 'nginx-node', prompt: 'Create nginx as a reverse proxy in front of one node:20-alpine backend' },
  { id: 'nginx-two-node', prompt: 'Create nginx with 2 node:20-alpine backend replicas and route traffic to them' },
  { id: 'node-postgres', prompt: 'Create a node:20-alpine backend with postgres:16 database and persistent storage' },
  { id: 'nginx-node-postgres', prompt: 'Create nginx, a node:20-alpine backend, and postgres:16 with dependencies configured' },
  { id: 'app-redis', prompt: 'Create a node:20-alpine web app with redis:7 cache' },
  { id: 'postgres-stateful', prompt: 'Create a standalone postgres database with a persistent volume' },
  { id: 'mongo-app', prompt: 'Create a node:20-alpine app service backed by mongo:7' },
  { id: 'scaled-backend', prompt: 'Create a node:20-alpine backend API service with 3 replicas behind nginx' },
  { id: 'multi-service-network-volume', prompt: 'Create a multi-service web stack with nginx, node:20-alpine app, postgres:16, redis:7, networks and volumes' },
];

const args = process.argv.slice(2);
const runs = readNumberArg('--runs', 3);
const dryRunOnly = args.includes('--dry-run-only');
const provider = readStringArg('--provider', process.env.INFRA_AGENT_PROVIDER ?? 'openai');

for (const scenario of scenarios) {
  for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
    const runId = `${scenario.id}-${runIndex}`;
    const projectName = `demo-${scenario.id}-${runIndex}`.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    await runOperation({ scenario, runId, projectName, operationType: 'dry-run', provider });
    if (!dryRunOnly) {
      await runOperation({ scenario, runId, projectName, operationType: 'deploy', provider });
      await runCli(['status', '--prjName', projectName], { scenario, runId, projectName, operationType: 'status', provider });
      await runCli(['status', '--drift', '--prjName', projectName], { scenario, runId, projectName, operationType: 'drift', provider });
      await runCli(['destroy', '--project', projectName, '--yes'], { scenario, runId, projectName, operationType: 'destroy', provider });
    }
  }
}

const reports = await writeMetricsReports();
console.log(`Metrics summary: ${reports.summaryPath}`);
console.log(`LLM call report: ${reports.llmReportPath}`);

async function runOperation(input: {
  scenario: Scenario;
  runId: string;
  projectName: string;
  operationType: 'dry-run' | 'deploy';
  provider: string;
}): Promise<void> {
  const argsForOperation = [
    'plan',
    input.scenario.prompt,
    '--prjName',
    input.projectName,
    '--provider',
    input.provider,
  ];
  if (input.operationType === 'deploy') argsForOperation.push('--deploy');
  await runCli(argsForOperation, input);
}

async function runCli(argsForCli: string[], input: {
  scenario: Scenario;
  runId: string;
  projectName: string;
  operationType: string;
  provider: string;
}): Promise<void> {
  const operationId = randomUUID();
  console.log(`[${input.scenario.id}/${input.runId}] ${input.operationType}: node ./node_modules/tsx/dist/cli.mjs src/cli/index.ts ${argsForCli.join(' ')}`);
  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['./node_modules/tsx/dist/cli.mjs', 'src/cli/index.ts', ...argsForCli], {
      stdio: 'inherit',
      env: {
        ...process.env,
        INFRA_METRICS: '1',
        INFRA_METRICS_OPERATION_ID: operationId,
        INFRA_METRICS_SCENARIO_ID: input.scenario.id,
        INFRA_METRICS_RUN_ID: input.runId,
        INFRA_METRICS_OPERATION_TYPE: input.operationType,
        INFRA_METRICS_PROJECT_NAME: input.projectName,
        INFRA_METRICS_PROVIDER: input.provider,
        INFRA_AGENT_PROVIDER: input.provider,
      },
    });
    child.on('exit', () => resolve());
    child.on('error', (error) => {
      console.error(error.message);
      resolve();
    });
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
