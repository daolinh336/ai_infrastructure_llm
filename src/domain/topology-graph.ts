import type { InfrastructureService } from './types.js';

export interface ServiceDependencyGraph {
  serviceStartOrder: string[];
  dependents: Map<string, string[]>;
  dependencyGraph: Array<{
    serviceName: string;
    dependsOn: string[];
    dependents: string[];
  }>;
}

export function inferMissingServiceDependencies(
  services: InfrastructureService[],
): InfrastructureService[] {
  const databaseNames = services
    .filter((service) => service.kind === 'database')
    .map((service) => service.name);
  const backendNames = services
    .filter((service) => service.kind === 'backend')
    .map((service) => service.name);

  return services.map((service) => {
    const inferred = new Set(service.dependsOn ?? []);

    if (service.kind === 'backend') {
      databaseNames.forEach((name) => inferred.add(name));
    }

    if (service.kind === 'reverse-proxy') {
      backendNames.forEach((name) => inferred.add(name));
    }

    inferred.delete(service.name);
    const dependsOn = [...inferred].filter((name) => services.some((candidate) => candidate.name === name));
    return dependsOn.length ? { ...service, dependsOn } : removeDependsOn(service);
  });
}

export function buildServiceDependencyGraph(
  services: InfrastructureService[],
): ServiceDependencyGraph {
  const serviceNames = new Set(services.map((service) => service.name));
  const originalOrder = new Map(services.map((service, index) => [service.name, index]));
  const dependsOnByService = new Map<string, string[]>();
  const dependents = new Map(services.map((service) => [service.name, [] as string[]]));

  for (const service of services) {
    const dependsOn = uniqueKnownDependencies(service.dependsOn ?? [], serviceNames, service.name);
    dependsOnByService.set(service.name, dependsOn);
    for (const dependency of dependsOn) {
      dependents.get(dependency)?.push(service.name);
    }
  }

  const sortByOriginalOrder = (names: string[]) => names.sort(
    (left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0),
  );

  for (const dependentList of dependents.values()) {
    sortByOriginalOrder(dependentList);
  }

  const inDegree = new Map(
    services.map((service) => [service.name, dependsOnByService.get(service.name)?.length ?? 0]),
  );
  const queue = sortByOriginalOrder(
    services
      .filter((service) => (inDegree.get(service.name) ?? 0) === 0)
      .map((service) => service.name),
  );
  const serviceStartOrder: string[] = [];

  while (queue.length) {
    const serviceName = queue.shift();
    if (!serviceName) break;

    serviceStartOrder.push(serviceName);

    for (const dependent of dependents.get(serviceName) ?? []) {
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);
      if ((inDegree.get(dependent) ?? 0) === 0) {
        queue.push(dependent);
        sortByOriginalOrder(queue);
      }
    }
  }

  if (serviceStartOrder.length !== services.length) {
    const cycle = findServiceDependencyCycle(services);
    throw new Error(`Circular service dependency detected: ${(cycle.length ? cycle : unresolvedServiceNames(services, serviceStartOrder)).join(' -> ')}.`);
  }

  return {
    serviceStartOrder,
    dependents,
    dependencyGraph: services.map((service) => ({
      serviceName: service.name,
      dependsOn: dependsOnByService.get(service.name) ?? [],
      dependents: dependents.get(service.name) ?? [],
    })),
  };
}

export function orderServicesByDependencies<T extends { name: string; dependsOn?: string[] }>(
  services: T[],
): T[] {
  const graph = buildServiceDependencyGraph(services as unknown as InfrastructureService[]);
  const byName = new Map(services.map((service) => [service.name, service]));
  return graph.serviceStartOrder.map((name) => byName.get(name)).filter((service): service is T => service !== undefined);
}

export function findServiceDependencyCycle(
  services: Array<{ name: string; dependsOn?: string[] }>,
): string[] {
  const serviceNames = new Set(services.map((service) => service.name));
  const dependencies = new Map(
    services.map((service) => [
      service.name,
      uniqueKnownDependencies(service.dependsOn ?? [], serviceNames, service.name),
    ]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(serviceName: string): string[] | null {
    if (visiting.has(serviceName)) {
      const cycleStart = path.indexOf(serviceName);
      return [...path.slice(cycleStart), serviceName];
    }

    if (visited.has(serviceName)) return null;

    visiting.add(serviceName);
    path.push(serviceName);

    for (const dependency of dependencies.get(serviceName) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }

    path.pop();
    visiting.delete(serviceName);
    visited.add(serviceName);
    return null;
  }

  for (const service of services) {
    const cycle = visit(service.name);
    if (cycle) return cycle;
  }

  return [];
}

function uniqueKnownDependencies(dependencies: string[], serviceNames: Set<string>, serviceName: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const dependency of dependencies) {
    if (dependency === serviceName || !serviceNames.has(dependency) || seen.has(dependency)) continue;
    seen.add(dependency);
    result.push(dependency);
  }

  return result;
}

function removeDependsOn(service: InfrastructureService): InfrastructureService {
  const { dependsOn: _dependsOn, ...rest } = service;
  return rest;
}

function unresolvedServiceNames(services: InfrastructureService[], ordered: string[]): string[] {
  return services.map((service) => service.name).filter((serviceName) => !ordered.includes(serviceName));
}
