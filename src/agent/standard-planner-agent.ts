import type { LlmProvider } from '../llm/provider.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import type {
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  ValidatedQuery,
} from '../domain/types.js';
import { validateInfrastructureSpec } from '../domain/schemas.js';
import type { PlannerAgent } from './agent-interfaces.js';

export class StandardPlannerAgent implements PlannerAgent {
  constructor(private readonly provider: LlmProvider) {}

  async proposeSpec(
    query: ValidatedQuery,
    _stateSnapshot: InfrastructureStateSnapshot | null,
    dockerMcpClient?: DockerMcpGateway,
  ): Promise<InfrastructureSpec> {
    // If Docker is available, gather existing state to inform the proposal
    const existingContainers: string[] = [];
    const existingImages: string[] = [];
    const existingNetworks: string[] = [];

    if (dockerMcpClient?.isInitialized) {
      try {
        const containers = await dockerMcpClient.listContainers(true);
        existingContainers.push(...containers.map((c) => c.name));
        const images = await dockerMcpClient.listImages();
        existingImages.push(...images.map((i) => i.reference));
        const networks = await dockerMcpClient.listNetworks();
        existingNetworks.push(...networks.map((n) => n.name));
      } catch {
        // Docker read-only failures are non-fatal for planning
      }
    }

    // Build services from the draft query
    const services = query.draft.services
      .filter((s) => s.image !== null && s.name !== null)
      .map((s) => {
        const kind = inferServiceKind(s.image!);
        const service: InfrastructureSpec['services'][0] = {
          kind,
          name: s.name!,
          image: s.image!,
        };
        if (s.port) {
          service.ports = [String(s.port) + ':' + String(s.port)];
        }
        if (s.replicas && s.replicas > 1) {
          service.replicas = s.replicas;
        }
        return service;
      });

    // Apply default dependsOn inference
    const inferred = applyDependencyInference(services);

    const spec: InfrastructureSpec = {
      projectName: toProjectName(query.normalizedPrompt),
      services: inferred,
      networks: query.draft.services.length > 1 ? ['app-network'] : [],
      volumes: [],
    };

    return validateInfrastructureSpec(spec);
  }

  async repairSpec(
    spec: InfrastructureSpec,
    _issues: string[],
    _dockerMcpClient?: DockerMcpGateway,
  ): Promise<InfrastructureSpec> {
    // For Phase 9+10, simple repair: just re-validate.
    // Future versions can use LLM to fix issues.
    return validateInfrastructureSpec(spec);
  }
}

function inferServiceKind(image: string): 'reverse-proxy' | 'backend' | 'database' {
  const base = (image.toLowerCase().split(':')[0] ?? '').split('/').pop() ?? '';
  const reverseProxyImages = new Set(['nginx', 'httpd', 'traefik', 'haproxy', 'caddy']);
  const databaseImages = new Set([
    'postgres', 'mysql', 'mariadb', 'mongo', 'redis',
    'rabbitmq', 'elasticsearch', 'kafka', 'cassandra', 'cockroachdb',
  ]);

  if (reverseProxyImages.has(base)) return 'reverse-proxy';
  if (databaseImages.has(base)) return 'database';
  return 'backend';
}

function applyDependencyInference(
  services: InfrastructureSpec['services'],
): InfrastructureSpec['services'] {
  const backends = services.filter((s) => s.kind === 'backend');
  const databases = services.filter((s) => s.kind === 'database');

  for (const svc of services) {
    const deps: string[] = [];

    if (svc.kind === 'reverse-proxy' && backends.length > 0) {
      deps.push(...backends.map((b) => b.name));
    } else if (svc.kind === 'reverse-proxy' && databases.length > 0) {
      deps.push(...databases.map((d) => d.name));
    }

    if (svc.kind === 'backend' && databases.length > 0) {
      deps.push(...databases.map((d) => d.name));
    }

    if (deps.length > 0) {
      svc.dependsOn = deps;
    }
  }

  return services;
}

function toProjectName(prompt: string): string {
  const cleaned = prompt.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'app';
}