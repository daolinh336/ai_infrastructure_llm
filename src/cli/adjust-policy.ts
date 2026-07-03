import type { InfrastructureService, InfrastructureSpec } from '../domain/types.js';

const ADJUST_REPLICA_KINDS = new Set(['backend', 'database']);

interface DatabaseGroup {
  baseName: string;
  services: InfrastructureService[];
}

const NUMBERED_REPLICA_NAME = /^(.*)-(\d+)$/;

function buildDatabaseGroups(services: InfrastructureService[]): Map<string, DatabaseGroup> {
  const groups = new Map<string, DatabaseGroup>();
  for (const service of services) {
    if (service.kind !== 'database') continue;
    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    if (!match || service.replicas !== undefined) continue;
    const baseName = match[1]!;
    const group = groups.get(baseName) ?? { baseName, services: [] };
    group.services.push(service);
    groups.set(baseName, group);
  }
  return groups;
}

function serviceFingerprint(service: InfrastructureService): string {
  return JSON.stringify({
    kind: service.kind,
    image: service.image,
    environment: service.environment ?? {},
    volumes: service.volumes ?? [],
    dependsOn: service.dependsOn ?? [],
  });
}

function databaseReplicaFingerprint(service: InfrastructureService): string {
  return JSON.stringify({
    kind: service.kind,
    image: service.image,
    environment: service.environment ?? {},
    volumeTargets: (service.volumes ?? []).map((volume) => volume.split(':').slice(1).join(':')).sort(),
  });
}

function normalizeDependsOn(dependencies: string[] | undefined, databaseGroupBaseNames: Set<string>): string[] {
  return [...new Set((dependencies ?? []).map((dependency) => {
    const match = NUMBERED_REPLICA_NAME.exec(dependency);
    return match && databaseGroupBaseNames.has(match[1]!) ? match[1]! : dependency;
  }))].sort();
}


export type SupportedAdjustChangeKind = 'port' | 'replicas';

export interface SupportedAdjustChange {
  kind: SupportedAdjustChangeKind;
  serviceName: string;
  message: string;
}

export function detectSupportedAdjustChanges(
  revised: InfrastructureSpec,
  original: InfrastructureSpec,
): SupportedAdjustChange[] {
  const changes: SupportedAdjustChange[] = [];
  const originalGroups = buildDatabaseGroups(original.services);
  const revisedGroups = buildDatabaseGroups(revised.services);
  const originalByName = new Map(original.services.map((service) => [service.name, service]));
  const handledReplicaGroups = new Set<string>();

  for (const service of revised.services) {
    const before = originalByName.get(service.name);
    if (before) {
      if (JSON.stringify(before.ports ?? []) !== JSON.stringify(service.ports ?? [])) {
        changes.push({
          kind: 'port',
          serviceName: service.name,
          message: `Port change on service "${service.name}".`,
        });
      }

      const beforeReplicas = before.replicas ?? 1;
      const afterReplicas = service.replicas ?? 1;
      if (beforeReplicas !== afterReplicas && ADJUST_REPLICA_KINDS.has(service.kind)) {
        changes.push({
          kind: 'replicas',
          serviceName: service.name,
          message: `Replica change on ${service.kind} service "${service.name}": ${beforeReplicas} -> ${afterReplicas}.`,
        });
      }
    }

    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    if (match && revisedGroups.has(match[1]!) && !handledReplicaGroups.has(match[1]!)) {
      const baseName = match[1]!;
      handledReplicaGroups.add(baseName);
      const beforeCount = originalGroups.get(baseName)?.services.length ?? 0;
      const afterCount = revisedGroups.get(baseName)?.services.length ?? 0;
      if (beforeCount !== afterCount && afterCount >= 1) {
        changes.push({
          kind: 'replicas',
          serviceName: baseName,
          message: `Replica change on database group "${baseName}": ${beforeCount} -> ${afterCount}.`,
        });
      }
    }
  }

  return changes;
}

export interface AdjustScopeViolation {
  message: string;
}

export function diffAdjustScope(
  revised: InfrastructureSpec,
  original: InfrastructureSpec,
): AdjustScopeViolation[] {
  const violations: AdjustScopeViolation[] = [];

  const originalGroups = buildDatabaseGroups(original.services);
  const revisedGroups = buildDatabaseGroups(revised.services);
  const originalGroupedNames = new Set<string>();
  const revisedGroupedNames = new Set<string>();
  for (const group of originalGroups.values()) {
    for (const service of group.services) originalGroupedNames.add(service.name);
  }
  for (const group of revisedGroups.values()) {
    for (const service of group.services) revisedGroupedNames.add(service.name);
  }

  const originalByName = new Map(original.services.map((service) => [service.name, service]));
  const revisedByName = new Map(revised.services.map((service) => [service.name, service]));

  for (const service of original.services) {
    if (originalGroupedNames.has(service.name)) continue;
    if (!revisedByName.has(service.name)) {
      violations.push({ message: `Adjust scope: service "${service.name}" was removed. Only port and replica changes are allowed.` });
    }
  }
  for (const service of revised.services) {
    if (revisedGroupedNames.has(service.name)) continue;
    if (!originalByName.has(service.name)) {
      violations.push({ message: `Adjust scope: service "${service.name}" was added. Only port and replica changes are allowed.` });
    }
  }

  const databaseGroupBaseNamesForDepends = new Set([...originalGroups.keys(), ...revisedGroups.keys()]);
  for (const service of revised.services) {
    if (revisedGroupedNames.has(service.name)) continue;
    const before = originalByName.get(service.name);
    if (!before) continue;

    if (service.kind !== before.kind) {
      violations.push({ message: `Adjust scope: service "${service.name}" kind changed from ${before.kind} to ${service.kind}. Only port and replica changes are allowed.` });
    }
    if (service.image !== before.image) {
      violations.push({ message: `Adjust scope: service "${service.name}" image changed "${before.image}" -> "${service.image}". Only port and replica changes are allowed.` });
    }
    const envChanged = JSON.stringify(service.environment ?? {}) !== JSON.stringify(before.environment ?? {});
    const volumesChanged = JSON.stringify(service.volumes ?? []) !== JSON.stringify(before.volumes ?? []);
    const dependsChanged = JSON.stringify(normalizeDependsOn(service.dependsOn, databaseGroupBaseNamesForDepends)) !== JSON.stringify(normalizeDependsOn(before.dependsOn, databaseGroupBaseNamesForDepends));
    if (envChanged || volumesChanged || dependsChanged) {
      violations.push({ message: `Adjust scope: service "${service.name}" changed a field other than ports or replicas. Only port and replica changes are allowed.` });
    }
  }

  const foldedBaseNames = new Set([...originalGroups.keys(), ...revisedGroups.keys()]);
  for (const baseName of foldedBaseNames) {
    const beforeGroup = originalGroups.get(baseName)?.services ?? [];
    const afterGroup = revisedGroups.get(baseName)?.services ?? [];
    const beforeFingerprints = [...new Set(beforeGroup.map(databaseReplicaFingerprint))].sort();
    const afterFingerprints = [...new Set(afterGroup.map(databaseReplicaFingerprint))].sort();
    if (JSON.stringify(beforeFingerprints) !== JSON.stringify(afterFingerprints)) {
      violations.push({ message: `Adjust scope: database replica group "${baseName}" changed fields other than replica count or ports. Only port and replica changes are allowed.` });
    }
  }

  if (JSON.stringify(original.networks) !== JSON.stringify(revised.networks)) {
    violations.push({ message: 'Adjust scope: networks changed. Only port and replica changes are allowed.' });
  }
  const originalVolumes = new Set(original.volumes);
  const revisedVolumes = new Set(revised.volumes);
  const changedVolumes = [
    ...original.volumes.filter((volume) => !revisedVolumes.has(volume)),
    ...revised.volumes.filter((volume) => !originalVolumes.has(volume)),
  ];
  const databaseGroupBaseNames = new Set([...originalGroups.keys(), ...revisedGroups.keys()]);
  const onlyDatabaseReplicaVolumesChanged = changedVolumes.every((volume) => {
    const match = /^(.*)-data-\d+$/.exec(volume) ?? /^(.*)-\d+$/.exec(volume);
    return Boolean(match && databaseGroupBaseNames.has(match[1]!));
  });
  if (changedVolumes.length > 0 && !onlyDatabaseReplicaVolumesChanged) {
    violations.push({ message: 'Adjust scope: named volumes changed. Only port and replica changes are allowed.' });
  }
  if (original.projectName !== revised.projectName) {
    violations.push({ message: 'Adjust scope: projectName changed. Only port and replica changes are allowed.' });
  }

  return violations;
}

export interface AdjustReplicaViolation {
  serviceName: string;
  message: string;
}

function foldReplicaCount(service: InfrastructureService, groups: Map<string, DatabaseGroup>): number {
  if (service.replicas !== undefined) return service.replicas ?? 1;
  const match = NUMBERED_REPLICA_NAME.exec(service.name);
  if (match && groups.has(match[1]!)) {
    return groups.get(match[1]!)!.services.length;
  }
  return 1;
}

export function validateAdjustReplicas(
  revised: InfrastructureSpec,
  original: InfrastructureSpec,
): AdjustReplicaViolation[] {
  const violations: AdjustReplicaViolation[] = [];
  const originalGroups = buildDatabaseGroups(original.services);
  const revisedGroups = buildDatabaseGroups(revised.services);
  const originalByName = new Map(original.services.map((service) => [service.name, service]));
  const originalLabels = new Map<string, string>();
  for (const service of original.services) {
    originalLabels.set(service.name, service.name);
    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    if (match && originalGroups.has(match[1]!)) {
      originalLabels.set(match[1]!, service.name);
    }
  }

  const handledRevised = new Set<string>();
  for (const service of revised.services) {
    if (handledRevised.has(service.name)) continue;
    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    const logicalName =
      match && revisedGroups.has(match[1]!) ? match[1]! : service.name;
    const groupServices = match && revisedGroups.has(match[1]!)
      ? revisedGroups.get(match[1]!)!.services
      : [service];
    for (const grouped of groupServices) handledRevised.add(grouped.name);

    const before = originalByName.get(logicalName) ?? originalByName.get(service.name);
    if (!before) continue;

    const beforeReplicas = before.replicas ?? foldReplicaCount(before, originalGroups);
    const afterReplicas = match && revisedGroups.has(match[1]!)
      ? groupServices.length
      : service.replicas ?? 1;

    if (afterReplicas === beforeReplicas) continue;

    if (!ADJUST_REPLICA_KINDS.has(service.kind)) {
      violations.push({
        serviceName: logicalName,
        message: `Adjust replicas: service "${logicalName}" is kind "${service.kind}"; replica adjustments are only supported for backend and database services.`,
      });
      continue;
    }

    if (afterReplicas < 1) {
      violations.push({
        serviceName: logicalName,
        message: `Adjust replicas: service "${logicalName}" replicas must be >= 1 (received ${afterReplicas}). Reducing to zero is not allowed.`,
      });
    }
  }

  return violations;
}

export interface AdjustPortConflict {
  hostPort: string;
  serviceName: string;
  usedByContainer: string;
  message: string;
}

export function detectAdjustPortConflicts(
  revised: InfrastructureSpec,
  usedHostPorts: Array<{ hostPort: string; containerName: string }>,
  ownProjectName: string,
): AdjustPortConflict[] {
  const conflicts: AdjustPortConflict[] = [];
  const usedByPort = new Map<string, string[]>();
  for (const entry of usedHostPorts) {
    const containers = usedByPort.get(entry.hostPort) ?? [];
    containers.push(entry.containerName);
    usedByPort.set(entry.hostPort, containers);
  }

  for (const service of revised.services) {
    for (const port of service.ports ?? []) {
      const hostPort = port.split(':')[0]?.trim();
      if (!hostPort || !/^\d+$/.test(hostPort)) continue;
      const occupants = (usedByPort.get(hostPort) ?? []).filter(
        (containerName) => !containerName.startsWith(ownProjectName + '-'),
      );
      for (const containerName of occupants) {
        conflicts.push({
          hostPort,
          serviceName: service.name,
          usedByContainer: containerName,
          message: `Adjust port: host port ${hostPort} requested by service "${service.name}" is already used by container "${containerName}".`,
        });
      }
    }
  }

  return conflicts;
}
