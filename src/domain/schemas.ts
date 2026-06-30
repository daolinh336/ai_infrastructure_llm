import { z } from 'zod';
import { hasSharedDatabaseDataVolume } from './stateful-database-volumes.js';
import type {
  AgentRunResult,
  ActionClassification,
  ApprovalRequest,
  ApprovalResult,
  ApprovedAction,
  DependencyAwareExecutionSchedule,
  DetailedDryRunPreview,
  DraftQuery,
  ExecutionPlan,
  InfrastructureStateSnapshot,
  InfrastructureSpec,
  IntentClassification,
  PreflightReport,
  ReActReasoningOutput,
  TopologyIssue,
  TopologyValidationResult,
  ValidatedQuery,
  VerificationReport,
  ContainerCreateSpec,
  DockerDeployResult,
  FeedbackIntent,
  PlannerRevisionRequest,
  ClarificationAnswer,
  PlanningClarificationContext,
  PlanningUncertainty,
  SpecPatchPlan,
  UserFeedback,
  RevisionObservation,
} from './types.js';
import { loadInfrastructureSchemaLimitConfig } from '../config/runtime-limits.js';

const serviceReplicasSchema = z
  .number()
  .int('Replicas must be an integer.')
  .min(1)
  .superRefine((replicas, context) => {
    const { maxServiceReplicas } = loadInfrastructureSchemaLimitConfig();

    if (replicas > maxServiceReplicas) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Replicas must be <= ${maxServiceReplicas}.`,
      });
    }
  });

const identifierSchema = z
  .string()
  .min(1, 'Must not be empty.')
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Must start with a letter or number and use only letters, numbers, dots, underscores, or hyphens.');

const timestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be a valid timestamp.');

const portMappingSchema = z
  .string()
  .regex(/^\d{1,5}:\d{1,5}$/, 'Must use "host:container" format.')
  .refine((value) => {
    const [hostPortText, containerPortText] = value.split(':');
    const hostPort = Number(hostPortText);
    const containerPort = Number(containerPortText);

    return (
      Number.isInteger(hostPort) &&
      Number.isInteger(containerPort) &&
      hostPort >= 1 &&
      hostPort <= 65535 &&
      containerPort >= 1 &&
      containerPort <= 65535
    );
  }, 'Port values must be between 1 and 65535.');

const volumeMountSchema = z
  .string()
  .min(1, 'Volume mount must not be empty.')
  .regex(/^[^:\s]+:[^:\s]+$/, 'Volume mounts must use "source:target" format.');

const environmentKeySchema = z
  .string()
  .min(1, 'Environment variable names must not be empty.')
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Environment variable names must use shell-style identifiers.');

const infrastructureIntentSchema = z.enum(['create', 'update', 'status', 'destroy', 'drift']);

export const intentClassificationSchema = z
  .object({
    scope: z.enum(['infrastructure', 'out-of-scope', 'unsafe']),
    intent: infrastructureIntentSchema.nullable(),
    reason: z.string().min(1, 'Intent classification reason must not be empty.'),
  })
  .strict();

export const draftServiceQuerySchema = z
  .object({
    name: z.string().min(1).nullable(),
    image: z.string().min(1).nullable(),
    port: z.number().int().nullable(),
    replicas: z.number().int().nullable(),
    requestedMounts: z.array(z.string().min(1)),
    privileged: z.boolean().nullable(),
    networkMode: z.string().min(1).nullable(),
    pidMode: z.string().min(1).nullable(),
    ipcMode: z.string().min(1).nullable(),
    cpu: z.number().nullable(),
    memoryGb: z.number().nullable(),
  })
  .strict();

export const draftQuerySchema = z
  .object({
    raw: z.string().min(1, 'Raw prompt must not be empty.'),
    normalizedPrompt: z.string().min(1, 'Normalized prompt must not be empty.'),
    intent: infrastructureIntentSchema,
    services: z.array(draftServiceQuerySchema),
    destructive: z.boolean(),
    missingInformation: z.array(z.string().min(1)),
  })
  .strict();

export const staticResourceEstimateSchema = z
  .object({
    totalContainers: z.number().int().min(0),
    maxCpu: z.number().nullable(),
    maxMemoryGb: z.number().nullable(),
  })
  .strict();

export const validatedQuerySchema = z
  .object({
    raw: z.string().min(1, 'Raw prompt must not be empty.'),
    normalizedPrompt: z.string().min(1, 'Normalized prompt must not be empty.'),
    intent: infrastructureIntentSchema,
    draft: draftQuerySchema,
    riskFlags: z.array(z.string().min(1)),
    securityFindings: z.array(z.string().min(1)),
    resourceEstimate: staticResourceEstimateSchema,
    clarificationRequired: z.boolean(),
    clarificationQuestion: z.string().min(1).nullable(),
  })
  .strict();

export const requestMetadataSchema = z
  .object({
    raw: z.string().min(1, 'Raw prompt must not be empty.'),
    normalizedPrompt: z.string().min(1, 'Normalized prompt must not be empty.'),
    intent: infrastructureIntentSchema,
  })
  .strict();

export const cliInputSchema = z.object({
  prompt: z.string().min(1, 'Prompt must not be empty.'),
  dryRun: z.boolean().default(false),
  provider: z.enum(['openai', 'gemini']).default('openai'),
});

export const reactReasoningOutputSchema = z
  .object({
    summary: z.string().min(1, 'Reasoning summary must not be empty.'),
    nextAction: z.enum(['continue_planning', 'ask_user', 'stop']),
    rationale: z.string().min(1, 'Reasoning rationale must not be empty.'),
    safetyNotes: z.array(z.string().min(1)),
  })
  .strict();

export const clarificationChoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();

export const planningUncertaintySchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(['info', 'warning', 'blocking']),
    field: z.enum(['services[].dependsOn', 'services[].ports', 'services[].image', 'services[].volumes', 'topology']),
    message: z.string().min(1),
    reason: z.string().min(1),
    affectedServices: z.array(identifierSchema),
    choices: z.array(clarificationChoiceSchema),
    allowOther: z.boolean(),
  })
  .strict();

export const clarificationAnswerSchema = z
  .object({
    uncertaintyId: z.string().min(1),
    selectedChoiceId: z.string().min(1).nullable(),
    otherText: z.string().min(1).nullable(),
    submittedAt: timestampSchema,
  })
  .strict()
  .superRefine((answer, context) => {
    if (answer.selectedChoiceId === null && answer.otherText === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['root'],
        message: 'Clarification answer must include a selected choice or other text.',
      });
    }
  });

export const planningClarificationContextSchema = z
  .object({
    query: validatedQuerySchema,
    spec: z.custom<InfrastructureSpec>(
      (value) => provisionalInfrastructureSpecSchema.safeParse(value).success,
      'Invalid provisional infrastructure spec.',
    ),
    assumptions: z.array(z.string().min(1)),
    uncertainties: z.array(planningUncertaintySchema).min(1),
  })
  .strict();

export const infrastructureServiceSchema = z
  .object({
    kind: z.enum(['reverse-proxy', 'backend', 'database']),
    name: identifierSchema,
    image: z.string().min(1, 'Image must not be empty.'),
    desiredStatus: z.enum(['running', 'stopped']).optional(),
    replicas: serviceReplicasSchema.optional(),
    ports: z.array(portMappingSchema).min(1).optional(),
    environment: z.record(environmentKeySchema, z.string().min(1, 'Environment values must not be empty.')).optional(),
    dependsOn: z.array(identifierSchema).min(1).optional(),
    volumes: z.array(volumeMountSchema).min(1).optional(),
  })
  .strict();

export function validateTopologyGraph(spec: {
  services: Array<{
    kind: 'reverse-proxy' | 'backend' | 'database';
    name: string;
  }>;
}): TopologyValidationResult {
  const issues: TopologyIssue[] = [];

  const services = spec.services;
  const databaseNames = services
    .filter((s) => s.kind === 'database')
    .map((s) => s.name);
  const backendNames = services
    .filter((s) => s.kind === 'backend')
    .map((s) => s.name);
  const proxyNames = services
    .filter((s) => s.kind === 'reverse-proxy')
    .map((s) => s.name);

  // 1. Reverse-proxy defined but no backend app service exists to route traffic.
  if (proxyNames.length > 0 && backendNames.length === 0 && services.length > 1) {
    if (databaseNames.length > 0) {
      issues.push({
        severity: 'error',
        message: 'Incomplete topology: Reverse proxy and database are defined, but no backend app service exists to route traffic.',
        affectedServices: [...proxyNames, ...databaseNames],
        suggestion: 'Add a backend service to connect the proxy to the database, or remove one of the layers.',
      });
    } else {
      issues.push({
        severity: 'error',
        message: 'Incomplete topology: Reverse proxy is defined, but no backend app service exists to handle the traffic.',
        affectedServices: [...proxyNames],
        suggestion: 'Add a backend service that the reverse proxy can route traffic to.',
      });
    }
  }

  // 2. Backend service is defined without a database.
  if (backendNames.length > 0 && databaseNames.length === 0) {
    issues.push({
      severity: 'warning',
      message: 'Stateless backend: Backend service is defined without a database. Ensure this is intended and the backend is stateless.',
      affectedServices: [...backendNames],
      suggestion: 'If the backend requires persistent storage, add a database service (e.g., postgres, mysql, redis).',
    });
  }

  // 3. Backend and database are defined, but no reverse proxy is configured.
  if (backendNames.length > 0 && databaseNames.length > 0 && proxyNames.length === 0) {
    issues.push({
      severity: 'warning',
      message: 'No entry point: Backend and database are defined, but no reverse proxy is configured. Services will not be externally accessible via a proxy.',
      affectedServices: [...backendNames],
      suggestion: 'Add a reverse-proxy service (e.g., nginx) to route external traffic to your backend.',
    });
  }

  return {
    valid: !issues.some((issue) => issue.severity === 'error'),
    issues,
  };
}

export const infrastructureSpecSchema = z
  .object({
    projectName: identifierSchema,
    services: z.array(infrastructureServiceSchema),
    networks: z.array(identifierSchema).min(1, 'At least one network is required.'),
    volumes: z.array(identifierSchema),
  })
  .strict()
  .superRefine((spec, context) => {
    addDuplicateIssues(spec.services.map((service) => service.name), ['services'], context);
    addDuplicateIssues(spec.networks, ['networks'], context);
    addDuplicateIssues(spec.volumes, ['volumes'], context);

    const topologyResult = validateTopologyGraph(spec);
    topologyResult.issues.forEach((issue) => {
      if (issue.severity === 'error') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['services'],
          message: `${issue.message} Suggestion: ${issue.suggestion}`,
        });
      }
    });

    const serviceNames = new Set(spec.services.map((service) => service.name));
    const volumeNames = new Set(spec.volumes);

    spec.services.forEach((service, serviceIndex) => {
      service.dependsOn?.forEach((dependency, dependencyIndex) => {
        if (dependency === service.name) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services', serviceIndex, 'dependsOn', dependencyIndex],
            message: 'Service cannot depend on itself.',
          });
        }

        if (!serviceNames.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services', serviceIndex, 'dependsOn', dependencyIndex],
            message: `Unknown service dependency "${dependency}".`,
          });
        }
      });

      service.volumes?.forEach((volumeMount, volumeIndex) => {
        const [source] = volumeMount.split(':');

        if (source && !volumeNames.has(source)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['services', serviceIndex, 'volumes', volumeIndex],
            message: `Volume source "${source}" must be declared in spec.volumes.`,
          });
        }
      });

      if (hasSharedDatabaseDataVolume(service)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['services', serviceIndex, 'volumes'],
          message:
            `Database service "${service.name}" cannot use one shared data volume with ${service.replicas ?? 1} replicas; use generated per-replica volumes instead.`,
        });
      }
    });
  });

const provisionalInfrastructureSpecSchema = z
  .object({
    projectName: identifierSchema,
    services: z.array(infrastructureServiceSchema).min(1, 'At least one service is required.'),
    networks: z.array(identifierSchema),
    volumes: z.array(identifierSchema),
  })
  .strict();

export const planStepSchema = z
  .object({
    id: identifierSchema,
    description: z.string().min(1, 'Step description must not be empty.'),
    action: z.enum(['generate-compose', 'write-state', 'deploy-compose', 'inspect-drift']),
    dependsOn: z.array(identifierSchema).min(1).optional(),
  })
  .strict();

export const executionPlanSchema = z
  .object({
    summary: z.string().min(1, 'Plan summary must not be empty.'),
    spec: infrastructureSpecSchema,
    assumptions: z
      .array(z.string().min(1, 'Plan assumptions must not be empty.'))
      .min(1, 'At least one plan assumption is required.'),
    steps: z.array(planStepSchema).min(1, 'At least one plan step is required.'),
  })
  .strict()
  .superRefine((plan, context) => {
    addDuplicateIssues(plan.steps.map((step) => step.id), ['steps'], context);

    const stepIds = new Set(plan.steps.map((step) => step.id));

    plan.steps.forEach((step, stepIndex) => {
      step.dependsOn?.forEach((dependency, dependencyIndex) => {
        if (dependency === step.id) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
            message: 'Plan step cannot depend on itself.',
          });
        }

        if (!stepIds.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', stepIndex, 'dependsOn', dependencyIndex],
            message: `Unknown plan step dependency "${dependency}".`,
          });
        }
      });
    });
  });

const executionScheduleStepKindSchema = z.enum([
  'create-resource',
  'start-service',
  'wait-until-ready',
]);

const executionScheduleResourceTypeSchema = z.enum(['network', 'volume', 'service']);

export const dependencyGraphEntrySchema = z
  .object({
    serviceName: identifierSchema,
    dependsOn: z.array(identifierSchema),
    dependents: z.array(identifierSchema),
  })
  .strict();

export const executionScheduleStepSchema = z
  .object({
    order: z.number().int().min(1),
    level: z.number().int().min(0),
    levelName: z.string().min(1),
    kind: executionScheduleStepKindSchema,
    resourceType: executionScheduleResourceTypeSchema,
    resourceName: identifierSchema,
    action: z.string().min(1),
    dependsOn: z.array(identifierSchema),
    dependents: z.array(identifierSchema),
    waitCondition: z.string().min(1).nullable(),
    readinessEnforced: z.boolean(),
    serviceKind: z.enum(['reverse-proxy', 'backend', 'database']).optional(),
    image: z.string().min(1).optional(),
    replicas: z.number().int().min(1).optional(),
    ports: z.array(portMappingSchema).optional(),
    volumes: z.array(volumeMountSchema).optional(),
  })
  .strict();

export const dependencyAwareExecutionScheduleSchema = z
  .object({
    projectName: identifierSchema,
    steps: z.array(executionScheduleStepSchema).min(1),
    dependencyGraph: z.array(dependencyGraphEntrySchema),
    serviceStartOrder: z.array(identifierSchema),
    destroyOrder: z.array(identifierSchema),
    warnings: z.array(z.string().min(1)),
  })
  .strict();

export const dryRunServiceImpactSchema = z
  .object({
    name: identifierSchema,
    kind: z.enum(['reverse-proxy', 'backend', 'database']),
    image: z.string().min(1),
    replicas: z.number().int().min(1),
    ports: z.array(portMappingSchema),
    volumes: z.array(volumeMountSchema),
    environmentKeys: z.array(environmentKeySchema),
    environment: z.record(environmentKeySchema, z.string().min(1)),
    dependsOn: z.array(identifierSchema),
    dependents: z.array(identifierSchema),
    waitCondition: z.string().min(1),
    readinessEnforced: z.boolean(),
    warnings: z.array(z.string().min(1)),
  })
  .strict();

export const dryRunPolicyFindingSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'blocker']),
    code: z.string().min(1),
    message: z.string().min(1),
    resourceName: identifierSchema.nullable(),
    resourceType: executionScheduleResourceTypeSchema.nullable(),
  })
  .strict();

export const detailedDryRunPreviewSchema = z
  .object({
    projectName: identifierSchema,
    artifactTargetPath: z.string().min(1),
    artifactWritten: z.literal(false),
    stateSaved: z.literal(false),
    dockerCalled: z.boolean(),
    mcpCalled: z.boolean(),
    composePreviewLineCount: z.number().int().min(0),
    totalServices: z.number().int().min(1),
    totalContainers: z.number().int().min(1),
    networks: z.array(identifierSchema),
    volumes: z.array(identifierSchema),
    services: z.array(dryRunServiceImpactSchema).min(1),
    schedule: dependencyAwareExecutionScheduleSchema,
    policyFindings: z.array(dryRunPolicyFindingSchema),
    actionsNotPerformed: z.array(z.string().min(1)),
  })
  .strict();

export const composeArtifactRecordSchema = z
  .object({
    targetPath: z.string().min(1),
    previewContent: z.string().min(1),
    previewSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Compose preview hash must be a SHA-256 hex digest.'),
    lineCount: z.number().int().min(0),
    written: z.boolean(),
    writtenAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.written && artifact.writtenAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writtenAt'],
        message: 'Written compose artifacts require writtenAt.',
      });
    }

    if (!artifact.written && artifact.writtenAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writtenAt'],
        message: 'Preview-only compose artifacts must not have writtenAt.',
      });
    }
  });

export const actionClassificationSchema = z
  .object({
    capability: z.literal('compose-artifact-write'),
    risk: z.literal('artifact-write'),
    summary: z.string().min(1),
    requiresApproval: z.literal(true),
    mutatesRuntime: z.boolean(),
    writesArtifact: z.literal(true),
    writesState: z.literal(true),
    callsDocker: z.boolean(),
    callsMcp: z.boolean(),
  })
  .strict();

export const findingCodeSchema = z.enum([
  'HOST_PORT_CONFLICT',
  'REPLICA_PORT_BIND_CONFLICT',
  'CONTAINER_NAME_CONFLICT',
  'PROJECT_NAME_CONFLICT',
  'NETWORK_NAME_CONFLICT',
  'VOLUME_NAME_CONFLICT',
  'MOUNT_DENIED',
  'ENV_INVALID',
  'MISSING_CONTAINER',
  'CONTAINER_NOT_RUNNING',
  'CONTAINER_UNHEALTHY',
  'HEALTHCHECK_FAILED',
  'IMAGE_MISMATCH',
  'IMAGE_NOT_FOUND',
  'IMAGE_PULL_FAILED',
  'PORT_MISMATCH',
  'NETWORK_MISMATCH',
  'VOLUME_MISMATCH',
  'DEPENDENCY_NOT_READY',
  'DOCKER_PERMISSION_DENIED',
  'MCP_TOOL_ERROR',
  'RUNTIME_DRIFT',
  'RUNTIME_OBSERVATION_UNCERTAIN',
  'UNKNOWN_RUNTIME_ERROR',
]);

export const suggestedResolutionSchema = z
  .object({
    action: z.enum(['auto-revise', 'ask-user', 'repair-runtime', 'retry-observe', 'manual-check']),
    summary: z.string().min(1),
    choices: z.array(clarificationChoiceSchema).min(1).optional(),
  })
  .strict();

export const verificationFindingSchema = z
  .object({
    code: findingCodeSchema,
    severity: z.enum(['info', 'warning', 'error', 'blocker']),
    resourceKind: z.enum(['container', 'service', 'image', 'network', 'volume', 'port', 'runtime']),
    resourceName: z.string().min(1).nullable(),
    expected: z.string().min(1).nullable(),
    actual: z.string().min(1).nullable(),
    evidence: z.array(z.string().min(1)),
    confidence: z.number().min(0).max(1),
    suggestedAction: suggestedResolutionSchema.nullable(),
    requiresUserInput: z.boolean(),
  })
  .strict();

export const verificationReportSchema = z
  .object({
    status: z.enum(['passed', 'failed', 'uncertain']),
    scope: z.enum(['meta-preflight', 'tool-runtime']),
    checkedAt: timestampSchema,
    issues: z.array(z.string().min(1)),
    findings: z.array(verificationFindingSchema).optional(),
    evidence: z.array(z.string().min(1)),
    errorReason: z.string().min(1).nullable(),
    revisionHint: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === 'passed' && report.issues.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issues'],
        message: 'Passed verification reports must not contain issues.',
      });
    }

    if (report.status !== 'passed' && report.issues.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issues'],
        message: 'Failed or uncertain verification reports require at least one issue.',
      });
    }
  });
export const plannerRevisionDecisionSchema = z.enum([
  'auto-revised',
  'needs-user-input',
  'no-safe-resolution',
]);

export const revisionHistoryRecordSchema = z
  .object({
    attemptIndex: z.number().int().min(0),
    revisionDecision: plannerRevisionDecisionSchema,
    revisionSummary: z.string().min(1),
    findings: z.array(verificationFindingSchema),
    userFeedback: z
      .object({
        message: z.string().min(1, 'User feedback message must not be empty.'),
        submittedAt: timestampSchema,
      })
      .strict()
      .nullable(),
    createdAt: timestampSchema,
  })
  .strict();


export const preflightReportSchema = z
  .object({
    status: z.enum(['passed', 'failed']),
    checkedAt: timestampSchema,
    issues: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)),
    policyFindings: z.array(dryRunPolicyFindingSchema),
    verificationReport: verificationReportSchema,
  })
  .strict()
  .superRefine((report, context) => {
    if (report.status === 'passed' && report.issues.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['issues'],
        message: 'Passed preflight reports must not contain issues.',
      });
    }

    if (report.status === 'passed' && report.evidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'Passed preflight reports require evidence.',
      });
    }

    if (report.status === 'passed' && report.policyFindings.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['policyFindings'],
        message: 'Passed preflight reports require policy evidence.',
      });
    }

    if (report.status === 'passed' && report.verificationReport.status !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationReport', 'status'],
        message: 'Passed preflight reports require passed meta verification.',
      });
    }

    if (report.verificationReport.scope !== 'meta-preflight') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationReport', 'scope'],
        message: 'Phase 8 preflight uses only meta-preflight verification.',
      });
    }
  });

export const approvalRequestSchema = z
  .object({
    id: z.string().min(1),
    requestedAt: timestampSchema,
    action: z.literal('write-compose-artifact'),
    request: requestMetadataSchema,
    planSummary: z.string().min(1),
    classification: actionClassificationSchema,
    artifactTargetPath: z.string().min(1),
    composePreviewSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Compose preview hash must be a SHA-256 hex digest.'),
    totalContainers: z.number().int().min(1),
    policyFindings: z.array(dryRunPolicyFindingSchema).min(1),
    preflight: preflightReportSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.preflight.status !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preflight', 'status'],
        message: 'Approval requests require a passed preflight report.',
      });
    }
  });

export const approvalResultSchema = z
  .object({
    id: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(['approved', 'rejected']),
    respondedAt: timestampSchema,
    approvedBy: z.literal('cli-user'),
    reason: z.string().min(1).nullable(),
  })
  .strict();

export const approvalMarkerSchema = z
  .object({
    type: z.literal('phase8-human-approval'),
    approvalId: z.string().min(1),
    approvedAt: timestampSchema,
    approvedBy: z.literal('cli-user'),
  })
  .strict();

export const approvedActionSchema = z
  .object({
    id: z.string().min(1),
    action: z.literal('write-compose-artifact'),
    request: requestMetadataSchema,
    classification: actionClassificationSchema,
    approval: approvalResultSchema,
    approvalMarker: approvalMarkerSchema,
    validatedSpec: infrastructureSpecSchema,
    composeArtifact: composeArtifactRecordSchema,
    dependencySchedule: dependencyAwareExecutionScheduleSchema,
    preflight: preflightReportSchema,
    policyFindings: z.array(dryRunPolicyFindingSchema).min(1),
    dockerCalled: z.boolean(),
    mcpCalled: z.boolean(),
    runtimeMutation: z.boolean(),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.approval.decision !== 'approved') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval', 'decision'],
        message: 'ApprovedAction requires an approved approval result.',
      });
    }

    if (action.approvalMarker.approvalId !== action.approval.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalMarker', 'approvalId'],
        message: 'Approval marker must reference the approval result.',
      });
    }

    if (action.approvalMarker.approvedAt !== action.approval.respondedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approvalMarker', 'approvedAt'],
        message: 'Approval marker timestamp must match approval result timestamp.',
      });
    }

    if (action.preflight.status !== 'passed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preflight', 'status'],
        message: 'ApprovedAction requires passed preflight.',
      });
    }

    if (!action.composeArtifact.written) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['composeArtifact', 'written'],
        message: 'ApprovedAction requires a written compose artifact record.',
      });
    }

    if (action.composeArtifact.writtenAt !== action.approvalMarker.approvedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['composeArtifact', 'writtenAt'],
        message: 'Compose artifact writtenAt must match the approval marker timestamp.',
      });
    }

    if (action.dependencySchedule.projectName !== action.validatedSpec.projectName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependencySchedule', 'projectName'],
        message: 'ApprovedAction schedule must belong to the validated spec project.',
      });
    }
  });

export const containerCreateSpecSchema = z
  .object({
    name: identifierSchema,
    image: z.string().min(1),
    command: z.array(z.string().min(1)).optional(),
    ports: z.array(portMappingSchema).optional(),
    environment: z.record(environmentKeySchema, z.string()).optional(),
    volumes: z.array(volumeMountSchema).optional(),
    networks: z.array(identifierSchema).optional(),
  })
  .strict();

export const dockerDeployResultSchema = z
  .object({
    networksCreated: z.array(z.string().min(1)),
    imagesPulled: z.array(z.string().min(1)),
    containersStarted: z.array(
      z.object({
        name: z.string().min(1),
        id: z.string().min(1),
      }).strict(),
    ),
    startedAt: timestampSchema,
  })
  .strict();

export const agentObservationSchema = z
  .object({
    source: z.string().min(1, 'Observation source must not be empty.'),
    message: z.string().min(1, 'Observation message must not be empty.'),
  })
  .strict();

export const reactStepSchema = z
  .object({
    id: identifierSchema,
    phase: z.enum(['reason', 'act', 'observe']),
    message: z.string().min(1, 'ReAct step message must not be empty.'),
    toolName: z.string().min(1).nullable(),
  })
  .strict();

export const guardToolCallCountSchema = z
  .object({
    tool: z.string().min(1),
    count: z.number().int().nonnegative(),
    capped: z.boolean(),
  })
  .strict();

export const guardDeltaEntrySchema = z
  .object({
    iteration: z.number().int().nonnegative(),
    hasDelta: z.boolean(),
    specHash: z.string(),
    issueCount: z.number().int().nonnegative(),
    stepHash: z.string(),
  })
  .strict();

export const guardTelemetrySchema = z
  .object({
    iterations: z.number().int().nonnegative(),
    outcome: z.enum(['converged', 'blocked']),
    blockReason: z.string().nullable(),
    perToolCounts: z.array(guardToolCallCountSchema),
    deltaHistory: z.array(guardDeltaEntrySchema),
    logFilePath: z.string().nullable(),
  })
  .strict();

export const plannedAgentRunResultSchema = z
  .object({
    status: z.literal('planned'),
    request: requestMetadataSchema,
    plan: executionPlanSchema,
    observations: z.array(agentObservationSchema).min(1, 'At least one observation is required.'),
    trace: z.array(reactStepSchema).min(1).optional(),
    guardTelemetry: guardTelemetrySchema.optional(),
  })
  .strict();

export const clarificationAgentRunResultSchema = z
  .object({
    status: z.literal('clarification'),
    clarificationQuestion: z.string().min(1, 'Clarification question must not be empty.'),
    clarificationChoices: z.array(clarificationChoiceSchema).optional(),
    allowOther: z.boolean().optional(),
    uncertainties: z.array(planningUncertaintySchema).optional(),
    clarificationContext: planningClarificationContextSchema.optional(),
    observations: z.array(agentObservationSchema).min(1, 'At least one observation is required.'),
    trace: z.array(reactStepSchema).min(1).optional(),
    guardTelemetry: guardTelemetrySchema.optional(),
  })
  .strict();

export const blockedAgentRunResultSchema = z
  .object({
    status: z.literal('blocked'),
    blockReason: z.string().min(1, 'Block reason must not be empty.'),
    iterations: z.number().int().nonnegative(),
    guardTelemetry: guardTelemetrySchema,
    observations: z.array(agentObservationSchema),
    trace: z.array(reactStepSchema).min(1).optional(),
  })
  .strict();

export const agentRunResultSchema = z.discriminatedUnion('status', [
  plannedAgentRunResultSchema,
  clarificationAgentRunResultSchema,
  blockedAgentRunResultSchema,
]);

const runtimeObservationSourceSchema = z.enum([
  'not-observed',
  'mcp-readonly',
  'runtime-adapter',
]);

export const runtimeContainerObservationSchema = z
  .object({
    name: identifierSchema,
    image: z.string().min(1).nullable(),
    status: z.string().min(1).nullable(),
    ports: z.array(z.string().min(1)),
    environment: z.record(z.string(), z.string()).nullable().optional(),
    healthStatus: z.string().min(1).nullable().optional(),
    restartCount: z.number().int().min(0).nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    logSnippet: z.string().nullable().optional(),
  })
  .strict();

export const runtimeContainerSummarySchema = z
  .object({
    name: z.string().min(1),
    image: z.string().min(1).nullable(),
    status: z.string().min(1).nullable(),
    ports: z.array(z.string().min(1)),
    networks: z.array(z.string().min(1)),
    mountDestinations: z.array(z.string().min(1)),
    restartPolicy: z.string().min(1).nullable(),
    healthStatus: z.string().min(1).nullable(),
  })
  .strict();

export const runtimeNamedResourceObservationSchema = z
  .object({
    name: identifierSchema,
    status: z.string().min(1).nullable(),
  })
  .strict();

export const runtimeResourceRefsSchema = z
  .object({
    projectName: identifierSchema,
    containers: z.array(identifierSchema),
    networks: z.array(identifierSchema),
    volumes: z.array(identifierSchema),
    images: z.array(z.string().min(1)),
  })
  .strict();

export const driftFindingSchema = z
  .object({
    kind: z.enum([
      'missing-container',
      'stopped-container',
      'running-container',
      'image-mismatch',
      'port-mismatch',
      'env-mismatch',
      'missing-network',
      'missing-volume',
      'missing-image',
      'extra-project-resource',
      'uncertain-runtime-evidence',
    ]),
    severity: z.enum(['minor', 'major', 'risky', 'unknown']),
    resourceType: z.enum(['container', 'network', 'volume', 'image', 'runtime']),
    resourceName: z.string().min(1),
    message: z.string().min(1),
    expected: z.string().nullable(),
    actual: z.string().nullable(),
    autoRepairable: z.boolean(),
  })
  .strict();

export const driftReportSchema = z
  .object({
    status: z.enum(['none', 'drifted', 'uncertain']),
    checkedAt: timestampSchema,
    projectName: identifierSchema,
    findings: z.array(driftFindingSchema),
    summary: z.string().min(1),
  })
  .strict();

export const repairActionSchema = z
  .object({
    kind: z.enum(['start-container', 'stop-container', 'recreate-container', 'pull-image', 'create-network', 'create-volume']),
    resourceName: z.string().min(1),
    risk: z.enum(['safe', 'approval-required']),
    reason: z.string().min(1),
  })
  .strict();

export const repairPlanSchema = z
  .object({
    projectName: identifierSchema,
    findings: z.array(driftFindingSchema),
    actions: z.array(repairActionSchema),
    requiresApproval: z.boolean(),
    autoRepairable: z.boolean(),
  })
  .strict();

export const repairReportSchema = z
  .object({
    status: z.enum(['applied', 'rejected', 'failed', 'partial']),
    actionsAttempted: z.array(repairActionSchema),
    actionsSucceeded: z.array(repairActionSchema),
    actionsFailed: z.array(z.object({ action: repairActionSchema, error: z.string().min(1) }).strict()),
  })
  .strict();

export const cleanupReportSchema = z
  .object({
    trigger: z.enum(['deploy-failed', 'repair-failed']),
    attempted: z.array(z.string().min(1)),
    succeeded: z.array(z.string().min(1)),
    failed: z.array(z.object({ resource: z.string().min(1), error: z.string().min(1) }).strict()),
    leftovers: z.array(z.string().min(1)),
  })
  .strict();

export const runtimeImageObservationSchema = z
  .object({
    reference: z.string().min(1),
    id: z.string().min(1).nullable(),
    status: z.string().min(1).nullable(),
  })
  .strict();

export const runtimeActualStateSchema = z
  .object({
    source: runtimeObservationSourceSchema,
    containers: z.array(runtimeContainerObservationSchema),
    networks: z.array(runtimeNamedResourceObservationSchema),
    volumes: z.array(runtimeNamedResourceObservationSchema),
    images: z.array(runtimeImageObservationSchema),
    lastObservedAt: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((actual, context) => {
    if (actual.source === 'not-observed' && actual.lastObservedAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lastObservedAt'],
        message: 'Actual runtime state cannot have lastObservedAt when source is not-observed.',
      });
    }
  });

export const verificationStateSchema = z
  .object({
    status: z.enum(['not-run', 'passed', 'failed', 'uncertain']),
    scope: z.enum(['preview', 'runtime']),
    checkedAt: timestampSchema.nullable(),
    summary: z.string().min(1),
    issues: z.array(z.string().min(1)),
    evidence: z.array(z.string().min(1)),
  })
  .strict();

export const pendingPreviewStateSchema = z
  .object({
    id: z.string().min(1),
    request: requestMetadataSchema,
    desired: infrastructureSpecSchema,
    plan: executionPlanSchema,
    composeArtifact: composeArtifactRecordSchema,
    dryRunPreview: detailedDryRunPreviewSchema.nullable(),
    observations: z.array(agentObservationSchema),
    trace: z.array(reactStepSchema),
    verification: verificationStateSchema,
    createdAt: timestampSchema,
    acceptedAt: timestampSchema.nullable(),
    approval: approvalResultSchema.nullable().optional(),
    approvedAction: approvedActionSchema.nullable().optional(),
  })
  .strict();

export const verifiedRuntimeSnapshotSchema = z
  .object({
    id: z.string().min(1),
    request: requestMetadataSchema,
    desired: infrastructureSpecSchema,
    composeArtifact: composeArtifactRecordSchema,
    actual: runtimeActualStateSchema,
    verification: verificationStateSchema,
    verificationReport: verificationReportSchema.optional(),
    resourceRefs: runtimeResourceRefsSchema.optional(),
    driftReport: driftReportSchema.nullable().optional(),
    repairReport: repairReportSchema.nullable().optional(),
    cleanupReport: cleanupReportSchema.nullable().optional(),
    revisionHistory: z.array(revisionHistoryRecordSchema).optional(),
    observedAt: timestampSchema.nullable().optional(),
    operation: z.enum(['deploy', 'repair', 'destroy', 'sync']).optional(),
    approvedAt: timestampSchema.nullable(),
    appliedAt: timestampSchema.nullable(),
    savedAt: timestampSchema,
  })
  .strict();

export const stateOperationRecordSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum([
      'pending-preview-saved',
      'legacy-state-migrated',
      'approval-rejected',
      'approved-action-created',
      'compose-artifact-written',
      'verified-runtime-saved',
      'repair-rejected',
      'drift-observed',
      'destroy-all-executed',
    ]),
    projectName: identifierSchema,
    request: requestMetadataSchema.nullable(),
    summary: z.string().min(1),
    createdAt: timestampSchema,
  })
  .strict();

export const infrastructureStateSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    current: verifiedRuntimeSnapshotSchema.nullable(),
    pendingPreview: pendingPreviewStateSchema.nullable(),
    history: z.array(stateOperationRecordSchema),
  })
  .strict();

const userFeedbackSchema = z
  .object({
    message: z.string().min(1, 'User feedback message must not be empty.'),
    submittedAt: timestampSchema,
  })
  .strict();

export const revisionObservationSchema = z
  .object({
    verificationReport: verificationReportSchema.nullable(),
    userFeedback: userFeedbackSchema.nullable(),
    driftSummary: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((obs, context) => {
    if (obs.verificationReport === null && obs.userFeedback === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['root'],
        message: 'Revision observation must include at least a verification report or user feedback.',
      });
    }
  });

const feedbackIntentSchema = z
  .object({
    source: z.literal('user-other-feedback'),
    rawText: z.string().min(1),
    intent: z.enum([
      'change-port',
      'change-name',
      'change-replicas',
      'change-image',
      'change-env',
      'remove-env',
      'change-volume',
      'remove-volume',
      'change-dependency',
      'remove-dependency',
      'change-network',
      'rename-network',
      'set-networks',
      'add-service',
      'remove-service',
      'rename-service',
      'change-status',
      'change-project',
      'remove-exposure',
      'yaml-edit-intent',
      'retry-as-is',
      'cancel',
      'unknown',
    ]),
    target: z
      .object({
        resourceKind: z
          .enum(['project', 'service', 'container', 'port', 'image', 'volume', 'network', 'environment'])
          .optional(),
        serviceSelector: z.lazy(() => serviceSelectorSchema).optional(),
        currentValue: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    desiredChange: z
      .object({
        hostPort: z.number().int().min(1).max(65535).optional(),
        containerPort: z.number().int().min(1).max(65535).optional(),
        name: z.string().min(1).optional(),
        replicas: serviceReplicasSchema.optional(),
        image: z.string().min(1).optional(),
        environment: z.record(z.string(), z.string()).optional(),
        volumes: z.array(z.string().min(1)).optional(),
        networks: z.array(z.string().min(1)).optional(),
        dependencies: z.array(identifierSchema).optional(),
        desiredStatus: z.enum(['running', 'stopped']).optional(),
        service: z.lazy(() => infrastructureServiceSchema).optional(),
        yamlFragment: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    confidence: z.number().min(0).max(1),
    ambiguities: z.array(z.string().min(1)),
    requiresUserInput: z.boolean(),
  })
  .strict();

const serviceSelectorSchema = z
  .object({
    targetKind: z.enum(['service', 'replica-group']).optional(),
    name: identifierSchema.optional(),
    nameLike: z.string().min(1).optional(),
    kind: z.enum(['reverse-proxy', 'backend', 'database']).optional(),
    imageFamily: z.string().min(1).optional(),
    exposesHostPort: z.boolean().optional(),
    dependsOn: identifierSchema.optional(),
    dependentOf: identifierSchema.optional(),
  })
  .strict()
  .superRefine((selector, context) => {
    if (Object.keys(selector).filter((key) => key !== 'targetKind').length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['root'],
        message: 'Service selector must include at least one matching hint.',
      });
    }
  });

const patchReasonSchema = z.string().min(1, 'Patch reason must not be empty.');

export const specPatchSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set-service-replicas'), target: serviceSelectorSchema, replicas: serviceReplicasSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('replace-service-port'), target: serviceSelectorSchema, from: portMappingSchema.optional(), to: portMappingSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('add-service-port'), target: serviceSelectorSchema, port: portMappingSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('remove-service-port'), target: serviceSelectorSchema, port: portMappingSchema.optional(), reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('set-service-image'), target: serviceSelectorSchema, image: z.string().min(1), reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('add-service'), service: infrastructureServiceSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('remove-service'), target: serviceSelectorSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('rename-service'), target: serviceSelectorSchema, name: identifierSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('set-service-env'), target: serviceSelectorSchema, key: environmentKeySchema, value: z.string().min(1), reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('remove-service-env'), target: serviceSelectorSchema, key: environmentKeySchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('add-service-volume'), target: serviceSelectorSchema, volume: volumeMountSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('remove-service-volume'), target: serviceSelectorSchema, volume: volumeMountSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('add-service-dependency'), target: serviceSelectorSchema, dependencyName: identifierSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('remove-service-dependency'), target: serviceSelectorSchema, dependencyName: identifierSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('set-service-desired-status'), target: serviceSelectorSchema, desiredStatus: z.enum(['running', 'stopped']), reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('set-project-name'), name: identifierSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('rename-network'), from: identifierSchema.optional(), to: identifierSchema, reason: patchReasonSchema }).strict(),
  z.object({ op: z.literal('set-networks'), networks: z.array(identifierSchema).min(1), reason: patchReasonSchema }).strict(),
]);

export const specPatchPlanSchema = z
  .object({
    patches: z.array(specPatchSchema),
    explanation: z.string().min(1),
    assumptions: z.array(z.string().min(1)),
    ambiguities: z.array(z.string().min(1)),
    requiresUserInput: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const plannerRevisionRequestSchema = z
  .object({
    desiredSpec: infrastructureSpecSchema,
    currentPlan: executionPlanSchema.optional(),
    runtimeIssueReport: z.unknown().optional(),
    feedbackIntent: feedbackIntentSchema.nullable().optional(),
    revisionObservation: revisionObservationSchema,
    stateSnapshot: infrastructureStateSnapshotSchema.nullable(),
    resourceRefs: z
      .object({
        projectName: z.string().min(1),
        operationId: z.string().min(1).optional(),
        containers: z.array(z.string().min(1)),
        networks: z.array(z.string().min(1)),
        volumes: z.array(z.string().min(1)),
        images: z.array(z.string().min(1)),
      })
      .optional(),
    attemptIndex: z.number().int().min(0),
  })
  .strict();


export type CliInput = z.infer<typeof cliInputSchema>;

export class DomainValidationError extends Error {
  constructor(
    readonly label: string,
    readonly issues: string[],
  ) {
    super([`Invalid ${label}:`, ...issues.map((issue) => `- ${issue}`)].join('\n'));
    this.name = 'DomainValidationError';
  }
}

export function validateIntentClassification(value: unknown): IntentClassification {
  return parseWithSchema(
    intentClassificationSchema,
    value,
    'intent classification',
  ) as IntentClassification;
}

export function validateDraftQuery(value: unknown): DraftQuery {
  return parseWithSchema(draftQuerySchema, value, 'draft query') as DraftQuery;
}

export function validateValidatedQuery(value: unknown): ValidatedQuery {
  return parseWithSchema(validatedQuerySchema, value, 'validated query') as ValidatedQuery;
}

export function validateReactReasoningOutput(value: unknown): ReActReasoningOutput {
  return parseWithSchema(
    reactReasoningOutputSchema,
    value,
    'ReAct reasoning output',
  ) as ReActReasoningOutput;
}

export function validateInfrastructureSpec(value: unknown): InfrastructureSpec {
  return parseWithSchema(infrastructureSpecSchema, value, 'infrastructure spec') as InfrastructureSpec;
}

export function validateExecutionPlan(value: unknown): ExecutionPlan {
  return parseWithSchema(executionPlanSchema, value, 'execution plan') as ExecutionPlan;
}

export function validateDependencyAwareExecutionSchedule(
  value: unknown,
): DependencyAwareExecutionSchedule {
  return parseWithSchema(
    dependencyAwareExecutionScheduleSchema,
    value,
    'dependency-aware execution schedule',
  ) as DependencyAwareExecutionSchedule;
}

export function validateDetailedDryRunPreview(value: unknown): DetailedDryRunPreview {
  return parseWithSchema(
    detailedDryRunPreviewSchema,
    value,
    'detailed dry-run preview',
  ) as DetailedDryRunPreview;
}

export function validateActionClassification(value: unknown): ActionClassification {
  return parseWithSchema(
    actionClassificationSchema,
    value,
    'action classification',
  ) as ActionClassification;
}

export function validateVerificationReport(value: unknown): VerificationReport {
  return parseWithSchema(
    verificationReportSchema,
    value,
    'verification report',
  ) as VerificationReport;
}

export function validateUserFeedback(value: unknown): UserFeedback {
  return parseWithSchema(userFeedbackSchema, value, 'user feedback') as UserFeedback;
}

export function validateRevisionObservation(value: unknown): RevisionObservation {
  return parseWithSchema(revisionObservationSchema, value, 'revision observation') as RevisionObservation;
}

export function validateFeedbackIntent(value: unknown): FeedbackIntent {
  return parseWithSchema(feedbackIntentSchema, value, 'feedback intent') as FeedbackIntent;
}

export function validatePlannerRevisionRequest(value: unknown): PlannerRevisionRequest {
  return parseWithSchema(plannerRevisionRequestSchema, value, 'planner revision request') as PlannerRevisionRequest;
}

export function validateSpecPatchPlan(value: unknown): SpecPatchPlan {
  return parseWithSchema(specPatchPlanSchema, value, 'spec patch plan') as SpecPatchPlan;
}

export function validatePlanningUncertainty(value: unknown): PlanningUncertainty {
  return parseWithSchema(planningUncertaintySchema, value, 'planning uncertainty') as PlanningUncertainty;
}

export function validateClarificationAnswer(value: unknown): ClarificationAnswer {
  return parseWithSchema(clarificationAnswerSchema, value, 'clarification answer') as ClarificationAnswer;
}

export function validatePlanningClarificationContext(value: unknown): PlanningClarificationContext {
  return parseWithSchema(
    planningClarificationContextSchema,
    value,
    'planning clarification context',
  ) as PlanningClarificationContext;
}
export function validatePreflightReport(value: unknown): PreflightReport {
  return parseWithSchema(
    preflightReportSchema,
    value,
    'preflight report',
  ) as PreflightReport;
}

export function validateApprovalRequest(value: unknown): ApprovalRequest {
  return parseWithSchema(
    approvalRequestSchema,
    value,
    'approval request',
  ) as ApprovalRequest;
}

export function validateApprovalResult(value: unknown): ApprovalResult {
  return parseWithSchema(
    approvalResultSchema,
    value,
    'approval result',
  ) as ApprovalResult;
}

export function validateApprovedAction(value: unknown): ApprovedAction {
  return parseWithSchema(
    approvedActionSchema,
    value,
    'approved action',
  ) as ApprovedAction;
}

export function validateContainerCreateSpec(value: unknown): ContainerCreateSpec {
  return parseWithSchema(
    containerCreateSpecSchema,
    value,
    'container create spec',
  ) as ContainerCreateSpec;
}

export function validateDockerDeployResult(value: unknown): DockerDeployResult {
  return parseWithSchema(
    dockerDeployResultSchema,
    value,
    'Docker deploy result',
  ) as DockerDeployResult;
}
export function validateAgentRunResult(value: unknown): AgentRunResult {
  return parseWithSchema(agentRunResultSchema, value, 'agent run result') as AgentRunResult;
}

export function validateInfrastructureStateSnapshot(value: unknown): InfrastructureStateSnapshot {
  return parseWithSchema(
    infrastructureStateSnapshotSchema,
    value,
    'infrastructure state snapshot',
  ) as InfrastructureStateSnapshot;
}

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  throw new DomainValidationError(label, formatValidationIssues(result.error.issues));
}

function formatValidationIssues(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`);
}

function formatPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join('.') : 'root';
}

function addDuplicateIssues(
  values: string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();

  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Duplicate value "${value}".`,
      });
    }

    seen.add(value);
  });
}

