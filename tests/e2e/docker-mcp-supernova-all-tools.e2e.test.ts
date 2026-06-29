import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpConnectionPlug } from '../../src/execution/mcp-connection-plug.js';

const SERVER_PATH = 'packages/docker-mcp-server-supernova/dist/index.js';
const TIMEOUT_MS = 300_000;
const IMAGE = 'busybox:1.36';
const FULL_EXTERNAL = process.env.INFRA_SUPERNOVA_FULL_EXTERNAL === '1';
const FULL_EXPENSIVE = process.env.INFRA_SUPERNOVA_FULL_EXPENSIVE === '1';

const EXPECTED_TOOLS = [
  'build_image',
  'check_health',
  'compose_down',
  'compose_logs',
  'compose_ps',
  'compose_restart',
  'compose_up',
  'container_health_status',
  'container_resource_usage',
  'container_stats',
  'copy_from_container',
  'copy_to_container',
  'create_network',
  'create_volume',
  'disk_usage',
  'docker_info',
  'exec_in_container',
  'inspect_container',
  'inspect_context',
  'inspect_volume',
  'list_containers',
  'list_contexts',
  'list_images',
  'list_networks',
  'list_volumes',
  'monitor_dashboard',
  'prune_containers',
  'prune_images',
  'prune_volumes',
  'pull_image',
  'recreate_container',
  'registry_login',
  'registry_push',
  'registry_search',
  'remove_container',
  'remove_image',
  'remove_network',
  'remove_volume',
  'resource_alert_check',
  'restart_container',
  'run_container',
  'scan_image',
  'search_logs',
  'set_restart_policy',
  'start_container',
  'stop_container',
  'stream_logs',
  'update_container',
  'use_context',
  'vulnerability_report',
  'watch_events',
  'watch_health',
].sort();

type ToolCase = {
  name: string;
  args: (fixture: Fixture) => Record<string, unknown>;
  allowError?: boolean;
  external?: boolean;
  expensive?: boolean;
};

type Fixture = {
  id: string;
  container: string;
  secondaryContainer: string;
  pruneContainer: string;
  network: string;
  volume: string;
  imageTag: string;
  composeDir: string;
  contextName: string;
};

describe('Supernova Docker MCP all-tool E2E', () => {
  it('enumerates and exercises every exposed Supernova tool through MCP stdio', async () => {
    const client = new McpConnectionPlug({ command: 'node', args: [SERVER_PATH], requestTimeoutMs: 120_000 });
    const id = `alltools-${Date.now().toString(36)}`;
    const fixture: Fixture = {
      id,
      container: `infra-${id}-main`,
      secondaryContainer: `infra-${id}-secondary`,
      pruneContainer: `infra-${id}-prune`,
      network: `infra-${id}-net`,
      volume: `infra-${id}-vol`,
      imageTag: `infra-${id}:latest`,
      composeDir: await mkdtemp(join(tmpdir(), `infra-${id}-compose-`)),
      contextName: 'default',
    };

    await writeFile(
      join(fixture.composeDir, 'docker-compose.yml'),
      `services:\n  smoke:\n    image: ${IMAGE}\n    command: ["sh", "-c", "echo compose-${id}; sleep 30"]\n`,
    );

    await client.connect();
    try {
      const tools = (await client.listTools()).map((tool) => tool.name).sort();
      expect(tools).toEqual(EXPECTED_TOOLS);

      await setupFixture(client, fixture);
      await resolveCurrentContext(client, fixture);

      const results: Record<string, string> = {};
      for (const testCase of toolCases) {
        if (testCase.external && !FULL_EXTERNAL) {
          results[testCase.name] = 'skipped: set INFRA_SUPERNOVA_FULL_EXTERNAL=1';
          continue;
        }
        if (testCase.expensive && !FULL_EXPENSIVE) {
          results[testCase.name] = 'skipped: set INFRA_SUPERNOVA_FULL_EXPENSIVE=1';
          continue;
        }
        try {
          const text = await client.callTool(testCase.name, testCase.args(fixture));
          expect(text.length, `${testCase.name} returned text`).toBeGreaterThan(0);
          results[testCase.name] = 'ok';
        } catch (error) {
          if (!testCase.allowError) throw new Error(`${testCase.name} failed: ${error instanceof Error ? error.message : String(error)}`);
          results[testCase.name] = `expected-error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      expect(Object.keys(results).sort()).toEqual(EXPECTED_TOOLS);
      const skipped = Object.entries(results).filter(([, result]) => result.startsWith('skipped'));
      if (skipped.length > 0) {
        console.warn('Supernova all-tool E2E skipped external/expensive tools:', skipped);
      }
    } finally {
      await cleanupFixture(client, fixture).catch(() => undefined);
      await client.disconnect();
    }
  }, TIMEOUT_MS);
});

const toolCases: ToolCase[] = [
  { name: 'build_image', args: (f) => ({ context: f.composeDir, tag: f.imageTag }), allowError: true },
  { name: 'check_health', args: (f) => ({ container_id: f.container, type: 'exec', command: ['true'] }) },
  { name: 'compose_up', args: (f) => ({ path: f.composeDir, detach: true }) },
  { name: 'compose_ps', args: (f) => ({ path: f.composeDir }) },
  { name: 'compose_logs', args: (f) => ({ path: f.composeDir, tail: 20 }) },
  { name: 'compose_restart', args: (f) => ({ path: f.composeDir, timeout: 1 }) },
  { name: 'compose_down', args: (f) => ({ path: f.composeDir, timeout: 1 }) },
  { name: 'container_health_status', args: () => ({}) },
  { name: 'container_resource_usage', args: () => ({ sort_by: 'cpu' }) },
  { name: 'container_stats', args: (f) => ({ container_id: f.container }) },
  { name: 'copy_to_container', args: (f) => ({ container_id: f.container, container_path: '/tmp/supernova-tool.txt', content: `hello-${f.id}` }) },
  { name: 'copy_from_container', args: (f) => ({ container_id: f.container, container_path: '/tmp/supernova-tool.txt' }) },
  { name: 'create_network', args: (f) => ({ name: `${f.network}-extra`, labels: labels(f) }) },
  { name: 'create_volume', args: (f) => ({ name: `${f.volume}-extra`, labels: labels(f) }) },
  { name: 'disk_usage', args: () => ({}) },
  { name: 'docker_info', args: () => ({}) },
  { name: 'exec_in_container', args: (f) => ({ container_id: f.container, command: ['echo', 'execcase'] }) },
  { name: 'inspect_container', args: (f) => ({ container_id: f.container }) },
  { name: 'inspect_context', args: (f) => ({ context_name: f.contextName }), allowError: true, expensive: true },
  { name: 'inspect_volume', args: (f) => ({ name: f.volume }) },
  { name: 'list_containers', args: (f) => ({ all: true, label: [`infra.supernova.e2e=${f.id}`] }) },
  { name: 'list_contexts', args: () => ({}), allowError: true, expensive: true },
  { name: 'list_images', args: () => ({ all: false, filter: IMAGE }) },
  { name: 'list_networks', args: (f) => ({ filter: f.network }) },
  { name: 'list_volumes', args: (f) => ({ filter: f.volume }) },
  { name: 'monitor_dashboard', args: () => ({}) },
  { name: 'prune_containers', args: (f) => ({ filter: `label=infra.supernova.prune=${f.id}` }) },
  { name: 'prune_images', args: (f) => ({ filter: JSON.stringify({ label: [`infra.supernova.prune=${f.id}`] }) }), allowError: true },
  { name: 'prune_volumes', args: (f) => ({ filter: `label=infra.supernova.prune=${f.id}` }) },
  { name: 'pull_image', args: () => ({ image: IMAGE }) },
  { name: 'recreate_container', args: (f) => ({ container_id: f.container, image: IMAGE, timeout: 1 }) },
  { name: 'registry_login', args: () => ({ username: process.env.INFRA_TEST_REGISTRY_USER ?? 'unused', password: process.env.INFRA_TEST_REGISTRY_PASSWORD ?? 'unused' }), allowError: true, external: true },
  { name: 'registry_push', args: (f) => ({ image: f.imageTag }), allowError: true, external: true },
  { name: 'registry_search', args: () => ({ term: 'busybox' }), allowError: true, external: true },
  { name: 'remove_container', args: (f) => ({ container_id: `${f.secondaryContainer}-recreated`, force: true }), allowError: true },
  { name: 'remove_image', args: (f) => ({ image: f.imageTag, force: true }), allowError: true },
  { name: 'remove_network', args: (f) => ({ network_id: `${f.network}-extra` }), allowError: true },
  { name: 'remove_volume', args: (f) => ({ name: `${f.volume}-extra`, force: true }), allowError: true },
  { name: 'resource_alert_check', args: () => ({ cpu_percent: 100, memory_percent: 100, restart_count: 100 }) },
  { name: 'restart_container', args: (f) => ({ container_id: f.container, timeout: 1 }) },
  {
    name: 'run_container',
    args: (f) => ({
      image: IMAGE,
      name: `${f.secondaryContainer}-run-case`,
      labels: labels(f),
      command: ['sh', '-c', 'echo run-case; sleep 2'],
      detach: true,
    }),
  },
  { name: 'scan_image', args: () => ({ image: IMAGE, timeout: 120 }), allowError: true, expensive: true },
  { name: 'search_logs', args: (f) => ({ pattern: f.id, containers: [f.container], tail: 100, ignore_case: false }) },
  { name: 'set_restart_policy', args: (f) => ({ container_id: f.container, policy: 'no' }) },
  { name: 'start_container', args: (f) => ({ container_id: f.secondaryContainer }) },
  { name: 'stop_container', args: (f) => ({ container_id: f.container, timeout: 1 }) },
  { name: 'stream_logs', args: (f) => ({ container_id: f.container, tail: 20 }) },
  { name: 'update_container', args: (f) => ({ container_id: f.container, cpu_shares: 128 }) },
  { name: 'use_context', args: (f) => ({ context_name: f.contextName }), allowError: true, expensive: true },
  { name: 'vulnerability_report', args: () => ({ image: IMAGE, timeout: 180 }), allowError: true, expensive: true },
  { name: 'watch_events', args: () => ({ event_type: 'all', duration: 1 }) },
  { name: 'watch_health', args: (f) => ({ container_id: f.container, timeout: 1, interval: 1 }), allowError: true },
];

async function setupFixture(client: McpConnectionPlug, fixture: Fixture): Promise<void> {
  await client.callTool('pull_image', { image: IMAGE });
  await client.callTool('create_network', { name: fixture.network, labels: labels(fixture) });
  await client.callTool('create_volume', { name: fixture.volume, labels: labels(fixture) });
  await client.callTool('run_container', {
    image: IMAGE,
    name: fixture.container,
    env: { SUPERNOVA_E2E: fixture.id },
    network: fixture.network,
    labels: labels(fixture),
    command: ['sh', '-c', `echo log-${fixture.id}; while true; do sleep 5; done`],
    detach: true,
  });
  await client.callTool('run_container', {
    image: IMAGE,
    name: fixture.secondaryContainer,
    labels: labels(fixture),
    command: ['sh', '-c', 'while true; do sleep 5; done'],
    detach: true,
  });
  await client.callTool('stop_container', { container_id: fixture.secondaryContainer, timeout: 1 });
  await client.callTool('run_container', {
    image: IMAGE,
    name: fixture.pruneContainer,
    labels: pruneLabels(fixture),
    command: ['sh', '-c', 'while true; do sleep 5; done'],
    detach: true,
  });
  await client.callTool('stop_container', { container_id: fixture.pruneContainer, timeout: 1 });
}


async function resolveCurrentContext(client: McpConnectionPlug, fixture: Fixture): Promise<void> {
  try {
    const text = await client.callTool('list_contexts', {});
    const parsed = JSON.parse(text) as { current?: string };
    if (typeof parsed.current === 'string' && parsed.current.length > 0) {
      fixture.contextName = parsed.current.replace(/^\*/, '').trim() || 'default';
    }
  } catch {
    fixture.contextName = 'default';
  }
}

async function cleanupFixture(client: McpConnectionPlug, fixture: Fixture): Promise<void> {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['compose_down', { path: fixture.composeDir, volumes: true, timeout: 1 }],
    ['remove_container', { container_id: fixture.container, force: true }],
    ['remove_container', { container_id: fixture.secondaryContainer, force: true }],
    ['remove_container', { container_id: fixture.pruneContainer, force: true }],
    ['remove_container', { container_id: `${fixture.secondaryContainer}-recreated`, force: true }],
    ['remove_container', { container_id: `${fixture.secondaryContainer}-run-case`, force: true }],
    ['remove_network', { network_id: fixture.network }],
    ['remove_network', { network_id: `${fixture.network}-extra` }],
    ['remove_volume', { name: fixture.volume, force: true }],
    ['remove_volume', { name: `${fixture.volume}-extra`, force: true }],
    ['remove_image', { image: fixture.imageTag, force: true }],
  ];
  for (const [name, args] of calls) {
    await client.callTool(name, args).catch(() => undefined);
  }
}

function labels(fixture: Fixture): Record<string, string> {
  return {
    'infra.supernova.e2e': fixture.id,
  };
}

function pruneLabels(fixture: Fixture): Record<string, string> {
  return {
    'infra.supernova.e2e': fixture.id,
    'infra.supernova.prune': fixture.id,
  };
}
