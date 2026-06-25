/* eslint-disable no-irregular-whitespace -- Stub parser keeps legacy mojibake prompt fixtures working. */
import OpenAI from 'openai';
import type {
  DraftQuery,
  DraftServiceQuery,
  InfrastructureIntent,
  IntentClassification,
  JsonSchema,
  LlmPurpose,
  ProviderName,
  ReActReasoningOutput,
} from '../domain/types.js';
import {
  canonicalizeImageBase,
  extractCanonicalImageBases,
} from '../domain/supported-images.js';

export const DEFAULT_OPENAI_AUX_MODEL = 'gpt-5.4-mini';
export const DEFAULT_OPENAI_REACT_MODEL = 'gpt-5.4-mini';
export const DEFAULT_GEMINI_AUX_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GEMINI_REACT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

export interface LlmRequest {
  system: string;
  user: string;
  purpose?: LlmPurpose;
}

export interface StructuredLlmRequest extends LlmRequest {
  schemaName: string;
  schema: JsonSchema;
  purpose: LlmPurpose;
}

export interface LlmResponse {
  text: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  complete(input: LlmRequest): Promise<LlmResponse>;
  completeStructured(input: StructuredLlmRequest): Promise<LlmResponse>;
}

export interface OpenAiProviderConfig {
  apiKey: string;
  auxiliaryModel: string;
  reactModel: string;
  baseURL?: string | undefined;
}

export interface GeminiProviderConfig {
  apiKey: string;
  auxiliaryModel: string;
  reactModel: string;
  baseUrl: string;
}

export interface OpenAiResponseCreateInput {
  model: string;
  instructions: string;
  input: string;
  text?: {
    format: {
      type: 'json_schema';
      name: string;
      schema: JsonSchema;
      strict: true;
    };
  };
}

export interface OpenAiResponsesClient {
  responses: {
    create(input: OpenAiResponseCreateInput): Promise<{ output_text?: string }>;
  };
}

export interface GeminiGenerateContentInput {
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  contents: Array<{
    role: 'user';
    parts: Array<{ text: string }>;
  }>;
  generationConfig?: {
    responseMimeType: 'application/json';
    responseSchema: JsonSchema;
  };
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export interface GeminiGenerateContentClient {
  generateContent(
    model: string,
    input: GeminiGenerateContentInput,
  ): Promise<GeminiGenerateContentResponse>;
}

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export class StubLlmProvider implements LlmProvider {
  constructor(public readonly name: ProviderName = 'stub') {}

  async complete(input: LlmRequest): Promise<LlmResponse> {
    if (input.system.includes('INTENT_CLASSIFIER_V1')) {
      return {
        text: JSON.stringify(classifyIntentForStub(input.user)),
      };
    }

    if (input.system.includes('STRUCTURED_QUERY_PARSER_V1')) {
      return {
        text: JSON.stringify(parseDraftQueryForStub(input.user)),
      };
    }

    return {
      text: [`[stub:${this.name}]`, input.system, input.user].join('\n\n'),
    };
  }

  async completeStructured(input: StructuredLlmRequest): Promise<LlmResponse> {
    if (input.schemaName === 'intent_classification') {
      return {
        text: JSON.stringify(classifyIntentForStub(input.user)),
      };
    }

    if (input.schemaName === 'draft_query') {
      return {
        text: JSON.stringify(parseDraftQueryForStub(input.user)),
      };
    }

    if (input.schemaName === 'react_reasoning_output') {
      return {
        text: JSON.stringify(createReActReasoningForStub()),
      };
    }

    return this.complete(input);
  }
}

export class OpenAiLlmProvider implements LlmProvider {
  readonly name = 'openai';
  private readonly client: OpenAiResponsesClient;

  constructor(
    private readonly config: OpenAiProviderConfig,
    client?: OpenAiResponsesClient,
  ) {
    this.client =
      client ??
      (new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      }) as unknown as OpenAiResponsesClient);
  }

  async complete(input: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.responses.create({
      model: this.getModelForPurpose(input.purpose ?? 'react'),
      instructions: input.system,
      input: input.user,
    });

    return {
      text: getOpenAiOutputText(response),
    };
  }

  async completeStructured(input: StructuredLlmRequest): Promise<LlmResponse> {
    const response = await this.client.responses.create({
      model: this.getModelForPurpose(input.purpose),
      instructions: input.system,
      input: input.user,
      text: {
        format: {
          type: 'json_schema',
          name: input.schemaName,
          schema: input.schema,
          strict: true,
        },
      },
    });

    return {
      text: getOpenAiOutputText(response),
    };
  }

  private getModelForPurpose(purpose: LlmPurpose): string {
    return purpose === 'auxiliary'
      ? this.config.auxiliaryModel
      : this.config.reactModel;
  }
}

export class GeminiLlmProvider implements LlmProvider {
  readonly name = 'gemini';
  private readonly client: GeminiGenerateContentClient;

  constructor(
    private readonly config: GeminiProviderConfig,
    client?: GeminiGenerateContentClient,
  ) {
    this.client = client ?? new GeminiHttpGenerateContentClient(config);
  }

  async complete(input: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.generateContent(
      this.getModelForPurpose(input.purpose ?? 'react'),
      this.createGenerateContentInput(input),
    );

    return {
      text: getGeminiOutputText(response),
    };
  }

  async completeStructured(input: StructuredLlmRequest): Promise<LlmResponse> {
    const response = await this.client.generateContent(
      this.getModelForPurpose(input.purpose),
      this.createGenerateContentInput(input, {
        responseMimeType: 'application/json',
        responseSchema: input.schema,
      }),
    );

    return {
      text: getGeminiOutputText(response),
    };
  }

  private createGenerateContentInput(
    input: LlmRequest,
    generationConfig?: GeminiGenerateContentInput['generationConfig'],
  ): GeminiGenerateContentInput {
    return {
      systemInstruction: {
        parts: [{ text: input.system }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: input.user }],
        },
      ],
      ...(generationConfig ? { generationConfig } : {}),
    };
  }

  private getModelForPurpose(purpose: LlmPurpose): string {
    return purpose === 'auxiliary'
      ? this.config.auxiliaryModel
      : this.config.reactModel;
  }
}

export class FallbackLlmProvider implements LlmProvider {
  readonly name: ProviderName;

  constructor(
    private readonly primary: LlmProvider,
    private readonly fallback: LlmProvider,
  ) {
    this.name = primary.name;
  }

  async complete(input: LlmRequest): Promise<LlmResponse> {
    return this.withFallback(
      () => this.primary.complete(input),
      () => this.fallback.complete(input),
    );
  }

  async completeStructured(input: StructuredLlmRequest): Promise<LlmResponse> {
    return this.withFallback(
      () => this.primary.completeStructured(input),
      () => this.fallback.completeStructured(input),
    );
  }

  private async withFallback(
    callPrimary: () => Promise<LlmResponse>,
    callFallback: () => Promise<LlmResponse>,
  ) {
    try {
      return await callPrimary();
    } catch (primaryError) {
      try {
        return await callFallback();
      } catch (fallbackError) {
        throw new Error(
          [
            `Primary provider "${this.primary.name}" failed and fallback provider "${this.fallback.name}" also failed.`,
            `Primary error: ${getErrorMessage(primaryError)}`,
            `Fallback error: ${getErrorMessage(fallbackError)}`,
          ].join('\n'),
        );
      }
    }
  }
}

export function createProvider(
  name: ProviderName = getDefaultProviderName(),
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider {
  const fallbackName = getFallbackProviderName(env);
  let primary: LlmProvider;

  try {
    primary = createSingleProvider(name, env);
  } catch (error) {
    if (fallbackName !== null && error instanceof ProviderConfigurationError) {
      return createSingleProvider(fallbackName, env);
    }

    throw error;
  }

  if (fallbackName === null || fallbackName === name) {
    return primary;
  }

  return new FallbackLlmProvider(
    primary,
    createSingleProvider(fallbackName, env),
  );
}

function createSingleProvider(
  name: ProviderName,
  env: NodeJS.ProcessEnv,
): LlmProvider {
  switch (name) {
    case 'stub':
      return new StubLlmProvider('stub');
    case 'openai':
      return new OpenAiLlmProvider(createOpenAiConfig(env));
    case 'gemini':
      return new GeminiLlmProvider(createGeminiConfig(env));
  }
}

export function getDefaultProviderName(
  env: NodeJS.ProcessEnv = process.env,
): ProviderName {
  const configuredProvider = env.INFRA_AGENT_PROVIDER;

  if (configuredProvider === undefined || configuredProvider.trim() === '') {
    return 'stub';
  }

  return parseProviderName(configuredProvider);
}

export function createOpenAiConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiProviderConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    throw new ProviderConfigurationError(
      [
        'OpenAI provider selected but OPENAI_API_KEY is not set.',
        'Add OPENAI_API_KEY to your local .env file, e.g.:',
        'OPENAI_API_KEY=your_openai_api_key_here',
        'Alternatively export it in PowerShell with: $env:OPENAI_API_KEY="your_api_key_here"',
      ].join('\n'),
    );
  }

  return {
    apiKey,
    auxiliaryModel: env.OPENAI_AUX_MODEL?.trim() || DEFAULT_OPENAI_AUX_MODEL,
    reactModel: env.OPENAI_REACT_MODEL?.trim() || DEFAULT_OPENAI_REACT_MODEL,
    baseURL: env.OPENAI_BASE_URL?.trim() || undefined,
  };
}

export function createGeminiConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeminiProviderConfig {
  const apiKey = env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim();

  if (!apiKey) {
    throw new ProviderConfigurationError(
      [
        'Gemini provider selected but GEMINI_API_KEY is not set.',
        'Add GEMINI_API_KEY to your local .env file, e.g.:',
        'GEMINI_API_KEY=your_gemini_api_key_here',
        'Alternatively export it in PowerShell with: $env:GEMINI_API_KEY="your_api_key_here"',
      ].join('\n'),
    );
  }

  return {
    apiKey,
    auxiliaryModel: env.GEMINI_AUX_MODEL?.trim() || DEFAULT_GEMINI_AUX_MODEL,
    reactModel: env.GEMINI_REACT_MODEL?.trim() || DEFAULT_GEMINI_REACT_MODEL,
    baseUrl: env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
  };
}

export function getFallbackProviderName(
  env: NodeJS.ProcessEnv = process.env,
): ProviderName | null {
  const configuredProvider = env.INFRA_AGENT_FALLBACK_PROVIDER;

  if (configuredProvider === undefined || configuredProvider.trim() === '') {
    return null;
  }

  return parseProviderName(configuredProvider);
}

function parseProviderName(value: string): ProviderName {
  if (value === 'stub' || value === 'openai' || value === 'gemini') {
    return value;
  }

  throw new ProviderConfigurationError(
    `Unknown provider "${value}". Supported providers: stub, openai, gemini.`,
  );
}

function getOpenAiOutputText(response: { output_text?: string }): string {
  if (
    typeof response.output_text === 'string' &&
    response.output_text.trim() !== ''
  ) {
    return response.output_text;
  }

  throw new Error('OpenAI response did not include output_text.');
}

class GeminiHttpGenerateContentClient implements GeminiGenerateContentClient {
  constructor(private readonly config: GeminiProviderConfig) {}

  async generateContent(
    model: string,
    input: GeminiGenerateContentInput,
  ): Promise<GeminiGenerateContentResponse> {
    const response = await fetch(this.getGenerateContentUrl(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey,
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      throw new Error(
        `Gemini generateContent failed with HTTP ${response.status}: ${truncate(await response.text())}`,
      );
    }

    return (await response.json()) as GeminiGenerateContentResponse;
  }

  private getGenerateContentUrl(model: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`;
  }
}

function getGeminiOutputText(response: GeminiGenerateContentResponse): string {
  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => part.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');

  if (typeof text === 'string' && text.trim() !== '') {
    return text;
  }

  throw new Error('Gemini response did not include text output.');
}

function truncate(value: string, maxLength = 500): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function classifyIntentForStub(prompt: string): IntentClassification {
  const normalizedPrompt = prompt.toLowerCase();

  if (/\b(hack|exploit|malware|facebook)\b/i.test(prompt)) {
    return {
      scope: 'unsafe',
      intent: null,
      reason: 'Request is unsafe or unrelated to infrastructure deployment.',
    };
  }

  if (
    normalizedPrompt.includes('chuyá»‡n cÆ°á»i') ||
    normalizedPrompt.includes('cau chuyen cuoi') ||
    normalizedPrompt.includes('joke')
  ) {
    return {
      scope: 'out-of-scope',
      intent: null,
      reason: 'Request is not an infrastructure management command.',
    };
  }

  const intent = detectIntent(prompt);
  const hasInfrastructureTerm =
    /\b(create|deploy|docker|container|service|infra|web|app|nginx|node|python|postgres|postgresql|mysql|redis|port|replica|status|drift|destroy)\b/i.test(
      prompt,
    ) ||
    /(táº¡o|xÃ³a|xoÃ¡|triá»ƒn khai|trang thÃ¡i|háº¡ táº§ng|á»©ng dá»¥ng)/i.test(
      prompt,
    );

  if (!hasInfrastructureTerm) {
    return {
      scope: 'out-of-scope',
      intent: null,
      reason: 'Request is not an infrastructure management command.',
    };
  }

  return {
    scope: 'infrastructure',
    intent,
    reason: 'Request appears to describe infrastructure management intent.',
  };
}

function parseDraftQueryForStub(rawInput: string): DraftQuery {
  const parsedInput = parseParserInput(rawInput);
  const raw = parsedInput.raw;
  const intent = parsedInput.intent ?? detectIntent(raw);
  const normalizedPrompt = raw.trim();
  const services = extractServices(raw);

  if (
    intent === 'create' &&
    services.length === 0 &&
    /(\bweb\b|\bapp\b|á»©ng dá»¥ng)/i.test(raw)
  ) {
    services.push(createDraftService());
  }

  return {
    raw,
    normalizedPrompt,
    intent,
    services,
    destructive: intent === 'destroy',
    missingInformation: [],
  };
}

function createReActReasoningForStub(): ReActReasoningOutput {
  return {
    summary: 'Stub ReAct reasoning accepted the ValidatedQuery.',
    nextAction: 'continue_planning',
    rationale:
      'Continue with deterministic internal tools for state loading, plan building, validation, and compose preview.',
    safetyNotes: [
      'Do not call Docker, MCP, or side-effecting tools during Phase 4 planning.',
    ],
  };
}

function parseParserInput(rawInput: string): {
  raw: string;
  intent: InfrastructureIntent | null;
} {
  try {
    const parsed = JSON.parse(rawInput) as { raw?: unknown; intent?: unknown };
    return {
      raw: typeof parsed.raw === 'string' ? parsed.raw : rawInput,
      intent: isInfrastructureIntent(parsed.intent) ? parsed.intent : null,
    };
  } catch {
    return {
      raw: rawInput,
      intent: null,
    };
  }
}

function detectIntent(prompt: string): InfrastructureIntent {
  if (/(destroy|delete|remove|xÃ³a|xoÃ¡)/i.test(prompt)) {
    return 'destroy';
  }

  if (/(status|tráº¡ng thÃ¡i)/i.test(prompt)) {
    return 'status';
  }

  if (/drift/i.test(prompt)) {
    return 'drift';
  }

  if (/(update|cáº­p nháº­t)/i.test(prompt)) {
    return 'update';
  }

  return 'create';
}

function extractServices(prompt: string): DraftServiceQuery[] {
  const services: DraftServiceQuery[] = [];
  const normalizedPrompt = prompt.toLowerCase();

  for (const image of extractCanonicalImageBases(prompt)) {
    services.push(
      createDraftService({
        name: image,
        image,
      }),
    );
  }

  const explicitImage = /\bimage\s+([A-Za-z0-9_./:-]+)/i.exec(prompt)?.[1];
  const normalizedExplicitImage =
    explicitImage !== undefined
      ? normalizeExplicitImageReference(explicitImage)
      : null;
  if (
    normalizedExplicitImage !== null &&
    !services.some((service) => service.image === normalizedExplicitImage)
  ) {
    services.push(
      createDraftService({
        name: getImageBaseFromReference(normalizedExplicitImage),
        image: normalizedExplicitImage,
      }),
    );
  }

  const port = extractNumber(
    prompt,
    /\b(?:port|cá»•ng)\s*(?:lÃ |=|:)?\s*(-?\d+)/i,
  );
  if (port !== null) {
    ensureFirstService(services).port = port;
  }

  const replicas =
    extractNumber(prompt, /\bs\S*\s+l\S*ng[^\d-]*(-?\d+)/i) ??
    extractNumber(
      prompt,
      /\b(?:replica|replicas|sá»‘ lÆ°á»£ng|so luong)[^\d-]*(-?\d+)/i,
    ) ??
    extractNumber(prompt, /(-?\d+)\s*(?:instance|instances|replica|replicas)/i);
  if (replicas !== null) {
    const targetService =
      services.find((service) => service.image === 'node') ??
      ensureFirstService(services);
    targetService.replicas = replicas;
  }

  const cpu = extractNumber(prompt, /\b(?:cpu)\s*(?:lÃ |=|:)?\s*(-?\d+)/i);
  const memoryGb = extractNumber(
    prompt,
    /\b(?:ram|memory)\s*(?:lÃ |=|:)?\s*(-?\d+)\s*(?:gb)?/i,
  );
  const requestedMounts = extractRequestedMounts(prompt);
  const privileged = /privileged\s*:?\s*true/i.test(prompt) ? true : null;
  const networkMode = /(host network|network_mode\s*:?\s*host)/i.test(prompt)
    ? 'host'
    : null;
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

  if (normalizedPrompt.includes('web app') && services.length === 0) {
    services.push(createDraftService());
  }

  return services;
}

function createDraftService(
  overrides: Partial<DraftServiceQuery> = {},
): DraftServiceQuery {
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

function normalizeExplicitImageReference(image: string): string {
  const slashIndex = image.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? image.slice(0, slashIndex + 1) : '';
  const baseAndSuffix = slashIndex >= 0 ? image.slice(slashIndex + 1) : image;
  const tagIndex = baseAndSuffix.indexOf(':');
  const base = tagIndex < 0 ? baseAndSuffix : baseAndSuffix.slice(0, tagIndex);
  const suffix = tagIndex < 0 ? '' : baseAndSuffix.slice(tagIndex);
  const canonicalBase = canonicalizeImageBase(base).value;

  return `${prefix}${canonicalBase}${suffix}`;
}

function getImageBaseFromReference(image: string): string {
  return (
    image.split(':')[0]?.split('/').pop()?.toLowerCase() ?? image.toLowerCase()
  );
}

function isInfrastructureIntent(value: unknown): value is InfrastructureIntent {
  return (
    value === 'create' ||
    value === 'update' ||
    value === 'status' ||
    value === 'destroy' ||
    value === 'drift'
  );
}
