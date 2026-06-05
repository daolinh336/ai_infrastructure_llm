import type {
  DraftQuery,
  DraftServiceQuery,
  InfrastructureIntent,
  IntentClassification,
  ProviderName,
} from '../domain/types.js';

export interface LlmRequest {
  system: string;
  user: string;
}

export interface LlmResponse {
  text: string;
}

export interface LlmProvider {
  readonly name: ProviderName;
  complete(input: LlmRequest): Promise<LlmResponse>;
}

export class StubLlmProvider implements LlmProvider {
  constructor(public readonly name: ProviderName) {}

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
      text: [
        `[stub:${this.name}]`,
        input.system,
        input.user,
      ].join('\n\n'),
    };
  }
}

export function createProvider(name: ProviderName): LlmProvider {
  return new StubLlmProvider(name);
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
    normalizedPrompt.includes('chuyện cười') ||
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
    ) || /(tạo|xóa|xoá|triển khai|trang thái|hạ tầng|ứng dụng)/i.test(prompt);

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

  if (intent === 'create' && services.length === 0 && /(\bweb\b|\bapp\b|ứng dụng)/i.test(raw)) {
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
  if (/(destroy|delete|remove|xóa|xoá)/i.test(prompt)) {
    return 'destroy';
  }

  if (/(status|trạng thái)/i.test(prompt)) {
    return 'status';
  }

  if (/drift/i.test(prompt)) {
    return 'drift';
  }

  if (/(update|cập nhật)/i.test(prompt)) {
    return 'update';
  }

  return 'create';
}

function extractServices(prompt: string): DraftServiceQuery[] {
  const services: DraftServiceQuery[] = [];
  const normalizedPrompt = prompt.toLowerCase();
  const serviceImages: Array<[RegExp, string, string]> = [
    [/\bnginx\b/i, 'nginx', 'nginx'],
    [/\bnode(?:\.js|js)?\b/i, 'node', 'node'],
    [/\bpython\b/i, 'python', 'python'],
    [/\bpostgres(?:ql)?\b/i, 'postgres', 'postgres'],
    [/\bmysql\b/i, 'mysql', 'mysql'],
    [/\bredis\b/i, 'redis', 'redis'],
  ];

  for (const [pattern, name, image] of serviceImages) {
    if (pattern.test(prompt)) {
      services.push(
        createDraftService({
          name,
          image,
        }),
      );
    }
  }

  const explicitImage = /\bimage\s+([A-Za-z0-9_./:-]+)/i.exec(prompt)?.[1];
  if (explicitImage && !services.some((service) => service.image === explicitImage)) {
    services.push(
      createDraftService({
        name: explicitImage.split(':')[0] ?? explicitImage,
        image: explicitImage,
      }),
    );
  }

  const port = extractNumber(prompt, /\b(?:port|cổng)\s*(?:là|=|:)?\s*(-?\d+)/i);
  if (port !== null) {
    ensureFirstService(services).port = port;
  }

  const replicas =
    extractNumber(prompt, /\b(?:replica|replicas|số lượng|so luong)[^\d-]*(-?\d+)/i) ??
    extractNumber(prompt, /(-?\d+)\s*(?:instance|instances|replica|replicas)/i);
  if (replicas !== null) {
    const targetService = services.find((service) => service.image === 'node') ?? ensureFirstService(services);
    targetService.replicas = replicas;
  }

  const cpu = extractNumber(prompt, /\b(?:cpu)\s*(?:là|=|:)?\s*(-?\d+)/i);
  const memoryGb = extractNumber(prompt, /\b(?:ram|memory)\s*(?:là|=|:)?\s*(-?\d+)\s*(?:gb)?/i);
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

  if (normalizedPrompt.includes('web app') && services.length === 0) {
    services.push(createDraftService());
  }

  return services;
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

function isInfrastructureIntent(value: unknown): value is InfrastructureIntent {
  return (
    value === 'create' ||
    value === 'update' ||
    value === 'status' ||
    value === 'destroy' ||
    value === 'drift'
  );
}
