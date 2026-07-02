import {
  validateDependencyAwareExecutionSchedule,
  validateDetailedDryRunPreview,
  validateExecutionPlan,
  validateInfrastructureSpec,
  validateTopologyGraph,
} from '../domain/schemas.js';
import type {
  DependencyAwareExecutionSchedule,
  DependencyGraphEntry,
  DetailedDryRunPreview,
  DryRunPolicyFinding,
  ExecutionPlan,
  ExecutionScheduleStep,
  InfrastructureService,
  InfrastructureSpec,
} from '../domain/types.js';

import { getImageReferenceBase } from '../domain/supported-images.js';
import { normalizeStatefulDatabaseReplicaVolumes } from '../domain/stateful-database-volumes.js';
import { isSecretLikeKey, type ResolvedSecret, type SecretResolutionResult } from '../compose/secret-resolver.js';
import {
  isObviouslyExposedSecret,
  type RepairedSecret,
  type SecretPolicyRepairResult,
} from '../compose/secret-policy-repair.js';
const ARTIFACT_TARGET_PATH = 'docker-compose.yaml';

const KEEPALIVE_IMAGE_BASES = new Set(['node', 'python', 'golang', 'openjdk', 'eclipse-temurin']);
const DATABASE_HEALTHCHECK_BASES = new Set(['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'elasticsearch']);
export function buildDependencyAwareExecutionSchedule(
  spec: InfrastructureSpec,
): DependencyAwareExecutionSchedule {
  const validSpec = normalizeStatefulDatabaseReplicaVolumes(
    validateInfrastructureSpec(spec),
  );
  const dependents = buildDependentsMap(validSpec.services);
  const serviceStartOrder = orderServicesByDependency(validSpec.services, dependents);
  const steps: ExecutionScheduleStep[] = [];
  let order = 1;

  for (const network of validSpec.networks) {
    steps.push({
      order,
      level: 0,
      levelName: 'Level 0 - Foundation',
      kind: 'create-resource',
      resourceType: 'network',
      resourceName: network,
      action: `Create/use network: ${network}`,
      dependsOn: [],
      dependents: [],
      waitCondition: null,
      readinessEnforced: false,
    });
    order += 1;
  }

  for (const volume of validSpec.volumes) {
    steps.push({
      order,
      level: 0,
      levelName: 'Level 0 - Foundation',
      kind: 'create-resource',
      resourceType: 'volume',
      resourceName: volume,
      action: `Create/use volume: ${volume}`,
      dependsOn: [],
      dependents: [],
      waitCondition: null,
      readinessEnforced: false,
    });
    order += 1;
  }

  for (const serviceName of serviceStartOrder) {
    const service = getService(validSpec.services, serviceName);
    const level = getServiceLevel(service.kind);
    const waitCondition = inferWaitCondition(service);
    const serviceDependents = dependents.get(service.name) ?? [];

    steps.push({
      order,
      level,
      levelName: getLevelName(level),
      kind: 'start-service',
      resourceType: 'service',
      resourceName: service.name,
      action: `Create/start service: ${service.name}`,
      dependsOn: service.dependsOn ?? [],
      dependents: serviceDependents,
      waitCondition: null,
      readinessEnforced: false,
      serviceKind: service.kind,
      image: service.image,
      replicas: service.replicas ?? 1,
      ports: service.ports ?? [],
      volumes: service.volumes ?? [],
    });
    order += 1;

    steps.push({
      order,
      level,
      levelName: getLevelName(level),
      kind: 'wait-until-ready',
      resourceType: 'service',
      resourceName: service.name,
      action: `Wait until service is ready: ${service.name}`,
      dependsOn: service.dependsOn ?? [],
      dependents: serviceDependents,
      waitCondition,
      readinessEnforced: false,
      serviceKind: service.kind,
      image: service.image,
      replicas: service.replicas ?? 1,
      ports: service.ports ?? [],
      volumes: service.volumes ?? [],
    });
    order += 1;
  }

  return validateDependencyAwareExecutionSchedule({
    projectName: validSpec.projectName,
    steps,
    dependencyGraph: buildDependencyGraph(validSpec.services, dependents),
    serviceStartOrder,
    destroyOrder: [...serviceStartOrder].reverse(),
    warnings: buildScheduleWarnings(validSpec.services, serviceStartOrder),
  });
}

export function buildDetailedDryRunPreview(
  plan: ExecutionPlan,
  composeYaml: string,
  schedule = buildDependencyAwareExecutionSchedule(plan.spec),
  secretResolution?: SecretResolutionResult,
  secretRepair?: SecretPolicyRepairResult,
): DetailedDryRunPreview {
  const validPlan = validateExecutionPlan(plan);
  const validSpec = normalizeStatefulDatabaseReplicaVolumes(validPlan.spec);
  const validSchedule = validateDependencyAwareExecutionSchedule(schedule);
  const policyFindings = evaluateDryRunPolicy(
    validSpec,
    validSchedule,
    secretResolution,
    secretRepair,
  );

  return validateDetailedDryRunPreview({
    projectName: validSpec.projectName,
    artifactTargetPath: ARTIFACT_TARGET_PATH,
    artifactWritten: false,
    stateSaved: false,
    dockerCalled: false,
    mcpCalled: false,
    composePreviewLineCount: countNonEmptyLines(composeYaml),
    totalServices: validSpec.services.length,
    totalContainers: validSpec.services.reduce(
      (total, service) => total + (service.replicas ?? 1),
      0,
    ),
    networks: validSpec.networks,
    volumes: validSpec.volumes,
    services: validSpec.services.map((service) => ({
      name: service.name,
      kind: service.kind,
      image: service.image,
      replicas: service.replicas ?? 1,
      ports: service.ports ?? [],
      volumes: service.volumes ?? [],
      environmentKeys: Object.keys(service.environment ?? {}),
      environment: service.environment ?? {},
      dependsOn: service.dependsOn ?? [],
      dependents:
        validSchedule.dependencyGraph.find((entry) => entry.serviceName === service.name)
          ?.dependents ?? [],
      waitCondition: inferWaitCondition(service),
      readinessEnforced: false,
      warnings: buildServiceWarnings(service),
    })),
    schedule: validSchedule,
    policyFindings,
    actionsNotPerformed: [
      'Docker Engine API was not called.',
      'MCP tools were not called.',
      `${ARTIFACT_TARGET_PATH} was not written.`,
      'state/infra-state.sqlite was not saved.',
      'No containers, networks, volumes, or images were created or pulled.',
    ],
  });
}

export function evaluateDryRunPolicy(
  spec: InfrastructureSpec,
  schedule = buildDependencyAwareExecutionSchedule(spec),
  secretResolution?: SecretResolutionResult,
  secretRepair?: SecretPolicyRepairResult,
): DryRunPolicyFinding[] {
  const validSpec = normalizeStatefulDatabaseReplicaVolumes(
    validateInfrastructureSpec(spec),
  );
  const findings: DryRunPolicyFinding[] = [];

  for (const service of validSpec.services) {
    for (const port of service.ports ?? []) {
      findings.push({
        severity: 'warning',
        code: 'exposed-host-port',
        message: `Service "${service.name}" would expose host port mapping ${port}.`,
        resourceName: service.name,
        resourceType: 'service',
      });
    }

    for (const [key, value] of Object.entries(service.environment ?? {})) {
      if (!isSecretLikeKey(key)) {
        continue;
      }
      const resolvedSecret = getResolvedSecret(secretResolution, service.name, key);
      const repairedSecret = getRepairedSecret(secretRepair, service.name, key);
      if (repairedSecret) {
        findings.push({
          severity: 'warning',
          code: 'secret-policy-auto-repaired',
          message: `Service "${service.name}" had an obvious secret for ${key} (${repairedSecret.reason}); it was automatically replaced in the compose YAML. Check the generated YAML for the new value.`,
          resourceName: service.name,
          resourceType: 'service',
        });
      } else if (resolvedSecret?.source === 'auto-generated') {
        findings.push({
          severity: 'info',
          code: 'auto-generated-secret',
          message: `Service "${service.name}" has no env value for ${key}; the system generated a password automatically. See state/generated-secrets.env after deploy.`,
          resourceName: service.name,
          resourceType: 'service',
        });
      } else if (resolvedSecret?.source === 'env-file') {
        if (isWeakSecret(value)) {
          findings.push({
            severity: 'warning',
            code: 'weak-env-secret',
            message: `Service "${service.name}" uses weak or guessable env secret ${resolvedSecret.envVarName} for ${key}; change the env value before deploy.`,
            resourceName: service.name,
            resourceType: 'service',
          });
        } else {
          findings.push({
            severity: 'info',
            code: 'env-secret-used',
            message: `Service "${service.name}" uses the password from env var ${resolvedSecret.envVarName} for ${key}.`,
            resourceName: service.name,
            resourceType: 'service',
          });
        }
      } else if (isAutoGeneratedSecret(value)) {
        findings.push({
          severity: 'info',
          code: 'auto-generated-secret',
          message: `Service "${service.name}" has no env value for ${key}; the system generated a password automatically. See state/generated-secrets.env after deploy.`,
          resourceName: service.name,
          resourceType: 'service',
        });
      } else if (isWeakSecret(value)) {
        findings.push({
          severity: 'warning',
          code: 'weak-hardcoded-secret',
          message: `Service "${service.name}" uses a weak hardcoded value for ${key}; replace it before real deploy.`,
          resourceName: service.name,
          resourceType: 'service',
        });
      }
    }

    if (service.volumes?.length) {
      findings.push({
        severity: 'info',
        code: 'persistent-volume-preview',
        message: `Service "${service.name}" would use persistent volume mount(s): ${service.volumes.join(', ')}.`,
        resourceName: service.name,
        resourceType: 'service',
      });
    }

    if ((service.replicas ?? 1) > 1) {
      findings.push({
        severity: 'warning',
        code: 'replica-preview',
        message: buildReplicaScaleWarning(service),
        resourceName: service.name,
        resourceType: 'service',
      });
    }

    findings.push({
      severity: 'warning',
      code: 'readiness-not-enforced-in-dry-run',
      message: `Service "${service.name}" has a planned wait gate (${inferWaitCondition(service)}), but this dry-run preview does not enforce runtime healthchecks yet.`,
      resourceName: service.name,
      resourceType: 'service',
    });
  }

  // Compose hardening policy warnings (mentor #5)
  for (const service of validSpec.services) {
    const imageBase = getImageReferenceBase(service.image);
    if (KEEPALIVE_IMAGE_BASES.has(imageBase)) {
      findings.push({
        severity: 'info',
        code: 'keepalive-demo-command',
        message: `Service "${service.name}" uses a raw runtime image ("${service.image}") with an injected keepalive command (tail -f /dev/null) for demo purposes; provide a real CMD/entrypoint for production.`,
        resourceName: service.name,
        resourceType: 'service',
      });
    }
    if (service.kind === 'database' && !DATABASE_HEALTHCHECK_BASES.has(imageBase)) {
      findings.push({
        severity: 'warning',
        code: 'database-missing-healthcheck',
        message: `Database service "${service.name}" (image: ${service.image}) has no deterministic healthcheck rule; add one or use a supported database image.`,
        resourceName: service.name,
        resourceType: 'service',
      });
    }
  }

  for (const warning of schedule.warnings) {
    findings.push({
      severity: 'warning',
      code: 'schedule-readiness-warning',
      message: warning,
      resourceName: null,
      resourceType: null,
    });
  }

  return findings;
}

function getResolvedSecret(
  secretResolution: SecretResolutionResult | undefined,
  serviceName: string,
  key: string,
): ResolvedSecret | undefined {
  return secretResolution?.services
    .find((service) => service.serviceName === serviceName)
    ?.secrets.find((secret) => secret.key === key);
}

function getRepairedSecret(
  secretRepair: SecretPolicyRepairResult | undefined,
  serviceName: string,
  key: string,
): RepairedSecret | undefined {
  return secretRepair?.repairedSecrets.find(
    (secret) => secret.serviceName === serviceName && secret.key === key,
  );
}

function orderServicesByDependency(
  services: InfrastructureService[],
  dependents: Map<string, string[]>,
): string[] {
  const originalOrder = new Map(services.map((service, index) => [service.name, index]));
  const inDegree = new Map(
    services.map((service) => [service.name, service.dependsOn?.length ?? 0]),
  );
  const queue = services
    .filter((service) => (inDegree.get(service.name) ?? 0) === 0)
    .map((service) => service.name);
  const ordered: string[] = [];

  sortServiceNamesByOriginalOrder(queue, originalOrder);

  while (queue.length) {
    const serviceName = queue.shift();
    if (!serviceName) {
      break;
    }

    ordered.push(serviceName);

    for (const dependent of dependents.get(serviceName) ?? []) {
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1);

      if ((inDegree.get(dependent) ?? 0) === 0) {
        queue.push(dependent);
        sortServiceNamesByOriginalOrder(queue, originalOrder);
      }
    }
  }

  if (ordered.length !== services.length) {
    const unresolved = services
      .map((service) => service.name)
      .filter((serviceName) => !ordered.includes(serviceName));
    throw new Error(
      `Circular service dependency detected: ${unresolved.join(', ')}.`,
    );
  }

  return ordered;
}

function buildDependentsMap(services: InfrastructureService[]): Map<string, string[]> {
  const dependents = new Map(services.map((service) => [service.name, [] as string[]]));

  for (const service of services) {
    for (const dependency of service.dependsOn ?? []) {
      dependents.get(dependency)?.push(service.name);
    }
  }

  const originalOrder = new Map(services.map((service, index) => [service.name, index]));
  for (const dependentList of dependents.values()) {
    sortServiceNamesByOriginalOrder(dependentList, originalOrder);
  }

  return dependents;
}

function buildDependencyGraph(
  services: InfrastructureService[],
  dependents: Map<string, string[]>,
): DependencyGraphEntry[] {
  return services.map((service) => ({
    serviceName: service.name,
    dependsOn: service.dependsOn ?? [],
    dependents: dependents.get(service.name) ?? [],
  }));
}

function buildScheduleWarnings(
  services: InfrastructureService[],
  serviceStartOrder: string[],
): string[] {
  const servicesByName = new Map(services.map((service) => [service.name, service]));
  const warnings: string[] = [];

  // Collect warning-level topology issues
  const mockSpec: InfrastructureSpec = {
    projectName: 'temp-project',
    services,
    networks: ['temp-net'],
    volumes: [],
  };
  const topologyResult = validateTopologyGraph(mockSpec);
  for (const issue of topologyResult.issues) {
    if (issue.severity === 'warning') {
      warnings.push(`${issue.message} Suggestion: ${issue.suggestion}`);
    }
  }

  for (const serviceName of serviceStartOrder) {
    const service = servicesByName.get(serviceName);

    if (!service) {
      continue;
    }

    for (const dependencyName of service.dependsOn ?? []) {
      const dependency = servicesByName.get(dependencyName);

      if (dependency?.kind === 'database' && service.kind === 'backend') {
        warnings.push(
          `${getDatabaseDisplayName(dependency)} service "${dependency.name}" must be healthy before backend service "${service.name}" starts.`,
        );
      }

      if (dependency?.kind === 'backend' && service.kind === 'reverse-proxy') {
        warnings.push(
          `Backend service "${dependency.name}" readiness is required before reverse proxy service "${service.name}" routes traffic.`,
        );
      }
    }

    warnings.push(
      `Service "${service.name}" has planned wait condition "${inferWaitCondition(service)}", but this preview does not enforce runtime healthchecks yet.`,
    );
  }

  return warnings;
}

function buildServiceWarnings(service: InfrastructureService): string[] {
  const warnings = [
    `Readiness gate is preview-only in this dry-run: ${inferWaitCondition(service)}.`,
  ];

  if ((service.replicas ?? 1) > 1) {
    warnings.push(buildReplicaScaleWarning(service));
  }

  return warnings;
}

function buildReplicaScaleWarning(service: InfrastructureService): string {
  const replicas = service.replicas ?? 1;

  if (service.kind === 'database') {
    return `Service "${service.name}" scales from 1 to ${replicas} replicas; stateful databases must use isolated per-replica services and volumes, not one shared data volume.`;
  }

  return `Service "${service.name}" scales from 1 to ${replicas} replicas; confirm the service is stateless and does not use fixed host ports or shared writable state.`;
}

function inferWaitCondition(service: InfrastructureService): string {
  switch (service.kind) {
    case 'database':
      return 'wait until database accepts connections / service healthy';
    case 'backend':
      return 'wait until service running/healthy';
    case 'reverse-proxy':
      return 'wait until upstream backend ready/running';
  }
}

function getDatabaseDisplayName(service: InfrastructureService): string {
  const imageBase = service.image.split(':')[0]?.split('/').pop()?.toLowerCase();

  switch (imageBase) {
    case 'postgres':
      return 'PostgreSQL';
    case 'mysql':
      return 'MySQL';
    case 'mariadb':
      return 'MariaDB';
    case 'mongo':
      return 'MongoDB';
    case 'redis':
      return 'Redis';
    default:
      return 'Database';
  }
}

function getServiceLevel(kind: InfrastructureService['kind']): number {
  switch (kind) {
    case 'database':
      return 1;
    case 'backend':
      return 2;
    case 'reverse-proxy':
      return 3;
  }
}

function getLevelName(level: number): string {
  switch (level) {
    case 0:
      return 'Level 0 - Foundation';
    case 1:
      return 'Level 1 - Data layer';
    case 2:
      return 'Level 2 - Application layer';
    case 3:
      return 'Level 3 - Routing/Proxy layer';
    default:
      return `Level ${level}`;
  }
}

function getService(services: InfrastructureService[], name: string): InfrastructureService {
  const service = services.find((candidate) => candidate.name === name);

  if (!service) {
    throw new Error(`Unknown service "${name}" while building execution schedule.`);
  }

  return service;
}

function sortServiceNamesByOriginalOrder(
  names: string[],
  originalOrder: Map<string, number>,
): void {
  names.sort((left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0));
}

function countNonEmptyLines(value: string): number {
  return value.trim() === '' ? 0 : value.trim().split(/\r?\n/).length;
}

function isAutoGeneratedSecret(value: string): boolean {
  return /^pw-.+$/i.test(value);
}

function isWeakSecret(value: string): boolean {
  return isObviouslyExposedSecret(value);
}
