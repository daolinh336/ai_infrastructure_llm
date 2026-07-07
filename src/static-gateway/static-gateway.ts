import type {
  DraftQuery,
  DraftServiceQuery,
  IntentClassification,
  ProgressReporter,
  StaticGatewayMetrics,
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
import { parseJsonResponse } from '../llm/json-response.js';
import type { LlmProvider } from '../llm/provider.js';

const INTENT_CLASSIFIER_SYSTEM_PROMPT = [
  'INTENT_CLASSIFIER_V1',
  'Decide whether the full user request is a create-infrastructure request before any infrastructure planning starts.',
  'Return accepted=true only when the request asks to create new infrastructure, services, containers, databases, networks, or app stacks.',
  'Return accepted=false for every non-create request, including update, status, destroy, delete, remove, drift, deploy-only, repair, general knowledge, or out-of-domain requests.',
  'When accepted=true, intent must be create. When accepted=false, intent must be null.',
  'Return only JSON with shape: {"accepted":true|false,"intent":"create|null","reason":"..."}',
].join('\n');

const STRUCTURED_QUERY_PARSER_SYSTEM_PROMPT = [
  'STRUCTURED_QUERY_PARSER_V1',
  'Extract only explicit infrastructure parameters from an already accepted create request.',
  'Return only JSON that matches the DraftQuery schema.',
  'Use null for missing fields. Do not validate ports, replicas, images, names, security, resource limits, or topology.',
  'Do not create an execution plan.',
].join('\n');

export type StaticGatewayResult =
  | {
      status: 'validated';
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

export class StaticGateway {
  constructor(
    private readonly auxiliaryProvider: LlmProvider,
    private readonly reportProgress: ProgressReporter = noopProgress,
  ) {}

  async validate(rawPrompt: string): Promise<StaticGatewayResult> {
    const metrics = createMetrics();
    this.reportProgress({
      phase: 'gate',
      message: 'thinking... normalize raw prompt before create-intent gate.',
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

    if (!classification.accepted) {
      metrics.intentRejected = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... request rejected by create-intent gate: ${classification.reason}`,
        toolName: 'intent_classifier',
      });
      return {
        status: 'rejected',
        reason: classification.reason,
        issues: [classification.reason],
        metrics,
      };
    }

    const explicitNonCreateIntent = detectExplicitNonCreateIntent(normalizedPrompt);
    if (explicitNonCreateIntent !== null) {
      const issue = `Only create intent is currently accepted by static validation; detected ${explicitNonCreateIntent} intent.`;
      metrics.intentRejected = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... request rejected by deterministic create-intent gate: ${issue}`,
        toolName: 'intent_classifier',
      });
      return {
        status: 'rejected',
        reason: issue,
        issues: [issue],
        metrics,
      };
    }

    if (classification.intent !== 'create') {
      const issue = classification.intent === null
        ? 'Only create intent is currently accepted by static validation.'
        : `Only create intent is currently accepted by static validation; got "${classification.intent}".`;
      metrics.intentRejected = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... request rejected by create-intent gate: ${issue}`,
        toolName: 'intent_classifier',
      });
      return {
        status: 'rejected',
        reason: issue,
        issues: [issue],
        metrics,
      };
    }

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

    if (draft.intent !== 'create') {
      const issue = `Only create intent is currently accepted by static validation; got "${draft.intent}".`;
      metrics.intentRejected = 1;
      this.reportProgress({
        phase: 'gate',
        message: `observe... request rejected by create-intent draft gate: ${issue}`,
        toolName: 'structured_parser',
      });
      return {
        status: 'rejected',
        reason: issue,
        issues: [issue],
        metrics,
      };
    }

    const validatedQuery = validateValidatedQuery({
      raw: draft.raw,
      normalizedPrompt: draft.normalizedPrompt,
      intent: 'create',
      draft,
      riskFlags: [],
      securityFindings: [],
      resourceEstimate: estimateResources(draft.services),
      clarificationRequired: false,
      clarificationQuestion: null,
    });

    metrics.intentAccepted = 1;
    metrics.schemaValidationPassed = 1;
    this.reportProgress({
      phase: 'gate',
      message: 'observe... create intent accepted; ReAct Agent may start.',
      toolName: 'intent_classifier',
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
      message: 'thinking... send full prompt to provider create-intent gate.',
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
      message: 'thinking... parse accepted create request for ReAct input.',
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

    return validateDraftQuery(
      normalizeDraftQueryCandidate(
        parseJsonResponse(completion.text),
        prompt,
        classification,
      ),
    );
  }
}

function normalizeDraftQueryCandidate(
  value: unknown,
  prompt: string,
  classification: IntentClassification,
): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const servicesCandidate = Array.isArray(value.services)
    ? value.services
    : Array.isArray(value.components)
      ? value.components
      : null;

  if (servicesCandidate === null) {
    return value;
  }

  return {
    raw: typeof value.raw === 'string' ? value.raw : prompt,
    normalizedPrompt:
      typeof value.normalizedPrompt === 'string' ? value.normalizedPrompt : prompt,
    intent:
      isStaticIntent(value.intent) || value.intent === null
        ? value.intent
        : classification.intent,
    projectName: getNullableString(value.projectName),
    services: servicesCandidate.map((service) => normalizeDraftServiceCandidate(service)),
    destructive:
      typeof value.destructive === 'boolean' ? value.destructive : false,
    missingInformation: Array.isArray(value.missingInformation)
      ? value.missingInformation.filter(
          (item): item is string => typeof item === 'string' && item.trim() !== '',
        )
      : [],
  };
}

function normalizeDraftServiceCandidate(value: unknown): DraftServiceQuery {
  const record = isRecord(value) ? value : {};

  return {
    name: getNullableString(record.name ?? record.role),
    image: getNullableString(record.image ?? record.technology),
    port: getNullableInteger(record.port ?? getFirstPortCandidate(record.ports)),
    replicas: getNullableInteger(record.replicas),
    dependsOn: getStringArray(record.dependsOn),
    requestedMounts: getStringArray(record.requestedMounts),
    privileged: getNullableBoolean(record.privileged),
    networkMode: getNullableString(record.networkMode),
    pidMode: getNullableString(record.pidMode),
    ipcMode: getNullableString(record.ipcMode),
    cpu: getNullableNumber(record.cpu),
    memoryGb: getNullableNumber(record.memoryGb),
  };
}

function estimateResources(services: DraftServiceQuery[]): {
  totalContainers: number;
  maxCpu: number | null;
  maxMemoryGb: number | null;
} {
  const totalContainers = services.reduce((total, service) => total + (service.replicas ?? 1), 0);
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

function getFirstPortCandidate(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.find((item) => typeof item === 'number' || typeof item === 'string') ?? null;
}

function getNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function getNullableInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

function getNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStaticIntent(value: unknown): value is IntentClassification['intent'] {
  return (
    value === 'create' ||
    value === 'update' ||
    value === 'status' ||
    value === 'destroy' ||
    value === 'drift'
  );
}

function detectExplicitNonCreateIntent(prompt: string): string | null {
  if (/^\s*(?:please\s+)?(?:delete|destroy|remove)\b|^\s*(?:vui long\s+)?(?:x[oó]a|xoá|xóa)\b/i.test(prompt)) {
    return 'destroy';
  }

  if (/^\s*(?:please\s+)?(?:update|change|modify|edit|adjust|scale|resize)\b|^\s*(?:vui long\s+)?(?:cap nhat|cập nhật|doi|đổi|sua|sửa)\b/i.test(prompt)) {
    return 'update';
  }

  if (/^\s*(?:please\s+)?(?:status|inspect|show|list)\b|^\s*(?:xem\s+)?(?:trang thai|trạng thái)\b/i.test(prompt)) {
    return 'status';
  }

  if (/^\s*(?:please\s+)?(?:check\s+)?drift\b/i.test(prompt)) {
    return 'drift';
  }

  if (/^\s*(?:please\s+)?(?:repair|sync|rollback)\b/i.test(prompt)) {
    return 'repair';
  }

  return null;
}

function createMetrics(): StaticGatewayMetrics {
  return {
    intentAccepted: 0,
    intentRejected: 0,
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
