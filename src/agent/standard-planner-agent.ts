import type { LlmProvider } from '../llm/provider.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import type {
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  PlannerRevisionRequest,
  PlannerRevisionResult,
  ValidatedQuery,
  VerificationFinding,
} from '../domain/types.js';
import { validateInfrastructureSpec } from '../domain/schemas.js';
import type { PlannerAgent } from './agent-interfaces.js';

export class StandardPlannerAgent implements PlannerAgent {
  constructor(private readonly provider: LlmProvider) {}

  async proposeSpec(
    query: ValidatedQuery,
    _stateSnapshot: InfrastructureStateSnapshot | null,
    dockerMcpClient?: DockerMcpGateway,
  ): Promise<InfrastructureSpec> {
    // If Docker is available, gather existing state to inform the proposal
    const existingContainers: string[] = [];
    const existingImages: string[] = [];
    const existingNetworks: string[] = [];

    if (dockerMcpClient?.isInitialized) {
      try {
        const containers = await dockerMcpClient.listContainers(true);
        existingContainers.push(...containers.map((c) => c.name));
        const images = await dockerMcpClient.listImages();
        existingImages.push(...images.map((i) => i.reference));
        const networks = await dockerMcpClient.listNetworks();
        existingNetworks.push(...networks.map((n) => n.name));
      } catch {
        // Docker read-only failures are non-fatal for planning
      }
    }

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
        if (s.port) {
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
      projectName: toProjectName(query.normalizedPrompt),
      services: inferred,
      networks: query.draft.services.length > 1 ? ['app-network'] : [],
      volumes: [],
    };

    return validateInfrastructureSpec(spec);
  }

  async repairSpec(
    spec: InfrastructureSpec,
    _issues: string[],
    _dockerMcpClient?: DockerMcpGateway,
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
    let llmAdvisory: string | null = null;
    let revisionDecision: PlannerRevisionResult['revisionDecision'] = 'auto-revised';

    if (issues.length > 0) {
      llmAdvisory = await this.getRevisionAdvisory(spec, issues, request.attemptIndex);
      revisedSpec = applyRevisionRepairs(spec, issues, request.attemptIndex + 1, findings);
      revisionDecision = requiresUserInput ? 'needs-user-input' : hasNoSafeResolution(findings) ? 'no-safe-resolution' : 'auto-revised';
      assumptions.push(
        `Revision ${request.attemptIndex + 1}: applied ${issues.length} fix(es) from verifier/user feedback.`,
      );
      assumptions.push(`Revision decision: ${revisionDecision}.`);
      if (llmAdvisory) {
        assumptions.push(`LLM advisory: ${llmAdvisory}`);
      }
    } else {
      assumptions.push(
        `Revision ${request.attemptIndex + 1}: no actionable issues detected, re-validating spec.`,
      );
    }

    const validatedSpec = validateInfrastructureSpec(revisedSpec);

    const result: PlannerRevisionResult = {
      revisedSpec: validatedSpec,
      revisionSummary: buildRevisionSummary(obs, issues),
      assumptions,
      revisionDecision,
    };
    const clarificationContext = buildRevisionClarifications(findings);
    if (clarificationContext !== undefined) {
      result.clarificationContext = clarificationContext;
    }
    return result;
  }

  private async getRevisionAdvisory(
    spec: InfrastructureSpec,
    issues: string[],
    attemptIndex: number,
  ): Promise<string | null> {
    try {
      const response = await this.provider.complete({
        purpose: 'react',
        system: [
          'You are a ReAct infrastructure planner.',
          'A verifier or user observation found that the current infrastructure plan needs revision.',
          'Recommend a safe high-level revision only. Do not produce Docker API payloads.',
        ].join('\n'),
        user: JSON.stringify({
          attemptIndex,
          projectName: spec.projectName,
          services: spec.services.map((service) => ({
            name: service.name,
            ports: service.ports ?? [],
            image: service.image,
          })),
          issues,
        }),
      });
      return response.text.trim().replace(/\s+/g, ' ').slice(0, 240) || null;
    } catch {
      return null;
    }
  }
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

function applyRevisionRepairs(
  spec: InfrastructureSpec,
  issues: string[],
  attemptNumber: number,
  findings: VerificationFinding[] = [],
): InfrastructureSpec {
  const conflictingContainerNames = new Set<string>();
  const conflictingHostPorts = new Set<number>();
  const requestedHostPorts = new Map<string, number>();
  const requestedImages = new Map<string, string>();
  let fallbackRequestedHostPort: number | null = null;
  let fallbackRequestedImage: string | null = null;

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
        requestedImages.set(finding.resourceName, fallback);
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

    const requestedPort = /(?:host\s+)?port\D+(\d{2,5})/i.exec(issue)?.[1];
    if (requestedPort) {
      const parsedPort = Number(requestedPort);
      if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        fallbackRequestedHostPort = parsedPort;
        for (const service of spec.services) {
          if (issue.toLowerCase().includes(service.name.toLowerCase())) {
            requestedHostPorts.set(service.name, parsedPort);
          }
        }
      }
    }

    const requestedImage = /(?:use|image|replace\s+with)\s+([A-Za-z0-9_./:-]+)/i.exec(issue)?.[1];
    if (requestedImage) {
      const normalizedImage = normalizeRevisionImage(requestedImage);
      if (normalizedImage !== null) {
        fallbackRequestedImage = normalizedImage;
        for (const service of spec.services) {
          if (issue.toLowerCase().includes(service.name.toLowerCase())) {
            requestedImages.set(service.name, normalizedImage);
          }
        }
      }
    }
  }

  const projectName = spec.services.some((service) =>
    conflictingContainerNames.has(spec.projectName + '-' + service.name.replace(/[_\s]+/g, '-')),
  )
    ? `${spec.projectName}-r${attemptNumber}`
    : spec.projectName;

  const services = spec.services.map((service) => {
    let repaired = service;
    const requestedImage = requestedImages.get(service.name) ?? fallbackRequestedImage;
    if (requestedImage !== null) {
      repaired = {
        ...repaired,
        kind: inferServiceKind(requestedImage),
        image: requestedImage,
      };
    }

    // If a container is reported as exited/stopped for a raw runtime backend,
    // inject a keepalive command so the container stays up for the demo.
    const exitedForThis = issues.some(
      (issue) =>
        issue.includes(service.name) &&
        (issue.includes('exited') ||
          issue.includes('not running') ||
          issue.includes('stopped')),
    );

    if (exitedForThis && service.kind === 'backend') {
      const base = (service.image.toLowerCase().split(':')[0] ?? '').split('/').pop() ?? '';
      const rawRuntimeBases = new Set(['node', 'python', 'golang', 'openjdk', 'eclipse-temurin', 'alpine', 'ubuntu', 'debian', 'busybox']);
      if (rawRuntimeBases.has(base)) {
        repaired = {
          ...repaired,
        };
      }
    }

    if (service.ports?.length) {
      const repairedPorts = service.ports.map((port) => {
        const [host, container] = port.split(':');
        const hostPort = Number(host);
        const requestedHostPort = requestedHostPorts.get(service.name) ?? fallbackRequestedHostPort;
        if (requestedHostPort !== null && !conflictingHostPorts.has(requestedHostPort)) {
          const containerPort = getDefaultContainerPort(repaired.image) ?? (container && /^\d+$/.test(container) ? container : host);
          return `${requestedHostPort}:${containerPort}`;
        }
        const defaultContainerPort = getDefaultContainerPort(repaired.image);
        if (requestedImage !== null && defaultContainerPort !== null && Number.isInteger(hostPort)) {
          return `${hostPort}:${defaultContainerPort}`;
        }
        if (!Number.isInteger(hostPort) || !conflictingHostPorts.has(hostPort)) {
          return port;
        }
        const containerPort = container && /^\d+$/.test(container) ? container : host;
        return `${nextSafePort(hostPort, conflictingHostPorts, attemptNumber)}:${containerPort}`;
      });
      repaired = {
        ...repaired,
        ports: repairedPorts,
      };
    }

    return repaired;
  });

  return { ...spec, projectName, services };
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
): string {
  const parts: string[] = [];
  if (obs.verificationReport) {
    parts.push('Verifier status: ' + obs.verificationReport.status);
  }
  if (obs.userFeedback) {
    parts.push('User feedback received.');
  }
  parts.push(issues.length + ' actionable issue(s) processed.');
  return parts.join(' ');
}
