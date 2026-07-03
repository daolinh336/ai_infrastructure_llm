import type {
  InfrastructureService,
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeContainerObservation,
} from '../domain/types.js';
import { isProtectedDockerNetwork } from './protected-docker-resources.js';

const PROXY_HINTS = ['nginx', 'traefik', 'caddy', 'envoy', 'haproxy', 'apache', 'httpd'];
const DB_HINTS = ['postgres', 'postgresql', 'mysql', 'mariadb', 'redis', 'mongodb', 'mongo', 'sqlite'];

function imageBaseName(image: string): string {
  const noTag = (image.split(':')[0] ?? image);
  return (noTag.split('/').pop() ?? noTag).toLowerCase();
}

function inferServiceKind(image: string): InfrastructureService['kind'] {
  const base = imageBaseName(image);
  if (PROXY_HINTS.some((hint) => base.includes(hint))) return 'reverse-proxy';
  if (DB_HINTS.some((hint) => base.includes(hint))) return 'database';
  return 'backend';
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PORT_RE = /^\d{1,5}:\d{1,5}$/;

function sanitizeIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, '-');
  const anchored = /^[A-Za-z0-9]/.test(cleaned) ? cleaned : 'svc-' + cleaned;
  return anchored || 'service';
}

function stripProjectPrefix(name: string, projectName: string): string {
  const prefix = projectName + '-';
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function stripComposeReplicaSuffix(name: string): string {
  return name.replace(/[-_][1-9][0-9]*$/, '');
}

function normalizeRuntimeResourceName(name: string, projectName: string): string {
  return sanitizeIdentifier(stripProjectPrefix(name, projectName));
}

function serviceFromContainer(
  container: RuntimeContainerObservation,
  projectName: string,
): InfrastructureService | null {
  const rawName = container.name;
  const serviceName = stripComposeReplicaSuffix(stripProjectPrefix(rawName, projectName));
  const name = sanitizeIdentifier(serviceName);
  const image = container.image;
  if (!image) return null;
  const ports = (container.ports ?? []).filter((port) => PORT_RE.test(port));
  const service: InfrastructureService = {
    kind: inferServiceKind(image),
    name,
    image,
  };
  if (container.status !== null && container.status !== 'running') {
    service.desiredStatus = 'stopped';
  }
  if (ports.length > 0) service.ports = ports;
  return service;
}

function syncManagedEnvironment(
  desiredEnvironment: Record<string, string> | undefined,
  actualEnvironment: Record<string, string> | null | undefined,
): Record<string, string> | undefined {
  if (!desiredEnvironment || actualEnvironment === null || actualEnvironment === undefined) {
    return desiredEnvironment;
  }
  const syncedEnvironment = Object.fromEntries(
    Object.keys(desiredEnvironment)
      .filter((key) => key in actualEnvironment)
      .map((key) => [key, actualEnvironment[key]!]),
  );
  return Object.keys(syncedEnvironment).length > 0 ? syncedEnvironment : undefined;
}

export function deriveSpecFromRuntime(
  actual: RuntimeActualState,
  sourceSpec: InfrastructureSpec,
): InfrastructureSpec {
  const projectName = sourceSpec.projectName;
  const sourceByName = new Map(sourceSpec.services.map((service) => [service.name, service]));
  const services: InfrastructureService[] = [];
  const seen = new Set<string>();

  for (const container of actual.containers) {
    const derived = serviceFromContainer(container, projectName);
    if (!derived) continue;
    if (seen.has(derived.name)) continue;
    seen.add(derived.name);

    const existing = sourceByName.get(derived.name);
    if (existing) {
      const merged: InfrastructureService = {
        ...existing,
        image: container.image ?? existing.image,
      };
      const syncedEnvironment = syncManagedEnvironment(existing.environment, container.environment);
      if (syncedEnvironment) {
        merged.environment = syncedEnvironment;
      } else {
        delete merged.environment;
      }
      if (derived.desiredStatus) {
        merged.desiredStatus = derived.desiredStatus;
      } else {
        delete merged.desiredStatus;
      }
      if (derived.ports && derived.ports.length > 0) {
        merged.ports = derived.ports;
      } else if (derived.desiredStatus === 'stopped') {
        delete merged.ports;
      }
      services.push(merged);
    } else {
      services.push(derived);
    }
  }

  const finalServices = services;

  const observedNetworks = actual.networks
    .map((network) => normalizeRuntimeResourceName(network.name, projectName))
    .filter((name) => !isProtectedDockerNetwork(name))
    .filter((name) => IDENTIFIER_RE.test(name));
  const finalNetworks = observedNetworks.length > 0 ? observedNetworks : sourceSpec.networks;

  const observedVolumes = actual.volumes
    .map((volume) => normalizeRuntimeResourceName(volume.name, projectName))
    .filter((name) => IDENTIFIER_RE.test(name));
  const finalVolumes = observedVolumes;

  const syncedServiceNames = new Set(finalServices.map((service) => service.name));
  const syncedVolumeNames = new Set(finalVolumes);
  const reconciledServices = finalServices.map((service) => {
    const reconciled: InfrastructureService = { ...service };
    if (reconciled.dependsOn) {
      reconciled.dependsOn = reconciled.dependsOn.filter((dep) => syncedServiceNames.has(dep));
      if (reconciled.dependsOn.length === 0) delete reconciled.dependsOn;
    }
    if (reconciled.volumes) {
      reconciled.volumes = reconciled.volumes.filter((mount) => {
        const [source] = mount.split(':');
        return !source || syncedVolumeNames.has(source);
      });
      if (reconciled.volumes.length === 0) delete reconciled.volumes;
    }
    return reconciled;
  });

  return {
    projectName,
    services: reconciledServices,
    networks: finalNetworks,
    volumes: finalVolumes,
  };
}



