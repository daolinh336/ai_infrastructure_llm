import type { InfrastructureService, InfrastructureSpec } from './types.js';
import { getImageReferenceBase } from './supported-images.js';

type DatabaseVolumeService = {
  kind: InfrastructureService['kind'];
  image: string;
  name: string;
  replicas?: number | undefined;
  volumes?: string[] | undefined;
};

const DATABASE_DATA_TARGETS: Record<string, string> = {
  postgres: '/var/lib/postgresql/data',
  mysql: '/var/lib/mysql',
  mariadb: '/var/lib/mysql',
  mongo: '/data/db',
  redis: '/data',
  rabbitmq: '/var/lib/rabbitmq',
  elasticsearch: '/usr/share/elasticsearch/data',
  kafka: '/tmp/kraft-combined-logs',
};

export function getDatabaseDataVolumeTarget(service: DatabaseVolumeService): string | null {
  if (service.kind !== 'database') return null;
  return DATABASE_DATA_TARGETS[getImageReferenceBase(service.image)] ?? '/data';
}

export function hasSharedDatabaseDataVolume(service: DatabaseVolumeService): boolean {
  const replicas = service.replicas ?? 1;
  const target = getDatabaseDataVolumeTarget(service);
  if (replicas <= 1 || !target) return false;

  return (service.volumes ?? []).some((mount) => mountTarget(mount) === target);
}

export function normalizeStatefulDatabaseReplicaVolumes(
  spec: InfrastructureSpec,
): InfrastructureSpec {
  const explicitSpec = expandStatefulDatabaseReplicas(spec);
  const generatedVolumes = new Set(explicitSpec.volumes);

  for (const service of explicitSpec.services) {
    for (const volume of getGeneratedDatabaseReplicaVolumeNames(service)) {
      generatedVolumes.add(volume);
    }
  }

  return {
    ...explicitSpec,
    services: explicitSpec.services.map((service) => ({
      ...service,
      ...(service.volumes ? { volumes: [...service.volumes] } : {}),
      ...(service.dependsOn ? { dependsOn: [...service.dependsOn] } : {}),
      ...(service.ports ? { ports: [...service.ports] } : {}),
      ...(service.environment ? { environment: { ...service.environment } } : {}),
    })),
    networks: [...explicitSpec.networks],
    volumes: [...generatedVolumes],
  };
}

export function expandStatefulDatabaseReplicas(spec: InfrastructureSpec): InfrastructureSpec {
  const generatedVolumes = new Set(spec.volumes);
  const replacedDataVolumes = new Set<string>();
  const expandedServiceNames = new Map<string, string[]>();
  const services = spec.services.flatMap((service) => {
    const replicas = service.replicas ?? 1;
    const target = getDatabaseDataVolumeTarget(service);
    if (service.kind !== 'database' || replicas <= 1 || !target) {
      expandedServiceNames.set(service.name, [service.name]);
      return [cloneService(service)];
    }

    const names = Array.from({ length: replicas }, (_, index) => getDatabaseReplicaServiceName(service.name, index));
    expandedServiceNames.set(service.name, names);
    (service.volumes ?? [])
      .filter((mount) => mountTarget(mount) === target)
      .map(mountSource)
      .forEach((source) => replacedDataVolumes.add(source));

    return names.map((name, index) => {
      const { replicas: _replicas, ...rest } = cloneService(service);
      const volumes = getContainerVolumeMountsForReplica(service, index) ?? [];
      volumes.forEach((volume) => {
        const source = mountSource(volume);
        if (source && !source.startsWith('.') && !source.startsWith('/') && !source.includes('\\')) {
          generatedVolumes.add(source);
        }
      });

      return {
        ...rest,
        name,
        ...(index === 0
          ? {}
          : { dependsOn: unique([...(rest.dependsOn ?? []), names[0]!]) }),
        ...(volumes.length > 0 ? { volumes } : {}),
      };
    });
  });

  return {
    ...spec,
    services: services.map((service) => {
      const dependsOn = (service.dependsOn ?? []).flatMap(
        (dependency) => expandedServiceNames.get(dependency) ?? [dependency],
      );
      return dependsOn.length > 0 ? { ...service, dependsOn: unique(dependsOn) } : service;
    }),
    volumes: [...generatedVolumes].filter((volume) => !replacedDataVolumes.has(volume)),
  };
}

export function getContainerVolumeMountsForReplica(
  service: DatabaseVolumeService,
  replicaIndex: number,
): string[] | undefined {
  const mounts = service.volumes ?? [];
  const target = getDatabaseDataVolumeTarget(service);
  const replicas = service.replicas ?? 1;

  if (replicas <= 1 || !target) return mounts.length ? [...mounts] : undefined;

  const nonDataMounts = mounts.filter((mount) => mountTarget(mount) !== target);
  return [
    ...nonDataMounts,
    `${getDatabaseReplicaVolumeName(service, replicaIndex)}:${target}`,
  ];
}

export function getGeneratedDatabaseReplicaVolumeNames(
  service: DatabaseVolumeService,
): string[] {
  const replicas = service.replicas ?? 1;
  const target = getDatabaseDataVolumeTarget(service);
  if (replicas <= 1 || !target) return [];

  return Array.from({ length: replicas }, (_, index) =>
    getDatabaseReplicaVolumeName(service, index),
  );
}

function getDatabaseReplicaVolumeName(
  service: DatabaseVolumeService,
  replicaIndex: number,
): string {
  const dataMount = (service.volumes ?? []).find(
    (mount) => mountTarget(mount) === getDatabaseDataVolumeTarget(service),
  );
  const baseSource = dataMount ? mountSource(dataMount) : `${service.name}-data`;
  return `${baseSource}-${replicaIndex + 1}`;
}

function getDatabaseReplicaServiceName(baseName: string, replicaIndex: number): string {
  return `${baseName}-${replicaIndex + 1}`;
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

function mountSource(mount: string): string {
  return mount.split(':')[0] ?? '';
}

function mountTarget(mount: string): string {
  return mount.split(':')[1] ?? '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
