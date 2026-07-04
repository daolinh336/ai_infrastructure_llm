import { isSecretLikeKey } from '../compose/secret-resolver.js';
import type {
  InfrastructureService,
  InfrastructureSpec,
} from '../domain/types.js';

const ADJUST_REPLICA_KINDS = new Set(['backend', 'database']);

interface DatabaseGroup {
  baseName: string;
  services: InfrastructureService[];
}

const NUMBERED_REPLICA_NAME = /^(.*)-(\d+)$/;

function buildDatabaseGroups(
  services: InfrastructureService[],
): Map<string, DatabaseGroup> {
  const groups = new Map<string, DatabaseGroup>();
  for (const service of services) {
    if (service.kind !== 'database') continue;
    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    const baseName = match ? match[1]! : service.name;
    const group = groups.get(baseName) ?? { baseName, services: [] };
    group.services.push(service);
    groups.set(baseName, group);
  }
  return groups;
}

function databaseReplicaTemplateFingerprint(
  service: InfrastructureService,
): string {
  return JSON.stringify({
    kind: service.kind,
    image: service.image,
    environment: comparableEnvironment(service),
    volumeTargets: getVolumeTargets(service),
  });
}

function databaseReplicaPrimaryFingerprint(
  service: InfrastructureService,
): string {
  return JSON.stringify({
    kind: service.kind,
    image: service.image,
    environment: comparableEnvironment(service, { includeSecretValues: true }),
    volumeTargets: getVolumeTargets(service),
  });
}

function comparableEnvironment(
  service: InfrastructureService,
  options: { includeSecretValues?: boolean } = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(service.environment ?? {})
      .filter(([key]) => options.includeSecretValues || !isSecretLikeKey(key))
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

function getVolumeTargets(service: InfrastructureService): string[] {
  return (service.volumes ?? [])
    .map((volume) => volume.split(':').slice(1).join(':'))
    .sort();
}

function databaseGroupTemplateFingerprint(
  services: InfrastructureService[],
): string | null {
  const fingerprints = [
    ...new Set(services.map(databaseReplicaTemplateFingerprint)),
  ].sort();
  if (fingerprints.length === 0) return null;
  return fingerprints.length === 1
    ? fingerprints[0]!
    : JSON.stringify(fingerprints);
}

function databaseGroupPrimaryFingerprint(
  services: InfrastructureService[],
): string | null {
  const primary = sortDatabaseGroupServices(services)[0];
  return primary ? databaseReplicaPrimaryFingerprint(primary) : null;
}

function sortDatabaseGroupServices(
  services: InfrastructureService[],
): InfrastructureService[] {
  return [...services].sort((left, right) => {
    const leftOrdinal = getDatabaseReplicaOrdinal(left.name);
    const rightOrdinal = getDatabaseReplicaOrdinal(right.name);
    return leftOrdinal - rightOrdinal || left.name.localeCompare(right.name);
  });
}

function getDatabaseReplicaOrdinal(serviceName: string): number {
  const match = NUMBERED_REPLICA_NAME.exec(serviceName);
  if (!match) return 1;
  const ordinal = Number(match[2]);
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : 1;
}
function normalizeDependsOn(
  dependencies: string[] | undefined,
  databaseGroupBaseNames: Set<string>,
): string[] {
  return [
    ...new Set(
      (dependencies ?? []).map((dependency) => {
        const match = NUMBERED_REPLICA_NAME.exec(dependency);
        return match && databaseGroupBaseNames.has(match[1]!)
          ? match[1]!
          : dependency;
      }),
    ),
  ].sort();
}

export type SupportedAdjustChangeKind = 'replicas';

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
  const originalByName = new Map(
    original.services.map((service) => [service.name, service]),
  );
  const handledReplicaGroups = new Set<string>();

  for (const service of revised.services) {
    const before = originalByName.get(service.name);
    if (before) {
      const beforeReplicas = before.replicas ?? 1;
      const afterReplicas = service.replicas ?? 1;
      if (
        beforeReplicas !== afterReplicas &&
        ADJUST_REPLICA_KINDS.has(service.kind)
      ) {
        changes.push({
          kind: 'replicas',
          serviceName: service.name,
          message: `Replica change on ${service.kind} service "${service.name}": ${beforeReplicas} -> ${afterReplicas}.`,
        });
      }
    }

    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    const baseName = match ? match[1]! : service.name;
    if (revisedGroups.has(baseName) && !handledReplicaGroups.has(baseName)) {
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
    for (const service of group.services)
      originalGroupedNames.add(service.name);
  }
  for (const group of revisedGroups.values()) {
    for (const service of group.services) revisedGroupedNames.add(service.name);
  }

  const originalByName = new Map(
    original.services.map((service) => [service.name, service]),
  );
  const revisedByName = new Map(
    revised.services.map((service) => [service.name, service]),
  );

  for (const service of original.services) {
    if (originalGroupedNames.has(service.name)) continue;
    if (!revisedByName.has(service.name)) {
      violations.push({
        message: `Adjust scope: service "${service.name}" was removed. Only backend/database replica changes are supported.`,
      });
    }
  }
  for (const service of revised.services) {
    if (revisedGroupedNames.has(service.name)) continue;
    if (!originalByName.has(service.name)) {
      violations.push({
        message: `Adjust scope: service "${service.name}" was added. Only backend/database replica changes are supported.`,
      });
    }
  }

  const databaseGroupBaseNamesForDepends = new Set([
    ...originalGroups.keys(),
    ...revisedGroups.keys(),
  ]);
  for (const service of revised.services) {
    if (revisedGroupedNames.has(service.name)) continue;
    const before = originalByName.get(service.name);
    if (!before) continue;

    if (service.kind !== before.kind) {
      violations.push({
        message: `Adjust scope: service "${service.name}" kind changed from ${before.kind} to ${service.kind}. Only backend/database replica changes are supported.`,
      });
    }
    if (service.image !== before.image) {
      violations.push({
        message: `Adjust scope: service "${service.name}" image changed "${before.image}" -> "${service.image}". Only backend/database replica changes are supported.`,
      });
    }
    const portsChanged =
      JSON.stringify(service.ports ?? []) !==
      JSON.stringify(before.ports ?? []);
    const envChanged =
      JSON.stringify(service.environment ?? {}) !==
      JSON.stringify(before.environment ?? {});
    const volumesChanged =
      JSON.stringify(service.volumes ?? []) !==
      JSON.stringify(before.volumes ?? []);
    const dependsChanged =
      JSON.stringify(
        normalizeDependsOn(service.dependsOn, databaseGroupBaseNamesForDepends),
      ) !==
      JSON.stringify(
        normalizeDependsOn(before.dependsOn, databaseGroupBaseNamesForDepends),
      );
    if (portsChanged || envChanged || volumesChanged || dependsChanged) {
      violations.push({
        message: `Adjust scope: service "${service.name}" changed a field other than replicas. Only backend/database replica changes are supported.`,
      });
    }
  }

  const foldedBaseNames = new Set([
    ...originalGroups.keys(),
    ...revisedGroups.keys(),
  ]);
  for (const baseName of foldedBaseNames) {
    const beforeGroup = originalGroups.get(baseName)?.services ?? [];
    const afterGroup = revisedGroups.get(baseName)?.services ?? [];
    if (
      databaseGroupTemplateFingerprint(beforeGroup) !==
        databaseGroupTemplateFingerprint(afterGroup) ||
      databaseGroupPrimaryFingerprint(beforeGroup) !==
        databaseGroupPrimaryFingerprint(afterGroup)
    ) {
      violations.push({
        message: `Adjust scope: database replica group "${baseName}" changed fields other than replica count. Only backend/database replica changes are supported.`,
      });
    }
  }
  if (JSON.stringify(original.networks) !== JSON.stringify(revised.networks)) {
    violations.push({
      message:
        'Adjust scope: networks changed. Only backend/database replica changes are supported.',
    });
  }
  const originalVolumes = new Set(original.volumes);
  const revisedVolumes = new Set(revised.volumes);
  const changedVolumes = [
    ...original.volumes.filter((volume) => !revisedVolumes.has(volume)),
    ...revised.volumes.filter((volume) => !originalVolumes.has(volume)),
  ];
  const databaseGroupBaseNames = new Set([
    ...originalGroups.keys(),
    ...revisedGroups.keys(),
  ]);
  const projectNamePrefix = original.projectName + '-';
  const onlyDatabaseReplicaVolumesChanged = changedVolumes.every((volume) => {
    let match = /^(.*)-data-\d+$/.exec(volume);
    if (match) {
      const base = match[1]!;
      return (
        databaseGroupBaseNames.has(base) ||
        (base.startsWith(projectNamePrefix) &&
          databaseGroupBaseNames.has(base.slice(projectNamePrefix.length)))
      );
    }
    match = /^(.*)-\d+$/.exec(volume);
    if (match) {
      const base = match[1]!;
      return (
        databaseGroupBaseNames.has(base) ||
        (base.startsWith(projectNamePrefix) &&
          databaseGroupBaseNames.has(base.slice(projectNamePrefix.length)))
      );
    }
    match = /^(.*)-data$/.exec(volume);
    if (match) {
      const base = match[1]!;
      return (
        databaseGroupBaseNames.has(base) ||
        (base.startsWith(projectNamePrefix) &&
          databaseGroupBaseNames.has(base.slice(projectNamePrefix.length)))
      );
    }
    return (
      databaseGroupBaseNames.has(volume) ||
      (volume.startsWith(projectNamePrefix) &&
        databaseGroupBaseNames.has(volume.slice(projectNamePrefix.length)))
    );
  });
  if (changedVolumes.length > 0 && !onlyDatabaseReplicaVolumesChanged) {
    violations.push({
      message:
        'Adjust scope: named volumes changed. Only backend/database replica changes are supported.',
    });
  }
  if (original.projectName !== revised.projectName) {
    violations.push({
      message:
        'Adjust scope: projectName changed. Only backend/database replica changes are supported.',
    });
  }

  return violations;
}

export interface AdjustReplicaViolation {
  serviceName: string;
  message: string;
}

function foldReplicaCount(
  service: InfrastructureService,
  groups: Map<string, DatabaseGroup>,
): number {
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
  const originalByName = new Map(
    original.services.map((service) => [service.name, service]),
  );
  const handledRevised = new Set<string>();
  for (const service of revised.services) {
    if (handledRevised.has(service.name)) continue;
    const match = NUMBERED_REPLICA_NAME.exec(service.name);
    const logicalName =
      match && revisedGroups.has(match[1]!) ? match[1]! : service.name;
    const groupServices =
      match && revisedGroups.has(match[1]!)
        ? revisedGroups.get(match[1]!)!.services
        : [service];
    for (const grouped of groupServices) handledRevised.add(grouped.name);

    const before =
      originalByName.get(logicalName) ?? originalByName.get(service.name);
    if (!before) continue;

    const beforeReplicas =
      before.replicas ?? foldReplicaCount(before, originalGroups);
    const afterReplicas =
      match && revisedGroups.has(match[1]!)
        ? groupServices.length
        : (service.replicas ?? 1);

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
