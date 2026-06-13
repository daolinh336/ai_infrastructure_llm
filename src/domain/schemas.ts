import { z } from 'zod';
import type {
  AgentRunResult,
  DependencyAwareExecutionSchedule,
  DetailedDryRunPreview,
  DraftQuery,
  ExecutionPlan,
  InfrastructureStateFile,
  InfrastructureSpec,
  IntentClassification,
  LegacyStateSnapshot,
  ReActReasoningOutput,
  ValidatedQuery,
} from './types.js';
import {
  SUPPORTED_IMAGE_BASES,
  isSupportedImageReference,
} from './supported-images.js';

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
  provider: z.enum(['stub', 'openai', 'gemini', 'ollama']).default('stub'),
});

export const reactReasoningOutputSchema = z
  .object({
    summary: z.string().min(1, 'Reasoning summary must not be empty.'),
    nextAction: z.enum(['continue_planning', 'ask_user', 'stop']),
    rationale: z.string().min(1, 'Reasoning rationale must not be empty.'),
    safetyNotes: z.array(z.string().min(1)),
  })
  .strict();

export const infrastructureServiceSchema = z
  .object({
    kind: z.enum(['reverse-proxy', 'backend', 'database']),
    name: identifierSchema,
    image: z.string().min(1, 'Image must not be empty.'),
    replicas: z.number().int('Replicas must be an integer.').min(1).max(50).optional(),
    ports: z.array(portMappingSchema).min(1).optional(),
    environment: z.record(environmentKeySchema, z.string().min(1, 'Environment values must not be empty.')).optional(),
    dependsOn: z.array(identifierSchema).min(1).optional(),
    volumes: z.array(volumeMountSchema).min(1).optional(),
  })
  .strict();

export const infrastructureSpecSchema = z
  .object({
    projectName: identifierSchema,
    services: z.array(infrastructureServiceSchema).min(1, 'At least one service is required.'),
    networks: z.array(identifierSchema).min(1, 'At least one network is required.'),
    volumes: z.array(identifierSchema),
  })
  .strict()
  .superRefine((spec, context) => {
    addDuplicateIssues(spec.services.map((service) => service.name), ['services'], context);
    addDuplicateIssues(spec.networks, ['networks'], context);
    addDuplicateIssues(spec.volumes, ['volumes'], context);

    const serviceNames = new Set(spec.services.map((service) => service.name));
    const volumeNames = new Set(spec.volumes);

    spec.services.forEach((service, serviceIndex) => {
      if (!isSupportedImageReference(service.image)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['services', serviceIndex, 'image'],
          message: `Image "${service.image}" is not supported. Supported images: ${SUPPORTED_IMAGE_BASES.join(', ')}.`,
        });
      }

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
    });
  });

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
    dockerCalled: z.literal(false),
    mcpCalled: z.literal(false),
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

export const plannedAgentRunResultSchema = z
  .object({
    status: z.literal('planned'),
    request: requestMetadataSchema,
    plan: executionPlanSchema,
    observations: z.array(agentObservationSchema).min(1, 'At least one observation is required.'),
    trace: z.array(reactStepSchema).min(1).optional(),
  })
  .strict();

export const clarificationAgentRunResultSchema = z
  .object({
    status: z.literal('clarification'),
    clarificationQuestion: z.string().min(1, 'Clarification question must not be empty.'),
    observations: z.array(agentObservationSchema).min(1, 'At least one observation is required.'),
    trace: z.array(reactStepSchema).min(1).optional(),
  })
  .strict();

export const agentRunResultSchema = z.discriminatedUnion('status', [
  plannedAgentRunResultSchema,
  clarificationAgentRunResultSchema,
]);

const runtimeObservationSourceSchema = z.enum([
  'not-observed',
  'mcp-readonly',
  'runtime-adapter',
  'legacy-placeholder',
]);

export const runtimeContainerObservationSchema = z
  .object({
    name: identifierSchema,
    image: z.string().min(1).nullable(),
    status: z.string().min(1).nullable(),
    ports: z.array(z.string().min(1)),
  })
  .strict();

export const runtimeNamedResourceObservationSchema = z
  .object({
    name: identifierSchema,
    status: z.string().min(1).nullable(),
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
      'verified-runtime-saved',
      'legacy-state-migrated',
    ]),
    projectName: identifierSchema,
    request: requestMetadataSchema.nullable(),
    summary: z.string().min(1),
    createdAt: timestampSchema,
  })
  .strict();

export const infrastructureStateFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    current: verifiedRuntimeSnapshotSchema.nullable(),
    pendingPreview: pendingPreviewStateSchema.nullable(),
    history: z.array(stateOperationRecordSchema),
  })
  .strict();

export const legacyStateSnapshotSchema = z
  .object({
    desired: infrastructureSpecSchema,
    actual: z
      .object({
        containers: z.array(z.string().min(1, 'Container names must not be empty.')),
        lastObservedAt: timestampSchema.nullable(),
      })
      .strict(),
    desiredStateSavedAt: timestampSchema.nullable().optional(),
    lastAppliedAt: timestampSchema.nullable(),
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

export function validateAgentRunResult(value: unknown): AgentRunResult {
  return parseWithSchema(agentRunResultSchema, value, 'agent run result') as AgentRunResult;
}

export function validateInfrastructureStateFile(value: unknown): InfrastructureStateFile {
  return parseWithSchema(
    infrastructureStateFileSchema,
    value,
    'infrastructure state file',
  ) as InfrastructureStateFile;
}

export function validateLegacyStateSnapshot(value: unknown): LegacyStateSnapshot {
  return parseWithSchema(
    legacyStateSnapshotSchema,
    value,
    'legacy state snapshot',
  ) as LegacyStateSnapshot;
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
