import type { ProviderName } from '../domain/types.js';

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
