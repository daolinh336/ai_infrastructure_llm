import type {
  DraftQuery,
  DraftServiceQuery,
  IntentClassification,
  StaticGatewayMetrics,
  StaticResourceEstimate,
  ValidatedQuery,
} from '../domain/types.js';
import {
  DomainValidationError,
  validateDraftQuery,
  validateIntentClassification,
  validateValidatedQuery,
} from '../domain/schemas.js';
import type { LlmProvider } from '../llm/provider.js';

const INTENT_CLASSIFIER_SYSTEM_PROMPT = [
  'INTENT_CLASSIFIER_V1',
  'Classify whether the user request is an infrastructure management command.',
  'Return only JSON with shape: {"scope":"infrastructure|out-of-scope|unsafe","intent":"create|update|status|destroy|drift|null","reason":"..."}',
].join('\n');

const STRUCTURED_QUERY_PARSER_SYSTEM_PROMPT = [
  'STRUCTURED_QUERY_PARSER_V1',
  'Extract only explicit infrastructure parameters from the user request.',
  'Return only JSON that matches the DraftQuery schema.',
  'Use null for missing fields. Do not validate ports, replicas, images, names, security, or resource limits.',
  'Do not create an execution plan.',
].join('\n');

const ALLOWED_IMAGE_BASES = new Set(['nginx', 'node', 'python', 'postgres', 'mysql', 'redis']);
const DOCKER_RESOURCE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TOTAL_CONTAINERS = 10;
const MAX_CPU = 4;
const MAX_MEMORY_GB = 8;

export type StaticGatewayResult =
  | {
      status: 'validated';
      validatedQuery: ValidatedQuery;
      issues: string[];
      metrics: StaticGatewayMetrics;
    }
  | {
      status: 'clarification';
      question: string;
      validatedQuery: ValidatedQuery;
      issues: string[];
      metrics: StaticGatewayMetrics;
    }
  | {
      status: 'rejected';
      reason: string;
      issues: string[];
      metrics: StaticGatewayMetrics;
    };

interface StaticValidationOutcome {
  issues: string[];
  riskFlags: string[];
  securityFindings: string[];
  resourceEstimate: StaticResourceEstimate;
  clarificationQuestion: string | null;
  blockedBySecurity: boolean;
  blockedByResourceLimit: boolean;
  blockedByImageWhitelist: boolean;
}

export class StaticGateway {
  constructor(private readonly auxiliaryProvider: LlmProvider) {}

  async validate(rawPrompt: string): Promise<StaticGatewayResult> {
    const metrics = createMetrics();
    const normalizedPrompt = rawPrompt.trim();

    if (!normalizedPrompt) {
      metrics.schemaValidationFailed = 1;
      return {
        status: 'rejected',
        reason: 'Static validation failed.',
        issues: ['Prompt must not be empty.'],
        metrics,
      };
    }

    const classification = await this.classifyIntent(normalizedPrompt);

    if (classification.scope === 'unsafe') {
      metrics.unsafeRejected = 1;
      return {
        status: 'rejected',
        reason: classification.reason,
        issues: [classification.reason],
        metrics,
      };
    }

    if (classification.scope === 'out-of-scope' || classification.intent === null) {
      metrics.intentRejected = 1;
      return {
        status: 'rejected',
        reason: classification.reason,
        issues: [classification.reason],
        metrics,
      };
    }

    metrics.intentAccepted = 1;

    let draft: DraftQuery;

    try {
      draft = await this.parseDraftQuery(normalizedPrompt, classification);
    } catch (error) {
      metrics.schemaValidationFailed = 1;
      return {
        status: 'rejected',
        reason: 'Structured parser output was invalid.',
        issues: [getErrorMessage(error)],
        metrics,
      };
    }

    const outcome = validateStaticRules(draft);
    metrics.securityBlocked = outcome.blockedBySecurity ? 1 : 0;
    metrics.resourceLimitBlocked = outcome.blockedByResourceLimit ? 1 : 0;
    metrics.imageWhitelistBlocked = outcome.blockedByImageWhitelist ? 1 : 0;

    if (outcome.issues.length) {
      metrics.schemaValidationFailed = 1;
      return {
        status: 'rejected',
        reason: 'Static validation failed.',
        issues: outcome.issues,
        metrics,
      };
    }

    const validatedQuery = validateValidatedQuery({
      raw: draft.raw,
      normalizedPrompt: draft.normalizedPrompt,
      intent: draft.intent,
      draft,
      riskFlags: outcome.riskFlags,
      securityFindings: outcome.securityFindings,
      resourceEstimate: outcome.resourceEstimate,
      clarificationRequired: outcome.clarificationQuestion !== null,
      clarificationQuestion: outcome.clarificationQuestion,
    });

    if (outcome.clarificationQuestion !== null) {
      metrics.clarificationRequired = 1;
      return {
        status: 'clarification',
        question: outcome.clarificationQuestion,
        validatedQuery,
        issues: [],
        metrics,
      };
    }

    metrics.schemaValidationPassed = 1;

    return {
      status: 'validated',
      validatedQuery,
      issues: [],
      metrics,
    };
  }

  private async classifyIntent(prompt: string): Promise<IntentClassification> {
    const completion = await this.auxiliaryProvider.complete({
      system: INTENT_CLASSIFIER_SYSTEM_PROMPT,
      user: prompt,
    });

    return validateIntentClassification(parseJsonResponse(completion.text));
  }

  private async parseDraftQuery(
    prompt: string,
    classification: IntentClassification,
  ): Promise<DraftQuery> {
    const completion = await this.auxiliaryProvider.complete({
      system: STRUCTURED_QUERY_PARSER_SYSTEM_PROMPT,
      user: JSON.stringify({
        raw: prompt,
        intent: classification.intent,
      }),
    });

    return validateDraftQuery(parseJsonResponse(completion.text));
  }
}

function validateStaticRules(draft: DraftQuery): StaticValidationOutcome {
  const issues: string[] = [];
  const riskFlags: string[] = [];
  const securityFindings: string[] = [];
  let blockedBySecurity = false;
  let blockedByResourceLimit = false;
  let blockedByImageWhitelist = false;

  if (draft.destructive || draft.intent === 'destroy') {
    riskFlags.push('destructive-intent');
  }

  const rawPrompt = draft.raw.toLowerCase();
  const rawSecurityFindings = findDangerousPromptFragments(rawPrompt);
  if (rawSecurityFindings.length) {
    blockedBySecurity = true;
    securityFindings.push(...rawSecurityFindings);
    issues.push(...rawSecurityFindings);
  }

  for (const [index, service] of draft.services.entries()) {
    const serviceLabel = `services.${index}`;

    validateStaticService(service, serviceLabel, issues, securityFindings, {
      markSecurityBlocked: () => {
        blockedBySecurity = true;
      },
      markImageWhitelistBlocked: () => {
        blockedByImageWhitelist = true;
      },
      markResourceLimitBlocked: () => {
        blockedByResourceLimit = true;
      },
    });
  }

  const resourceEstimate = estimateResources(draft.services);

  if (resourceEstimate.totalContainers > MAX_TOTAL_CONTAINERS) {
    blockedByResourceLimit = true;
    issues.push(
      `Total requested containers must be <= ${MAX_TOTAL_CONTAINERS}; got ${resourceEstimate.totalContainers}.`,
    );
  }

  const clarificationQuestion = getClarificationQuestion(draft);

  return {
    issues,
    riskFlags,
    securityFindings,
    resourceEstimate,
    clarificationQuestion,
    blockedBySecurity,
    blockedByResourceLimit,
    blockedByImageWhitelist,
  };
}

function validateStaticService(
  service: DraftServiceQuery,
  serviceLabel: string,
  issues: string[],
  securityFindings: string[],
  markers: {
    markSecurityBlocked(): void;
    markImageWhitelistBlocked(): void;
    markResourceLimitBlocked(): void;
  },
): void {
  if (service.name !== null && !DOCKER_RESOURCE_NAME_PATTERN.test(service.name)) {
    issues.push(
      `${serviceLabel}.name must use only letters, numbers, underscores, or hyphens.`,
    );
  }

  if (service.image !== null && !isAllowedImage(service.image)) {
    markers.markImageWhitelistBlocked();
    issues.push(
      `${serviceLabel}.image "${service.image}" is not allowed. Supported images: ${[
        ...ALLOWED_IMAGE_BASES,
      ].join(', ')}.`,
    );
  }

  if (service.port !== null && (service.port < 1 || service.port > 65535)) {
    issues.push(`${serviceLabel}.port must be between 1 and 65535.`);
  }

  if (
    service.replicas !== null &&
    (service.replicas < 1 || service.replicas > MAX_TOTAL_CONTAINERS)
  ) {
    issues.push(`${serviceLabel}.replicas must be between 1 and ${MAX_TOTAL_CONTAINERS}.`);
  }

  for (const mount of service.requestedMounts) {
    const finding = getDangerousMountFinding(mount);
    if (finding !== null) {
      markers.markSecurityBlocked();
      securityFindings.push(finding);
      issues.push(finding);
    }
  }

  if (service.privileged === true) {
    markers.markSecurityBlocked();
    const finding = `${serviceLabel}.privileged is blocked by static security policy.`;
    securityFindings.push(finding);
    issues.push(finding);
  }

  for (const [field, value] of [
    ['networkMode', service.networkMode],
    ['pidMode', service.pidMode],
    ['ipcMode', service.ipcMode],
  ] as const) {
    if (value?.toLowerCase() === 'host') {
      markers.markSecurityBlocked();
      const finding = `${serviceLabel}.${field}=host is blocked by static security policy.`;
      securityFindings.push(finding);
      issues.push(finding);
    }
  }

  if (service.cpu !== null && service.cpu > MAX_CPU) {
    markers.markResourceLimitBlocked();
    issues.push(`${serviceLabel}.cpu must be <= ${MAX_CPU}.`);
  }

  if (service.memoryGb !== null && service.memoryGb > MAX_MEMORY_GB) {
    markers.markResourceLimitBlocked();
    issues.push(`${serviceLabel}.memoryGb must be <= ${MAX_MEMORY_GB}.`);
  }
}

function estimateResources(services: DraftServiceQuery[]): StaticResourceEstimate {
  const totalContainers = services.reduce((total, service) => {
    if (service.replicas === null) {
      return total + 1;
    }

    return total + Math.max(service.replicas, 0);
  }, 0);

  const cpus = services
    .map((service) => service.cpu)
    .filter((cpu): cpu is number => cpu !== null);
  const memories = services
    .map((service) => service.memoryGb)
    .filter((memoryGb): memoryGb is number => memoryGb !== null);

  return {
    totalContainers,
    maxCpu: cpus.length ? Math.max(...cpus) : null,
    maxMemoryGb: memories.length ? Math.max(...memories) : null,
  };
}

function getClarificationQuestion(draft: DraftQuery): string | null {
  if (draft.intent !== 'create') {
    return null;
  }

  if (!draft.services.length || draft.services.every((service) => service.image === null)) {
    return 'Bạn muốn dùng image/runtime nào? Hiện hỗ trợ: nginx, node, python, postgres, mysql, redis.';
  }

  return null;
}

function isAllowedImage(image: string): boolean {
  const imageBase = image.split(':')[0]?.split('/').pop()?.toLowerCase();
  return imageBase !== undefined && ALLOWED_IMAGE_BASES.has(imageBase);
}

function findDangerousPromptFragments(rawPrompt: string): string[] {
  const findings: string[] = [];

  for (const dangerousFragment of [
    '/var/run/docker.sock',
    'mount /etc',
    'mount / ',
    'mount /:',
    'privileged: true',
    'privileged true',
  ]) {
    if (rawPrompt.includes(dangerousFragment)) {
      findings.push(`Dangerous request blocked: ${dangerousFragment}.`);
    }
  }

  return findings;
}

function getDangerousMountFinding(mount: string): string | null {
  const source = mount.split(':')[0]?.toLowerCase();

  if (!source) {
    return null;
  }

  if (source === '/var/run/docker.sock' || source === '/etc' || source === '/') {
    return `Dangerous mount source blocked: ${source}.`;
  }

  return null;
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(withoutFence);
  } catch (error) {
    throw new DomainValidationError('structured LLM JSON', [
      `Response was not valid JSON: ${getErrorMessage(error)}`,
    ]);
  }
}

function createMetrics(): StaticGatewayMetrics {
  return {
    intentAccepted: 0,
    intentRejected: 0,
    unsafeRejected: 0,
    clarificationRequired: 0,
    schemaValidationPassed: 0,
    schemaValidationFailed: 0,
    securityBlocked: 0,
    resourceLimitBlocked: 0,
    imageWhitelistBlocked: 0,
    runtimeCallsDuringStaticValidation: 0,
    reactInvocationsAfterStaticValidationFailure: 0,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
