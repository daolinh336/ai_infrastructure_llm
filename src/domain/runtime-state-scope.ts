import type { InfrastructureService, InfrastructureSpec, RuntimeActualState } from './types.js';



function toServiceContainerName(projectName: string, serviceName: string): string {
  return projectName + '-' + serviceName.replace(/[_\s]+/g, '-');
}

function toReplicaContainerNames(
  projectName: string,
  service: Pick<InfrastructureService, 'name' | 'replicas'>,
): string[] {
  const baseName = toServiceContainerName(projectName, service.name);
  const replicas = service.replicas ?? 1;
  if (replicas <= 1) return [baseName];

  return Array.from({ length: replicas }, (_, index) => baseName + '-' + String(index + 1));
}

function stripProjectPrefix(name: string, projectName: string): string {
  const prefix = projectName + '-';
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function stripComposeReplicaSuffix(name: string): string {
  return name.replace(/[-_][1-9][0-9]*$/, '');
}

function normalizeObservedContainerName(name: string, projectName: string): string {
  return stripComposeReplicaSuffix(stripProjectPrefix(name, projectName));
}

function resourceNameMatchesProject(name: string, desiredName: string, projectName: string): boolean {
  return (
    name === desiredName ||
    stripProjectPrefix(name, projectName) === desiredName ||
    stripProjectPrefix(desiredName, projectName) === name
  );
}

function imageBase(image: string): string {
  return (image.split(':')[0] ?? '').split('/').pop()?.toLowerCase() ?? image.toLowerCase();
}

export function scopeRuntimeActualStateToSpec(
  actual: RuntimeActualState,
  desired: InfrastructureSpec,
): RuntimeActualState {
  const projectName = desired.projectName;
  const projectPrefix = projectName + '-';
  const expectedContainerNames = new Set(
    desired.services.flatMap((service) => toReplicaContainerNames(projectName, service)),
  );
  const desiredServiceNames = new Set(desired.services.map((service) => service.name));
  const desiredNetworkNames = new Set(desired.networks);
  const desiredVolumeNames = new Set(desired.volumes);

  const containers = actual.containers.filter((container) =>
    expectedContainerNames.has(container.name) ||
    container.name.startsWith(projectPrefix) ||
    desiredServiceNames.has(container.name) ||
    desiredServiceNames.has(normalizeObservedContainerName(container.name, projectName)),
  );

  const networks = actual.networks.filter((network) =>
    network.name.startsWith(projectPrefix) ||
    [...desiredNetworkNames].some((desiredName) => resourceNameMatchesProject(network.name, desiredName, projectName)),
  );

  const volumes = actual.volumes.filter((volume) =>
    volume.name.startsWith(projectPrefix) ||
    [...desiredVolumeNames].some((desiredName) => resourceNameMatchesProject(volume.name, desiredName, projectName)),
  );

  const desiredImages = new Set(desired.services.map((service) => service.image));
  const desiredImageBases = new Set([...desiredImages].map(imageBase));
  const observedContainerImages = new Set(
    containers
      .map((container) => container.image)
      .filter((image): image is string => image !== null),
  );
  const images = actual.images.filter((image) =>
    desiredImages.has(image.reference) ||
    desiredImageBases.has(imageBase(image.reference)) ||
    observedContainerImages.has(image.reference),
  );

  return {
    ...actual,
    containers,
    networks,
    volumes,
    images,
  };
}
