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
  extractCanonicalImageBases,
  isSupportedImageReference,
  textMentionsSupportedImage,
} from '../domain/supported-images.js';
import { parseJsonResponse } from '../llm/json-response.js';
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
      phase: 'static',
      message: 'thinking... normalize raw prompt before pre-ReAct validation.',
    });
    const normalizedPrompt = rawPrompt.trim();

    if (!normalizedPrompt) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'static',
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
      classification = await this.classifyIntentWithFastPath(normalizedPrompt);
    } catch (error) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'static',
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
        phase: 'static',
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
        phase: 'static',
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
      phase: 'static',
      message: `observe... intent accepted as "${classification.intent}".`,
      toolName: 'intent_classifier',
    });

    let draft: DraftQuery;

    try {
      draft = await this.parseDraftQueryWithFastPath(normalizedPrompt, classification);
    } catch (error) {
      metrics.schemaValidationFailed = 1;
      this.reportProgress({
        phase: 'static',
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
        phase: 'static',
        message: `observe... normalized image alias(es): ${normalization.corrections.join(', ')}.`,
        toolName: 'structured_parser',
      });
    }

    this.reportProgress({
      phase: 'static',
      message: `observe... DraftQuery parsed with ${draft.services.length} service hint(s).`,
      toolName: 'structured_parser',
    });
    this.reportProgress({
      phase: 'static',
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
        phase: 'static',
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
        phase: 'static',
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
      phase: 'static',
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
    const completion = await this.auxiliaryProvider.completeStructured({
      system: INTENT_CLASSIFIER_SYSTEM_PROMPT,
      user: prompt,
      purpose: 'auxiliary',
      schemaName: 'intent_classification',
      schema: intentClassificationJsonSchema,
    });

    return validateIntentClassification(parseJsonResponse(completion.text));
  }

  private async classifyIntentWithFastPath(prompt: string): Promise<IntentClassification> {
    this.reportProgress({
      phase: 'static',
      message: 'thinking... try deterministic intent classifier fast path.',
      toolName: 'intent_classifier',
    });

    const fastClassification = classifyIntentFastPath(prompt);
    if (fastClassification !== null) {
      this.reportProgress({
        phase: 'static',
        message: 'observe... intent classified locally; auxiliary LLM not needed.',
        toolName: 'intent_classifier',
      });
      return validateIntentClassification(fastClassification);
    }

    this.reportProgress({
      phase: 'static',
      message: 'thinking... local classifier was uncertain; classify intent with auxiliary LLM.',
      toolName: 'intent_classifier',
    });
    return this.classifyIntent(prompt);
  }

  private async parseDraftQuery(
    prompt: string,
    classification: IntentClassification,
  ): Promise<DraftQuery> {
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

  private async parseDraftQueryWithFastPath(
    prompt: string,
    classification: IntentClassification,
  ): Promise<DraftQuery> {
    this.reportProgress({
      phase: 'static',
      message: 'thinking... try deterministic DraftQuery parser fast path.',
      toolName: 'structured_parser',
    });

    const fastDraft = parseDraftQueryFastPath(prompt, classification);
    if (fastDraft !== null) {
      this.reportProgress({
        phase: 'static',
        message: 'observe... DraftQuery parsed locally; auxiliary LLM not needed.',
        toolName: 'structured_parser',
      });
      return validateDraftQuery(fastDraft);
    }

    this.reportProgress({
      phase: 'static',
      message: 'thinking... local parser was uncertain; parse prompt with auxiliary LLM.',
      toolName: 'structured_parser',
    });
    return this.parseDraftQuery(prompt, classification);
  }
}

function classifyIntentFastPath(prompt: string): IntentClassification | null {
  if (isUnsafePrompt(prompt)) {
    return {
      scope: 'unsafe',
      intent: null,
      reason: 'Request is unsafe or unrelated to infrastructure deployment.',
    };
  }

  if (isClearlyOutOfScopePrompt(prompt)) {
    return {
      scope: 'out-of-scope',
      intent: null,
      reason: 'Request is not an infrastructure management command.',
    };
  }

  if (!hasInfrastructureSignal(prompt)) {
    return null;
  }

  return {
    scope: 'infrastructure',
    intent: detectIntentFastPath(prompt),
    reason: 'Request matched deterministic infrastructure intent rules.',
  };
}

function parseDraftQueryFastPath(
  prompt: string,
  classification: IntentClassification,
): DraftQuery | null {
  if (classification.scope !== 'infrastructure' || classification.intent === null) {
    return null;
  }

  const services = extractDraftServicesFastPath(prompt);

  if (classification.intent === 'create' && !services.length && !hasGenericDeployTarget(prompt)) {
    return null;
  }

  return {
    raw: prompt,
    normalizedPrompt: prompt.trim(),
    intent: classification.intent,
    services,
    destructive: classification.intent === 'destroy',
    missingInformation: [],
  };
}

function isUnsafePrompt(prompt: string): boolean {
  return /\b(hack|exploit|malware|facebook)\b/i.test(prompt);
}

function isClearlyOutOfScopePrompt(prompt: string): boolean {
  return /\b(joke|story|cau chuyen cuoi|chuyen cuoi)\b/i.test(prompt);
}

function hasInfrastructureSignal(prompt: string): boolean {
  return (
    /\b(create|deploy|docker|container|containers|image|images|service|infra|web|app|port|replica|replicas|status|drift|destroy)\b/i.test(
      prompt,
    ) ||
    /\b(tao|xoa|tri?n khai|trang thai|ha tang|ung dung)\b/i.test(prompt) ||
    textMentionsSupportedImage(prompt)
  );
}

function detectIntentFastPath(prompt: string): IntentClassification['intent'] {
  if (/(destroy|delete|remove|xoa)/i.test(prompt)) {
    return 'destroy';
  }

  if (/(status|trang thai)/i.test(prompt)) {
    return 'status';
  }

  if (/drift/i.test(prompt)) {
    return 'drift';
  }

  if (/(update|cap nhat)/i.test(prompt)) {
    return 'update';
  }

  return 'create';
}

function extractDraftServicesFastPath(prompt: string): DraftServiceQuery[] {
  const services: DraftServiceQuery[] = [];

  for (const image of extractCanonicalImageBases(prompt)) {
    services.push(
      createDraftService({
        name: image,
        image,
      }),
    );
  }

  const explicitImage = /\bimage\s+([A-Za-z0-9_./:-]+)/i.exec(prompt)?.[1];
  const normalizedExplicitImage = normalizeImageReference(explicitImage ?? null).value;
  if (
    explicitImage &&
    normalizedExplicitImage !== null &&
    !services.some((service) => service.image === normalizedExplicitImage)
  ) {
    services.push(
      createDraftService({
        name: splitImageReference(normalizedExplicitImage).base,
        image: normalizedExplicitImage,
      }),
    );
  }

  if (!services.length && hasGenericDeployTarget(prompt)) {
    services.push(createDraftService());
  }

  const port = extractNumber(prompt, /\b(?:port|cong)\s*(?:la|=|:)?\s*(-?\d+)/i);
  if (port !== null) {
    ensureFirstService(services).port = port;
  }

  const replicas =
    extractNumber(prompt, /\b(?:replica|replicas|so luong)[^\d-]*(-?\d+)/i) ??
    extractNumber(
      prompt,
      /(-?\d+)\s*(?:cai\s+)?(?:container|containers|instance|instances|replica|replicas)\b/i,
    );
  if (replicas !== null) {
    const targetService =
      services.find((service) => service.image === 'node') ?? ensureFirstService(services);
    targetService.replicas = replicas;
  }

  const cpu = extractNumber(prompt, /\bcpu\s*(?:la|=|:)?\s*(-?\d+)/i);
  const memoryGb = extractNumber(
    prompt,
    /\b(?:ram|memory)\s*(?:la|=|:)?\s*(-?\d+)\s*(?:gb)?/i,
  );
  const requestedMounts = extractRequestedMounts(prompt);
  const privileged = /privileged\s*:?\s*true/i.test(prompt) ? true : null;
  const networkMode = /(host network|network_mode\s*:?\s*host)/i.test(prompt) ? 'host' : null;
  const pidMode = /pid\s*:?\s*host/i.test(prompt) ? 'host' : null;
  const ipcMode = /ipc\s*:?\s*host/i.test(prompt) ? 'host' : null;

  if (
    requestedMounts.length ||
    privileged !== null ||
    networkMode !== null ||
    pidMode !== null ||
    ipcMode !== null ||
    cpu !== null ||
    memoryGb !== null
  ) {
    const service = ensureFirstService(services);
    service.requestedMounts = requestedMounts;
    service.privileged = privileged;
    service.networkMode = networkMode;
    service.pidMode = pidMode;
    service.ipcMode = ipcMode;
    service.cpu = cpu;
    service.memoryGb = memoryGb;
  }

  return services;
}

function hasGenericDeployTarget(prompt: string): boolean {
  return /\b(web|app|service|container|containers|image|images|ung dung)\b/i.test(prompt);
}

function createDraftService(overrides: Partial<DraftServiceQuery> = {}): DraftServiceQuery {
  return {
    name: null,
    image: null,
    port: null,
    replicas: null,
    requestedMounts: [],
    privileged: null,
    networkMode: null,
    pidMode: null,
    ipcMode: null,
    cpu: null,
    memoryGb: null,
    ...overrides,
  };
}

function ensureFirstService(services: DraftServiceQuery[]): DraftServiceQuery {
  const firstService = services[0];

  if (firstService) {
    return firstService;
  }

  const service = createDraftService();
  services.push(service);
  return service;
}

function extractNumber(prompt: string, pattern: RegExp): number | null {
  const value = pattern.exec(prompt)?.[1];

  if (value === undefined) {
    return null;
  }

  return Number(value);
}

function extractRequestedMounts(prompt: string): string[] {
  const mounts = new Set<string>();
  const mountMatch = /\bmount\s+(\S+)/i.exec(prompt)?.[1];

  if (mountMatch) {
    mounts.add(mountMatch);
  }

  if (prompt.includes('/var/run/docker.sock')) {
    mounts.add('/var/run/docker.sock:/var/run/docker.sock');
  }

  if (/\bmount\s+\/etc\b/i.test(prompt)) {
    mounts.add('/etc:/etc');
  }

  if (/\bmount\s+\/(?:\s|$|:)/i.test(prompt)) {
    mounts.add('/:root');
  }

  return [...mounts];
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

  if (
    service.replicas !== null &&
    service.image !== null &&
    service.replicas > MAX_TOTAL_CONTAINERS
  ) {
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
  const deployableServices = services.filter((service) => service.image !== null);
  const totalContainers = deployableServices.reduce((total, service) => {
    if (service.replicas === null) {
      return total + 1;
    }

    return total + Math.max(service.replicas, 0);
  }, 0);

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

function getClarificationQuestion(draft: DraftQuery): string | null {
  void draft;
  return null;
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
