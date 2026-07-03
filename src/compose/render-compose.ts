import type { InfrastructureSpec } from '../domain/types.js';
import { validateInfrastructureSpec } from '../domain/schemas.js';
import { getImageReferenceBase } from '../domain/supported-images.js';
import { normalizeStatefulDatabaseReplicaVolumes } from '../domain/stateful-database-volumes.js';
import { namespaceInfrastructureSpec } from '../domain/project-identity.js';
import { orderServicesByDependencies } from '../domain/topology-graph.js';
import YAML from 'yaml';

/**
 * Compose hardening (Sprint A.4 / mentor feedback #5).
 *
 * Deterministic auto-resolves derived from the service image base — no LLM,
 * no schema change. The compose YAML is an artifact rendered from the validated
 * InfrastructureSpec; healthcheck/restart/command are added here so the output
 * is production-ready instead of exiting immediately or hiding failures behind
 * missing readiness checks.
 */

interface ComposeHealthcheck {
  test: string[];
  interval: string;
  timeout: string;
  retries: number;
  start_period?: string;
}

const DATABASE_HEALTHCHECKS: Record<string, (environment?: Record<string, string>) => ComposeHealthcheck> = {
  postgres: (environment) => ({
    test: ['CMD-SHELL', `pg_isready -U ${shellQuote(environment?.POSTGRES_USER ?? 'app')}`],
    interval: '10s',
    timeout: '5s',
    retries: 5,
    start_period: '10s',
  }),
  mysql: () => ({
    test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost'],
    interval: '10s',
    timeout: '5s',
    retries: 5,
    start_period: '15s',
  }),
  mariadb: () => ({
    test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'],
    interval: '10s',
    timeout: '5s',
    retries: 5,
    start_period: '15s',
  }),
  mongo: () => ({
    test: ['CMD', 'mongosh', '--quiet', '--eval', "db.adminCommand('ping')"],
    interval: '10s',
    timeout: '5s',
    retries: 5,
    start_period: '10s',
  }),
  redis: () => ({
    test: ['CMD', 'redis-cli', 'ping'],
    interval: '10s',
    timeout: '3s',
    retries: 5,
  }),
  elasticsearch: () => ({
    test: ['CMD-SHELL', 'curl -fs http://localhost:9200/_cluster/health || exit 1'],
    interval: '15s',
    timeout: '5s',
    retries: 5,
    start_period: '30s',
  }),
};

// App-runtime images that ship with no default CMD and would exit immediately.
// A keepalive command lets the container stay up for the demo/runtime deploy.
const KEEPALIVE_COMMAND: Record<string, string[]> = {
  node: ['tail', '-f', '/dev/null'],
  python: ['tail', '-f', '/dev/null'],
  golang: ['tail', '-f', '/dev/null'],
  openjdk: ['tail', '-f', '/dev/null'],
  'eclipse-temurin': ['tail', '-f', '/dev/null'],
};

export function getRuntimeKeepaliveCommand(image: string): string[] | undefined {
  const command = KEEPALIVE_COMMAND[getImageReferenceBase(image)];
  return command ? [...command] : undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getAllowedHostPorts(service: { kind: string; name: string; image: string; ports?: string[] }): string[] {
  if (service.kind !== 'reverse-proxy') {
    return [];
  }

  return service.ports ?? [];
}

export function renderCompose(spec: InfrastructureSpec): string {
  const validSpec = normalizeStatefulDatabaseReplicaVolumes(
    namespaceInfrastructureSpec(validateInfrastructureSpec(spec)),
  );
  const orderedServices = orderServicesByDependencies(validSpec.services);
  const compose = {
    services: Object.fromEntries(
      orderedServices.map((service) => {
        const imageBase = getImageReferenceBase(service.image);
        const healthcheck = DATABASE_HEALTHCHECKS[imageBase]?.(service.environment);
        const command = getRuntimeKeepaliveCommand(service.image);
        const replicas = service.replicas ?? 1;
        const ports = getAllowedHostPorts(service);
        return [
          service.name,
          {
            image: service.image,
            restart: 'unless-stopped',
            deploy: { replicas },
            ...(ports.length ? { ports } : {}),
            ...(service.environment ? { environment: service.environment } : {}),
            ...(service.dependsOn?.length ? { depends_on: service.dependsOn } : {}),
            ...(service.volumes?.length ? { volumes: service.volumes } : {}),
            ...(command ? { command } : {}),
            ...(healthcheck ? { healthcheck } : {}),
            networks: validSpec.networks,
          },
        ] as const;
      }),
    ),
    networks: Object.fromEntries(validSpec.networks.map((name) => [name, {}])),
    volumes: Object.fromEntries(validSpec.volumes.map((name) => [name, {}])),
  };

  return YAML.stringify(compose, { aliasDuplicateObjects: false });
}
