import type {
  InfrastructureService,
  InfrastructureSpec,
  ResolvedSpecPatchResult,
  ServiceSelector,
  SpecPatch,
} from '../domain/types.js';
import { expandStatefulDatabaseReplicas, getDatabaseDataVolumeTarget } from '../domain/stateful-database-volumes.js';

export function applySpecPatchPlan(
  spec: InfrastructureSpec,
  patches: SpecPatch[],
  options: { allowBlockedPatchOps?: string[] } = {},
): { spec: InfrastructureSpec; results: ResolvedSpecPatchResult[] } {
  let revised = cloneSpec(spec);
  const results: ResolvedSpecPatchResult[] = [];
  const allowedBlockedOps = new Set(options.allowBlockedPatchOps ?? []);

  for (const patch of patches) {
    const resolution = resolvePatchTargets(revised, patch);
    const policyBlock = resolution.blockedReason ?? (allowedBlockedOps.has(patch.op) ? null : evaluatePatchPolicy(revised, patch, resolution.matchedServices));
    const before = JSON.stringify(revised);
    revised = policyBlock === null ? applyResolvedPatch(revised, patch, resolution.matchedServices) : revised;
    results.push({
      patch,
      matchedServiceNames: resolution.matchedServices.map((service) => service.name),
      applied: policyBlock === null && JSON.stringify(revised) !== before,
      blockedReason: policyBlock,
    });
  }

  return { spec: revised, results };
}

function resolvePatchTargets(
  spec: InfrastructureSpec,
  patch: SpecPatch,
): { matchedServices: InfrastructureService[]; blockedReason: string | null } {
  if (!('target' in patch)) {
    return { matchedServices: [], blockedReason: null };
  }

  const matches = resolveServiceSelector(spec, patch.target);
  if (matches.length === 0) {
    if (patch.op === 'set-service-replicas' && resolveStatefulDatabaseReplicaGroup(spec, patch.target, []) !== null) {
      return { matchedServices: [], blockedReason: null };
    }
    return { matchedServices: [], blockedReason: 'No matching service for selector.' };
  }

  if (matches.length > 1) {
    if (patch.op === 'set-service-replicas' && resolveStatefulDatabaseReplicaGroup(spec, patch.target, matches) !== null) {
      return { matchedServices: matches, blockedReason: null };
    }
    return { matchedServices: matches, blockedReason: 'Ambiguous selector matched multiple services.' };
  }

  return { matchedServices: matches, blockedReason: null };
}

export function resolveServiceSelector(
  spec: InfrastructureSpec,
  selector: ServiceSelector,
): InfrastructureService[] {
  const scored = spec.services
    .map((service) => ({ service, score: scoreServiceSelector(service, selector, spec) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) return [];
  const topScore = scored[0]!.score;
  return scored.filter((entry) => entry.score === topScore).map((entry) => entry.service);
}

function scoreServiceSelector(
  service: InfrastructureService,
  selector: ServiceSelector,
  spec: InfrastructureSpec,
): number {
  let score = 0;
  const imageFamily = service.image.toLowerCase().split(':')[0]?.split('/').pop() ?? '';

  if (selector.name && service.name === selector.name) score += 100;
  if (selector.nameLike) {
    const needle = selector.nameLike.toLowerCase();
    if (service.name.toLowerCase().includes(needle) || imageFamily.includes(needle)) score += 60;
  }
  if (selector.kind && service.kind === selector.kind) score += 40;
  if (selector.imageFamily && imageFamily.includes(selector.imageFamily.toLowerCase())) score += 50;
  if (selector.exposesHostPort !== undefined) {
    const exposes = (service.ports?.length ?? 0) > 0;
    if (exposes === selector.exposesHostPort) score += 25;
  }
  if (selector.dependsOn && service.dependsOn?.includes(selector.dependsOn)) score += 20;
  if (selector.dependentOf) {
    const isDependent = spec.services.some((candidate) =>
      candidate.name === selector.dependentOf && candidate.dependsOn?.includes(service.name),
    );
    if (isDependent) score += 20;
  }

  return score;
}

function evaluatePatchPolicy(
  spec: InfrastructureSpec,
  patch: SpecPatch,
  matchedServices: InfrastructureService[],
): string | null {
  if (patch.op === 'remove-service') {
    if (isAutoSafeDatabaseRemoval(spec, matchedServices)) return null;
    return 'Removing a service requires explicit user confirmation.';
  }

  if (patch.op === 'add-service' && patch.service.kind === 'database' && (patch.service.ports?.length ?? 0) > 0) {
    return 'Adding an externally exposed database service requires explicit user confirmation.';
  }

  if ((patch.op === 'add-service-port' || patch.op === 'replace-service-port') && matchedServices.some((service) => service.kind === 'database')) {
    return 'Exposing a database service port requires explicit user confirmation.';
  }

  if (patch.op === 'add-service-volume' && isRiskyVolumeMount(patch.volume)) {
    return 'Adding a risky host or Docker socket volume mount requires explicit user confirmation.';
  }

  if (patch.op === 'add-service' && (patch.service.volumes ?? []).some(isRiskyVolumeMount)) {
    return 'Adding a service with a risky host or Docker socket volume mount requires explicit user confirmation.';
  }

  return null;
}

function isAutoSafeDatabaseRemoval(
  spec: InfrastructureSpec,
  matchedServices: InfrastructureService[],
): boolean {
  if (matchedServices.length !== 1) return false;
  const target = matchedServices[0]!;
  if (target.kind !== 'database') return false;
  return !spec.services.some((service) => service.dependsOn?.includes(target.name));
}

function isRiskyVolumeMount(volume: string): boolean {
  const source = volume.split(':')[0] ?? '';
  return source === '/var/run/docker.sock' || source === '/' || source.startsWith('/etc') || source.startsWith('/var/run');
}

function applyResolvedPatch(
  spec: InfrastructureSpec,
  patch: SpecPatch,
  matchedServices: InfrastructureService[],
): InfrastructureSpec {
  if (patch.op === 'set-project-name') {
    return { ...spec, projectName: patch.name };
  }

  if (patch.op === 'rename-network') {
    const networks = patch.from
      ? spec.networks.map((network) => (network === patch.from ? patch.to : network))
      : spec.networks.map(() => patch.to);
    return { ...spec, networks: unique(networks.length > 0 ? networks : [patch.to]) };
  }

  if (patch.op === 'set-networks') {
    return { ...spec, networks: unique(patch.networks) };
  }

  if (patch.op === 'add-service') {
    if (spec.services.some((service) => service.name === patch.service.name)) return spec;
    return {
      ...spec,
      services: [...spec.services, cloneService(patch.service)],
      networks: spec.networks.length > 0 ? spec.networks : ['app-network'],
      volumes: unique([...spec.volumes, ...declaredNamedVolumes(patch.service.volumes ?? [])]),
    };
  }

  if (patch.op === 'set-service-replicas') {
    const databaseGroup = resolveStatefulDatabaseReplicaGroup(spec, patch.target, matchedServices);
    if (databaseGroup) {
      return resizeStatefulDatabaseReplicaGroup(spec, databaseGroup, patch.replicas);
    }
  }

  if (matchedServices.length !== 1) {
    return spec;
  }

  const target = matchedServices[0]!;

  if (patch.op === 'remove-service') {
    return {
      ...spec,
      services: spec.services
        .filter((service) => service.name !== target.name)
        .map((service) => {
          const dependsOn = (service.dependsOn ?? []).filter((dependency) => dependency !== target.name);
          if (!service.dependsOn) return service;
          const { dependsOn: _removedDependsOn, ...rest } = service;
          return dependsOn.length > 0 ? { ...service, dependsOn } : rest;
        }),
    };
  }

  if (patch.op === 'rename-service') {
    return {
      ...spec,
      services: spec.services.map((service) => ({
        ...service,
        name: service.name === target.name ? patch.name : service.name,
        ...(service.dependsOn
          ? {
              dependsOn: service.dependsOn.map((dependency) =>
                dependency === target.name ? patch.name : dependency,
              ),
            }
          : {}),
      })),
    };
  }

  if (patch.op === 'set-service-replicas' && target.kind === 'database') {
    return expandStatefulDatabaseReplicas({
      ...spec,
      services: spec.services.map((service) =>
        service.name === target.name ? { ...service, replicas: patch.replicas } : service,
      ),
    });
  }

  return {
    ...spec,
    services: spec.services.map((service) => {
      if (service.name !== target.name) return service;

      if (patch.op === 'set-service-replicas') {
        return { ...service, replicas: patch.replicas };
      }
      if (patch.op === 'replace-service-port') {
        const existingPorts = service.ports ?? [];
        const ports = patch.from
          ? existingPorts.map((port) => (port === patch.from ? patch.to : port))
          : existingPorts.length > 0
            ? existingPorts.map((port, index) => (index === 0 ? patch.to : port))
            : [patch.to];
        return { ...service, ports: unique(ports) };
      }
      if (patch.op === 'add-service-port') {
        return { ...service, ports: unique([...(service.ports ?? []), patch.port]) };
      }
      if (patch.op === 'remove-service-port') {
        const ports = patch.port ? (service.ports ?? []).filter((port) => port !== patch.port) : [];
        const { ports: _removedPorts, ...rest } = service;
        return ports.length > 0 ? { ...service, ports } : rest;
      }
      if (patch.op === 'set-service-image') {
        return { ...service, kind: inferServiceKind(patch.image), image: patch.image };
      }
      if (patch.op === 'set-service-env') {
        return { ...service, environment: { ...(service.environment ?? {}), [patch.key]: patch.value } };
      }
      if (patch.op === 'remove-service-env') {
        if (!service.environment?.[patch.key]) return service;
        const environment = { ...service.environment };
        delete environment[patch.key];
        const { environment: _removedEnv, ...rest } = service;
        return Object.keys(environment).length > 0 ? { ...service, environment } : rest;
      }
      if (patch.op === 'add-service-volume') {
        return { ...service, volumes: unique([...(service.volumes ?? []), patch.volume]) };
      }
      if (patch.op === 'remove-service-volume') {
        const volumes = (service.volumes ?? []).filter((volume) => volume !== patch.volume);
        const { volumes: _removedVolumes, ...rest } = service;
        return volumes.length > 0 ? { ...service, volumes } : rest;
      }
      if (patch.op === 'add-service-dependency') {
        return { ...service, dependsOn: unique([...(service.dependsOn ?? []), patch.dependencyName]) };
      }
      if (patch.op === 'remove-service-dependency') {
        const dependsOn = (service.dependsOn ?? []).filter((dependency) => dependency !== patch.dependencyName);
        const { dependsOn: _removedDependsOn, ...rest } = service;
        return dependsOn.length > 0 ? { ...service, dependsOn } : rest;
      }
      if (patch.op === 'set-service-desired-status') {
        return { ...service, desiredStatus: patch.desiredStatus };
      }

      return service;
    }),
  };
}

function inferServiceKind(image: string): InfrastructureService['kind'] {
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

type StatefulDatabaseReplicaGroup = {
  baseName: string;
  services: InfrastructureService[];
};

function resolveStatefulDatabaseReplicaGroup(
  spec: InfrastructureSpec,
  selector: ServiceSelector,
  matchedServices: InfrastructureService[],
): StatefulDatabaseReplicaGroup | null {
  const groups = new Map<string, InfrastructureService[]>();
  for (const service of spec.services) {
    if (service.kind !== 'database') continue;
    const parsed = parseNumberedReplicaServiceName(service.name);
    if (!parsed) continue;
    const services = groups.get(parsed.baseName) ?? [];
    services.push(service);
    groups.set(parsed.baseName, services);
  }

  const candidates = [...groups.entries()]
    .map(([baseName, services]) => ({ baseName, services: sortNumberedReplicaServices(services) }))
    .filter((group) => group.services.length > 0)
    .filter((group) => matchesReplicaGroupSelector(group, selector, matchedServices));

  return candidates.length === 1 ? candidates[0]! : null;
}

function matchesReplicaGroupSelector(
  group: StatefulDatabaseReplicaGroup,
  selector: ServiceSelector,
  matchedServices: InfrastructureService[],
): boolean {
  const imageFamilies = new Set(group.services.map((service) => imageFamily(service.image)));
  if (selector.name && selector.name !== group.baseName && !group.services.some((service) => service.name === selector.name)) return false;
  if (selector.nameLike) {
    const needle = selector.nameLike.toLowerCase();
    if (!group.baseName.toLowerCase().includes(needle) && ![...imageFamilies].some((family) => family.includes(needle))) return false;
  }
  if (selector.kind && selector.kind !== 'database') return false;
  if (selector.imageFamily && ![...imageFamilies].some((family) => family.includes(selector.imageFamily!.toLowerCase()))) return false;
  if (matchedServices.length > 0) {
    const groupNames = new Set(group.services.map((service) => service.name));
    return matchedServices.every((service) => groupNames.has(service.name));
  }
  return Boolean(selector.name || selector.nameLike || selector.kind || selector.imageFamily);
}

function resizeStatefulDatabaseReplicaGroup(
  spec: InfrastructureSpec,
  group: StatefulDatabaseReplicaGroup,
  replicas: number,
): InfrastructureSpec {
  const groupNames = new Set(group.services.map((service) => service.name));
  const groupVolumeSources = new Set(group.services.flatMap((service) => (service.volumes ?? []).map(mountSource)));
  const first = group.services[0]!;
  const logicalDatabase = toLogicalDatabaseService(first, group.baseName, replicas, groupNames);
  let inserted = false;
  const logicalServices = spec.services.flatMap((service) => {
    if (groupNames.has(service.name)) {
      if (inserted) return [];
      inserted = true;
      return [logicalDatabase];
    }

    return [rewriteServiceDependencies(service, groupNames, group.baseName)];
  });

  return expandStatefulDatabaseReplicas({
    ...spec,
    services: logicalServices,
    volumes: spec.volumes.filter((volume) => !groupVolumeSources.has(volume)),
  });
}

function toLogicalDatabaseService(
  service: InfrastructureService,
  baseName: string,
  replicas: number,
  groupNames: Set<string>,
): InfrastructureService {
  const target = getDatabaseDataVolumeTarget(service);
  const dataMount = target ? (service.volumes ?? []).find((volume) => mountTarget(volume) === target) : undefined;
  const baseDataSource = dataMount ? stripReplicaOrdinal(mountSource(dataMount)) : `${baseName}-data`;
  const dependsOn = (service.dependsOn ?? []).filter((dependency) => !groupNames.has(dependency));
  const { replicas: _replicas, ...rest } = cloneService(service);
  return {
    ...rest,
    name: baseName,
    replicas,
    ...(target ? { volumes: [`${baseDataSource}:${target}`] } : {}),
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

function rewriteServiceDependencies(
  service: InfrastructureService,
  groupNames: Set<string>,
  baseName: string,
): InfrastructureService {
  if (!service.dependsOn) return service;
  return {
    ...service,
    dependsOn: unique(service.dependsOn.map((dependency) => groupNames.has(dependency) ? baseName : dependency)),
  };
}

function parseNumberedReplicaServiceName(name: string): { baseName: string; ordinal: number } | null {
  const match = /^(.+)-(\d+)$/.exec(name);
  if (!match) return null;
  return { baseName: match[1]!, ordinal: Number(match[2]) };
}

function sortNumberedReplicaServices(services: InfrastructureService[]): InfrastructureService[] {
  return [...services].sort((left, right) => (parseNumberedReplicaServiceName(left.name)?.ordinal ?? 0) - (parseNumberedReplicaServiceName(right.name)?.ordinal ?? 0));
}

function imageFamily(image: string): string {
  return image.toLowerCase().split(':')[0]?.split('/').pop() ?? '';
}

function stripReplicaOrdinal(source: string): string {
  return source.replace(/-\d+$/, '');
}

function mountSource(mount: string): string {
  return mount.split(':')[0] ?? '';
}

function mountTarget(mount: string): string {
  return mount.split(':')[1] ?? '';
}

function cloneSpec(spec: InfrastructureSpec): InfrastructureSpec {
  return {
    ...spec,
    services: spec.services.map((service) => ({
      ...service,
      ...(service.ports ? { ports: [...service.ports] } : {}),
      ...(service.dependsOn ? { dependsOn: [...service.dependsOn] } : {}),
      ...(service.environment ? { environment: { ...service.environment } } : {}),
      ...(service.volumes ? { volumes: [...service.volumes] } : {}),
    })),
    networks: [...spec.networks],
    volumes: [...spec.volumes],
  };
}

function cloneService(service: InfrastructureService): InfrastructureService {
  return {
    ...service,
    ...(service.ports ? { ports: [...service.ports] } : {}),
    ...(service.dependsOn ? { dependsOn: [...service.dependsOn] } : {}),
    ...(service.environment ? { environment: { ...service.environment } } : {}),
    ...(service.volumes ? { volumes: [...service.volumes] } : {}),
  };
}

function declaredNamedVolumes(volumeMounts: string[]): string[] {
  return volumeMounts
    .map((volume) => volume.split(':')[0] ?? '')
    .filter((source) => source.length > 0 && !source.startsWith('.') && !source.startsWith('/') && !source.includes('\\'));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
