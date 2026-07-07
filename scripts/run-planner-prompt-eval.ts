import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseJsonResponse } from '../src/llm/json-response.js';
import {
  createGeminiConfig,
  createOpenAiConfig,
  GeminiLlmProvider,
  OpenAiLlmProvider,
} from '../src/llm/provider.js';
import type { LlmProvider } from '../src/llm/provider.js';
import { validateExecutionPlan } from '../src/domain/schemas.js';
import type { ExecutionPlan, InfrastructureService, JsonSchema } from '../src/domain/types.js';
import type { TokenUsage } from '../src/metrics/types.js';

interface EvalCase {
  id: string;
  prompt: string;
  expected: {
    serviceKinds: Array<InfrastructureService['kind']>;
    minServices: number;
    requiredImages: string[];
    requiredPorts?: string[];
    requiredVolumes?: string[];
    dependencyEdges?: Array<[string, string]>;
  };
}

interface EvalResult {
  id: string;
  prompt: string;
  provider: string;
  model: string;
  latencyMs: number;
  parseSuccess: boolean;
  topologyScore: number;
  topologyPassed: boolean;
  issues: string[];
  usage?: TokenUsage | undefined;
  output?: ExecutionPlan;
  rawOutput?: string;
}

const cases: EvalCase[] = [
  {
    id: 'three-tier-nginx-node-postgres',
    prompt: 'Create a web application with nginx, 2 node backends, and postgres. Expose nginx on port 8080.',
    expected: {
      serviceKinds: ['reverse-proxy', 'backend', 'database'],
      minServices: 3,
      requiredImages: ['nginx', 'node', 'postgres'],
      requiredPorts: ['8080:80'],
      requiredVolumes: ['postgres-data'],
      dependencyEdges: [
        ['nginx', 'api'],
        ['api', 'postgres'],
      ],
    },
  },
  {
    id: 'api-redis-cache',
    prompt: 'Plan a Node.js API with a Redis cache. Run 3 API replicas and expose the API on host port 3000.',
    expected: {
      serviceKinds: ['backend', 'database'],
      minServices: 2,
      requiredImages: ['node', 'redis'],
      requiredPorts: ['3000:3000'],
      requiredVolumes: ['redis-data'],
      dependencyEdges: [['api', 'redis']],
    },
  },
  {
    id: 'wordpress-mysql',
    prompt: 'Create a WordPress site with MySQL storage. Expose WordPress on port 8081 and persist database data.',
    expected: {
      serviceKinds: ['backend', 'database'],
      minServices: 2,
      requiredImages: ['wordpress', 'mysql'],
      requiredPorts: ['8081:80'],
      requiredVolumes: ['mysql-data'],
      dependencyEdges: [['wordpress', 'mysql']],
    },
  },
  {
    id: 'nginx-static-site',
    prompt: 'Create a simple static website served by nginx on host port 8082. No database is needed.',
    expected: {
      serviceKinds: ['reverse-proxy'],
      minServices: 1,
      requiredImages: ['nginx'],
      requiredPorts: ['8082:80'],
    },
  },
  {
    id: 'python-api-postgres',
    prompt: 'Deploy a Python API with PostgreSQL. The API should wait for the database and expose port 5000.',
    expected: {
      serviceKinds: ['backend', 'database'],
      minServices: 2,
      requiredImages: ['python', 'postgres'],
      requiredPorts: ['5000:5000'],
      requiredVolumes: ['postgres-data'],
      dependencyEdges: [['api', 'postgres']],
    },
  },
];
const executionPlanJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', minLength: 1 },
    spec: {
      type: 'object',
      properties: {
        projectName: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['reverse-proxy', 'backend', 'database'] },
              name: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
              image: { type: 'string', minLength: 1 },
              desiredStatus: { type: ['string', 'null'], enum: ['running', 'stopped', null] },
              replicas: { type: ['integer', 'null'], minimum: 1 },
              ports: { type: ['array', 'null'], items: { type: 'string', pattern: '^\\d{1,5}:\\d{1,5}$' } },
              dependsOn: {
                type: ['array', 'null'],
                items: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
              },
              volumes: { type: ['array', 'null'], items: { type: 'string', pattern: '^[^:\\s]+:[^:\\s]+$' } },
            },
            required: ['kind', 'name', 'image', 'desiredStatus', 'replicas', 'ports', 'dependsOn', 'volumes'],
            additionalProperties: false,
          },
        },
        networks: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          minItems: 1,
        },
        volumes: {
          type: 'array',
          items: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
        },
      },
      required: ['projectName', 'services', 'networks', 'volumes'],
      additionalProperties: false,
    },
    assumptions: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          description: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['generate-compose', 'write-state', 'deploy-compose', 'inspect-drift'] },
          dependsOn: {
            type: ['array', 'null'],
            items: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' },
          },
        },
        required: ['id', 'description', 'action', 'dependsOn'],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ['summary', 'spec', 'assumptions', 'steps'],
  additionalProperties: false,
} satisfies JsonSchema;

const systemPrompt = [
  'INFRA_PLANNER_PROMPT_EVAL_V1',
  'You are an infrastructure planner for a guarded natural-language DevOps CLI.',
  'Convert the user request into exactly one schema-valid ExecutionPlan JSON object.',
  'Do not emit Markdown, comments, prose, shell commands, docker-compose YAML, or fields outside the schema.',
  'Use only these service kinds: reverse-proxy, backend, database.',
  'Use Docker image names that match the requested technology, e.g. nginx, node, postgres, redis, mysql, wordpress, python.',
  'Model dependencies explicitly with dependsOn: proxies depend on backends; backends depend on databases/caches.',
  'Persist stateful databases/caches with named volumes and declare every named volume in spec.volumes.',
  'Prefer one shared backend service with replicas for scaled app tiers instead of inventing many duplicate services.',
  'Always include one network, at least one assumption, and dry-run-oriented steps: generate-compose then write-state.',
  '',
  'Few-shot topology patterns:',
  '1. nginx + 2 node backends + postgres -> services: nginx(reverse-proxy, ports 8080:80, dependsOn api), api(backend, image node, replicas 2, dependsOn postgres), postgres(database, image postgres, volume postgres-data:/var/lib/postgresql/data).',
  '2. API + Redis cache -> api(backend, exposed app port, dependsOn redis), redis(database, image redis, redis-data:/data).',
  '3. Static nginx site -> one reverse-proxy service only, no database, no fake backend.',
].join('\n');
async function main(): Promise<void> {
  process.loadEnvFile?.('.env');

  const selectedCaseIds = readListArg('--case');
  const selectedRepeatCount = readNumberArg('--repeat', 1);
  const outputDirectory = readStringArg('--out', 'state/planner-eval');
  const selectedCases = selectedCaseIds.length > 0
    ? cases.filter((testCase) => selectedCaseIds.includes(testCase.id))
    : cases;

  if (selectedCases.length === 0) {
    throw new Error(`No eval cases matched: ${selectedCaseIds.join(', ')}`);
  }

  const providerSelection = readProviderArg('--provider', 'openai');
  const runners = createProviderRunners(providerSelection, process.env);
  const results: EvalResult[] = [];

  mkdirSync(outputDirectory, { recursive: true });

  for (const runner of runners) {
    for (const testCase of selectedCases) {
      for (let runIndex = 0; runIndex < selectedRepeatCount; runIndex += 1) {
        const start = performance.now();
        try {
          const response = await runner.provider.completeStructured({
            purpose: 'react',
            system: systemPrompt,
            user: buildUserPrompt(testCase.prompt),
            schemaName: 'execution_plan',
            schema: runner.schema,
          });
          const latencyMs = Math.round(performance.now() - start);

          results.push(evaluateResponse({
            testCase,
            providerLabel: runner.label,
            model: response.model ?? runner.defaultModel,
            latencyMs,
            rawOutput: response.text,
            usage: response.usage,
          }));
        } catch (error) {
          const latencyMs = Math.round(performance.now() - start);
          results.push({
            id: testCase.id,
            prompt: testCase.prompt,
            provider: runner.label,
            model: runner.defaultModel,
            latencyMs,
            parseSuccess: false,
            topologyScore: 0,
            topologyPassed: false,
            issues: [`Provider call failed: ${error instanceof Error ? error.message : String(error)}`],
          });
        }
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = join(outputDirectory, `planner-prompt-eval-${timestamp}.json`);
  const markdownPath = join(outputDirectory, `planner-prompt-eval-${timestamp}.md`);

  writeFileSync(jsonPath, JSON.stringify({ systemPrompt, cases: selectedCases, results, summary: summarizeResults(results) }, null, 2));
  writeFileSync(markdownPath, renderMarkdownReport(results, selectedCases));

  console.log(`Planner prompt eval JSON: ${jsonPath}`);
  console.log(`Planner prompt eval report: ${markdownPath}`);
  console.log(renderConsoleSummary(results));
}

function buildUserPrompt(prompt: string): string {
  return [
    'Natural-language infrastructure request:',
    prompt,
    '',
    'Return only the ExecutionPlan JSON object. The object must pass the repository Zod executionPlanSchema.',
  ].join('\n');
}

function evaluateResponse(input: {
  testCase: EvalCase;
  providerLabel: string;
  model: string;
  latencyMs: number;
  rawOutput: string;
  usage?: EvalResult['usage'];
}): EvalResult {
  const issues: string[] = [];

  try {
    const parsed = validateExecutionPlan(normalizeOptionalArrays(removeNullOptionals(parseJsonResponse(input.rawOutput))));
    const topologyIssues = scoreTopology(parsed, input.testCase);
    issues.push(...topologyIssues);

    return {
      id: input.testCase.id,
      prompt: input.testCase.prompt,
      provider: input.providerLabel,
      model: input.model,
      latencyMs: input.latencyMs,
      parseSuccess: true,
      topologyScore: Math.max(0, 1 - topologyIssues.length / 6),
      topologyPassed: topologyIssues.length === 0,
      issues,
      output: parsed,
      rawOutput: input.rawOutput,
      ...(input.usage ? { usage: input.usage } : {}),
    };
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
    return {
      id: input.testCase.id,
      prompt: input.testCase.prompt,
      provider: input.providerLabel,
      model: input.model,
      latencyMs: input.latencyMs,
      parseSuccess: false,
      topologyScore: 0,
      topologyPassed: false,
      issues,
      rawOutput: input.rawOutput,
      ...(input.usage ? { usage: input.usage } : {}),
    };
  }
}

function normalizeOptionalArrays(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const plan = value as Record<string, unknown>;
  const spec = plan.spec as Record<string, unknown> | undefined;

  if (spec && Array.isArray(spec.services)) {
    spec.services = spec.services.map((service) => {
      if (service === null || typeof service !== 'object') return service;
      const entry = service as Record<string, unknown>;
      for (const key of ['ports', 'volumes', 'dependsOn']) {
        if (Array.isArray(entry[key]) && (entry[key] as unknown[]).length === 0) {
          delete entry[key];
        }
      }
      return entry;
    });
  }

  if (Array.isArray(plan.steps)) {
    plan.steps = plan.steps.map((step) => {
      if (step === null || typeof step !== 'object') return step;
      const entry = step as Record<string, unknown>;
      if (Array.isArray(entry.dependsOn) && (entry.dependsOn as unknown[]).length === 0) {
        delete entry.dependsOn;
      }
      return entry;
    });
  }

  return plan;
}

function removeNullOptionals(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeNullOptionals);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, propertyValue]) => propertyValue !== null)
      .map(([propertyName, propertyValue]) => [propertyName, removeNullOptionals(propertyValue)]),
  );
}
function scoreTopology(plan: ExecutionPlan, testCase: EvalCase): string[] {
  const issues: string[] = [];
  const services = plan.spec.services;
  const serviceText = JSON.stringify(services).toLowerCase();

  if (services.length < testCase.expected.minServices) {
    issues.push(`Expected at least ${testCase.expected.minServices} services, got ${services.length}.`);
  }

  for (const kind of testCase.expected.serviceKinds) {
    if (!services.some((service) => service.kind === kind)) {
      issues.push(`Missing service kind ${kind}.`);
    }
  }

  for (const image of testCase.expected.requiredImages) {
    if (!services.some((service) => service.image.toLowerCase().includes(image))) {
      issues.push(`Missing image containing ${image}.`);
    }
  }

  for (const port of testCase.expected.requiredPorts ?? []) {
    if (!services.some((service) => service.ports?.includes(port))) {
      issues.push(`Missing port mapping ${port}.`);
    }
  }

  for (const volume of testCase.expected.requiredVolumes ?? []) {
    if (!plan.spec.volumes.some((declaredVolume) => declaredVolume.toLowerCase().includes(volume))) {
      issues.push(`Missing declared volume like ${volume}.`);
    }
  }

  for (const [fromHint, toHint] of testCase.expected.dependencyEdges ?? []) {
    const source = services.find((service) => includesHint(service.name, fromHint) || includesHint(service.image, fromHint));
    const target = services.find((service) => includesHint(service.name, toHint) || includesHint(service.image, toHint));

    if (!source || !target || !source.dependsOn?.includes(target.name)) {
      issues.push(`Missing dependency edge ${fromHint} -> ${toHint}.`);
    }
  }

  if (/(privileged|host|pidMode|ipcMode|networkMode|docker.sock)/i.test(serviceText)) {
    issues.push('Unexpected unsafe low-level runtime field or host-level setting.');
  }

  return issues;
}

function includesHint(value: string, hint: string): boolean {
  return value.toLowerCase().includes(hint.toLowerCase());
}

type ResultSummary = {
  total: number;
  parseSuccess: number;
  topologyPassed: number;
  parseSuccessRate: number;
  topologyPassRate: number;
  averageLatencyMs: number;
  averageTopologyScore: number;
};

function summarizeResults(results: EvalResult[]): ResultSummary {
  const total = results.length;
  const parseSuccess = results.filter((result) => result.parseSuccess).length;
  const topologyPassed = results.filter((result) => result.topologyPassed).length;
  const averageLatencyMs = average(results.map((result) => result.latencyMs));
  const averageTopologyScore = average(results.map((result) => result.topologyScore));

  return {
    total,
    parseSuccess,
    topologyPassed,
    parseSuccessRate: ratio(parseSuccess, total),
    topologyPassRate: ratio(topologyPassed, total),
    averageLatencyMs,
    averageTopologyScore,
  };
}

function groupByProvider(results: EvalResult[]): Array<{ provider: string; results: EvalResult[] }> {
  const order: string[] = [];
  const byProvider = new Map<string, EvalResult[]>();
  for (const result of results) {
    if (!byProvider.has(result.provider)) {
      byProvider.set(result.provider, []);
      order.push(result.provider);
    }
    byProvider.get(result.provider)!.push(result);
  }
  return order.map((provider) => ({ provider, results: byProvider.get(provider)! }));
}

function renderMarkdownReport(results: EvalResult[], selectedCases: EvalCase[]): string {
  const summary = summarizeResults(results);
  const groups = groupByProvider(results);
  const lines = [
    '# Planner Prompt Evaluation',
    '',
    `- Providers: ${groups.map((group) => group.provider).join(', ') || 'none'}`,
    `- Cases: ${selectedCases.length}`,
    `- Runs: ${results.length}`,
    `- Zod parse success: ${summary.parseSuccess}/${summary.total} (${formatPercent(summary.parseSuccessRate)})`,
    `- Topology pass: ${summary.topologyPassed}/${summary.total} (${formatPercent(summary.topologyPassRate)})`,
    `- Average latency: ${summary.averageLatencyMs} ms`,
    '',
    '## Provider Comparison',
    '',
    '| Provider | Runs | Parse Zod | Topology | Avg score | Avg latency ms |',
    '|---|---:|---:|---:|---:|---:|',
    ...groups.map((group) => {
      const groupSummary = summarizeResults(group.results);
      return [
        `| ${group.provider}`,
        String(groupSummary.total),
        `${groupSummary.parseSuccess}/${groupSummary.total} (${formatPercent(groupSummary.parseSuccessRate)})`,
        `${groupSummary.topologyPassed}/${groupSummary.total} (${formatPercent(groupSummary.topologyPassRate)})`,
        groupSummary.averageTopologyScore.toFixed(2),
        String(groupSummary.averageLatencyMs),
      ].join(' | ') + ' |';
    }),
    '',
    '## Prompt Template',
    '',
    '```text',
    systemPrompt,
    '```',
    '',
    '## Results',
    '',
    '| Provider | Case | Model | Parse Zod | Topology | Score | Latency ms | Issues |',
    '|---|---|---|---:|---:|---:|---:|---|',
    ...results.map((result) => [
      `| ${result.provider}`,
      result.id,
      result.model,
      result.parseSuccess ? 'yes' : 'no',
      result.topologyPassed ? 'yes' : 'no',
      result.topologyScore.toFixed(2),
      String(result.latencyMs),
      result.issues.length > 0 ? result.issues.join('<br>') : '-',
    ].join(' | ') + ' |'),
    '',
    '## Example Outputs',
  ];

  const examples: EvalResult[] = [];
  for (const group of groups) {
    const firstParsed = group.results.find((result) => result.parseSuccess && result.output);
    if (firstParsed) examples.push(firstParsed);
  }
  for (const result of examples.slice(0, 2)) {
    lines.push('', `### ${result.provider} - ${result.id}`, '', 'Prompt:', '', '```text', result.prompt, '```', '', 'Output:', '', '```json', JSON.stringify(result.output ?? result.rawOutput, null, 2), '```');
  }

  lines.push(
    '',
    '## Report Wording',
    '',
    'Kết quả benchmark ở trên đo trực tiếp trên các provider được liệt kê, trên cùng một prompt template và cùng bộ case. Kết luận provider tốt hơn chỉ áp dụng trong phạm vi bộ case và cấu hình model đã đo; đổi model hoặc mở rộng bộ case có thể cho kết quả khác.',
  );

  return `${lines.join('\n')}\n`;
}

function renderConsoleSummary(results: EvalResult[]): string {
  const summary = summarizeResults(results);
  return [
    `Runs: ${summary.total}`,
    `Zod parse success: ${summary.parseSuccess}/${summary.total} (${formatPercent(summary.parseSuccessRate)})`,
    `Topology pass: ${summary.topologyPassed}/${summary.total} (${formatPercent(summary.topologyPassRate)})`,
    `Average latency: ${summary.averageLatencyMs} ms`,
  ].join('\n');
}

function readStringArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
}

function readNumberArg(name: string, fallback: number): number {
  const raw = readStringArg(name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readListArg(name: string): string[] {
  const value = readStringArg(name, '');
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

type ProviderSelection = 'openai' | 'gemini' | 'both';

interface ProviderRunner {
  label: string;
  provider: LlmProvider;
  defaultModel: string;
  schema: JsonSchema;
}

function readProviderArg(name: string, fallback: ProviderSelection): ProviderSelection {
  const raw = readStringArg(name, fallback);
  if (raw === 'openai' || raw === 'gemini' || raw === 'both') {
    return raw;
  }
  throw new Error(`${name} must be one of: openai, gemini, both.`);
}

function toGeminiResponseSchema(schema: JsonSchema): JsonSchema {
  const disallowedKeys = new Set([
    'pattern',
    'additionalProperties',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
  ]);

  const convert = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(source)) {
      if (disallowedKeys.has(key)) {
        continue;
      }
      if (key === 'type' && Array.isArray(entry)) {
        const nonNull = entry.filter((item) => item !== 'null');
        const isNullable = entry.includes('null');
        result.type = nonNull.length === 1 ? nonNull[0] : (nonNull[0] ?? 'string');
        if (isNullable) {
          result.nullable = true;
        }
        continue;
      }
      if (key === 'enum' && Array.isArray(entry)) {
        result.enum = entry.filter((item) => item !== null);
        continue;
      }
      result[key] = convert(entry);
    }

    return result;
  };

  return convert(schema) as JsonSchema;
}

function createProviderRunners(
  selection: ProviderSelection,
  env: NodeJS.ProcessEnv,
): ProviderRunner[] {
  const runners: ProviderRunner[] = [];

  if (selection === 'openai' || selection === 'both') {
    const config = createOpenAiConfig(env);
    runners.push({
      label: 'openai',
      provider: new OpenAiLlmProvider(config),
      defaultModel: config.reactModel,
      schema: executionPlanJsonSchema,
    });
  }

  if (selection === 'gemini' || selection === 'both') {
    const config = createGeminiConfig(env);
    runners.push({
      label: 'gemini',
      provider: new GeminiLlmProvider(config),
      defaultModel: config.reactModel,
      schema: toGeminiResponseSchema(executionPlanJsonSchema),
    });
  }

  if (runners.length === 0) {
    throw new Error(`No provider runners created for selection: ${selection}`);
  }

  return runners;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});