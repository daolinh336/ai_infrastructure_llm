import type {
  FeedbackIntent,
  InfrastructureService,
  InfrastructureSpec,
  ResolvedSpecPatchResult,
  ServiceSelector,
  SpecPatch,
  VerificationFinding,
} from '../domain/types.js';
import { expandStatefulDatabaseReplicas, getDatabaseDataVolumeTarget } from '../domain/stateful-database-volumes.js';
import { getTrustedImageProfile } from '../domain/supported-images.js';

export function applySpecPatchPlan(
  spec: InfrastructureSpec,
  patches: SpecPatch[],
  options: { allowBlockedPatchOps?: string[]; verificationFindings?: VerificationFinding[]; feedbackIntent?: FeedbackIntent | null } = {},
): { spec: InfrastructureSpec; results: ResolvedSpecPatchResult[] } {
  let revised = stripDisallowedHostPortsFromSpec(cloneSpec(spec));
  const results: ResolvedSpecPatchResult[] = [];
  const allowedBlockedOps = new Set(options.allowBlockedPatchOps ?? []);

  for (const patch of patches) {
    const resolution = resolvePatchTargets(revised, patch);
    const relevanceBlock = resolution.blockedReason === null
      ? evaluatePatchRelevance(patch, resolution.matchedServices, options.verificationFindings ?? [], options.feedbackIntent ?? null)
      : null;
    const policyBlock = resolution.blockedReason ?? relevanceBlock ?? (allowedBlockedOps.has(patch.op) ? null : evaluatePatchPolicy(revised, patch, resolution.matchedServices));
    const before = JSON.stringify(revised);
    revised = policyBlock === null
      ? stripDisallowedHostPortsFromSpec(applyResolvedPatch(revised, patch, resolution.matchedServices))
      : revised;
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

  if (patch.op === 'set-service-replicas' && patch.target.targetKind === 'replica-group') {
    const databaseGroup = resolveStatefulDatabaseReplicaGroup(spec, patch.target, []);
    if (databaseGroup !== null) return { matchedServices: databaseGroup.services, blockedReason: null };
    return { matchedServices: [], blockedReason: `No matching replica group for selector ${formatSelector(patch.target)}. Available replica groups: ${formatReplicaGroups(spec)}. Available services: ${formatServices(spec)}. Suggested fix: target an existing service by name/kind, or first create an expanded stateful DB replica group before using targetKind="replica-group".` };
  }

  const matches = resolveServiceSelector(spec, patch.target);
  if (matches.length === 0) {
    if (patch.op === 'set-service-replicas' && resolveStatefulDatabaseReplicaGroup(spec, patch.target, []) !== null) {
      return { matchedServices: [], blockedReason: null };
    }
    return { matchedServices: [], blockedReason: `No matching service for selector ${formatSelector(patch.target)}. Available services: ${formatServices(spec)}. Suggested fix: use one of the listed service names, or clarify which service should change.` };
  }

  if (matches.length > 1) {
    if (patch.op === 'set-service-replicas' && resolveStatefulDatabaseReplicaGroup(spec, patch.target, matches) !== null) {
      return { matchedServices: matches, blockedReason: null };
    }
    return { matchedServices: matches, blockedReason: `Ambiguous selector ${formatSelector(patch.target)} matched multiple services: ${matches.map((service) => service.name).join(', ')}. Suggested fix: choose exactly one service name.` };
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

function canExposeHostPorts(service: InfrastructureService): boolean {
  return service.kind === 'reverse-proxy';
}

function stripDisallowedHostPorts(service: InfrastructureService): InfrastructureService {
  if (canExposeHostPorts(service) || !service.ports?.length) return service;
  const { ports: _removedPorts, ...rest } = service;
  return rest;
}

function stripDisallowedHostPortsFromSpec(spec: InfrastructureSpec): InfrastructureSpec {
  return {
    ...spec,
    services: spec.services.map(stripDisallowedHostPorts),
  };
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
    const service = stripDisallowedHostPorts(cloneService(patch.service));
    return {
      ...spec,
      services: [...spec.services, service],
      networks: spec.networks.length > 0 ? spec.networks : ['app-network'],
      volumes: unique([...spec.volumes, ...declaredNamedVolumes(service.volumes ?? [])]),
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

  const services = spec.services.map((service) => {
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
      return rebuildServiceForTrustedImage(service, patch.image);
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
  });

  return {
    ...spec,
    services,
    ...(patch.op === 'add-service-volume'
      ? { volumes: unique([...spec.volumes, ...declaredNamedVolumes([patch.volume])]) }
      : {}),
  };
}

function evaluatePatchRelevance(
  patch: SpecPatch,
  matchedServices: InfrastructureService[],
  findings: VerificationFinding[],
  feedbackIntent: FeedbackIntent | null,
): string | null {
  if (findings.length === 0) return null;
  if (feedbackIntent?.intent === 'change-replicas' && feedbackIntent.desiredChange?.replicas !== undefined) return null;

  const findingCodes = new Set(findings.map((finding) => finding.code));
  const affectedServices = new Set(findings.flatMap((finding) => finding.resourceName ? [extractServiceName(finding.resourceName)] : []));
  const patchCodes = new Set(patch.resolvesIssueCodes ?? []);
  const patchServices = new Set(patch.affectedServiceNames ?? []);
  const matchedNames = new Set(matchedServices.map((service) => service.name));

  if (patchCodes.size > 0 && ![...patchCodes].some((code) => findingCodes.has(code))) {
    return 'Patch does not address the reported runtime issue.';
  }

  if (affectedServices.size > 0 && patchServices.size > 0 && ![...patchServices].some((service) => affectedServices.has(service))) {
    return 'Patch targets a different service than the reported runtime issue.';
  }

  if (patchServices.size > 0 && affectedServices.size > 0 && matchedNames.size > 0 && ![...matchedNames].some((service) => affectedServices.has(service))) {
    return 'Patch target does not match the service reported by the runtime issue.';
  }

  if (patch.op === 'set-service-replicas' && !isReplicaRelevant(findings)) {
    return 'Patch does not address the reported runtime issue.';
  }

  return null;
}

function extractServiceName(resourceName: string): string {
  const parts = resourceName.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? resourceName;
}

function isReplicaRelevant(findings: VerificationFinding[]): boolean {
  return findings.some((finding) => {
    const text = [finding.code, finding.resourceKind, finding.expected, finding.actual, ...finding.evidence].filter(Boolean).join(' ').toLowerCase();
    return finding.code.includes('REPLICA') || finding.resourceKind === 'container' || /replica|instance|container count/.test(text);
  });
}

function formatSelector(selector: ServiceSelector): string {
  return JSON.stringify(selector);
}

function formatServices(spec: InfrastructureSpec): string {
  return spec.services.map((service) => `${service.name}(${service.kind}, ${service.image})`).join(', ') || 'none';
}

function formatReplicaGroups(spec: InfrastructureSpec): string {
  const groups = new Map<string, string[]>();
  for (const service of spec.services) {
    if (service.kind !== 'database') continue;
    const parsed = parseNumberedReplicaServiceName(service.name);
    if (!parsed) continue;
    groups.set(parsed.baseName, [...(groups.get(parsed.baseName) ?? []), service.name]);
  }
  return [...groups.entries()].map(([baseName, services]) => `${baseName}=[${services.join(', ')}]`).join('; ') || 'none';
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

function rebuildServiceForTrustedImage(service: InfrastructureService, image: string): InfrastructureService {
  const profile = getTrustedImageProfile(image);
  const nextPorts = profile?.defaultPorts.length ? profile.defaultPorts : service.ports;
  const nextEnvironment = profile && Object.keys(profile.defaultEnvironment).length > 0
    ? { ...profile.defaultEnvironment, ...(service.environment ?? {}) }
    : service.environment;
  const nextVolumes = profile?.defaultVolumes.length
    ? profile.defaultVolumes.map((mount) => {
        const target = mount.split(':')[1] ?? '';
        const existing = (service.volumes ?? []).find((candidate) => target && candidate.endsWith(':' + target));
        return existing ?? mount.replace(/^data:/, `${service.name}-data:`);
      })
    : service.volumes;

  return {
    ...service,
    kind: inferServiceKind(image),
    image,
    ...(nextPorts && nextPorts.length > 0 ? { ports: nextPorts } : {}),
    ...(nextEnvironment && Object.keys(nextEnvironment).length > 0 ? { environment: nextEnvironment } : {}),
    ...(nextVolumes && nextVolumes.length > 0 ? { volumes: nextVolumes } : {}),
  };
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
  const logicalGroups: StatefulDatabaseReplicaGroup[] = [];
  for (const service of spec.services) {
    if (service.kind !== 'database') continue;
    const parsed = parseNumberedReplicaServiceName(service.name);
    if (!parsed && selector.targetKind === 'replica-group') {
      logicalGroups.push({ baseName: service.name, services: [service] });
      continue;
    }
    if (!parsed) continue;
    const services = groups.get(parsed.baseName) ?? [];
    services.push(service);
    groups.set(parsed.baseName, services);
  }

  const candidates = [
    ...logicalGroups,
    ...[...groups.entries()]
    .map(([baseName, services]) => ({ baseName, services: sortNumberedReplicaServices(services) }))
  ]
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
  if (selector.targetKind === 'service') return false;
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

  if (replicas === 1) {
    const keptService = toSinglePhysicalDatabaseService(first, groupNames);
    const services = spec.services.flatMap((service) => {
      if (groupNames.has(service.name)) return service.name === first.name ? [keptService] : [];
      return [rewriteServiceDependencies(service, groupNames, first.name)];
    });
    return {
      ...spec,
      services,
      volumes: unique([
        ...spec.volumes.filter((volume) => !groupVolumeSources.has(volume)),
        ...declaredNamedVolumes(keptService.volumes ?? []),
      ]),
    };
  }

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

  const resized = expandStatefulDatabaseReplicas({
    ...spec,
    services: logicalServices,
    volumes: spec.volumes.filter((volume) => !groupVolumeSources.has(volume)),
  });

  return {
    ...resized,
    volumes: unique([
      ...resized.volumes,
      ...resized.services.flatMap((service) => declaredNamedVolumes(service.volumes ?? [])),
    ]),
  };
}

function toSinglePhysicalDatabaseService(
  service: InfrastructureService,
  groupNames: Set<string>,
): InfrastructureService {
  const { replicas: _replicas, ...rest } = cloneService(service);
  const dependsOn = (rest.dependsOn ?? []).filter((dependency) => !groupNames.has(dependency));
  const { dependsOn: _dependsOn, ...serviceWithoutDependsOn } = rest;
  return {
    ...serviceWithoutDependsOn,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
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
