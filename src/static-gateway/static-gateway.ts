import type {
  DraftQuery,
  DraftServiceQuery,
  IntentClassification,
  ProgressReporter,
  StaticGatewayMetrics,
  StaticResourceEstimate,
  ValidatedQuery,
} from '../domain/types.js';
import {
  validateDraftQuery,
  validateIntentClassification,
  validateValidatedQuery,
} from '../domain/schemas.js';
import {
  draftQueryJsonSchema,
  intentClassificationJsonSchema,
} from '../domain/structured-output-schemas.js';
import {
  canonicalizeImageBase,
  isSupportedImageReference,
} from '../domain/supported-images.js';
import { parseJsonResponse } from '../llm/json-response.js';
import type { LlmProvider } from '../llm/provider.js';

const INTENT_CLASSIFIER_SYSTEM_PROMPT = [
  'INTENT_CLASSIFIER_V1',
  'Classify the full user request before any infrastructure planning starts.',
  'Do not accept a request only because it contains a create/deploy verb.',
  'Return scope unsafe when the request asks to build or deploy systems for domination, coercion, cyber abuse, malware, exploitation, evasion, surveillance abuse, or other harmful control over people/systems.',
  'Return scope infrastructure only when the actual requested outcome is allowed infrastructure management.',
  'Return only JSON with shape: {"scope":"infrastructure|out-of-scope|unsafe","intent":"create|update|status|destroy|drift|null","reason":"..."}',
].join('\n');

const STRUCTURED_QUERY_PARSER_SYSTEM_PROMPT = [
  'STRUCTURED_QUERY_PARSER_V1',
  'Extract only explicit infrastructure parameters from the user request.',
  'Return only JSON that matches the DraftQuery schema.',
  'Use null for missing fields. Do not validate ports, replicas, images, names, security, or resource limits.',
  'Do not create an execution plan.',
].join('\n');

const DOCKER_RESOURCE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_TOTAL_CONTAINERS = 10;
const MAX_ABSURD_REPLICAS = 100_000;
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
  constructor(
    private readonly auxiliaryProvider: LlmProvider,
    private readonly reportProgress: ProgressReporter = noopProgress,
  ) {}

  async validate(rawPrompt: string): Promise<StaticGatewayResult> {
    const metrics = createMetrics();
    this.reportProgress({
      phase: 'gate',
      message: 'thinking... normalize raw prompt before pre-ReAct validation.',
    });
    const normalizedPrompt = rawPrompt.trim();

    if (!normalizedPrompt) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'gate',
        message: 'observe... prompt is empty, stopping before ReAct.',
      });
      return {
        status: 'rejected',
        reason: 'Static validation failed.',
        issues: ['Prompt must not be empty.'],
        metrics,
      };
    }

    let classification: IntentClassification;

    try {
      classification = await this.classifyIntent(normalizedPrompt);
    } catch (error) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'gate',
        message: 'observe... intent classifier returned invalid output.',
        toolName: 'intent_classifier',
      });
      return {
        status: 'rejected',
        reason: 'Intent classifier output was invalid.',
        issues: [getErrorMessage(error)],
        metrics,
      };
    }

    if (classification.scope === 'unsafe') {
      metrics.unsafeRejected = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... unsafe request rejected: ${classification.reason}`,
        toolName: 'intent_classifier',
      });
      return {
        status: 'rejected',
        reason: classification.reason,
        issues: [classification.reason],
        metrics,
      };
    }

    if (classification.scope === 'out-of-scope' || classification.intent === null) {
      metrics.intentRejected = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... out-of-scope request rejected: ${classification.reason}`,
        toolName: 'intent_classifier',
      });
      return {
        status: 'rejected',
        reason: classification.reason,
        issues: [classification.reason],
        metrics,
      };
    }

    metrics.intentAccepted = 1;
    this.reportProgress({
      phase: 'gate',
      message: `observe... intent accepted as "${classification.intent}".`,
      toolName: 'intent_classifier',
    });

    let draft: DraftQuery;

    try {
      draft = await this.parseDraftQuery(normalizedPrompt, classification);
    } catch (error) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'gate',
        message: 'observe... structured parser returned invalid output.',
        toolName: 'structured_parser',
      });
      return {
        status: 'rejected',
        reason: 'Structured parser output was invalid.',
        issues: [getErrorMessage(error)],
        metrics,
      };
    }

    const normalization = normalizeDraftQueryImageAliases(draft);
    draft = normalization.draft;
    if (normalization.corrections.length) {
      this.reportProgress({
        phase: 'gate',
        message: `observe... normalized image alias(es): ${normalization.corrections.join(', ')}.`,
        toolName: 'structured_parser',
      });
    }

    this.reportProgress({
      phase: 'gate',
      message: `observe... DraftQuery parsed with ${draft.services.length} service hint(s).`,
      toolName: 'structured_parser',
    });
    this.reportProgress({
      phase: 'gate',
      message: 'acting... run deterministic static safety and schema rules.',
      toolName: 'static_validator',
    });

    const outcome = validateStaticRules(draft);
    metrics.securityBlocked = outcome.blockedBySecurity ? 1 : 0;
    metrics.resourceLimitBlocked = outcome.blockedByResourceLimit ? 1 : 0;
    metrics.imageWhitelistBlocked = outcome.blockedByImageWhitelist ? 1 : 0;

    if (outcome.issues.length) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... static validation failed with ${outcome.issues.length} issue(s).`,
        toolName: 'static_validator',
      });
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
      this.reportProgress({
        phase: 'gate',
        message: 'observe... clarification is required before ReAct can start.',
        toolName: 'static_validator',
      });
      return {
        status: 'clarification',
        question: outcome.clarificationQuestion,
        validatedQuery,
        issues: [],
        metrics,
      };
    }

    metrics.schemaValidationPassed = 1;
    this.reportProgress({
      phase: 'gate',
      message: 'observe... ValidatedQuery ready; ReAct Agent may start.',
      toolName: 'static_validator',
    });

    return {
      status: 'validated',
      validatedQuery,
      issues: [],
      metrics,
    };
  }

  private async classifyIntent(prompt: string): Promise<IntentClassification> {
    this.reportProgress({
      phase: 'gate',
      message: 'thinking... send full prompt to provider intent gate.',
      toolName: 'intent_classifier',
    });

    const completion = await this.auxiliaryProvider.completeStructured({
      system: INTENT_CLASSIFIER_SYSTEM_PROMPT,
      user: prompt,
      purpose: 'auxiliary',
      schemaName: 'intent_classification',
      schema: intentClassificationJsonSchema,
    });

    return validateIntentClassification(parseJsonResponse(completion.text));
  }

  private async parseDraftQuery(
    prompt: string,
    classification: IntentClassification,
  ): Promise<DraftQuery> {
    this.reportProgress({
      phase: 'gate',
      message: 'thinking... parse prompt with provider structured parser.',
      toolName: 'structured_parser',
    });

    const completion = await this.auxiliaryProvider.completeStructured({
      system: STRUCTURED_QUERY_PARSER_SYSTEM_PROMPT,
      user: JSON.stringify({
        raw: prompt,
        intent: classification.intent,
      }),
      purpose: 'auxiliary',
      schemaName: 'draft_query',
      schema: draftQueryJsonSchema,
    });

    return validateDraftQuery(parseJsonResponse(completion.text));
  }
}

function normalizeDraftQueryImageAliases(draft: DraftQuery): {
  draft: DraftQuery;
  corrections: string[];
} {
  const corrections: string[] = [];
  const services = draft.services.map((service) => {
    const normalizedImage = normalizeImageReference(service.image);
    const normalizedName = normalizeResourceNameAlias(service.name);

    if (normalizedImage.correction !== null) {
      corrections.push(normalizedImage.correction);
    }

    if (normalizedName.correction !== null) {
      corrections.push(normalizedName.correction);
    }

    return {
      ...service,
      image: normalizedImage.value,
      name: normalizedName.value,
    };
  });

  return {
    draft: {
      ...draft,
      services,
    },
    corrections,
  };
}

function normalizeImageReference(image: string | null): {
  value: string | null;
  correction: string | null;
} {
  if (image === null) {
    return {
      value: null,
      correction: null,
    };
  }

  const parsed = splitImageReference(image);
  const normalizedBase = normalizeImageBase(parsed.base);

  if (normalizedBase === parsed.base) {
    return {
      value: image,
      correction: null,
    };
  }

  return {
    value: `${parsed.prefix}${normalizedBase}${parsed.suffix}`,
    correction: `${parsed.base}->${normalizedBase}`,
  };
}

function normalizeResourceNameAlias(name: string | null): {
  value: string | null;
  correction: string | null;
} {
  if (name === null) {
    return {
      value: null,
      correction: null,
    };
  }

  const normalizedName = normalizeImageBase(name);

  if (normalizedName === name) {
    return {
      value: name,
      correction: null,
    };
  }

  return {
    value: normalizedName,
    correction: `${name}->${normalizedName}`,
  };
}

function splitImageReference(image: string): {
  prefix: string;
  base: string;
  suffix: string;
} {
  const slashIndex = image.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? image.slice(0, slashIndex + 1) : '';
  const baseAndSuffix = slashIndex >= 0 ? image.slice(slashIndex + 1) : image;
  const tagIndex = baseAndSuffix.indexOf(':');

  if (tagIndex < 0) {
    return {
      prefix,
      base: baseAndSuffix.toLowerCase(),
      suffix: '',
    };
  }

  return {
    prefix,
    base: baseAndSuffix.slice(0, tagIndex).toLowerCase(),
    suffix: baseAndSuffix.slice(tagIndex),
  };
}

function normalizeImageBase(base: string): string {
  return canonicalizeImageBase(base).value;
}

function validateStaticRules(draft: DraftQuery): StaticValidationOutcome {
  const issues: string[] = [];
  const riskFlags: string[] = [];
  const securityFindings: string[] = [];
  let blockedBySecurity = false;
  let blockedByResourceLimit = false;
  const blockedByImageWhitelist = false;

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
      markUnresolvedImageReference: (image) => {
        riskFlags.push(`${serviceLabel}.unresolved-image-reference:${image}`);
      },
      markSecurityBlocked: () => {
        blockedBySecurity = true;
      },
      markResourceLimitBlocked: () => {
        blockedByResourceLimit = true;
      },
    });
  }

  const resourceEstimate = estimateResources(draft.services);
  const explicitContainerCount = extractExplicitContainerCount(draft.raw);

  if (resourceEstimate.totalContainers > MAX_TOTAL_CONTAINERS) {
    blockedByResourceLimit = true;
    issues.push(
      `Total requested containers must be <= ${MAX_TOTAL_CONTAINERS}; got ${resourceEstimate.totalContainers}.`,
    );
  }

  if (explicitContainerCount !== null && explicitContainerCount > MAX_TOTAL_CONTAINERS) {
    blockedByResourceLimit = true;
    issues.push(
      `Explicit container count must be <= ${MAX_TOTAL_CONTAINERS}; got ${explicitContainerCount}.`,
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
    markUnresolvedImageReference(image: string): void;
    markSecurityBlocked(): void;
    markResourceLimitBlocked(): void;
  },
): void {
  if (service.name !== null && !DOCKER_RESOURCE_NAME_PATTERN.test(service.name)) {
    issues.push(
      `${serviceLabel}.name must use only letters, numbers, underscores, or hyphens.`,
    );
  }

  if (service.image !== null && !isSupportedImageReference(service.image)) {
    markers.markUnresolvedImageReference(service.image);
  }

  if (service.port !== null && (service.port < 1 || service.port > 65535)) {
    issues.push(`${serviceLabel}.port must be between 1 and 65535.`);
  }

  if (service.replicas !== null && service.replicas < 1) {
    issues.push(`${serviceLabel}.replicas must be >= 1.`);
  }

  if (service.replicas !== null && service.replicas > MAX_TOTAL_CONTAINERS) {
    markers.markResourceLimitBlocked();
    issues.push(`${serviceLabel}.replicas must be <= ${MAX_TOTAL_CONTAINERS}.`);
  }

  if (
    service.replicas !== null &&
    service.image === null &&
    service.replicas > MAX_ABSURD_REPLICAS
  ) {
    issues.push(`${serviceLabel}.replicas is too large to be a valid static request.`);
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

  const deployableServices = services.filter((service) => service.image !== null);

  const cpus = deployableServices
    .map((service) => service.cpu)
    .filter((cpu): cpu is number => cpu !== null);
  const memories = deployableServices
    .map((service) => service.memoryGb)
    .filter((memoryGb): memoryGb is number => memoryGb !== null);

  return {
    totalContainers,
    maxCpu: cpus.length ? Math.max(...cpus) : null,
    maxMemoryGb: memories.length ? Math.max(...memories) : null,
  };
}

function extractExplicitContainerCount(prompt: string): number | null {
  const counts = [...prompt.matchAll(/(-?\d+)\s*(?:c[aá]i\s+)?(?:container|containers)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value));

  return counts.length ? Math.max(...counts) : null;
}

function getClarificationQuestion(draft: DraftQuery): string | null {
  const topology = inferDraftTopology(draft.services);

  if (topology.hasReverseProxy && topology.hasDatabase && !topology.hasBackend) {
    return 'Topology is unclear: you requested a reverse proxy and a database, but no backend app service. Do you want to add a backend service between them, or remove the reverse proxy?';
  }

  if (topology.hasReverseProxy && !topology.hasBackend && draft.services.length > 1) {
    return 'Topology is incomplete: you requested a reverse proxy without a backend app service. Which backend should the proxy route traffic to?';
  }

  return null;
}

function inferDraftTopology(services: DraftServiceQuery[]): {
  hasReverseProxy: boolean;
  hasBackend: boolean;
  hasDatabase: boolean;
} {
  let hasReverseProxy = false;
  let hasBackend = false;
  let hasDatabase = false;

  for (const service of services) {
    if (service.image === null) {
      continue;
    }

    const imageBase = normalizeImageBase(splitImageReference(service.image).base);

    if (isReverseProxyImageBase(imageBase)) {
      hasReverseProxy = true;
      continue;
    }

    if (isDatabaseImageBase(imageBase)) {
      hasDatabase = true;
      continue;
    }

    hasBackend = true;
  }

  return {
    hasReverseProxy,
    hasBackend,
    hasDatabase,
  };
}

function isReverseProxyImageBase(imageBase: string): boolean {
  return ['nginx', 'httpd', 'traefik'].includes(imageBase);
}

function isDatabaseImageBase(imageBase: string): boolean {
  return [
    'postgres',
    'mysql',
    'mariadb',
    'mongo',
    'redis',
    'rabbitmq',
    'elasticsearch',
    'kafka',
  ].includes(imageBase);
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

function noopProgress(): void {
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
