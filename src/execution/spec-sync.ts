import type {
  InfrastructureService,
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeContainerObservation,
} from '../domain/types.js';

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

function serviceFromContainer(
  container: RuntimeContainerObservation,
  projectName: string,
): InfrastructureService | null {
  const rawName = container.name;
  const prefix = projectName + '-';
  const serviceName = rawName.startsWith(prefix) ? rawName.slice(prefix.length) : rawName;
  const name = sanitizeIdentifier(serviceName);
  const image = container.image;
  if (!image) return null;
  const ports = (container.ports ?? []).filter((port) => PORT_RE.test(port));
  const service: InfrastructureService = {
    kind: inferServiceKind(image),
    name,
    image,
  };
  if (ports.length > 0) service.ports = ports;
  return service;
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
      if (derived.ports && derived.ports.length > 0) {
        merged.ports = derived.ports;
      }
      services.push(merged);
    } else {
      services.push(derived);
    }
  }

  const finalServices = services.length > 0 ? services : sourceSpec.services;

  const observedNetworks = actual.networks
    .map((network) => network.name)
    .filter((name) => IDENTIFIER_RE.test(name));
  const finalNetworks = observedNetworks.length > 0 ? observedNetworks : sourceSpec.networks;

  const observedVolumes = actual.volumes
    .map((volume) => volume.name)
    .filter((name) => IDENTIFIER_RE.test(name));
  const finalVolumes = observedVolumes.length > 0 ? observedVolumes : sourceSpec.volumes;

  return {
    projectName,
    services: finalServices,
    networks: finalNetworks,
    volumes: finalVolumes,
  };
}
