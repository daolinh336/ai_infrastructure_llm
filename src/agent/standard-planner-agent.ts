import type { LlmProvider } from '../llm/provider.js';
import type { PlannerRuntimeReader } from '../execution/runtime-environment-reader.js';
import type {
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  PlannerRevisionRequest,
  PlannerRevisionResult,
  ResolvedSpecPatchResult,
  SpecPatchPlan,
  ValidatedQuery,
  VerificationFinding,
} from '../domain/types.js';
import { validateInfrastructureSpec, validateSpecPatchPlan } from '../domain/schemas.js';
import { specPatchPlanJsonSchema } from '../domain/structured-output-schemas.js';
import { parseJsonResponse } from '../llm/json-response.js';
import type { PlannerAgent } from './agent-interfaces.js';
import { applySpecPatchPlan } from './spec-patch-applier.js';

export class StandardPlannerAgent implements PlannerAgent {
  constructor(private readonly provider: LlmProvider) {}

  async proposeSpec(
    query: ValidatedQuery,
    _stateSnapshot: InfrastructureStateSnapshot | null,
    runtimeReader?: PlannerRuntimeReader,
  ): Promise<InfrastructureSpec> {
    const runtimeContext = await readPlannerRuntimeContext(runtimeReader);

    // Build services from the draft query
    const services = query.draft.services
      .filter((s) => s.image !== null && s.name !== null)
      .map((s) => {
        const kind = inferServiceKind(s.image!);
        const service: InfrastructureSpec['services'][0] = {
          kind,
          name: s.name!,
          image: s.image!,
        };
        if (s.port && !hasPlannerPortConflict(runtimeContext, s.port)) {
          service.ports = [String(s.port) + ':' + String(s.port)];
        }
        if (s.replicas && s.replicas > 1) {
          service.replicas = s.replicas;
        }
        return service;
      });

    // Apply default dependsOn inference
    const inferred = applyDependencyInference(services);

    const spec: InfrastructureSpec = {
      projectName: avoidProjectNameConflict(toProjectName(query.normalizedPrompt), runtimeContext.containerNames),
      services: inferred,
      networks: query.draft.services.length > 1 ? ['app-network'] : [],
      volumes: [],
    };

    return validateInfrastructureSpec(spec);
  }

  async repairSpec(
    spec: InfrastructureSpec,
    _issues: string[],
    _runtimeReader?: PlannerRuntimeReader,
  ): Promise<InfrastructureSpec> {
    // For Phase 9+10, simple repair: just re-validate.
    // Future versions can use LLM to fix issues.
    return validateInfrastructureSpec(spec);
  }

  async reviseFromFeedback(
    request: PlannerRevisionRequest,
  ): Promise<PlannerRevisionResult> {
    const spec = request.desiredSpec;
    const obs = request.revisionObservation;
    const issues = collectRevisionIssues(obs);
    const findings = obs.verificationReport?.findings ?? [];
    const requiresUserInput = findings.some((finding) => findingNeedsUserInput(finding));
    const assumptions: string[] = [];

    let revisedSpec = spec;
    let patchPlan: SpecPatchPlan | null = null;
    let patchResults: ResolvedSpecPatchResult[] | undefined;
    let revisionDecision: PlannerRevisionResult['revisionDecision'] = 'auto-revised';
    let revisionStats: RevisionRepairResult | null = null;

    if (issues.length > 0) {
      patchPlan = await this.getRevisionPatchPlan(spec, issues, findings, request.attemptIndex);
      if (patchPlan !== null && patchPlan.patches.length > 0) {
        const plannedRevision = applySpecPatchPlan(spec, patchPlan.patches, {
          allowBlockedPatchOps: extractAllowedPatchOps(issues),
        });
        revisedSpec = plannedRevision.spec;
        patchResults = plannedRevision.results;
        const appliedPatchCount = plannedRevision.results.filter((result) => result.applied).length;
        const blockedPatchCount = plannedRevision.results.filter((result) => result.blockedReason !== null).length;
        const skippedPatchCount = plannedRevision.results.length - appliedPatchCount;
        revisionStats = {
          spec: revisedSpec,
          appliedPatchCount,
          skippedPatchCount,
          unmatchedIssueCount: patchPlan.requiresUserInput || patchPlan.ambiguities.length > 0 ? 1 : 0,
        };
        revisionDecision = requiresUserInput || patchPlan.requiresUserInput || patchPlan.ambiguities.length > 0 || blockedPatchCount > 0 || (appliedPatchCount === 0 && skippedPatchCount > 0)
          ? 'needs-user-input'
          : hasNoSafeResolution(findings)
            ? 'no-safe-resolution'
            : 'auto-revised';
        assumptions.push(
          `Revision ${request.attemptIndex + 1}: received ${issues.length} observation(s), applied ${appliedPatchCount} structured patch(es), skipped ${skippedPatchCount}.`,
        );
        assumptions.push(`LLM structured revision: ${patchPlan.explanation}`);
        assumptions.push(...patchPlan.assumptions);
        if (patchPlan.ambiguities.length > 0) {
          assumptions.push(`Revision ambiguities: ${patchPlan.ambiguities.join('; ')}`);
        }
      } else {
        const revision = applyRevisionRepairs(spec, issues, request.attemptIndex + 1, findings);
        revisionStats = revision;
        revisedSpec = revision.spec;
        revisionDecision = requiresUserInput || revision.unmatchedIssueCount > 0 || (revision.appliedPatchCount === 0 && revision.skippedPatchCount > 0) ? 'needs-user-input' : hasNoSafeResolution(findings) ? 'no-safe-resolution' : 'auto-revised';
        assumptions.push(
          `Revision ${request.attemptIndex + 1}: received ${issues.length} observation(s), applied ${revision.appliedPatchCount} deterministic fallback patch(es), skipped ${revision.skippedPatchCount + revision.unmatchedIssueCount}.`,
        );
        if (patchPlan !== null) {
          assumptions.push(`LLM structured revision returned no direct patch: ${patchPlan.explanation}`);
        }
        if (revision.unmatchedIssueCount > 0) {
          assumptions.push('Feedback received but no safe deterministic patch matched.');
        }
      }
      assumptions.push(`Revision decision: ${revisionDecision}.`);
    } else {
      assumptions.push(
        `Revision ${request.attemptIndex + 1}: no actionable issues detected, re-validating spec.`,
      );
    }

    const validatedSpec = validateInfrastructureSpec(revisedSpec);

    const result: PlannerRevisionResult = {
      revisedSpec: validatedSpec,
      revisionSummary: buildRevisionSummary(obs, issues, revisionStats),
      assumptions,
      revisionDecision,
    };
    if (patchPlan !== null) {
      result.patchPlan = patchPlan;
    }
    if (patchResults !== undefined) {
      result.patchResults = patchResults;
    }
    const clarificationContext = [
      ...(buildRevisionClarifications(findings) ?? []),
      ...buildPatchClarifications(patchResults ?? []),
    ];
    if (clarificationContext.length > 0) {
      result.clarificationContext = clarificationContext;
    }
    return result;
  }

  private async getRevisionPatchPlan(
    spec: InfrastructureSpec,
    issues: string[],
    findings: VerificationFinding[],
    attemptIndex: number,
  ): Promise<SpecPatchPlan | null> {
    try {
      const response = await this.provider.completeStructured({
        purpose: 'react',
        system: [
          'REVISION_PATCH_PLANNER_V1',
          'You revise desired infrastructure by returning schema-valid JSON patches only.',
          'Patch InfrastructureSpec, not Docker API payloads and not docker-compose YAML.',
          'Use semantic service selectors when the user uses aliases like nginx, backend, db, app, proxy, or cache.',
          'Understand natural language flexibly: map names, roles, image families, counts, and port intent into the closest valid SpecPatch.',
          'Normalize free-form user feedback into schema-valid patches: ports, replicas, images, env vars, volumes, dependencies, service names, service status, project name, networks, add/remove services.',
          'Examples: "nginx sang 83:83" => replace-service-port with selector imageFamily nginx and to 83:83; "change web port from 80 to 67" => replace-service-port to 67:80 when current web mapping is 80:80; "web port 83" => replace-service-port preserving existing container port when only one current mapping exists; "backend len 3" => set-service-replicas; "doi image backend thanh node:22" => set-service-image; "set POSTGRES_PASSWORD to abc" => set-service-env; "them volume logs:/logs cho backend" => add-service-volume; "backend depends on db" => add-service-dependency; "stop redis" => set-service-desired-status; "them redis cache" => add-service; "doi ten api thanh backend" => rename-service.',
          'Return requiresUserInput=true with ambiguities when the target or requested change is unsafe or unclear.',
        ].join('\n'),
        user: JSON.stringify({
          attemptIndex,
          projectName: spec.projectName,
          services: spec.services.map((service) => ({
            name: service.name,
            kind: service.kind,
            ports: service.ports ?? [],
            image: service.image,
            replicas: service.replicas ?? 1,
            dependsOn: service.dependsOn ?? [],
            volumes: service.volumes ?? [],
            environmentKeys: Object.keys(service.environment ?? {}),
          })),
          networks: spec.networks,
          volumes: spec.volumes,
          issues,
          findings,
          patchGuidance: {
            sourceOfTruth: 'Return patches for InfrastructureSpec only. Compose YAML is rendered later.',
            targetResolution: 'Prefer selectors by exact name, nameLike, kind, imageFamily, exposesHostPort, dependsOn, dependentOf instead of guessing a concrete name when the user uses an alias.',
            portInference: 'When the user gives host:container, use it exactly. When the user gives one port and the target service already has exactly one mapping, preserve the existing container port unless the user explicitly says both sides should change.',
            schemaNormalization: 'Always convert natural-language feedback to one or more SpecPatch objects when the intent and target can be inferred from current services. Do not leave patches empty just because wording is informal.',
          },
        }),
        schemaName: 'spec_patch_plan',
        schema: specPatchPlanJsonSchema,
      });
      return validateSpecPatchPlan(parseJsonResponse(response.text));
    } catch {
      return null;
    }
  }
}

interface PlannerRuntimeContext {
  containerNames: string[];
  usedHostPorts: Array<{ hostPort: string; containerName: string }>;
  containerSummaries: NonNullable<Awaited<ReturnType<PlannerRuntimeReader['inspectContainerSummary']>>>[];
}

async function readPlannerRuntimeContext(runtimeReader: PlannerRuntimeReader | undefined): Promise<PlannerRuntimeContext> {
  const empty: PlannerRuntimeContext = {
    containerNames: [],
    usedHostPorts: [],
    containerSummaries: [],
  };
  if (!runtimeReader) return empty;

  try {
    const [containerNames, usedHostPorts] = await Promise.all([
      runtimeReader.listContainerNames(),
      runtimeReader.listUsedHostPorts(),
    ]);
    const summaries = await Promise.all(
      containerNames.map((name) => runtimeReader.inspectContainerSummary(name)),
    );
    return {
      containerNames,
      usedHostPorts,
      containerSummaries: summaries.filter((summary): summary is PlannerRuntimeContext['containerSummaries'][number] => summary !== null),
    };
  } catch {
    return empty;
  }
}

function hasPlannerPortConflict(runtimeContext: PlannerRuntimeContext, port: number): boolean {
  const requestedPort = String(port);
  if (runtimeContext.usedHostPorts.some((usedPort) => usedPort.hostPort === requestedPort)) return true;
  return runtimeContext.containerSummaries.some((summary) =>
    summary.ports.some((mapping) => mapping.split(':')[0]?.trim() === requestedPort),
  );
}

function avoidProjectNameConflict(projectName: string, containerNames: string[]): string {
  const hasConflict = containerNames.some((containerName) =>
    containerName === projectName || containerName.startsWith(projectName + '-'),
  );
  return hasConflict ? projectName + '-planned' : projectName;
}

function inferServiceKind(image: string): 'reverse-proxy' | 'backend' | 'database' {
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

function applyDependencyInference(
  services: InfrastructureSpec['services'],
): InfrastructureSpec['services'] {
  const backends = services.filter((s) => s.kind === 'backend');
  const databases = services.filter((s) => s.kind === 'database');

  for (const svc of services) {
    const deps: string[] = [];

    if (svc.kind === 'reverse-proxy' && backends.length > 0) {
      deps.push(...backends.map((b) => b.name));
    }

    if (svc.kind === 'backend' && databases.length > 0) {
      deps.push(...databases.map((d) => d.name));
    }

    if (deps.length > 0) {
      svc.dependsOn = deps;
    }
  }

  return services;
}

function toProjectName(prompt: string): string {
  const cleaned = prompt.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'app';
}
function collectRevisionIssues(obs: import('../domain/types.js').RevisionObservation): string[] {
  const issues: string[] = [];
  if (obs.verificationReport) {
    for (const finding of obs.verificationReport.findings ?? []) {
      issues.push(formatFindingForPlanner(finding));
    }
    for (const issue of obs.verificationReport.issues) {
      issues.push(issue);
    }
  }
  if (obs.userFeedback) {
    issues.push('User feedback: ' + obs.userFeedback.message);
  }
  if (obs.driftSummary) {
    issues.push('Drift: ' + obs.driftSummary);
  }
  return issues;
}

function extractAllowedPatchOps(issues: string[]): string[] {
  return issues.flatMap((issue) => [...issue.matchAll(/allow:([a-z-]+)/gi)].map((match) => match[1]!));
}

type RevisionPatch =
  | { kind: 'set-project-name'; name: string }
  | { kind: 'rename-network'; from: string | null; to: string }
  | { kind: 'set-networks'; networks: string[] }
  | { kind: 'rename-service'; from: string; to: string }
  | { kind: 'add-service-dependency'; serviceName: string; dependencyName: string }
  | { kind: 'remove-service-dependency'; serviceName: string; dependencyName: string }
  | { kind: 'set-service-image'; serviceName: string | null; image: string }
  | { kind: 'set-service-host-port'; serviceName: string | null; hostPort: number; containerPort?: number }
  | { kind: 'set-service-replicas'; serviceName: string; replicas: number };

type RevisionRepairResult = {
  spec: InfrastructureSpec;
  appliedPatchCount: number;
  skippedPatchCount: number;
  unmatchedIssueCount: number;
};

function applyRevisionRepairs(
  spec: InfrastructureSpec,
  issues: string[],
  attemptNumber: number,
  findings: VerificationFinding[] = [],
): RevisionRepairResult {
  const patches = parseRevisionPatches(spec, issues, attemptNumber, findings);
  return applyRevisionPatches(spec, issues, patches);
}

function parseRevisionPatches(
  spec: InfrastructureSpec,
  issues: string[],
  attemptNumber: number,
  findings: VerificationFinding[] = [],
): RevisionPatch[] {
  const patches: RevisionPatch[] = [];
  const conflictingContainerNames = new Set<string>();
  const conflictingHostPorts = new Set<number>();

  for (const finding of findings) {
    if (finding.code === 'CONTAINER_NAME_CONFLICT' && finding.resourceName) {
      conflictingContainerNames.add(finding.resourceName);
    }
    if (finding.code === 'HOST_PORT_CONFLICT' && finding.expected) {
      const port = Number(finding.expected.replace(/\D+/g, ''));
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        conflictingHostPorts.add(port);
      }
    }
    if (finding.code === 'IMAGE_NOT_FOUND' && finding.resourceName) {
      const fallback = supportedImageFallback(finding.expected ?? finding.resourceName);
      if (fallback) {
        patches.push({ kind: 'set-service-image', serviceName: finding.resourceName, image: fallback });
      }
    }
  }

  for (const issue of issues) {
    const containerName = /Container name conflict: "([^"]+)"/.exec(issue)?.[1];
    if (containerName) {
      conflictingContainerNames.add(containerName);
    }

    const hostPort = /Host port conflict: service "[^"]+" wants (\d+)/.exec(issue)?.[1];
    if (hostPort) {
      conflictingHostPorts.add(Number(hostPort));
    }

    const requestedPortMapping = parseRequestedPortMapping(issue);
    if (requestedPortMapping) {
      patches.push({
        kind: 'set-service-host-port',
        serviceName: findMentionedServiceName(spec, issue),
        hostPort: requestedPortMapping.hostPort,
        containerPort: requestedPortMapping.containerPort,
      });
    }

    const requestedPort = requestedPortMapping ? null : parseRequestedHostPort(issue);
    if (requestedPort) {
      const parsedPort = requestedPort;
      if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        patches.push({ kind: 'set-service-host-port', serviceName: findMentionedServiceName(spec, issue), hostPort: parsedPort });
      }
    }

    const requestedImage = /(?:use|image|replace\s+with)\s+([A-Za-z0-9_./:-]+)/i.exec(issue)?.[1];
    if (requestedImage) {
      const normalizedImage = normalizeRevisionImage(requestedImage);
      if (normalizedImage !== null) {
        patches.push({ kind: 'set-service-image', serviceName: findMentionedServiceName(spec, issue), image: normalizedImage });
      }
    }

    const projectName = /(?:change|set|rename)\s+project\s+name\s+(?:to\s+)?([A-Za-z0-9_.-]+)/i.exec(issue)?.[1];
    if (projectName) {
      patches.push({ kind: 'set-project-name', name: sanitizeIdentifier(projectName) });
    }

    const networkRename = /rename\s+network\s+([A-Za-z0-9_.-]+)\s+to\s+([A-Za-z0-9_.-]+)/i.exec(issue);
    if (networkRename) {
      patches.push({ kind: 'rename-network', from: sanitizeIdentifier(networkRename[1]!), to: sanitizeIdentifier(networkRename[2]!) });
    }

    const networkName = /(?:change|set)\s+network\s+name\s+(?:to\s+)?([A-Za-z0-9_.-]+)/i.exec(issue)?.[1];
    if (networkName) {
      patches.push({ kind: 'rename-network', from: null, to: sanitizeIdentifier(networkName) });
    }

    const serviceRename = /rename\s+(?:service\s+)?([A-Za-z0-9_.-]+)\s+to\s+([A-Za-z0-9_.-]+)/i.exec(issue);
    if (serviceRename && spec.services.some((service) => service.name === serviceRename[1])) {
      patches.push({ kind: 'rename-service', from: serviceRename[1]!, to: sanitizeIdentifier(serviceRename[2]!) });
    }

    const replicas = /set\s+([A-Za-z0-9_.-]+)\s+replicas\s+to\s+(\d+)/i.exec(issue);
    if (replicas) {
      patches.push({ kind: 'set-service-replicas', serviceName: replicas[1]!, replicas: Number(replicas[2]) });
    }

    const addDependency = /(?:add\s+dependency|make)\s+([A-Za-z0-9_.-]+)\s+(?:depends?\s+on|waits?\s+for)\s+([A-Za-z0-9_.-]+)/i.exec(issue);
    if (addDependency) {
      patches.push({ kind: 'add-service-dependency', serviceName: addDependency[1]!, dependencyName: addDependency[2]! });
    }

    const removeDependency = /remove\s+dependency\s+([A-Za-z0-9_.-]+)\s+(?:from|on|depends?\s+on)\s+([A-Za-z0-9_.-]+)/i.exec(issue);
    if (removeDependency) {
      patches.push({ kind: 'remove-service-dependency', serviceName: removeDependency[1]!, dependencyName: removeDependency[2]! });
    }

    const missingNetwork = /(?:missing-network|missing\s+network|network\s+drift)[:\s]+([A-Za-z0-9_.-]+)/i.exec(issue)?.[1];
    if (missingNetwork) {
      patches.push({ kind: 'set-networks', networks: uniqueIdentifiers([...spec.networks, sanitizeIdentifier(missingNetwork)]) });
    } else if (/missing-network|network drift|missing network/i.test(issue) && spec.networks.length === 0) {
      patches.push({ kind: 'set-networks', networks: ['app-network'] });
    }
  }

  const projectName = spec.services.some((service) =>
    conflictingContainerNames.has(spec.projectName + '-' + service.name.replace(/[_\s]+/g, '-')),
  )
    ? `${spec.projectName}-r${attemptNumber}`
    : spec.projectName;

  if (projectName !== spec.projectName) {
    patches.push({ kind: 'set-project-name', name: sanitizeIdentifier(projectName) });
  }

  for (const service of spec.services) {
    if (!service.ports?.length) continue;
    for (const port of service.ports) {
      const [host] = port.split(':');
      const hostPort = Number(host);
      if (Number.isInteger(hostPort) && conflictingHostPorts.has(hostPort)) {
        patches.push({ kind: 'set-service-host-port', serviceName: service.name, hostPort: nextSafePort(hostPort, conflictingHostPorts, attemptNumber) });
      }
    }
  }

  return patches;
}

function applyRevisionPatches(
  spec: InfrastructureSpec,
  issues: string[],
  patches: RevisionPatch[],
): RevisionRepairResult {
  let revisedSpec: InfrastructureSpec = {
    ...spec,
    services: spec.services.map((service) => ({
      ...service,
      ...(service.dependsOn ? { dependsOn: [...service.dependsOn] } : {}),
      ...(service.ports ? { ports: [...service.ports] } : {}),
    })),
    networks: [...spec.networks],
    volumes: [...spec.volumes],
  };
  let appliedPatchCount = 0;
  let skippedPatchCount = 0;

  for (const patch of orderRevisionPatches(patches)) {
    const before = JSON.stringify(revisedSpec);
    revisedSpec = applyRevisionPatch(revisedSpec, patch);
    if (JSON.stringify(revisedSpec) === before) {
      skippedPatchCount += 1;
    } else {
      appliedPatchCount += 1;
    }
  }

  return {
    spec: revisedSpec,
    appliedPatchCount,
    skippedPatchCount,
    unmatchedIssueCount: countUnmatchedFeedbackIssues(issues, patches),
  };
}

function orderRevisionPatches(patches: RevisionPatch[]): RevisionPatch[] {
  const priority: Record<RevisionPatch['kind'], number> = {
    'set-project-name': 0,
    'rename-network': 0,
    'set-networks': 0,
    'rename-service': 0,
    'add-service-dependency': 1,
    'remove-service-dependency': 1,
    'set-service-image': 1,
    'set-service-host-port': 2,
    'set-service-replicas': 2,
  };
  return [...patches].sort((left, right) => priority[left.kind] - priority[right.kind]);
}

function applyRevisionPatch(spec: InfrastructureSpec, patch: RevisionPatch): InfrastructureSpec {
  if (patch.kind === 'set-project-name') {
    return { ...spec, projectName: patch.name };
  }

  if (patch.kind === 'rename-network') {
    const networks = patch.from === null
      ? spec.networks.map(() => patch.to)
      : spec.networks.map((network) => network === patch.from ? patch.to : network);
    return { ...spec, networks: uniqueIdentifiers(networks.length ? networks : [patch.to]) };
  }

  if (patch.kind === 'set-networks') {
    return { ...spec, networks: uniqueIdentifiers(patch.networks.map(sanitizeIdentifier)) };
  }

  if (patch.kind === 'rename-service') {
    return {
      ...spec,
      services: spec.services.map((service) => ({
        ...service,
        name: service.name === patch.from ? patch.to : service.name,
        ...(service.dependsOn ? { dependsOn: service.dependsOn.map((dependency) => dependency === patch.from ? patch.to : dependency) } : {}),
      })),
    };
  }

  if (patch.kind === 'set-service-image') {
    return {
      ...spec,
      services: spec.services.map((service) => {
        if (!matchesPatchService(service.name, patch.serviceName, spec.services.length)) return service;
        return { ...service, kind: inferServiceKind(patch.image), image: patch.image };
      }),
    };
  }

  if (patch.kind === 'add-service-dependency') {
    if (!spec.services.some((service) => service.name === patch.dependencyName)) return spec;
    return {
      ...spec,
      services: spec.services.map((service) => {
        if (service.name !== patch.serviceName || service.name === patch.dependencyName) return service;
        return { ...service, dependsOn: uniqueIdentifiers([...(service.dependsOn ?? []), patch.dependencyName]) };
      }),
    };
  }

  if (patch.kind === 'remove-service-dependency') {
    return {
      ...spec,
      services: spec.services.map((service) => {
        if (service.name !== patch.serviceName || !service.dependsOn?.includes(patch.dependencyName)) return service;
        const dependsOn = service.dependsOn.filter((dependency) => dependency !== patch.dependencyName);
        const { dependsOn: _removed, ...serviceWithoutDependsOn } = service;
        return dependsOn.length > 0 ? { ...service, dependsOn } : serviceWithoutDependsOn;
      }),
    };
  }

  if (patch.kind === 'set-service-host-port') {
    const portExposedServiceCount = spec.services.filter((service) => service.ports?.length).length;
    return {
      ...spec,
      services: spec.services.map((service) => {
        if (!matchesPatchService(service.name, patch.serviceName, portExposedServiceCount) || !service.ports?.length) return service;
        return {
          ...service,
          ports: service.ports.map((port) => {
            const [host, container] = port.split(':');
            const patchImage = spec.services.find((candidate) => candidate.name === service.name)?.image ?? service.image;
            const containerPort = patch.containerPort !== undefined
              ? String(patch.containerPort)
              : getDefaultContainerPort(patchImage) ?? (container && /^\d+$/.test(container) ? container : host);
            return `${patch.hostPort}:${containerPort}`;
          }),
        };
      }),
    };
  }

  if (patch.kind === 'set-service-replicas') {
    return {
      ...spec,
      services: spec.services.map((service) => service.name === patch.serviceName ? { ...service, replicas: patch.replicas } : service),
    };
  }

  return spec;
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .slice(0, 63);
  return cleaned || 'app';
}

function uniqueIdentifiers(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function findMentionedServiceName(spec: InfrastructureSpec, issue: string): string | null {
  const normalizedIssue = issue.toLowerCase();
  const exactServiceName = spec.services.find((service) => containsIdentifier(normalizedIssue, service.name))?.name;
  if (exactServiceName) return exactServiceName;

  const imageFamilyServiceName = spec.services.find((service) => {
    const imageFamily = service.image.toLowerCase().split(':')[0]?.split('/').pop() ?? '';
    return imageFamily.length > 0 && normalizedIssue.includes(imageFamily);
  })?.name;
  if (imageFamilyServiceName) return imageFamilyServiceName;

  if (/\b(proxy|reverse-proxy|web)\b/i.test(issue)) {
    const exposedReverseProxies = spec.services.filter((service) => service.kind === 'reverse-proxy' && service.ports?.length);
    if (exposedReverseProxies.length === 1) return exposedReverseProxies[0]!.name;
  }

  const exposedServices = spec.services.filter((service) => service.ports?.length);
  if (exposedServices.length === 1) return exposedServices[0]!.name;

  return null;
}

function containsIdentifier(text: string, identifier: string): boolean {
  const escapedIdentifier = identifier.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_.-])${escapedIdentifier}($|[^a-z0-9_.-])`).test(text);
}

function matchesPatchService(serviceName: string, patchServiceName: string | null, serviceCount: number): boolean {
  return patchServiceName === serviceName || (patchServiceName === null && serviceCount === 1);
}

function parseRequestedPortMapping(issue: string): { hostPort: number; containerPort: number } | null {
  const explicitTarget = /(?:to|->|=>)\s*(\d{1,5})\s*:\s*(\d{1,5})/i.exec(issue);
  if (explicitTarget) {
    const hostPort = Number(explicitTarget[1]);
    const containerPort = Number(explicitTarget[2]);
    if (!isValidTcpPort(hostPort) || !isValidTcpPort(containerPort)) return null;
    return { hostPort, containerPort };
  }

  const matches = [...issue.matchAll(/(\d{1,5})\s*:\s*(\d{1,5})/g)];
  const target = matches.at(-1);
  if (!target) return null;

  const hostPort = Number(target[1]);
  const containerPort = Number(target[2]);
  if (!isValidTcpPort(hostPort) || !isValidTcpPort(containerPort)) return null;
  return { hostPort, containerPort };
}

function parseRequestedHostPort(issue: string): number | null {
  const explicitTarget = /\bport\b[\s\S]*?\b(?:to|->|=>)\s*(\d{1,5})(?!\s*:)/i.exec(issue);
  if (explicitTarget) {
    const port = Number(explicitTarget[1]);
    return isValidTcpPort(port) ? port : null;
  }

  const portPhrase = /\b(?:host\s+)?port\b[\s\S]*?(\d{1,5})(?!\s*:)/i.exec(issue);
  if (!portPhrase) return null;

  const port = Number(portPhrase[1]);
  return isValidTcpPort(port) ? port : null;
}

function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function countUnmatchedFeedbackIssues(issues: string[], patches: RevisionPatch[]): number {
  if (patches.length > 0) return 0;
  return issues.filter((issue) => issue.startsWith('User feedback:')).length;
}

function hasNoSafeResolution(findings: VerificationFinding[]): boolean {
  return findings.some((finding) =>
    finding.suggestedAction?.action === 'manual-check' ||
    finding.suggestedAction?.action === 'repair-runtime',
  );
}

function buildRevisionClarifications(
  findings: VerificationFinding[],
): PlannerRevisionResult['clarificationContext'] {
  const riskyFindings = findings.filter((finding) => findingNeedsUserInput(finding));
  if (riskyFindings.length === 0) return undefined;
  return riskyFindings.map((finding, index) => ({
    id: `revision-${index + 1}-${finding.code.toLowerCase()}`,
    severity: finding.severity === 'blocker' || finding.severity === 'error' ? 'blocking' : 'warning',
    field: finding.code === 'IMAGE_NOT_FOUND' || finding.code === 'IMAGE_MISMATCH' ? 'services[].image' : finding.code === 'HOST_PORT_CONFLICT' || finding.code === 'PORT_MISMATCH' ? 'services[].ports' : 'topology',
    message: formatFindingForPlanner(finding),
    reason: finding.suggestedAction?.summary ?? 'Planner needs human guidance before making a risky change.',
    affectedServices: finding.resourceKind === 'service' && finding.resourceName ? [finding.resourceName] : [],
    choices: finding.suggestedAction?.choices ?? [
      { id: '1', label: 'Auto safe fix', description: 'Let the planner apply only low-risk spec changes.', value: 'auto-safe-fix' },
      { id: '2', label: 'Keep current', description: 'Do not change this part of the spec automatically.', value: 'keep-current' },
    ],
    allowOther: true,
  }));
}

function buildPatchClarifications(
  patchResults: ResolvedSpecPatchResult[],
): NonNullable<PlannerRevisionResult['clarificationContext']> {
  return patchResults
    .filter((result) => result.blockedReason !== null)
    .map((result, index) => ({
      id: `patch-${index + 1}-${result.patch.op}`,
      severity: 'warning',
      field: patchField(result.patch.op),
      message: `Structured revision patch "${result.patch.op}" needs user input before it can be applied.`,
      reason: result.blockedReason ?? 'Patch requires user input.',
      affectedServices: result.matchedServiceNames,
      choices: [
        { id: '1', label: 'Allow patch', description: 'Apply this structured revision patch after explicit confirmation.', value: `allow:${result.patch.op}` },
        { id: '2', label: 'Keep current', description: 'Skip this patch and keep the current desired spec unchanged.', value: `skip:${result.patch.op}` },
      ],
      allowOther: true,
    }));
}

function patchField(op: string): import('../domain/types.js').PlanningUncertaintyField {
  if (op.includes('port')) return 'services[].ports';
  if (op.includes('image')) return 'services[].image';
  if (op.includes('volume')) return 'services[].volumes';
  if (op.includes('dependency')) return 'services[].dependsOn';
  return 'topology';
}

function formatFindingForPlanner(finding: VerificationFinding): string {
  const resource = finding.resourceName ? `${finding.resourceKind} "${finding.resourceName}"` : finding.resourceKind;
  return `${finding.code}: ${resource}; expected=${finding.expected ?? 'n/a'}; actual=${finding.actual ?? 'n/a'}; ${finding.evidence.join(' ')}`;
}

function findingNeedsUserInput(finding: VerificationFinding): boolean {
  return finding.requiresUserInput || (finding.code === 'IMAGE_NOT_FOUND' && supportedImageFallback(finding.expected ?? finding.resourceName ?? '') === null);
}

function nextSafePort(port: number, occupiedPorts: Set<number>, attemptNumber: number): number {
  let candidate = Math.min(65535, port + attemptNumber);
  while (occupiedPorts.has(candidate) && candidate < 65535) {
    candidate += 1;
  }
  return candidate;
}

function supportedImageFallback(image: string): string | null {
  const base = (image.toLowerCase().split(':')[0] ?? '').split('/').pop() ?? '';
  if (base === 'nginx' || image.toLowerCase().includes('web')) return 'nginx:stable';
  if (base === 'node') return 'node:20-alpine';
  if (base === 'python') return 'python:3.12-alpine';
  if (base === 'postgres') return 'postgres:16-alpine';
  if (base === 'redis') return 'redis:7-alpine';
  return null;
}

function getDefaultContainerPort(image: string): string | null {
  const base = (image.toLowerCase().split(':')[0] ?? '').split('/').pop() ?? '';
  if (base === 'nginx' || base === 'httpd') return '80';
  return null;
}

function normalizeRevisionImage(image: string): string | null {
  const cleaned = image.replace(/[.,;]+$/g, '').toLowerCase();
  const ignoredWords = new Set(['a', 'an', 'the', 'different', 'image', 'container']);
  if (ignoredWords.has(cleaned)) return null;
  if (cleaned === 'nginx') return 'nginx:stable';
  if (cleaned === 'node') return 'node:20-alpine';
  if (cleaned === 'python') return 'python:3.12-alpine';
  return cleaned.includes(':') ? cleaned : `${cleaned}:latest`;
}

function buildRevisionSummary(
  obs: import('../domain/types.js').RevisionObservation,
  issues: string[],
  revisionStats: RevisionRepairResult | null = null,
): string {
  const parts: string[] = [];
  if (obs.verificationReport) {
    parts.push('Verifier status: ' + obs.verificationReport.status);
  }
  if (obs.userFeedback) {
    parts.push('User feedback received.');
  }
  parts.push(issues.length + ' observation(s) received.');
  if (revisionStats) {
    parts.push(revisionStats.appliedPatchCount + ' patch(es) applied.');
    parts.push((revisionStats.skippedPatchCount + revisionStats.unmatchedIssueCount) + ' patch(es)/feedback item(s) skipped.');
  } else {
    parts.push(issues.length + ' actionable issue(s) processed.');
  }
  return parts.join(' ');
}

