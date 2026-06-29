import { access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DockerMcpGateway } from '../../src/execution/docker-mcp-gateway.js';

const SUPERNOVA_DIST = 'packages/docker-mcp-server-supernova/dist/index.js';
const SMOKE_TIMEOUT_MS = 120_000;

describe('Supernova Docker MCP real smoke', () => {
  it('deploys, observes, and cleans up through MCP only', async () => {
    await access(SUPERNOVA_DIST);

    const gateway = new DockerMcpGateway({ requestTimeoutMs: 60_000 });
    const suffix = Date.now().toString(36);
    const networkName = `infra-mcp-smoke-${suffix}`;
    const containerName = `infra-mcp-smoke-nginx-${suffix}`;

    await gateway.initialize();
    try {
      expect(gateway.runtimeProfileName).toBe('supernova-local');
      expect(gateway.serverInfo?.name).toBe('docker-mcp-server');
      expect(gateway.capabilityReport?.missingOperations).toEqual([]);

      gateway.setAllowMutations(true);
      await gateway.createNetwork(networkName, { 'infra-react-agent.smoke': 'true' });
      await gateway.pullImage('nginx:stable-alpine');
      await gateway.createContainer({
        name: containerName,
        image: 'nginx:stable-alpine',
        ports: undefined,
        environment: { INFRA_SMOKE: 'true' },
        volumes: undefined,
        networks: [networkName],
        labels: { 'infra-react-agent.smoke': 'true' },
      });
      gateway.setAllowMutations(false);

      const actual = await gateway.observeActualStateWithInspect({ containerNames: [containerName] });
      const container = actual.containers.find((entry) => entry.name === containerName);
      expect(container).toMatchObject({ name: containerName, image: 'nginx:stable-alpine', status: 'running' });
      expect(container?.environment).toMatchObject({ INFRA_SMOKE: 'true' });
    } finally {
      gateway.setAllowMutations(true);
      await gateway.removeContainer(containerName).catch(() => undefined);
      await gateway.removeNetwork(networkName).catch(() => undefined);
      gateway.setAllowMutations(false);
      await gateway.shutdown();
    }
  }, SMOKE_TIMEOUT_MS);
});
