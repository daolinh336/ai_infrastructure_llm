import { z } from 'zod';
import type {
  AgentRunResult,
  DraftQuery,
  ExecutionPlan,
  InfrastructureSpec,
  IntentClassification,
  StateSnapshot,
  ValidatedQuery,
} from './types.js';

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

export const cliInputSchema = z.object({
  prompt: z.string().min(1, 'Prompt must not be empty.'),
  dryRun: z.boolean().default(false),
  provider: z.enum(['openai', 'gemini', 'ollama']).default('openai'),
});

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

export const agentRunResultSchema = z
  .object({
    plan: executionPlanSchema,
    observations: z.array(agentObservationSchema).min(1, 'At least one observation is required.'),
    trace: z.array(reactStepSchema).min(1).optional(),
  })
  .strict();

export const stateSnapshotSchema = z
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

export function validateInfrastructureSpec(value: unknown): InfrastructureSpec {
  return parseWithSchema(infrastructureSpecSchema, value, 'infrastructure spec') as InfrastructureSpec;
}

export function validateExecutionPlan(value: unknown): ExecutionPlan {
  return parseWithSchema(executionPlanSchema, value, 'execution plan') as ExecutionPlan;
}

export function validateAgentRunResult(value: unknown): AgentRunResult {
  return parseWithSchema(agentRunResultSchema, value, 'agent run result') as AgentRunResult;
}

export function validateStateSnapshot(value: unknown): StateSnapshot {
  return parseWithSchema(stateSnapshotSchema, value, 'state snapshot') as StateSnapshot;
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
