import type { InfrastructureService } from '../domain/types.js';

export function toServiceContainerName(projectName: string, serviceName: string): string {
  return projectName + '-' + serviceName.replace(/[_\s]+/g, '-');
}

export function toReplicaContainerNames(
  projectName: string,
  service: Pick<InfrastructureService, 'name' | 'replicas'>,
): string[] {
  const baseName = toServiceContainerName(projectName, service.name);
  const replicas = service.replicas ?? 1;
  if (replicas <= 1) return [baseName];

  return Array.from({ length: replicas }, (_, index) => baseName + '-' + String(index + 1));
}

export function matchesServiceContainer(
  projectName: string,
  service: Pick<InfrastructureService, 'name' | 'replicas'>,
  containerName: string,
): boolean {
  return toReplicaContainerNames(projectName, service).includes(containerName);
}
