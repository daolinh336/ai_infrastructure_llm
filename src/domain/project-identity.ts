import type { InfrastructureService, InfrastructureSpec } from './types.js';

export function normalizeProjectName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'infra-project';
}

export function toProjectId(projectName: string): string {
  return normalizeProjectName(projectName);
}

export function prefixProjectResource(projectId: string, name: string): string {
  const normalizedName = normalizeProjectName(name);
  return normalizedName.startsWith(projectId + '-') ? normalizedName : projectId + '-' + normalizedName;
}

export function namespaceInfrastructureSpec(spec: InfrastructureSpec): InfrastructureSpec {
  const projectId = toProjectId(spec.projectName);
  const volumeNameMap = new Map(spec.volumes.map((name) => [name, prefixProjectResource(projectId, name)]));

  return {
    ...spec,
    projectName: projectId,
    networks: spec.networks.map((name) => prefixProjectResource(projectId, name)),
    volumes: spec.volumes.map((name) => volumeNameMap.get(name) ?? prefixProjectResource(projectId, name)),
    services: spec.services.map((service) => namespaceServiceVolumes(service, volumeNameMap, projectId)),
  };
}

function namespaceServiceVolumes(
  service: InfrastructureService,
  volumeNameMap: Map<string, string>,
  projectId: string,
): InfrastructureService {
  if (!service.volumes?.length) return service;

  return {
    ...service,
    volumes: service.volumes.map((mount) => {
      const [source, ...rest] = mount.split(':');
      if (!source || rest.length === 0) return mount;
      return [volumeNameMap.get(source) ?? prefixProjectResource(projectId, source), ...rest].join(':');
    }),
  };
}
