import type { LlmProvider } from '../llm/provider.js';
import type { PlannerRuntimeReader } from '../execution/runtime-environment-reader.js';
import type {
  FeedbackIntent,
  IssueAnalysis,
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  PlannerRevisionRequest,
  PlannerRevisionResult,
  RevisionHistoryRecord,
  ResolvedSpecPatchResult,
  ServiceSelector,
  SpecPatch,
  SpecPatchPlan,
  ValidatedQuery,
  VerificationFinding,
} from '../domain/types.js';
import { validateFeedbackIntent, validateInfrastructureSpec, validateSpecPatchPlan, validateVerifierRemediationPatchPlan } from '../domain/schemas.js';
import { feedbackIntentJsonSchema, specPatchPlanJsonSchema, verifierRemediationPatchPlanJsonSchema } from '../domain/structured-output-schemas.js';
import { expandStatefulDatabaseReplicas, isStatefulDatabaseService } from '../domain/stateful-database-volumes.js';
import { parseJsonResponse } from '../llm/json-response.js';
import { namespaceInfrastructureSpec } from '../domain/project-identity.js';
import type { PlannerAgent } from './agent-interfaces.js';
import { applySpecPatchPlan, resolveServiceSelector } from './spec-patch-applier.js';
import {
  getTrustedDefaultImageForBase,
  getTrustedImageForBaseVersion,
  getTrustedImageProfile,
  getTrustedReplacementImages,
} from '../domain/supported-images.js';
import { loadInfrastructureSchemaLimitConfig } from '../config/runtime-limits.js';

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

    // Use default dependsOn inference
    const inferred = applyDependencyInference(services);

    const spec: InfrastructureSpec = {
      projectName: avoidProjectNameConflict(toProjectName(query.normalizedPrompt), runtimeContext.containerNames),
      services: inferred,
      networks: query.draft.services.length > 1 ? ['app-network'] : [],
      volumes: [],
    };

    return validateInfrastructureSpec(expandStatefulDatabaseReplicas(spec));
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
    runtimeReader?: PlannerRuntimeReader,
  ): Promise<PlannerRevisionResult> {
    const spec = request.desiredSpec;
    const obs = request.revisionObservation;
    const issues = collectRevisionIssues(obs);
    const findings = obs.verificationReport?.findings ?? [];
    const requiresUserInput = findings.some((finding) => findingNeedsUserInput(finding));
    const assumptions: string[] = [];

    let revisedSpec = spec;
    let patchPlan: SpecPatchPlan | null = null;
    let patchPlanError: string | null = null;
    let patchResults: ResolvedSpecPatchResult[] | undefined;
    let revisionDecision: PlannerRevisionResult['revisionDecision'] = 'auto-revised';
    let revisionStats: RevisionRepairResult | null = null;
    let feedbackLimitBlocked = false;

    if (issues.length > 0) {
      let feedbackIntent = request.feedbackIntent ?? null;
      if (feedbackIntent === null && obs.userFeedback !== null) {
        const intentResult = await this.getFeedbackIntent(spec, request, issues, findings);
        feedbackIntent = intentResult.feedbackIntent;
        assumptions.push(...intentResult.diagnostics);
      }
      if (obs.userFeedback !== null) {
        const limitPatchPlan = buildLimitViolationPatchPlan(obs.userFeedback.message, feedbackIntent);
        if (limitPatchPlan !== null) {
          patchPlan = limitPatchPlan;
          feedbackLimitBlocked = true;
          assumptions.push('Revision blocked before patch planning because user feedback exceeded a configured limit.');
        }
      }
      if (patchPlan === null) {
        const patchPlanMode = selectRevisionPatchPlanMode(request, feedbackIntent, findings);
        const patchPlanResult = await this.getRevisionPatchPlan(
          spec,
          { ...request, feedbackIntent },
          issues,
          findings,
          patchPlanMode,
        );
        patchPlan = patchPlanResult.patchPlan;
        patchPlanError = patchPlanResult.error;
        assumptions.push(...patchPlanResult.diagnostics);
      }
      if (patchPlan !== null && obs.userFeedback != null) {
        const normalizedPatchPlan = normalizeStatefulDatabaseReplicaPatchPlan(
          spec,
          patchPlan,
          obs.userFeedback.message,
          feedbackIntent,
        );
        if (normalizedPatchPlan !== patchPlan) {
          patchPlan = normalizedPatchPlan;
          assumptions.push('Revision patch source: normalized stateful database total/group feedback to a logical database replica patch.');
        }
      }
      if (patchPlan !== null) {
        const portConflictPatchPlan = normalizeHostPortConflictPatchPlan(
          spec,
          patchPlan,
          issues,
          findings,
        );
        if (portConflictPatchPlan !== patchPlan) {
          patchPlan = portConflictPatchPlan;
          assumptions.push('Revision patch source: host port conflict requires an explicit replace-service-port patch; port removal and deterministic port synthesis are not allowed for this issue.');
        }
      }
      if (patchPlan !== null && (patchPlan.patches.length > 0 || patchPlan.requiresUserInput || patchPlan.ambiguities.length > 0 || isServiceTargetAmbiguityPatchPlan(patchPlan))) {
        const plannedRevision = applySpecPatchPlan(spec, patchPlan.patches, {
          allowBlockedPatchOps: extractAllowedPatchOps(issues),
          verificationFindings: findings,
          feedbackIntent,
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
      } else if (obs.userFeedback !== null) {
        revisionDecision = 'needs-user-input';
        assumptions.push(
          `Revision ${request.attemptIndex + 1}: received ${issues.length} observation(s), but no schema-valid feedback patch could be inferred safely.`,
        );
        if (patchPlan !== null) {
          assumptions.push(`LLM structured revision returned no direct patch: ${patchPlan.explanation}`);
        } else {
          assumptions.push(`LLM structured revision failed or was unavailable: ${patchPlanError ?? 'unknown error'}. Deterministic feedback parsing is disabled.`);
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

    const validatedSpec = validateInfrastructureSpec(namespaceInfrastructureSpec(revisedSpec));

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
      ...buildPatchClarifications(patchResults ?? [], findings),
      ...buildPatchPlanAmbiguityClarifications(spec, patchPlan),
    ];
    if (clarificationContext.length > 0) {
      result.clarificationContext = clarificationContext;
    }
    return result;
  }

  private async getRevisionPatchPlan(
    spec: InfrastructureSpec,
    request: PlannerRevisionRequest,
    issues: string[],
    findings: VerificationFinding[],
    mode: RevisionPatchPlanMode,
  ): Promise<RevisionPatchPlanResult> {
    try {
      const isVerifierRemediation = mode === 'verifier-remediation';
      const userPayload = JSON.stringify({
        patchPlanMode: mode,
        attemptIndex: request.attemptIndex,
        projectName: spec.projectName,
        logicalServiceCatalog: buildLogicalRevisionServiceCatalog(spec),
        physicalServiceCatalog: buildPhysicalRevisionServiceCatalog(spec),
        serviceCatalog: buildLogicalRevisionServiceCatalog(spec),
        databaseReplicaGroups: buildDatabaseReplicaGroups(spec),
        verifierObservation: buildVerifierObservationContext(spec, request.revisionObservation),
        userFeedback: request.revisionObservation.userFeedback,
        feedbackIntent: request.feedbackIntent ?? null,
        runtimeIssueReport: request.runtimeIssueReport ?? null,
        revisionHistory: buildRevisionHistoryContext(request.revisionHistory ?? []),
        runtimeRefs: request.resourceRefs ?? null,
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
          issueGrounding: isVerifierRemediation
            ? 'Start from verifierObservation.affectedResources. For every patch, include resolvesIssueCodes, affectedServiceNames, and resolutionReason showing which verifier issue and affected entity the patch resolves.'
            : 'Planner/user revision mode: do not use verifier issue codes as action names. Convert user intent into patch op values such as set-service-replicas, rename-service, replace-service-port.',
          targetResolution: 'Prefer selectors by exact name, nameLike, kind, imageFamily, exposesHostPort, dependsOn, dependentOf instead of guessing a concrete name when the user uses an alias.',
          portInference: 'When the user gives host:container, use it exactly. When the user gives one port and the target service already has exactly one mapping, preserve the existing container port unless the user explicitly says both sides should change.',
          schemaNormalization: 'Convert natural-language feedback to SpecPatch objects only when the intent, target, and causal link to the observation are clear. Otherwise return requiresUserInput=true with a specific ambiguity.',
          replicaGroupTargeting: 'Use targetKind="replica-group" only when userFeedback or verifierObservation explicitly asks for database replica/group/overall instance count. Then set patch.target.name to databaseReplicaGroups.baseName and include kind="database" plus imageFamily.',
          feedbackIntent: 'If feedbackIntent is present, treat it as the structured parse of user other feedback and convert it to SpecPatch objects. If feedbackIntent is absent but userFeedback exists, infer intent from userFeedback and observations.',
        },
      });
      const response = await this.provider.completeStructured({
        purpose: 'react',
        system: [
          'REVISION_PATCH_PLANNER_V1',
          'You revise desired infrastructure by returning schema-valid JSON patches only.',
          'Patch InfrastructureSpec, not Docker API payloads and not docker-compose YAML.',
          ...(isVerifierRemediation
            ? [
                'Return issueAnalysis first: for each relevant verifier observation, identify the issue, affected service/resource, intended fix, and any user input needed.',
                'Every patch must include resolvesIssueCodes, affectedServiceNames, and resolutionReason. resolvesIssueCodes must use verifier finding codes such as HOST_PORT_CONFLICT or IMAGE_NOT_FOUND, never user intents such as change-replicas.',
              ]
            : [
                'Use the base planner patch schema: patches need op, target/service fields, and reason; do not include issueAnalysis and do not require resolvesIssueCodes.',
                'User intents such as change-replicas, change-name, and change-port are not patch ops and are not verifier issue codes. Convert them into set-service-replicas, rename-service, or replace-service-port patches.',
              ]),
          'Do not emit patches that are unrelated to verifierObservation unless userFeedback explicitly asks for that separate change.',
          'If a runtime issue identifies an affected service but the necessary replacement value is missing, return no patch, requiresUserInput=true, and a specific ambiguity asking for that value.',
          'Use logicalServiceCatalog as the default source of truth for mapping user wording to existing services.',
          'Use physicalServiceCatalog only when the user explicitly names an expanded physical service like postgres-2.',
          'When databaseReplicaGroups are present, treat expanded names like postgres-1/postgres-2 as one logical stateful database group for replica-count changes.',
          'Only for explicit stateful database total/group/overall instance changes, emit one set-service-replicas patch with targetKind="replica-group", name=databaseReplicaGroups.baseName, kind="database", and imageFamily; do not emit separate patches for each physical service.',
          'Use verifierObservation, userFeedback, and runtimeRefs as observations about the same desired spec; do not ignore verifier evidence when user feedback is present.',
          'Use revisionHistory as prior failed attempts for the same deploy loop; if earlier findings show a host port or value already failed, do not propose that failed value again.',
          'Treat userFeedback from an "other" answer as a fresh natural-language instruction, but still ground target selection in logicalServiceCatalog, physicalServiceCatalog, and verifierObservation.',
          'Choose targets by comparing the user request with each service name, role, image family, exposed ports, dependencies, dependents, and current replicas.',
          'If prior clarification feedback contains targetService:<name>, use the requested change to that exact existing service name.',
          'Understand natural language flexibly: map names, roles, image families, counts, and port intent into the closest valid SpecPatch.',
          'Normalize free-form user feedback into schema-valid patches: ports, replicas, images, env vars, volumes, dependencies, service names, service status, project name, networks, add/remove services.',
          'Use targetKind="service" for ordinary single services and targetKind="replica-group" only for logical stateful replica groups.',
          'When multiple current services could match, return requiresUserInput=true with a short ambiguity instead of guessing. The app will present service options to the user.',
        ].join('\n'),
        user: userPayload,
        schemaName: 'spec_patch_plan',
        schema: isVerifierRemediation ? verifierRemediationPatchPlanJsonSchema : specPatchPlanJsonSchema,
      });
      const patchPlan = normalizeAndValidateSpecPatchPlan(parseJsonResponse(response.text), mode, findings);
      return {
        patchPlan,
        error: null,
        diagnostics: [
          `LLM revision request sent to structured provider with schema spec_patch_plan (${mode}).`,
          `LLM revision input: ${truncateDiagnostic(userPayload)}`,
          `LLM revision raw response: ${truncateDiagnostic(response.text)}`,
          `LLM revision validated patch ops: ${patchPlan.patches.map((patch) => patch.op).join(', ') || 'none'}.`,
        ],
      };
    } catch (error) {
      const formattedError = formatRevisionPatchPlanError(error);
      return {
        patchPlan: null,
        error: formattedError,
        diagnostics: [
          'LLM revision request failed or returned invalid structured output.',
          `LLM revision error: ${truncateDiagnostic(formattedError)}`,
        ],
      };
    }
  }

  private async getFeedbackIntent(
    spec: InfrastructureSpec,
    request: PlannerRevisionRequest,
    issues: string[],
    findings: VerificationFinding[],
  ): Promise<FeedbackIntentResult> {
    const rawText = request.revisionObservation.userFeedback?.message ?? '';
    if (rawText.trim().length === 0) {
      return {
        feedbackIntent: null,
        diagnostics: ['LLM feedback intent parsing skipped because user feedback is empty.'],
      };
    }

    try {
      const userPayload = JSON.stringify({
        rawText,
        attemptIndex: request.attemptIndex,
        projectName: spec.projectName,
        logicalServiceCatalog: buildLogicalRevisionServiceCatalog(spec),
        physicalServiceCatalog: buildPhysicalRevisionServiceCatalog(spec),
        serviceCatalog: buildLogicalRevisionServiceCatalog(spec),
        databaseReplicaGroups: buildDatabaseReplicaGroups(spec),
        verifierObservation: buildVerifierObservationContext(spec, request.revisionObservation),
        runtimeIssueReport: request.runtimeIssueReport ?? null,
        revisionHistory: buildRevisionHistoryContext(request.revisionHistory ?? []),
        runtimeRefs: request.resourceRefs ?? null,
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
        parserGuidance: {
          sourceOfTruth: 'Parse other feedback into FeedbackIntent only. Do not return SpecPatchPlan here.',
          yamlIntent: 'If the user pastes YAML or asks to edit YAML, set intent=yaml-edit-intent and place the YAML in desiredChange.yamlFragment; do not claim it is already applied.',
          targetResolution: 'Ground target selection in service names, kinds, image families, exposed host ports, dependencies, and verifier findings.',
        },
      });
      const response = await this.provider.completeStructured({
        purpose: 'react',
        system: [
          'FEEDBACK_INTENT_PARSER_V1',
          'Parse free-form user other feedback into one schema-valid FeedbackIntent object.',
          'Do not produce infrastructure patches. Do not edit docker-compose YAML. Only classify intent, target, desiredChange, confidence, and ambiguities.',
          'Use runtime issues and current service catalog to resolve phrases like change port, rename, replicas, image, env, volume, network, remove exposure, or YAML edit intent.',
          'When databaseReplicaGroups are present, interpret phrases like total 4 database instances as change-replicas for the logical database group, not as separate add/remove service requests.',
          'If the target or desired value is ambiguous, set requiresUserInput=true and include concise ambiguities.',
        ].join('\n'),
        user: userPayload,
        schemaName: 'feedback_intent',
        schema: feedbackIntentJsonSchema,
      });
      const feedbackIntent = normalizeAndValidateFeedbackIntent(
        parseJsonResponse(response.text),
        rawText,
      );
      return {
        feedbackIntent,
        diagnostics: [
          'LLM other feedback parsed with schema feedback_intent.',
          `LLM feedback intent input: ${truncateDiagnostic(userPayload)}`,
          `LLM feedback intent raw response: ${truncateDiagnostic(response.text)}`,
          `LLM feedback intent parsed: ${feedbackIntent.intent} confidence=${feedbackIntent.confidence}.`,
        ],
      };
    } catch (error) {
      return {
        feedbackIntent: null,
        diagnostics: [
          'LLM other feedback intent parsing failed or returned invalid structured output.',
          `LLM feedback intent error: ${truncateDiagnostic(formatRevisionPatchPlanError(error))}`,
        ],
      };
    }
  }
}

interface FeedbackIntentResult {
  feedbackIntent: FeedbackIntent | null;
  diagnostics: string[];
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

function buildRevisionHistoryContext(history: RevisionHistoryRecord[]): Array<{
  attemptIndex: number;
  revisionDecision: RevisionHistoryRecord['revisionDecision'];
  revisionSummary: string;
  findings: Array<{
    code: string;
    resourceKind: string;
    resourceName: string | null;
    expected: string | null;
    actual: string | null;
    evidence: string[];
  }>;
  userFeedback: string | null;
}> {
  return history.map((record) => ({
    attemptIndex: record.attemptIndex,
    revisionDecision: record.revisionDecision,
    revisionSummary: record.revisionSummary,
    findings: record.findings.map((finding) => ({
      code: finding.code,
      resourceKind: finding.resourceKind,
      resourceName: finding.resourceName ?? null,
      expected: finding.expected ?? null,
      actual: finding.actual ?? null,
      evidence: finding.evidence,
    })),
    userFeedback: record.userFeedback?.message ?? null,
  }));
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

function buildPhysicalRevisionServiceCatalog(spec: InfrastructureSpec): Array<{
  name: string;
  role: InfrastructureSpec['services'][number]['kind'];
  image: string;
  imageFamily: string;
  stateful: boolean;
  replicaGroup: string | null;
  ordinal: number | null;
  physicalInstances: number;
  currentDesiredInstances: number;
  exposedPorts: string[];
  dependsOn: string[];
  dependents: string[];
  volumes: string[];
  environmentKeys: string[];
}> {
  return spec.services.map((service) => {
    const imageFamily = service.image.toLowerCase().split(':')[0]?.split('/').pop() ?? service.image.toLowerCase();
    const parsed = parseNumberedReplicaServiceName(service.name);
    return {
      name: service.name,
      role: service.kind,
      image: service.image,
      imageFamily,
      stateful: isStatefulDatabaseService(service),
      replicaGroup: service.kind === 'database' ? parsed?.baseName ?? null : null,
      ordinal: service.kind === 'database' ? parsed?.ordinal ?? null : null,
      physicalInstances: 1,
      currentDesiredInstances: service.replicas ?? 1,
      exposedPorts: service.ports ?? [],
      dependsOn: service.dependsOn ?? [],
      dependents: spec.services
        .filter((candidate) => candidate.dependsOn?.includes(service.name))
        .map((candidate) => candidate.name),
      volumes: service.volumes ?? [],
      environmentKeys: Object.keys(service.environment ?? {}),
    };
  });
}

function buildLogicalRevisionServiceCatalog(spec: InfrastructureSpec): Array<{
  name: string;
  role: InfrastructureSpec['services'][number]['kind'];
  image: string;
  imageFamily: string;
  stateful: boolean;
  currentDesiredInstances: number;
  expandedServices: string[];
  exposedPorts: string[];
  dependsOn: string[];
  dependents: string[];
  volumes: string[];
  environmentKeys: string[];
}> {
  const databaseGroups = buildDatabaseReplicaGroups(spec);
  const groupedPhysicalNames = new Set(databaseGroups.flatMap((group) => group.serviceNames));
  const logicalCatalog = spec.services
    .filter((service) => !groupedPhysicalNames.has(service.name))
    .map((service) => {
      const imageFamily = getServiceImageFamily(service);
      return {
        name: service.name,
        role: service.kind,
        image: service.image,
        imageFamily,
        stateful: isStatefulDatabaseService(service),
        currentDesiredInstances: service.replicas ?? 1,
        expandedServices: [service.name],
        exposedPorts: service.ports ?? [],
        dependsOn: service.dependsOn ?? [],
        dependents: getServiceDependents(spec, service.name),
        volumes: service.volumes ?? [],
        environmentKeys: Object.keys(service.environment ?? {}),
      };
    });

  return [
    ...logicalCatalog,
    ...databaseGroups.map((group) => {
      const representative = group.serviceNames
        .map((name) => spec.services.find((service) => service.name === name))
        .find((service): service is InfrastructureSpec['services'][number] => service !== undefined);
      return {
        name: group.baseName,
        role: 'database' as const,
        image: representative?.image ?? group.imageFamily,
        imageFamily: group.imageFamily,
        stateful: true,
        currentDesiredInstances: group.currentDesiredInstances,
        expandedServices: group.serviceNames,
        exposedPorts: uniqueIdentifiers(group.serviceNames.flatMap((name) => spec.services.find((service) => service.name === name)?.ports ?? [])),
        dependsOn: uniqueIdentifiers(group.serviceNames.flatMap((name) => spec.services.find((service) => service.name === name)?.dependsOn ?? [])
          .filter((dependency) => !group.serviceNames.includes(dependency))),
        dependents: uniqueIdentifiers(group.serviceNames.flatMap((name) => getServiceDependents(spec, name))),
        volumes: uniqueIdentifiers(group.serviceNames.flatMap((name) => spec.services.find((service) => service.name === name)?.volumes ?? [])),
        environmentKeys: uniqueIdentifiers(group.serviceNames.flatMap((name) => Object.keys(spec.services.find((service) => service.name === name)?.environment ?? {}))),
      };
    }),
  ];
}

function buildDatabaseReplicaGroups(spec: InfrastructureSpec): Array<{
  baseName: string;
  imageFamily: string;
  currentDesiredInstances: number;
  serviceNames: string[];
  volumeNames: string[];
}> {
  const expandedGroups = new Map<string, InfrastructureSpec['services']>();
  const logicalGroups: Array<{
    baseName: string;
    imageFamily: string;
    currentDesiredInstances: number;
    serviceNames: string[];
    volumeNames: string[];
  }> = [];

  for (const service of spec.services) {
    if (service.kind !== 'database') continue;
    const imageFamily = service.image.toLowerCase().split(':')[0]?.split('/').pop() ?? service.image.toLowerCase();
    const parsed = parseNumberedReplicaServiceName(service.name);

    if ((service.replicas ?? 1) > 1 || parsed === null) {
      logicalGroups.push({
        baseName: parsed?.baseName ?? service.name,
        imageFamily,
        currentDesiredInstances: service.replicas ?? 1,
        serviceNames: [service.name],
        volumeNames: declaredNamedVolumes(service.volumes ?? []),
      });
      continue;
    }

    const services = expandedGroups.get(parsed.baseName) ?? [];
    services.push(service);
    expandedGroups.set(parsed.baseName, services);
  }

  return [
    ...logicalGroups,
    ...[...expandedGroups.entries()]
      .map(([baseName, services]) => {
        const sortedServices = [...services].sort(
          (left, right) => (parseNumberedReplicaServiceName(left.name)?.ordinal ?? 0) - (parseNumberedReplicaServiceName(right.name)?.ordinal ?? 0),
        );
        const first = sortedServices[0]!;
        const imageFamily = first.image.toLowerCase().split(':')[0]?.split('/').pop() ?? first.image.toLowerCase();
        return {
          baseName,
          imageFamily,
          currentDesiredInstances: sortedServices.length,
          serviceNames: sortedServices.map((service) => service.name),
          volumeNames: sortedServices.flatMap((service) => declaredNamedVolumes(service.volumes ?? [])),
        };
      }),
  ];
}

function getServiceImageFamily(service: InfrastructureSpec['services'][number]): string {
  return service.image.toLowerCase().split(':')[0]?.split('/').pop() ?? service.image.toLowerCase();
}

function getServiceDependents(spec: InfrastructureSpec, serviceName: string): string[] {
  return spec.services
    .filter((candidate) => candidate.dependsOn?.includes(serviceName))
    .map((candidate) => candidate.name);
}

function buildVerifierObservationContext(spec: InfrastructureSpec, obs: import('../domain/types.js').RevisionObservation): {
  status: string | null;
  scope: string | null;
  revisionHint: string | null;
  issues: string[];
  findings: Array<{
    code: string;
    severity: string;
    resourceKind: string;
    resourceName: string | null;
    expected: string | null;
    actual: string | null;
    evidence: string[];
    suggestedAction: string | null;
    requiresUserInput: boolean;
  }>;
  affectedResources: Array<{
    issueCode: string;
    resourceRef: string;
    serviceName: string | null;
    serviceKind: InfrastructureSpec['services'][number]['kind'] | null;
    currentDesiredValue: string | null;
    runtimeActualValue: string | null;
    blockedReason: string | null;
    userActionNeeded: string | null;
  }>;
  driftSummary: string | null;
} {
  const report = obs.verificationReport;
  return {
    status: report?.status ?? null,
    scope: report?.scope ?? null,
    revisionHint: report?.revisionHint ?? null,
    issues: report?.issues ?? [],
    findings: (report?.findings ?? []).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      resourceKind: finding.resourceKind,
      resourceName: finding.resourceName ?? null,
      expected: finding.expected ?? null,
      actual: finding.actual ?? null,
      evidence: finding.evidence,
      suggestedAction: finding.suggestedAction?.summary ?? null,
      requiresUserInput: finding.requiresUserInput,
    })),
    affectedResources: (report?.findings ?? []).map((finding) => buildAffectedResource(spec, finding)),
    driftSummary: obs.driftSummary,
  };
}

function buildAffectedResource(
  spec: InfrastructureSpec,
  finding: VerificationFinding,
): ReturnType<typeof buildVerifierObservationContext>['affectedResources'][number] {
  const serviceName = finding.resourceKind === 'service' || finding.resourceKind === 'port'
    ? finding.resourceName ?? extractServiceNameFromResourceName(finding.resourceName)
    : null;
  const service = serviceName ? spec.services.find((candidate) => candidate.name === serviceName) ?? null : null;
  return {
    issueCode: finding.code,
    resourceRef: finding.resourceName ? `${finding.resourceKind}/${finding.resourceName}` : finding.resourceKind,
    serviceName: service?.name ?? serviceName,
    serviceKind: service?.kind ?? null,
    currentDesiredValue: finding.expected ?? summarizeDesiredFindingValue(service, finding),
    runtimeActualValue: finding.actual ?? null,
    blockedReason: finding.evidence[0] ?? finding.suggestedAction?.summary ?? null,
    userActionNeeded: finding.requiresUserInput
      ? finding.suggestedAction?.summary ?? describeFindingActionNeeded(finding)
      : null,
  };
}

function extractServiceNameFromResourceName(resourceName: string | null | undefined): string | null {
  if (!resourceName) return null;
  const parts = resourceName.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : resourceName;
}

function summarizeDesiredFindingValue(
  service: InfrastructureSpec['services'][number] | null,
  finding: VerificationFinding,
): string | null {
  if (!service) return null;
  if (finding.code === 'HOST_PORT_CONFLICT' || finding.code === 'PORT_MISMATCH') return (service.ports ?? []).join(', ') || null;
  if (finding.code === 'IMAGE_NOT_FOUND' || finding.code === 'IMAGE_MISMATCH') return service.image;
  return null;
}

function describeFindingActionNeeded(finding: VerificationFinding): string | null {
  if (finding.code === 'HOST_PORT_CONFLICT') return 'Choose a replacement host port for the affected service.';
  return 'Provide guidance for the affected runtime issue.';
}

function extractAllowedPatchOps(issues: string[]): string[] {
  return issues.flatMap((issue) => [...issue.matchAll(/allow:([a-z0-9-]+)/gi)].map((match) => match[1]!));
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

type RevisionPatchPlanResult =
  | { patchPlan: SpecPatchPlan; error: null; diagnostics: string[] }
  | { patchPlan: null; error: string; diagnostics: string[] };

type RevisionPatchPlanMode = 'planner-revision' | 'verifier-remediation';

type NormalizedSpecPatchPlanShape = SpecPatchPlan & { issueAnalysis?: IssueAnalysis[] };

function selectRevisionPatchPlanMode(
  request: PlannerRevisionRequest,
  feedbackIntent: FeedbackIntent | null,
  _findings: VerificationFinding[],
): RevisionPatchPlanMode {

  const structuredFeedbackIntent = feedbackIntent !== null
    && feedbackIntent.intent !== 'unknown'
    && feedbackIntent.intent !== 'retry-as-is'
    && feedbackIntent.intent !== 'cancel';
  if (structuredFeedbackIntent) return 'planner-revision';

  if (request.revisionObservation.userFeedback !== null) return 'planner-revision';
  return 'planner-revision';
}

function truncateDiagnostic(value: string, maxLength = 1200): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function formatRevisionPatchPlanError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function normalizeAndValidateSpecPatchPlan(value: unknown, mode: RevisionPatchPlanMode, findings: VerificationFinding[] = []): SpecPatchPlan {
  const normalizedPlan = normalizeSpecPatchPlanShape(value);
  if (mode === 'verifier-remediation') {
    return validateVerifierRemediationPatchPlan(addVerifierGrounding(normalizedPlan, findings));
  }
  const { issueAnalysis: _issueAnalysis, ...plannerPlan } = normalizedPlan;
  return validateSpecPatchPlan(plannerPlan);
}

function addVerifierGrounding(plan: NormalizedSpecPatchPlanShape, findings: VerificationFinding[]): NormalizedSpecPatchPlanShape {
  if (findings.length === 0) return plan;
  const fallbackIssueAnalysis: IssueAnalysis[] = findings.map((finding) => ({
    issueCode: finding.code,
    affectedResource: finding.resourceName ?? finding.resourceKind,
    ...(extractServiceNameFromResourceName(finding.resourceName) ? { affectedServiceName: extractServiceNameFromResourceName(finding.resourceName)! } : {}),
    intendedFix: finding.evidence[0] ?? finding.suggestedAction?.summary ?? finding.code,
  }));

  const firstFinding = findings[0]!;
  const patches = plan.patches.map((patch) => {
    const matchedFinding = findGroundingFindingForPatch(patch, findings) ?? firstFinding;
    const affectedServiceNames = patch.affectedServiceNames?.length
      ? patch.affectedServiceNames
      : [extractServiceNameFromResourceName(matchedFinding.resourceName), ...resolveServiceNamesFromSelector(patch)]
        .filter((name): name is string => Boolean(name));
    return {
      ...patch,
      resolvesIssueCodes: patch.resolvesIssueCodes?.length ? patch.resolvesIssueCodes : [matchedFinding.code],
      affectedServiceNames: affectedServiceNames.length > 0 ? uniqueIdentifiers(affectedServiceNames) : [matchedFinding.resourceName ?? matchedFinding.resourceKind],
      resolutionReason: patch.resolutionReason ?? patch.reason,
    };
  });

  return {
    ...plan,
    issueAnalysis: plan.issueAnalysis?.length ? plan.issueAnalysis : fallbackIssueAnalysis,
    patches,
  };
}

function findGroundingFindingForPatch(patch: SpecPatch, findings: VerificationFinding[]): VerificationFinding | null {
  const patchServices = resolveServiceNamesFromSelector(patch);
  return findings.find((finding) => {
    const serviceName = extractServiceNameFromResourceName(finding.resourceName);
    return serviceName !== null && patchServices.includes(serviceName);
  }) ?? null;
}

function resolveServiceNamesFromSelector(patch: SpecPatch): string[] {
  if ('target' in patch) {
    return [patch.target.name].filter((name): name is string => Boolean(name));
  }
  if ('service' in patch) return [patch.service.name];
  return [];
}
function normalizeAndValidateFeedbackIntent(value: unknown, rawText: string): FeedbackIntent {
  const record = isRecord(value) ? value : {};
  const intent = normalizeFeedbackIntentName(record.intent ?? record.kind ?? record.action ?? record.type);
  const targetRecord = isRecord(record.target) ? record.target : {};
  const desiredRecord = isRecord(record.desiredChange) ? record.desiredChange : record;
  const serviceSelector = normalizePatchTarget(
    targetRecord.serviceSelector
      ?? targetRecord.selector
      ?? record.serviceSelector
      ?? record.selector
      ?? record.target
      ?? record.service
      ?? record.serviceName
      ?? targetRecord.name,
  );
  const replicas = normalizeInteger(
    desiredRecord.replicas
      ?? desiredRecord.replicaCount
      ?? desiredRecord.instances
      ?? desiredRecord.totalInstances
      ?? desiredRecord.count
      ?? record.replicas
      ?? record.replicaCount
      ?? record.instances
      ?? record.totalInstances
      ?? record.count,
  );
  const desiredChange = {
    ...(replicas !== null ? { replicas } : {}),
    ...(normalizeInteger(desiredRecord.hostPort) !== null ? { hostPort: normalizeInteger(desiredRecord.hostPort)! } : {}),
    ...(normalizeInteger(desiredRecord.containerPort) !== null ? { containerPort: normalizeInteger(desiredRecord.containerPort)! } : {}),
    ...(normalizeString(desiredRecord.name) ? { name: normalizeString(desiredRecord.name)! } : {}),
    ...(normalizeString(desiredRecord.image) ? { image: normalizeString(desiredRecord.image)! } : {}),
    ...(Object.keys(normalizeEnvironmentRecord(desiredRecord.environment)).length > 0 ? { environment: normalizeEnvironmentRecord(desiredRecord.environment) } : {}),
    ...(normalizeStringArray(desiredRecord.volumes).length > 0 ? { volumes: normalizeStringArray(desiredRecord.volumes) } : {}),
    ...(normalizeStringArray(desiredRecord.networks).length > 0 ? { networks: normalizeStringArray(desiredRecord.networks) } : {}),
    ...(normalizeStringArray(desiredRecord.dependencies ?? desiredRecord.dependsOn).length > 0 ? { dependencies: normalizeStringArray(desiredRecord.dependencies ?? desiredRecord.dependsOn).map(sanitizeIdentifier).filter(Boolean) } : {}),
    ...(normalizeDesiredStatus(desiredRecord.desiredStatus ?? desiredRecord.status) ? { desiredStatus: normalizeDesiredStatus(desiredRecord.desiredStatus ?? desiredRecord.status)! } : {}),
    ...(normalizeInfrastructureService(desiredRecord.service ?? record.service) ? { service: normalizeInfrastructureService(desiredRecord.service ?? record.service)! } : {}),
    ...(normalizeString(desiredRecord.yamlFragment) ? { yamlFragment: normalizeString(desiredRecord.yamlFragment)! } : {}),
  };

  return validateFeedbackIntent({
    source: 'user-other-feedback',
    rawText: normalizeString(record.rawText) ?? rawText,
    intent,
    ...(serviceSelector || normalizeString(targetRecord.currentValue) || normalizeResourceKind(targetRecord.resourceKind ?? targetRecord.kind ?? targetRecord.scope)
      ? {
          target: {
            ...(normalizeResourceKind(targetRecord.resourceKind ?? targetRecord.kind ?? targetRecord.scope) ? { resourceKind: normalizeResourceKind(targetRecord.resourceKind ?? targetRecord.kind ?? targetRecord.scope) } : {}),
            ...(serviceSelector ? { serviceSelector } : {}),
            ...(normalizeString(targetRecord.currentValue) ? { currentValue: normalizeString(targetRecord.currentValue)! } : {}),
          },
        }
      : {}),
    ...(Object.keys(desiredChange).length > 0 ? { desiredChange } : {}),
    confidence: normalizeConfidence(record.confidence, intent === 'unknown' ? 0.25 : 0.7),
    ambiguities: normalizeStringArray(record.ambiguities ?? record.questions),
    requiresUserInput: typeof record.requiresUserInput === 'boolean'
      ? record.requiresUserInput
      : intent === 'unknown',
  });
}

function normalizeFeedbackIntentName(value: unknown): FeedbackIntent['intent'] {
  const intent = normalizeString(value)?.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/_/g, '-');
  const aliases: Record<string, FeedbackIntent['intent']> = {
    replicas: 'change-replicas',
    replica: 'change-replicas',
    instances: 'change-replicas',
    'change-instances': 'change-replicas',
    'set-instances': 'change-replicas',
    'set-replicas': 'change-replicas',
    scale: 'change-replicas',
    port: 'change-port',
    ports: 'change-port',
    rename: 'change-name',
    name: 'change-name',
    image: 'change-image',
    env: 'change-env',
    environment: 'change-env',
    'set-env': 'change-env',
    'remove-env': 'remove-env',
    'delete-env': 'remove-env',
    volume: 'change-volume',
    volumes: 'change-volume',
    'add-volume': 'change-volume',
    'remove-volume': 'remove-volume',
    dependency: 'change-dependency',
    dependencies: 'change-dependency',
    'add-dependency': 'change-dependency',
    'remove-dependency': 'remove-dependency',
    network: 'change-network',
    networks: 'set-networks',
    project: 'change-project',
    'project-name': 'change-project',
    status: 'change-status',
    service: 'add-service',
    'delete-service': 'remove-service',
  };
  const normalized = intent ? (aliases[intent] ?? intent) : 'unknown';
  const allowed = new Set<FeedbackIntent['intent']>([
    'change-port', 'change-name', 'change-replicas', 'change-image', 'change-env', 'remove-env',
    'change-volume', 'remove-volume', 'change-dependency', 'remove-dependency', 'change-network',
    'rename-network', 'set-networks', 'add-service', 'remove-service', 'rename-service', 'change-status',
    'change-project', 'remove-exposure', 'yaml-edit-intent', 'retry-as-is', 'cancel', 'unknown',
  ]);
  return allowed.has(normalized as FeedbackIntent['intent']) ? normalized as FeedbackIntent['intent'] : 'unknown';
}

function normalizeResourceKind(value: unknown): NonNullable<FeedbackIntent['target']>['resourceKind'] | null {
  const kind = normalizeString(value)?.toLowerCase();
  if (kind === 'project' || kind === 'service' || kind === 'container' || kind === 'port' || kind === 'image' || kind === 'volume' || kind === 'network' || kind === 'environment') return kind;
  if (kind === 'database' || kind === 'db') return 'service';
  return null;
}

function normalizeSpecPatchPlanShape(value: unknown): NormalizedSpecPatchPlanShape {
  const record = isRecord(value) ? value : {};
  const rawPatches = Array.isArray(record.patches)
    ? record.patches
    : looksLikeRawPatch(record)
      ? [record]
      : [];
  const patches = rawPatches.flatMap((patch) => normalizeSpecPatchShape(patch));
  const ambiguities = normalizeStringArray(record.ambiguities);
  const explanation = normalizeString(record.explanation)
    ?? normalizeString(record.summary)
    ?? normalizeString(record.reason)
    ?? (patches.length > 0
      ? 'Normalized LLM revision output into schema-valid SpecPatchPlan.'
      : 'LLM revision output did not contain a directly applicable schema-valid patch.');
  const issueAnalysis = normalizeIssueAnalysis(record.issueAnalysis);

  const plan: NormalizedSpecPatchPlanShape = {
    patches,
    explanation,
    assumptions: normalizeStringArray(record.assumptions),
    ambiguities,
    requiresUserInput: typeof record.requiresUserInput === 'boolean'
      ? record.requiresUserInput
      : patches.length === 0,
    confidence: normalizeConfidence(record.confidence, patches.length > 0 ? 0.7 : 0.25),
  };
  if (issueAnalysis) plan.issueAnalysis = issueAnalysis;
  return plan;
}

function normalizeSpecPatchShape(value: unknown): SpecPatch[] {
  if (!isRecord(value)) return [];
  const op = normalizePatchOp(value.op ?? value.kind ?? value.action ?? value.type);
  const reason = normalizeString(value.reason) ?? normalizeString(value.explanation) ?? 'Normalized LLM patch.';
  const relevance = normalizePatchRelevance(value);
  const target = normalizePatchTarget(value.target ?? value.selector ?? value.service ?? value.serviceName ?? value.name);

  if (op === 'set-service-replicas') {
    const replicas = normalizeInteger(value.replicas ?? value.replicaCount ?? value.instances ?? value.count);
    return target && replicas !== null && replicas >= 1 && replicas <= 50 ? [{ op, target, replicas, reason, ...relevance }] : [];
  }

  if (op === 'replace-service-port') {
    const to = normalizePortMapping(value.to ?? value.port ?? value.mapping ?? value.ports);
    const from = normalizePortMapping(value.from);
    return target && to ? [{ op, target, to, ...(from ? { from } : {}), reason, ...relevance }] : [];
  }

  if (op === 'add-service-port') {
    const port = normalizePortMapping(value.port ?? value.to ?? value.mapping);
    return target && port ? [{ op, target, port, reason, ...relevance }] : [];
  }

  if (op === 'remove-service-port') {
    const port = normalizePortMapping(value.port ?? value.from);
    return target ? [{ op, target, ...(port ? { port } : {}), reason, ...relevance }] : [];
  }

  if (op === 'set-service-image') {
    const image = normalizeRevisionImage(normalizeString(value.image ?? value.to ?? value.value) ?? '');
    return target && image ? [{ op, target, image, reason, ...relevance }] : [];
  }

  if (op === 'remove-service') {
    return target ? [{ op, target, reason, ...relevance }] : [];
  }

  if (op === 'rename-service') {
    const name = normalizeIdentifierString(value.to ?? value.newName ?? value.name);
    return target && name ? [{ op, target, name, reason, ...relevance }] : [];
  }

  if (op === 'set-service-env') {
    const key = normalizeString(value.key ?? value.name);
    const envValue = normalizeString(value.value ?? value.to);
    return target && key && envValue ? [{ op, target, key, value: envValue, reason, ...relevance }] : [];
  }

  if (op === 'remove-service-env') {
    const key = normalizeString(value.key ?? value.name);
    return target && key ? [{ op, target, key, reason, ...relevance }] : [];
  }

  if (op === 'add-service-volume' || op === 'remove-service-volume') {
    const volume = normalizeString(value.volume ?? value.mount ?? value.value);
    return target && volume ? [{ op, target, volume, reason, ...relevance }] : [];
  }

  if (op === 'add-service-dependency' || op === 'remove-service-dependency') {
    const dependencyName = normalizeIdentifierString(value.dependencyName ?? value.dependency ?? value.dependsOn);
    return target && dependencyName ? [{ op, target, dependencyName, reason, ...relevance }] : [];
  }

  if (op === 'set-service-desired-status') {
    const desiredStatus = normalizeString(value.desiredStatus ?? value.status ?? value.value);
    return target && (desiredStatus === 'running' || desiredStatus === 'stopped') ? [{ op, target, desiredStatus, reason, ...relevance }] : [];
  }

  if (op === 'set-project-name') {
    const name = normalizeIdentifierString(value.name ?? value.projectName ?? value.to);
    return name ? [{ op, name, reason, ...relevance }] : [];
  }

  if (op === 'rename-network') {
    const from = normalizeIdentifierString(value.from);
    const to = normalizeIdentifierString(value.to ?? value.name ?? value.networkName);
    return to ? [{ op, ...(from ? { from } : {}), to, reason, ...relevance }] : [];
  }

  if (op === 'set-networks') {
    const networks = normalizeStringArray(value.networks ?? value.names).map(sanitizeIdentifier).filter(Boolean);
    return networks.length > 0 ? [{ op, networks: uniqueIdentifiers(networks), reason, ...relevance }] : [];
  }

  if (op === 'add-service') {
    const service = normalizeInfrastructureService(value.service ?? value);
    return service ? [{ op, service, reason, ...relevance }].filter((patch) => validatePotentialPatch(patch)) : [];
  }

  return [];
}

function normalizePatchRelevance(value: Record<string, unknown>): Partial<Pick<SpecPatch, 'resolvesIssueCodes' | 'affectedServiceNames' | 'resolutionReason'>> {
  const resolvesIssueCodes = normalizeStringArray(value.resolvesIssueCodes);
  const affectedServiceNames = normalizeStringArray(value.affectedServiceNames).map(sanitizeIdentifier).filter(Boolean);
  const resolutionReason = normalizeString(value.resolutionReason);
  const relevance: Partial<Pick<SpecPatch, 'resolvesIssueCodes' | 'affectedServiceNames' | 'resolutionReason'>> = {};
  if (resolvesIssueCodes.length > 0) relevance.resolvesIssueCodes = resolvesIssueCodes as NonNullable<SpecPatch['resolvesIssueCodes']>;
  if (affectedServiceNames.length > 0) relevance.affectedServiceNames = uniqueIdentifiers(affectedServiceNames);
  if (resolutionReason) relevance.resolutionReason = resolutionReason;
  return relevance;
}

function normalizeIssueAnalysis(value: unknown): IssueAnalysis[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const issueCode = normalizeString(entry.issueCode ?? entry.code);
    const affectedResource = normalizeString(entry.affectedResource ?? entry.resourceRef ?? entry.resource);
    const intendedFix = normalizeString(entry.intendedFix ?? entry.proposedResolution ?? entry.fix);
    const affectedServiceName = normalizeIdentifierString(entry.affectedServiceName ?? entry.serviceName);
    const userActionNeeded = normalizeString(entry.userActionNeeded);
    return issueCode && affectedResource && intendedFix
      ? [{ issueCode, affectedResource, intendedFix, ...(affectedServiceName ? { affectedServiceName } : {}), ...(userActionNeeded ? { userActionNeeded } : {}) }]
      : [];
  });
  return issues.length > 0 ? issues : undefined;
}

function normalizeInfrastructureService(value: unknown): InfrastructureSpec['services'][number] | null {
  if (!isRecord(value)) return null;
  const kind = normalizeString(value.kind ?? value.role);
  const name = normalizeIdentifierString(value.name ?? value.serviceName);
  const image = normalizeRevisionImage(normalizeString(value.image) ?? '');
  if ((kind !== 'reverse-proxy' && kind !== 'backend' && kind !== 'database') || !name || !image) return null;

  const environment = normalizeEnvironmentRecord(value.environment ?? value.env);
  const desiredStatus = normalizeDesiredStatus(value.desiredStatus ?? value.status);
  const replicas = normalizeInteger(value.replicas ?? value.replicaCount ?? value.instances);
  const ports = normalizeStringArray(value.ports ?? value.port).flatMap((port) => normalizePortMapping(port) ?? []);
  const dependsOn = normalizeStringArray(value.dependsOn ?? value.dependencies).map(sanitizeIdentifier).filter(Boolean);
  const volumes = normalizeStringArray(value.volumes ?? value.mounts);

  return {
    kind,
    name,
    image,
    ...(desiredStatus ? { desiredStatus } : {}),
    ...(replicas !== null && replicas >= 1 && replicas <= 50 ? { replicas } : {}),
    ...(ports.length > 0 ? { ports: uniqueIdentifiers(ports) } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
    ...(dependsOn.length > 0 ? { dependsOn: uniqueIdentifiers(dependsOn) } : {}),
    ...(volumes.length > 0 ? { volumes } : {}),
  };
}

function normalizeEnvironmentRecord(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const key = normalizeString(entry.key ?? entry.name);
      const envValue = normalizeString(entry.value ?? entry.to);
      return key && envValue ? [[key, envValue] as [string, string]] : [];
    }));
  }

  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, envValue]) => {
      const normalizedValue = normalizeString(envValue);
      return normalizedValue ? [[key, normalizedValue] as [string, string]] : [];
    }),
  );
}

function normalizeDesiredStatus(value: unknown): NonNullable<InfrastructureSpec['services'][number]['desiredStatus']> | null {
  const status = normalizeString(value)?.toLowerCase();
  if (status === 'running' || status === 'run' || status === 'start' || status === 'started') return 'running';
  if (status === 'stopped' || status === 'stop' || status === 'down') return 'stopped';
  return null;
}

function validatePotentialPatch(patch: unknown): patch is SpecPatch {
  try {
    validateSpecPatchPlan({ patches: [patch], explanation: 'validate', assumptions: [], ambiguities: [], requiresUserInput: false, confidence: 1 });
    return true;
  } catch {
    return false;
  }
}

function looksLikeRawPatch(record: Record<string, unknown>): boolean {
  return ['op', 'kind', 'action', 'type'].some((key) => key in record);
}

function normalizePatchOp(value: unknown): SpecPatch['op'] | null {
  const op = normalizeString(value)?.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/_/g, '-');
  if (!op) return null;
  const aliases: Record<string, SpecPatch['op']> = {
    'set-replicas': 'set-service-replicas',
    'update-replicas': 'set-service-replicas',
    'set-service-replica-count': 'set-service-replicas',
    'update-service-replicas': 'set-service-replicas',
    'set-instances': 'set-service-replicas',
    'set-service-instances': 'set-service-replicas',
    'change-port': 'replace-service-port',
    'set-port': 'replace-service-port',
    'set-service-port': 'replace-service-port',
    'update-service-port': 'replace-service-port',
    'change-service-port': 'replace-service-port',
    'expose-port': 'add-service-port',
    'add-port': 'add-service-port',
    'remove-port': 'remove-service-port',
    'delete-service-port': 'remove-service-port',
    'change-image': 'set-service-image',
    'update-image': 'set-service-image',
    'set-image': 'set-service-image',
    'delete-service': 'remove-service',
    'set-env': 'set-service-env',
    'remove-env': 'remove-service-env',
    'add-volume': 'add-service-volume',
    'remove-volume': 'remove-service-volume',
    'add-dependency': 'add-service-dependency',
    'remove-dependency': 'remove-service-dependency',
    'set-status': 'set-service-desired-status',
    'rename-project': 'set-project-name',
  };
  const allowed = new Set<SpecPatch['op']>([
    'set-service-replicas', 'replace-service-port', 'add-service-port', 'remove-service-port', 'set-service-image',
    'add-service', 'remove-service', 'rename-service', 'set-service-env', 'remove-service-env', 'add-service-volume',
    'remove-service-volume', 'add-service-dependency', 'remove-service-dependency', 'set-service-desired-status',
    'set-project-name', 'rename-network', 'set-networks',
  ]);
  return allowed.has(op as SpecPatch['op']) ? op as SpecPatch['op'] : aliases[op] ?? null;
}

function normalizePatchTarget(value: unknown): ServiceSelector | null {
  if (typeof value === 'string') return { name: sanitizeIdentifier(value) };
  if (!isRecord(value)) return null;
  const selector: ServiceSelector = {};
  const targetKind = normalizeString(value.targetKind ?? value.targetType ?? value.resourceKind);
  const name = normalizeIdentifierString(value.name ?? value.serviceName);
  const nameLike = normalizeString(value.nameLike ?? value.alias)?.replace(/^\/+/, '');
  const kind = normalizeString(value.kind ?? value.role);
  const imageFamily = normalizeString(value.imageFamily ?? value.image);
  const dependsOn = normalizeIdentifierString(value.dependsOn);
  const dependentOf = normalizeIdentifierString(value.dependentOf);
  if (targetKind === 'service' || targetKind === 'replica-group') selector.targetKind = targetKind;
  if (name) selector.name = name;
  if (nameLike) selector.nameLike = nameLike;
  if (kind === 'reverse-proxy' || kind === 'backend' || kind === 'database') selector.kind = kind;
  if (imageFamily) selector.imageFamily = imageFamily.toLowerCase().split(':')[0]?.split('/').pop() ?? imageFamily;
  if (typeof value.exposesHostPort === 'boolean') selector.exposesHostPort = value.exposesHostPort;
  if (dependsOn) selector.dependsOn = dependsOn;
  if (dependentOf) selector.dependentOf = dependentOf;
  return Object.keys(selector).some((key) => key !== 'targetKind') ? selector : null;
}

function normalizePortMapping(value: unknown): string | null {
  if (Array.isArray(value)) return normalizePortMapping(value[0]);
  if (isRecord(value)) {
    const host = normalizeInteger(value.hostPort ?? value.host);
    const container = normalizeInteger(value.containerPort ?? value.container ?? value.targetPort);
    return host !== null && container !== null && isValidTcpPort(host) && isValidTcpPort(container) ? `${host}:${container}` : null;
  }
  const text = normalizeString(value);
  if (!text) return null;
  const mapping = /(\d{1,5})\s*:\s*(\d{1,5})/.exec(text);
  if (!mapping) return null;
  const host = Number(mapping[1]);
  const container = Number(mapping[2]);
  return isValidTcpPort(host) && isValidTcpPort(container) ? `${host}:${container}` : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => normalizeString(item) ?? []);
  const text = normalizeString(value);
  return text ? [text] : [];
}

function normalizeIdentifierString(value: unknown): string | null {
  const text = normalizeString(value);
  return text ? sanitizeIdentifier(text) : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeConfidence(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildDeterministicFeedbackPatchPlan(
  spec: InfrastructureSpec,
  feedback: string,
  patchPlanError: string | null,
  feedbackIntent: FeedbackIntent | null,
): SpecPatchPlan {
  const patches: SpecPatch[] = [];
  const ambiguities: string[] = [];
  const normalizedFeedback = feedback.trim();
  const reason = `Deterministic fallback normalized user feedback: ${normalizedFeedback}`;

  if (feedbackIntent !== null) {
    const intentPatchResult = buildPatchesFromFeedbackIntent(spec, feedbackIntent, reason);
    patches.push(...intentPatchResult.patches);
    ambiguities.push(...intentPatchResult.ambiguities);
  }

  const replicaRequests = parseReplicaFeedbackRequests(normalizedFeedback);
  if (replicaRequests.length > 0) {
    const explicitReplicaPatches: SpecPatch[] = [];
    const explicitReplicaAmbiguities: string[] = [];
    for (const replicaRequest of replicaRequests) {
      const target = inferFeedbackServiceSelector(spec, replicaRequest.targetText, { preferReplicaServices: true });
      if (target.selector !== null && target.ambiguous === false) {
        explicitReplicaPatches.push({ op: 'set-service-replicas', target: target.selector, replicas: replicaRequest.replicas, reason });
      } else {
        explicitReplicaAmbiguities.push(target.reason ?? `Which existing service should receive ${replicaRequest.replicas} replica(s)?`);
      }
    }
    if (explicitReplicaPatches.length > 0 && explicitReplicaAmbiguities.length === 0) {
      for (let index = patches.length - 1; index >= 0; index -= 1) {
        if (patches[index]?.op === 'set-service-replicas') patches.splice(index, 1);
      }
      patches.push(...explicitReplicaPatches);
    } else {
      patches.push(...explicitReplicaPatches);
      ambiguities.push(...explicitReplicaAmbiguities);
    }
  } else {
    const replicaRequest = patches.some((patch) => patch.op === 'set-service-replicas')
      ? null
      : parseReplicaFeedback(normalizedFeedback);
    if (replicaRequest !== null) {
    const target = inferFeedbackServiceSelector(spec, normalizedFeedback, { preferReplicaServices: true });
    if (target.selector !== null && target.ambiguous === false) {
      patches.push({ op: 'set-service-replicas', target: target.selector, replicas: replicaRequest, reason });
    } else {
      ambiguities.push(target.reason ?? 'Which existing service should receive the requested replica/instance count?');
    }
    }
  }

  const portMappingRequest = parseRequestedPortMapping(normalizedFeedback);
  if (portMappingRequest !== null) {
    const target = inferFeedbackServiceSelector(spec, normalizedFeedback, { preferPortServices: true });
    if (target.selector !== null && target.ambiguous === false) {
      patches.push({
        op: 'replace-service-port',
        target: target.selector,
        to: `${portMappingRequest.hostPort}:${portMappingRequest.containerPort}`,
        reason,
      });
    } else {
      ambiguities.push(target.reason ?? 'Which existing service should receive the requested port mapping?');
    }
  } else {
    const hostPortRequest = parseRequestedHostPort(normalizedFeedback);
    if (hostPortRequest !== null) {
      const target = inferFeedbackServiceSelector(spec, normalizedFeedback, { preferPortServices: true });
      const targetServices = target.selector ? resolveServiceSelector(spec, target.selector) : [];
      if (target.selector !== null && target.ambiguous === false && targetServices.length === 1) {
        const existingPort = targetServices[0]?.ports?.[0];
        const containerPort = existingPort?.split(':')[1] ?? getDefaultContainerPort(targetServices[0]!.image) ?? String(hostPortRequest);
        patches.push({
          op: 'replace-service-port',
          target: target.selector,
          to: `${hostPortRequest}:${containerPort}`,
          reason,
        });
      } else {
        ambiguities.push(target.reason ?? 'Which existing service should receive the requested host port?');
      }
    }
  }

  const imageRequest = parseImageFeedback(normalizedFeedback);
  if (imageRequest !== null) {
    const target = inferFeedbackServiceSelector(spec, normalizedFeedback, { image: imageRequest });
    if (target.selector !== null && target.ambiguous === false) {
      patches.push({ op: 'set-service-image', target: target.selector, image: imageRequest, reason });
    } else {
      ambiguities.push(target.reason ?? 'Which existing service should use the requested image?');
    }
  }

  const projectName = /(?:change|set|rename)\s+project\s+name\s+(?:to\s+)?([A-Za-z0-9_.-]+)/i.exec(normalizedFeedback)?.[1];
  if (projectName) {
    patches.push({ op: 'set-project-name', name: sanitizeIdentifier(projectName), reason });
  }

  const serviceRename = /rename\s+(?:service\s+)?([A-Za-z0-9_.-]+)\s+to\s+([A-Za-z0-9_.-]+)/i.exec(normalizedFeedback);
  if (serviceRename && spec.services.some((service) => service.name === serviceRename[1])) {
    patches.push({
      op: 'rename-service',
      target: { name: serviceRename[1]! },
      name: sanitizeIdentifier(serviceRename[2]!),
      reason,
    });
  }

  const networkRename = /rename\s+network\s+([A-Za-z0-9_.-]+)\s+to\s+([A-Za-z0-9_.-]+)/i.exec(normalizedFeedback);
  if (networkRename) {
    patches.push({ op: 'rename-network', from: sanitizeIdentifier(networkRename[1]!), to: sanitizeIdentifier(networkRename[2]!), reason });
  } else {
    const networkName = /(?:change|set)\s+network\s+name\s+(?:to\s+)?([A-Za-z0-9_.-]+)/i.exec(normalizedFeedback)?.[1];
    if (networkName) {
      patches.push({ op: 'rename-network', to: sanitizeIdentifier(networkName), reason });
    }
  }

  return validateSpecPatchPlan({
    patches,
    explanation: patchPlanError
      ? `LLM structured revision failed validation, so deterministic fallback produced schema-valid patches where safe. Original error: ${patchPlanError}`
      : 'Deterministic fallback produced schema-valid patches where safe.',
    assumptions: [
      'Fallback only emits InfrastructureSpec patches supported by SpecPatchPlan schema.',
      'Fallback applies changes only when the target service can be inferred from the current service catalog.',
    ],
    ambiguities: uniqueIdentifiers(patches.length > 0 ? [] : ambiguities),
    requiresUserInput: ambiguities.length > 0 && patches.length === 0,
    confidence: patches.length > 0 && ambiguities.length === 0 ? 0.82 : patches.length > 0 ? 0.65 : 0.25,
  });
}

function buildLimitViolationPatchPlan(
  feedback: string,
  feedbackIntent: FeedbackIntent | null,
): SpecPatchPlan | null {
  const ambiguities = collectFeedbackLimitViolations(feedback, feedbackIntent);
  if (ambiguities.length === 0) return null;

  return validateSpecPatchPlan({
    patches: [],
    explanation: 'User feedback requested values outside configured safety limits.',
    assumptions: ['No InfrastructureSpec patch was produced because at least one requested value exceeds the current configured limit.'],
    ambiguities,
    requiresUserInput: true,
    confidence: 1,
  });
}

function collectFeedbackLimitViolations(
  feedback: string,
  feedbackIntent: FeedbackIntent | null,
): string[] {
  const { maxServiceReplicas } = loadInfrastructureSchemaLimitConfig();
  const replicaValues = uniqueNumbers([
    ...parseReplicaFeedbackValues(feedback),
    ...(feedbackIntent?.intent === 'change-replicas' && feedbackIntent.desiredChange?.replicas !== undefined
      ? [feedbackIntent.desiredChange.replicas]
      : []),
  ]);
  const portValues = uniqueNumbers([
    ...parsePortFeedbackValues(feedback),
    ...(feedbackIntent?.desiredChange?.hostPort !== undefined ? [feedbackIntent.desiredChange.hostPort] : []),
    ...(feedbackIntent?.desiredChange?.containerPort !== undefined ? [feedbackIntent.desiredChange.containerPort] : []),
  ]);

  return [
    ...replicaValues
      .filter((replicas) => replicas < 1 || replicas > maxServiceReplicas)
      .map((replicas) => replicas < 1
        ? `Requested replicas ${replicas} is below minimum 1.`
        : `Requested replicas ${replicas} exceeds max allowed ${maxServiceReplicas}.`),
    ...portValues
      .filter((port) => port < 1 || port > 65535)
      .map((port) => `Requested port ${port} is outside allowed range 1-65535.`),
  ];
}

function parseReplicaFeedbackValues(feedback: string): number[] {
  const values: number[] = [];
  const patterns = [
    /\b(?:total|overall|group|database\s+group|db\s+group)\b[^\d-]{0,80}\b(?:is|are|to|=|thanh|con)?\s*(-?\d+)\b/gi,
    /\b(?:tong|nhom)\b[^\d-]{0,80}\b(?:la|thanh|con)?\s*(-?\d+)\b/gi,
    /\b(?:giam|tang|ha|nang|xuong|len)\s+(?:(?:xuong|len)\s+)?(?:(?:con|thanh|toi|to)\s+)?(-?\d+)\s*(?:instances?|replicas?)?\b/gi,
    /\b(?:just|only|to|use|with|set|make|want|needs?|need)\s+(-?\d+)\s+(?:[a-z0-9_-]+\s+){0,4}(?:instances?|replicas?|containers?)\b/gi,
    /\b(?:instances?|replicas?|containers?)\s+(?:to|=|is|are)?\s*(-?\d+)\b/gi,
    /\b(?:scale|replicas?)\s+[^\d-]{0,30}\bto\s+(-?\d+)\b/gi,
    /\b(-?\d+)\s*(?:instances?|replicas?|containers?)\s*(?:of|for)?\s*(?:backend|api|nodejs?|server|db|database|postgres(?:ql)?|mysql|mariadb|mongo|redis|rabbitmq|elasticsearch|kafka|web|nginx|proxy|reverse-proxy|frontend)\b/gi,
    /\b(?:backend|api|nodejs?|server|db|database|postgres(?:ql)?|mysql|mariadb|mongo|redis|rabbitmq|elasticsearch|kafka|web|nginx|proxy|reverse-proxy|frontend)\b[^\d-]{0,30}\b(-?\d+)\s*(?:instances?|replicas?|containers?)\b/gi,
  ];

  for (const pattern of patterns) {
    for (const match of feedback.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isInteger(value)) values.push(value);
    }
  }
  return values;
}

function parsePortFeedbackValues(feedback: string): number[] {
  if (!/\b(port|ports|host\s*port|container\s*port|c[oÃ´]ng)\b/i.test(feedback)) return [];
  return [...feedback.matchAll(/\b(\d{1,6})\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value));
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function buildPatchesFromFeedbackIntent(
  spec: InfrastructureSpec,
  feedbackIntent: FeedbackIntent,
  reason: string,
): { patches: SpecPatch[]; ambiguities: string[] } {
  const patches: SpecPatch[] = [];
  const ambiguities: string[] = [...feedbackIntent.ambiguities];
  const selector = feedbackIntent.target?.serviceSelector ?? null;

  if (feedbackIntent.intent === 'change-replicas') {
    const replicas = feedbackIntent.desiredChange?.replicas ?? null;
    if (replicas === null) {
      ambiguities.push('Requested replica/instance count was not clear.');
      return { patches, ambiguities };
    }

    const target = selector ?? inferFeedbackServiceSelector(spec, feedbackIntent.rawText, { preferReplicaServices: true }).selector;
    if (target !== null) {
      patches.push({ op: 'set-service-replicas', target, replicas, reason });
    } else {
      ambiguities.push('Which existing service should receive the requested replica/instance count?');
    }
  }

  if (feedbackIntent.intent === 'change-port') {
    const hostPort = feedbackIntent.desiredChange?.hostPort ?? null;
    if (hostPort === null || selector === null) return { patches, ambiguities };
    const targetServices = resolveServiceSelector(spec, selector);
    if (targetServices.length !== 1) {
      ambiguities.push('Which existing service should receive the requested host port?');
      return { patches, ambiguities };
    }
    const existingPort = targetServices[0]?.ports?.[0];
    const existingContainerPort = Number(existingPort?.split(':')[1]);
    const containerPort = feedbackIntent.desiredChange?.containerPort
      ?? (Number.isInteger(existingContainerPort) ? existingContainerPort : hostPort);
    patches.push({ op: 'replace-service-port', target: selector, to: `${hostPort}:${containerPort}`, reason });
  }

  if (feedbackIntent.intent === 'change-image' && feedbackIntent.desiredChange?.image && selector !== null) {
    const image = normalizeRevisionImage(feedbackIntent.desiredChange.image);
    if (image !== null) {
      patches.push({ op: 'set-service-image', target: selector, image, reason });
    } else {
      ambiguities.push('Requested replacement image was not clear.');
    }
  }

  if ((feedbackIntent.intent === 'change-name' || feedbackIntent.intent === 'rename-service') && feedbackIntent.desiredChange?.name) {
    if (feedbackIntent.target?.resourceKind === 'project') {
      patches.push({ op: 'set-project-name', name: sanitizeIdentifier(feedbackIntent.desiredChange.name), reason });
    } else if (selector !== null) {
      patches.push({ op: 'rename-service', target: selector, name: sanitizeIdentifier(feedbackIntent.desiredChange.name), reason });
    }
  }

  if (feedbackIntent.intent === 'change-project' && feedbackIntent.desiredChange?.name) {
    patches.push({ op: 'set-project-name', name: sanitizeIdentifier(feedbackIntent.desiredChange.name), reason });
  }

  if (feedbackIntent.intent === 'add-service' && feedbackIntent.desiredChange?.service) {
    patches.push({ op: 'add-service', service: feedbackIntent.desiredChange.service, reason });
  }

  if (feedbackIntent.intent === 'remove-service' && selector !== null) {
    patches.push({ op: 'remove-service', target: selector, reason });
  }

  if (feedbackIntent.intent === 'change-env' && selector !== null && feedbackIntent.desiredChange?.environment) {
    for (const [key, value] of Object.entries(feedbackIntent.desiredChange.environment)) {
      patches.push({ op: 'set-service-env', target: selector, key, value, reason });
    }
  }

  if (feedbackIntent.intent === 'remove-env' && selector !== null) {
    const keys = Object.keys(feedbackIntent.desiredChange?.environment ?? {});
    const explicitKey = normalizeString(feedbackIntent.target?.currentValue);
    for (const key of uniqueIdentifiers([...keys, ...(explicitKey ? [explicitKey] : [])])) {
      patches.push({ op: 'remove-service-env', target: selector, key, reason });
    }
  }

  if ((feedbackIntent.intent === 'change-volume' || feedbackIntent.intent === 'remove-volume') && selector !== null) {
    const volumes = feedbackIntent.desiredChange?.volumes ?? [];
    for (const volume of volumes) {
      patches.push({ op: feedbackIntent.intent === 'change-volume' ? 'add-service-volume' : 'remove-service-volume', target: selector, volume, reason });
    }
  }

  if ((feedbackIntent.intent === 'change-dependency' || feedbackIntent.intent === 'remove-dependency') && selector !== null) {
    const dependencies = feedbackIntent.desiredChange?.dependencies ?? [];
    for (const dependencyName of dependencies) {
      patches.push({ op: feedbackIntent.intent === 'change-dependency' ? 'add-service-dependency' : 'remove-service-dependency', target: selector, dependencyName, reason });
    }
  }

  if (feedbackIntent.intent === 'change-status' && selector !== null && feedbackIntent.desiredChange?.desiredStatus) {
    patches.push({ op: 'set-service-desired-status', target: selector, desiredStatus: feedbackIntent.desiredChange.desiredStatus, reason });
  }

  if ((feedbackIntent.intent === 'change-network' || feedbackIntent.intent === 'set-networks') && feedbackIntent.desiredChange?.networks?.length) {
    patches.push({ op: 'set-networks', networks: feedbackIntent.desiredChange.networks.map(sanitizeIdentifier).filter(Boolean), reason });
  }

  if (feedbackIntent.intent === 'rename-network' && feedbackIntent.desiredChange?.name) {
    patches.push({
      op: 'rename-network',
      ...(feedbackIntent.target?.currentValue ? { from: sanitizeIdentifier(feedbackIntent.target.currentValue) } : {}),
      to: sanitizeIdentifier(feedbackIntent.desiredChange.name),
      reason,
    });
  }

  return { patches, ambiguities };
}

function normalizeStatefulDatabaseReplicaPatchPlan(
  spec: InfrastructureSpec,
  patchPlan: SpecPatchPlan,
  feedback: string,
  feedbackIntent: FeedbackIntent | null,
): SpecPatchPlan {
  const requestedReplicas = feedbackIntent?.desiredChange?.replicas ?? parseReplicaFeedback(feedback);
  if (requestedReplicas === null || requestedReplicas < 1 || requestedReplicas > 50) return patchPlan;
  if (!isDatabaseGroupTotalFeedback(feedback, feedbackIntent)) return patchPlan;

  const group = resolveSingleStatefulDatabaseGroupForFeedback(spec, feedback, patchPlan.patches);
  if (group === null) return patchPlan;

  const logicalPatch: SpecPatch = {
    op: 'set-service-replicas',
    target: { targetKind: 'replica-group', name: group.baseName, kind: 'database', imageFamily: group.imageFamily },
    replicas: requestedReplicas,
    reason: `Normalize stateful database group total feedback to logical ${group.baseName} replica count.`,
  };

  const nonReplicaPatches = patchPlan.patches.filter((patch) => patch.op !== 'set-service-replicas');
  return {
    ...patchPlan,
    patches: [logicalPatch, ...nonReplicaPatches],
    explanation: patchPlan.explanation,
    assumptions: uniqueIdentifiers([
      ...patchPlan.assumptions,
      `Stateful database group "${group.baseName}" is represented by ${group.serviceNames.join(', ')}; total instances means logical replicas.`,
    ]),
    ambiguities: patchPlan.ambiguities.filter((ambiguity) => !/database|replica|instance/i.test(ambiguity)),
    requiresUserInput: false,
    confidence: Math.max(patchPlan.confidence, 0.82),
  };
}

function normalizeHostPortConflictPatchPlan(
  spec: InfrastructureSpec,
  patchPlan: SpecPatchPlan,
  issues: string[],
  findings: VerificationFinding[],
): SpecPatchPlan {
  const conflicts = collectHostPortConflicts(spec, issues, findings);
  if (conflicts.length === 0) return patchPlan;

  const affectedServices = new Set(conflicts.map((conflict) => conflict.service.name));
  const patches = patchPlan.patches.filter((patch) => {
    if (patch.op !== 'remove-service-port') return true;
    const matched = resolveServiceSelector(spec, patch.target);
    return !matched.some((service) => affectedServices.has(service.name));
  });
  const hasReplacementFor = collectPortReplacementServiceNames(spec, patches);
  const missingReplacementServices = conflicts
    .filter((conflict) => !hasReplacementFor.has(conflict.service.name))
    .map((conflict) => conflict.service.name);

  const unchanged = patches.length === patchPlan.patches.length
    && patches.every((patch, index) => patch === patchPlan.patches[index])
    && missingReplacementServices.length === 0;
  if (unchanged) return patchPlan;

  return {
    ...patchPlan,
    patches,
    explanation: `${patchPlan.explanation} Host port conflicts require an explicit replace-service-port patch from the planner or user feedback; deterministic port synthesis is disabled.`,
    ambiguities: missingReplacementServices.length > 0
      ? uniqueIdentifiers([
          ...patchPlan.ambiguities,
          `Choose a replacement host port for ${missingReplacementServices.join(', ')}.`,
        ])
      : patchPlan.ambiguities.filter((ambiguity) => !/LLM provider|required|port|feedback/i.test(ambiguity)),
    requiresUserInput: patchPlan.requiresUserInput || missingReplacementServices.length > 0,
  };
}

function collectPortReplacementServiceNames(spec: InfrastructureSpec, patches: SpecPatch[]): Set<string> {
  const replacementServices = new Set<string>();
  const renamedToOriginal = new Map<string, string>();

  const resolveOriginalServiceNames = (selector: ServiceSelector): string[] => {
    const directMatches = resolveServiceSelector(spec, selector).map((service) => service.name);
    const aliasMatch = selector.name ? renamedToOriginal.get(selector.name) : undefined;
    return uniqueIdentifiers(aliasMatch ? [...directMatches, aliasMatch] : directMatches);
  };

  for (const patch of patches) {
    if (patch.op === 'rename-service') {
      for (const originalName of resolveOriginalServiceNames(patch.target)) {
        renamedToOriginal.set(patch.name, originalName);
      }
      continue;
    }

    if (patch.op === 'replace-service-port') {
      for (const serviceName of resolveOriginalServiceNames(patch.target)) {
        replacementServices.add(serviceName);
      }
    }
  }

  return replacementServices;
}

function collectHostPortConflicts(
  spec: InfrastructureSpec,
  issues: string[],
  findings: VerificationFinding[],
): Array<{ service: InfrastructureSpec['services'][number]; hostPort: number; containerPort: string; currentPort: string }> {
  const conflicts: Array<{ service: InfrastructureSpec['services'][number]; hostPort: number; containerPort: string; currentPort: string }> = [];

  for (const finding of findings) {
    if (finding.code !== 'HOST_PORT_CONFLICT') continue;
    const serviceName = extractServiceNameFromResourceName(finding.resourceName);
    const service = serviceName ? spec.services.find((candidate) => candidate.name === serviceName) : null;
    const hostPort = extractHostPort(finding.expected) ?? extractHostPort(finding.actual);
    if (!service || hostPort === null) continue;
    const currentPort = (service.ports ?? []).find((port) => Number(port.split(':')[0]) === hostPort) ?? service.ports?.[0];
    if (!currentPort) continue;
    conflicts.push({ service, hostPort, containerPort: currentPort.split(':')[1] ?? getDefaultContainerPort(service.image) ?? String(hostPort), currentPort });
  }

  for (const issue of issues) {
    const match = /Host port conflict: service "([^"]+)" wants (\d+)/i.exec(issue);
    if (!match) continue;
    const service = spec.services.find((candidate) => candidate.name === match[1]);
    const hostPort = Number(match[2]);
    if (!service || !Number.isInteger(hostPort)) continue;
    if (conflicts.some((conflict) => conflict.service.name === service.name && conflict.hostPort === hostPort)) continue;
    const currentPort = (service.ports ?? []).find((port) => Number(port.split(':')[0]) === hostPort) ?? service.ports?.[0];
    if (!currentPort) continue;
    conflicts.push({ service, hostPort, containerPort: currentPort.split(':')[1] ?? getDefaultContainerPort(service.image) ?? String(hostPort), currentPort });
  }

  return conflicts;
}

function extractHostPort(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /\b([1-9][0-9]{0,4})(?::\d{1,5})?\b/.exec(value);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function isDatabaseGroupTotalFeedback(feedback: string, feedbackIntent: FeedbackIntent | null): boolean {
  const normalizedFeedback = feedback.toLowerCase();
  const mentionsDatabase = inferFeedbackServiceKind(normalizedFeedback, null) === 'database';
  const mentionsTotal = /\b(total|overall|group|all|entire|logical|database\s+group|db\s+group)\b/i.test(normalizedFeedback)
    || /\b(tong|tổng|nhom|nhóm|tat\s*ca|tất\s*cả)\b/i.test(normalizedFeedback);
  const intentTargetsDatabase = feedbackIntent?.intent === 'change-replicas'
    && (feedbackIntent.target?.serviceSelector?.kind === 'database' || feedbackIntent.target?.resourceKind === 'service');
  return (mentionsDatabase && mentionsTotal) || Boolean(intentTargetsDatabase && mentionsDatabase);
}

function resolveSingleStatefulDatabaseGroupForFeedback(
  spec: InfrastructureSpec,
  feedback: string,
  patches: SpecPatch[],
): ReturnType<typeof buildDatabaseReplicaGroups>[number] | null {
  const groups = buildDatabaseReplicaGroups(spec).filter((group) => group.serviceNames.length > 0);
  if (groups.length === 0) return null;

  const normalizedFeedback = feedback.toLowerCase();
  const patchTargets = patches
    .filter((patch): patch is Extract<SpecPatch, { op: 'set-service-replicas' }> => patch.op === 'set-service-replicas')
    .map((patch) => patch.target);
  const candidates = groups.filter((group) => {
    const mentionedByFeedback = containsIdentifier(normalizedFeedback, group.baseName)
      || containsIdentifier(normalizedFeedback, group.imageFamily)
      || group.serviceNames.some((serviceName) => containsIdentifier(normalizedFeedback, serviceName));
    const mentionedByPatch = patchTargets.some((target) =>
      target.kind === 'database'
      || target.imageFamily === group.imageFamily
      || target.name === group.baseName
      || (target.name !== undefined && group.serviceNames.includes(target.name))
      || (target.nameLike !== undefined && (group.baseName.includes(target.nameLike) || group.imageFamily.includes(target.nameLike))),
    );
    return mentionedByFeedback || mentionedByPatch;
  });

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) return null;
  return groups.length === 1 ? groups[0]! : null;
}

function shouldPreferDeterministicFeedbackPatchPlan(
  spec: InfrastructureSpec,
  deterministicPatchPlan: SpecPatchPlan,
  llmPatchPlan: SpecPatchPlan | null,
  feedback: string,
  feedbackIntent: FeedbackIntent | null,
): boolean {
  const hasDeterministicPatch = deterministicPatchPlan.patches.length > 0;
  const hasDeterministicAmbiguity = isServiceTargetAmbiguityPatchPlan(deterministicPatchPlan);
  if (!hasDeterministicPatch && !hasDeterministicAmbiguity) return false;
  if (llmPatchPlan === null || (llmPatchPlan.patches.length === 0 && !isServiceTargetAmbiguityPatchPlan(llmPatchPlan))) {
    return true;
  }
  if (deterministicPatchPlan.requiresUserInput || deterministicPatchPlan.ambiguities.length > 0) return false;

  const deterministicReplicaOnly = deterministicPatchPlan.patches.length > 0
    && deterministicPatchPlan.patches.every((patch) =>
      patch.op === 'set-service-replicas' && isSupportedDeterministicReplicaTarget(patch.target),
    );
  const clearReplicaOnlyFeedback = isClearReplicaOnlyFeedback(feedback, feedbackIntent);
  const llmReplicaPatches = llmPatchPlan.patches.filter(isSetServiceReplicasPatch);
  if (deterministicReplicaOnly && clearReplicaOnlyFeedback) {
    if (llmReplicaPatches.length === 0) return true;

    const hasCompatibleLlmReplicaPatch = llmReplicaPatches.some((llmPatch) =>
      deterministicPatchPlan.patches.some((deterministicPatch) =>
        deterministicPatch.op === 'set-service-replicas'
        && serviceSelectorsResolveCompatibly(spec, deterministicPatch.target, llmPatch.target),
      ),
    );
    if (!hasCompatibleLlmReplicaPatch) return true;

    const llmReplicaOnly = llmPatchPlan.patches.length === llmReplicaPatches.length;
    if (!llmReplicaOnly) return true;
  }

  return false;
}

function isSetServiceReplicasPatch(patch: SpecPatch): patch is Extract<SpecPatch, { op: 'set-service-replicas' }> {
  return patch.op === 'set-service-replicas';
}

function serviceSelectorsResolveCompatibly(
  spec: InfrastructureSpec,
  left: ServiceSelector,
  right: ServiceSelector,
): boolean {
  const leftNames = resolveServiceSelector(spec, left).map((service) => service.name);
  const rightNames = resolveServiceSelector(spec, right).map((service) => service.name);
  if (leftNames.length > 0 && rightNames.length > 0) {
    return leftNames.some((name) => rightNames.includes(name));
  }

  if (left.name && right.name) return left.name === right.name;
  if (left.kind && right.kind) return left.kind === right.kind;
  if (left.imageFamily && right.imageFamily) return left.imageFamily === right.imageFamily;
  if (left.nameLike && right.nameLike) return left.nameLike === right.nameLike;

  return false;
}

function isSupportedDeterministicReplicaTarget(target: ServiceSelector): boolean {
  return target.kind === 'backend'
    || target.kind === 'database'
    || target.targetKind === 'replica-group'
    || target.name === 'backend'
    || target.name === 'database'
    || target.name === 'db'
    || target.nameLike === 'backend'
    || target.nameLike === 'database'
    || target.nameLike === 'db'
    || target.imageFamily === 'postgres'
    || target.imageFamily === 'mysql'
    || target.imageFamily === 'mariadb'
    || target.imageFamily === 'mongo'
    || target.imageFamily === 'redis';
}

function isClearReplicaOnlyFeedback(feedback: string, feedbackIntent: FeedbackIntent | null): boolean {
  const normalizedFeedback = feedback.toLowerCase();
  const hasReplicaIntent = feedbackIntent?.intent === 'change-replicas'
    || parseReplicaFeedbackRequests(feedback).length > 0
    || parseReplicaFeedback(feedback) !== null;
  if (!hasReplicaIntent) return false;

  const hasNonReplicaCue = /\b(port|ports|host\s*port|image|tag|version|rename|name|env|environment|volume|mount|network|dependency|depends?)\b/i.test(normalizedFeedback)
    || /\b(cong|anh|phien\s*ban|doi\s+ten|bien\s*moi\s*truong|mang|phu\s*thuoc)\b/i.test(normalizedFeedback);
  return !hasNonReplicaCue;
}

function parseReplicaFeedback(feedback: string): number | null {
  const patterns = [
    /\b(?:total|overall|group|database\s+group|db\s+group)\b[^\d]{0,80}\b(?:is|are|to|=|thanh|thành|con|còn)?\s*(\d+)\b/i,
    /\b(?:tong|tổng|nhom|nhóm)\b[^\d]{0,80}\b(?:la|là|thanh|thành|con|còn)?\s*(\d+)\b/i,
    /\b(?:giam|giảm|tang|tăng|ha|hạ|nang|nâng|xuong|xuống|len|lên)\s+(?:(?:xuong|xuống|len|lên)\s+)?(?:(?:con|còn|thanh|thành|toi|tới|to)\s+)?(\d+)\s*(?:instances?|replicas?)?\b/i,
    /\b(?:just|only|to|use|with|set|make|want|needs?|need)\s+(\d+)\s+(?:[a-z0-9_-]+\s+){0,4}(?:instances?|replicas?)\b/i,
    /\b(?:instances?|replicas?)\s+(?:to|=|is|are)?\s*(\d+)\b/i,
    /\b(?:scale|replicas?)\s+[^\d]{0,30}\bto\s+(\d+)\b/i,
  ];
  for (const pattern of patterns) {
    const value = pattern.exec(feedback)?.[1];
    if (!value) continue;
    const replicas = Number(value);
    if (Number.isInteger(replicas) && replicas >= 1 && replicas <= 50) return replicas;
  }
  return null;
}

function parseReplicaFeedbackRequests(feedback: string): Array<{ replicas: number; targetText: string }> {
  const requests: Array<{ replicas: number; targetText: string }> = [];
  const serviceWords = '(?:backend|api|nodejs?|server|db|database|databse|postgres(?:ql)?|mysql|mariadb|mongo|redis|rabbitmq|elasticsearch|kafka|web|nginx|proxy|reverse-proxy|frontend)';
  const word = '(?!and\\b|va\\b|,)[A-Za-z0-9_.-]+';
  const patterns = [
    { pattern: new RegExp(`\\b(\\d+)\\s*(?:instances?|replicas?|containers?)\\s*(?:of|for)?\\s*(${word}(?:\\s+${word}){0,3})`, 'gi'), countIndex: 1, targetIndex: 2 },
    { pattern: new RegExp(`\\b(${serviceWords})\\b[^\\d,;]{0,30}?\\b(\\d+)\\s*(?:instances?|replicas?|containers?)?`, 'gi'), countIndex: 2, targetIndex: 1 },
  ];

  for (const { pattern, countIndex, targetIndex } of patterns) {
    for (const match of feedback.matchAll(pattern)) {
      const countText = match[countIndex];
      const targetText = match[targetIndex];
      if (!countText || !targetText) continue;
      const betweenTargetAndCount = countIndex > targetIndex
        ? feedback.slice((match.index ?? 0) + targetText.length, (match.index ?? 0) + match[0].lastIndexOf(countText))
        : '';
      if (/\b(?:and|va)\b/i.test(betweenTargetAndCount)) continue;
      if (countIndex > targetIndex) {
        const hasReplicaCue = /\b(?:instance|instances|replica|replicas|container|containers|len|xuong|con|to|thanh)\b/i.test(betweenTargetAndCount);
        const hasNonReplicaCue = /\b(?:version|tag|image|port|host)\b/i.test(betweenTargetAndCount);
        if (!hasReplicaCue || hasNonReplicaCue) continue;
      }
      const replicas = Number(countText);
      if (!Number.isInteger(replicas) || replicas < 1 || replicas > 50) continue;
      if (!containsServiceHint(targetText)) continue;
      const normalizedTarget = targetText.trim();
      const alreadyParsed = requests.some((request) =>
        request.replicas === replicas && request.targetText.toLowerCase() === normalizedTarget.toLowerCase(),
      );
      if (!alreadyParsed) requests.push({ replicas, targetText: normalizedTarget });
    }
  }

  return requests;
}

function containsServiceHint(text: string): boolean {
  return /\b(api|backend|node|nodejs|server|db|database|databse|postgres|postgresql|mysql|mariadb|mongo|redis|rabbitmq|elasticsearch|kafka|web|nginx|proxy|reverse-proxy|frontend)\b/i.test(text);
}

function parseImageFeedback(feedback: string): string | null {
  const versionedImage = parseTrustedImageVersionFeedback(feedback);
  if (versionedImage !== null) return versionedImage;

  const requestedImage = [
    /\b(?:change|set|update|switch|downgrade|upgrade)\s+(?:\w+\s+){0,4}?image\s+(?:to|with)\s+([A-Za-z0-9_./:-]+)/i,
    /\b(?:change|set|update|switch|downgrade|upgrade)\s+(?:\w+\s+){0,4}?(?:to|with)\s+image\s+([A-Za-z0-9_./:-]+)/i,
    /\breplace\s+(?:\w+\s+){0,4}?with\s+([A-Za-z0-9_./:-]+)/i,
    /\buse\s+([A-Za-z0-9_./:-]+)(?:\s+image)?\b/i,
  ].map((pattern) => pattern.exec(feedback)?.[1]).find((value): value is string => Boolean(value));
  return requestedImage ? normalizeRevisionImage(requestedImage) : null;
}

function parseTrustedImageVersionFeedback(feedback: string): string | null {
  const direct = /\b([a-z][a-z0-9_.-]*)\s*[: ]\s*(v?\d+(?:\.\d+)*(?:-[a-z0-9_.-]+)?)\b/i.exec(feedback);
  if (direct) {
    const resolved = getTrustedImageForBaseVersion(direct[1]!, direct[2]!);
    if (resolved !== null) return resolved;
  }

  const contextual = /\b(?:version|tag|phiên b?n|phien ban|xu?ng|xuong|lên|len|downgrade|upgrade)\s+(?:to\s+)?(v?\d+(?:\.\d+)*(?:-[a-z0-9_.-]+)?)\b/i.exec(feedback);
  if (contextual) {
    for (const base of extractImageBaseMentions(feedback)) {
      const resolved = getTrustedImageForBaseVersion(base, contextual[1]!);
      if (resolved !== null) return resolved;
    }
  }

  return null;
}

function extractImageBaseMentions(text: string): string[] {
  const tokens = [...text.matchAll(/[A-Za-z][A-Za-z0-9_.-]*/g)].map((match) => match[0].toLowerCase());
  return tokens.filter((token) => getTrustedDefaultImageForBase(token) !== null);
}

function inferFeedbackServiceSelector(
  spec: InfrastructureSpec,
  feedback: string,
  options: { preferReplicaServices?: boolean; preferPortServices?: boolean; image?: string } = {},
): { selector: ServiceSelector | null; ambiguous: boolean; reason: string | null } {
  const normalizedFeedback = feedback.toLowerCase();
  const exactService = spec.services.find((service) => containsIdentifier(normalizedFeedback, service.name));
  if (exactService) return { selector: { name: exactService.name }, ambiguous: false, reason: null };

  const imageFamilyService = spec.services.find((service) => {
    const imageFamily = service.image.toLowerCase().split(':')[0]?.split('/').pop() ?? '';
    return imageFamily.length > 0 && containsIdentifier(normalizedFeedback, imageFamily);
  });
  if (imageFamilyService) {
    return { selector: { name: imageFamilyService.name }, ambiguous: false, reason: null };
  }

  const kind = inferFeedbackServiceKind(normalizedFeedback, options.image);
  if (kind !== null) {
    const matches = spec.services.filter((service) => service.kind === kind);
    if (matches.length === 1) return { selector: { kind }, ambiguous: false, reason: null };
    if (options.preferReplicaServices && kind === 'database' && isExpandedDatabaseReplicaGroup(matches)) {
      return { selector: { kind }, ambiguous: false, reason: null };
    }
    if (matches.length > 1) return { selector: null, ambiguous: true, reason: `Multiple ${kind} services match the feedback.` };
  }

  if (options.preferPortServices) {
    const portServices = spec.services.filter((service) => (service.ports?.length ?? 0) > 0);
    if (portServices.length === 1) return { selector: { name: portServices[0]!.name }, ambiguous: false, reason: null };
    if (portServices.length > 1) return { selector: null, ambiguous: true, reason: 'Multiple services expose host ports.' };
  }

  if (options.preferReplicaServices) {
    const replicatedServices = spec.services.filter((service) => (service.replicas ?? 1) !== 1);
    if (replicatedServices.length === 1) return { selector: { name: replicatedServices[0]!.name }, ambiguous: false, reason: null };
  }

  if (spec.services.length === 1) return { selector: { name: spec.services[0]!.name }, ambiguous: false, reason: null };
  return { selector: null, ambiguous: true, reason: 'Feedback target does not clearly match exactly one current service.' };
}

function isExpandedDatabaseReplicaGroup(services: InfrastructureSpec['services']): boolean {
  if (services.length <= 1) return false;

  const groups = new Map<string, Set<number>>();
  for (const service of services) {
    const match = /^(.+)-(\d+)$/.exec(service.name);
    if (!match) return false;

    const baseName = match[1]!;
    const replicaNumber = Number(match[2]);
    if (!Number.isInteger(replicaNumber) || replicaNumber < 1) return false;

    const existing = groups.get(baseName) ?? new Set<number>();
    existing.add(replicaNumber);
    groups.set(baseName, existing);
  }

  if (groups.size !== 1) return false;

  const replicaNumbers = [...groups.values()][0]!;
  return Array.from({ length: services.length }, (_, index) => index + 1).every((replicaNumber) =>
    replicaNumbers.has(replicaNumber),
  );
}

function inferFeedbackServiceKind(feedback: string, requestedImage: string | null | undefined): InfrastructureSpec['services'][number]['kind'] | null {
  const imageKind = requestedImage ? inferServiceKind(requestedImage) : null;
  if (/\b(db|database|databse|postgres|postgresql|mysql|mariadb|mongo|redis|rabbitmq|elasticsearch|kafka)\b/i.test(feedback) || imageKind === 'database') return 'database';
  if (/\b(web|nginx|proxy|reverse-proxy|frontend|httpd|traefik|haproxy|caddy)\b/i.test(feedback) || imageKind === 'reverse-proxy') return 'reverse-proxy';
  if (/\b(api|backend|node|nodejs|server)\b/i.test(feedback)) return 'backend';
  return null;
}

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

  for (const finding of findings) {
    if (finding.code === 'CONTAINER_NAME_CONFLICT' && finding.resourceName) {
      conflictingContainerNames.add(finding.resourceName);
    }
    if ((finding.code === 'IMAGE_NOT_FOUND' || finding.code === 'IMAGE_PULL_FAILED') && finding.resourceName) {
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

    const allowExplicitPortFromText = issue.startsWith('User feedback:');
    const requestedPortMapping = allowExplicitPortFromText ? parseRequestedPortMapping(issue) : null;
    if (requestedPortMapping) {
      patches.push({
        kind: 'set-service-host-port',
        serviceName: findMentionedServiceName(spec, issue),
        hostPort: requestedPortMapping.hostPort,
        containerPort: requestedPortMapping.containerPort,
      });
    }

    const requestedPort = allowExplicitPortFromText && !requestedPortMapping ? parseRequestedHostPort(issue) : null;
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
        return rebuildServiceForTrustedImage(service, patch.image);
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

function declaredNamedVolumes(volumeMounts: string[]): string[] {
  return volumeMounts.map(mountSource).filter(isNamedVolumeSource);
}

function mountSource(mount: string): string {
  return mount.split(':')[0] ?? '';
}

function isNamedVolumeSource(source: string): boolean {
  return source.length > 0 && !source.startsWith('.') && !source.startsWith('/') && !source.includes('\\');
}

function parseNumberedReplicaServiceName(name: string): { baseName: string; ordinal: number } | null {
  const match = /^(.+)-(\d+)$/.exec(name);
  if (!match) return null;
  const ordinal = Number(match[2]);
  if (!Number.isInteger(ordinal) || ordinal < 1) return null;
  return { baseName: match[1]!, ordinal };
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
    field: finding.code === 'IMAGE_NOT_FOUND' || finding.code === 'IMAGE_MISMATCH' || finding.code === 'IMAGE_PULL_FAILED' ? 'services[].image' : finding.code === 'HOST_PORT_CONFLICT' || finding.code === 'PORT_MISMATCH' ? 'services[].ports' : 'topology',
    message: formatClarificationMessage(finding),
    reason: formatClarificationReason(finding),
    affectedServices: finding.resourceKind === 'service' && finding.resourceName ? [finding.resourceName] : [],
    choices: finding.suggestedAction?.choices ?? [
      { id: '1', label: 'Auto safe fix', description: 'Let the planner use only low-risk spec changes.', value: 'auto-safe-fix' },
      { id: '2', label: 'Keep current', description: 'Do not change this part of the spec automatically.', value: 'keep-current' },
    ],
    allowOther: true,
  }));
}

function formatClarificationMessage(finding: VerificationFinding): string {
  if (finding.code === 'HOST_PORT_CONFLICT') {
    const serviceName = finding.resourceName ?? 'the affected web service';
    return `Host port ${finding.expected ?? 'requested by the spec'} for ${serviceName} is already allocated.`;
  }
  return formatFindingForPlanner(finding);
}

function formatClarificationReason(finding: VerificationFinding): string {
  if (finding.code === 'HOST_PORT_CONFLICT') {
    const serviceName = finding.resourceName ?? 'the affected web/reverse-proxy service';
    return `Choose a replacement host port for ${serviceName}; the planner should not change unrelated services.`;
  }
  return finding.suggestedAction?.summary ?? 'Planner needs human guidance before making a risky change.';
}

function buildPatchClarifications(
  patchResults: ResolvedSpecPatchResult[],
  findings: VerificationFinding[],
): NonNullable<PlannerRevisionResult['clarificationContext']> {
  return patchResults
    .filter((result) => result.blockedReason !== null)
    .map((result, index) => ({
      id: `patch-${index + 1}-${result.patch.op}`,
      severity: 'warning',
      field: patchField(result.patch.op),
      message: formatBlockedPatchMessage(result, findings),
      reason: result.blockedReason ?? 'Patch requires user input.',
      affectedServices: result.matchedServiceNames,
      choices: buildBlockedPatchChoices(result),
      allowOther: true,
    }));
}

function formatBlockedPatchMessage(result: ResolvedSpecPatchResult, findings: VerificationFinding[]): string {
  if (result.blockedReason?.includes('reported runtime issue')) {
    const portConflict = findings.find((finding) => finding.code === 'HOST_PORT_CONFLICT');
    if (portConflict) return `The proposed "${result.patch.op}" patch does not fix the host port conflict on ${portConflict.resourceName ?? 'the affected service'}.`;
  }
  return `Structured revision patch "${result.patch.op}" needs user input before it can be applied.`;
}

function buildBlockedPatchChoices(result: ResolvedSpecPatchResult): NonNullable<PlannerRevisionResult['clarificationContext']>[number]['choices'] {
  if (result.blockedReason?.includes('reported runtime issue') || result.blockedReason?.includes('different service')) {
    return [
      { id: '1', label: 'Describe fix', description: 'Provide a different change that directly addresses the runtime issue.', value: `describe-fix:${result.patch.op}` },
      { id: '2', label: 'Keep current', description: 'Skip this patch and keep the current desired spec unchanged.', value: `skip:${result.patch.op}` },
    ];
  }
  return [
    { id: '1', label: 'Allow patch', description: 'Use this structured revision patch after explicit confirmation.', value: `allow:${result.patch.op}` },
    { id: '2', label: 'Keep current', description: 'Skip this patch and keep the current desired spec unchanged.', value: `skip:${result.patch.op}` },
  ];
}

function buildPatchPlanAmbiguityClarifications(
  spec: InfrastructureSpec,
  patchPlan: SpecPatchPlan | null,
): NonNullable<PlannerRevisionResult['clarificationContext']> {
  if (patchPlan === null || !isServiceTargetAmbiguityPatchPlan(patchPlan)) return [];

  return [{
    id: 'revision-llm-target-ambiguity',
    severity: 'warning',
    field: 'topology',
    message: 'Planner could not confidently choose which existing service to change.',
    reason: patchPlan.ambiguities[0] ?? 'The requested change is ambiguous against the current desired services.',
    affectedServices: spec.services.map((service) => service.name),
    choices: spec.services.slice(0, 3).map((service, index) => ({
      id: String(index + 1),
      label: service.name,
      description: `Use the requested change to ${service.kind} service ${service.name} (${service.image}).`,
      value: `targetService:${service.name}`,
    })),
    allowOther: true,
  }];
}

function isServiceTargetAmbiguityPatchPlan(patchPlan: SpecPatchPlan): boolean {
  return patchPlan.requiresUserInput && patchPlan.patches.length === 0 && patchPlan.ambiguities.some((ambiguity) =>
    /which existing service|target service|which service|multiple .*services? match/i.test(ambiguity),
  );
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
  return finding.requiresUserInput || ((finding.code === 'IMAGE_NOT_FOUND' || finding.code === 'IMAGE_PULL_FAILED') && supportedImageFallback(finding.expected ?? finding.resourceName ?? '') === null);
}


function supportedImageFallback(image: string): string | null {
  const direct = getTrustedDefaultImageForBase(image);
  if (direct) return direct;
  const replacements = getTrustedReplacementImages(image, inferServiceKind(image), true);
  return replacements[0] ?? null;
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
  const trusted = getTrustedDefaultImageForBase(cleaned);
  if (trusted) return trusted;
  if (!/^[a-z0-9./:_-]+$/i.test(cleaned)) return null;
  return cleaned.includes(':') ? cleaned : `${cleaned}:latest`;
}

function rebuildServiceForTrustedImage(
  service: InfrastructureSpec['services'][number],
  image: string,
): InfrastructureSpec['services'][number] {
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
