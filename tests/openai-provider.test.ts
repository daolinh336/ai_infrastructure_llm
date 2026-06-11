import { describe, expect, it } from 'vitest';
import { intentClassificationJsonSchema } from '../src/domain/structured-output-schemas.js';
import {
  DEFAULT_OPENAI_AUX_MODEL,
  DEFAULT_OPENAI_REACT_MODEL,
  OpenAiLlmProvider,
  ProviderConfigurationError,
  createOpenAiConfig,
  createProvider,
  type OpenAiResponseCreateInput,
  type OpenAiResponsesClient,
} from '../src/llm/provider.js';

class FakeOpenAiClient implements OpenAiResponsesClient {
  readonly calls: OpenAiResponseCreateInput[] = [];

  constructor(private readonly outputText: string) {}

  readonly responses = {
    create: async (input: OpenAiResponseCreateInput) => {
      this.calls.push(input);
      return { output_text: this.outputText };
    },
  };
}

describe('OpenAI provider configuration', () => {
  it('requires OPENAI_API_KEY for the real OpenAI provider', () => {
    expect(() => createOpenAiConfig({})).toThrow(ProviderConfigurationError);
    expect(() => createOpenAiConfig({})).toThrow(/OPENAI_API_KEY/);
  });

  it('uses documented environment variables and model defaults', () => {
    const config = createOpenAiConfig({
      OPENAI_API_KEY: 'test-key',
    });

    expect(config).toEqual({
      apiKey: 'test-key',
      auxiliaryModel: DEFAULT_OPENAI_AUX_MODEL,
      reactModel: DEFAULT_OPENAI_REACT_MODEL,
    });
  });

  it('allows auxiliary and ReAct model overrides', () => {
    const config = createOpenAiConfig({
      OPENAI_API_KEY: 'test-key',
      OPENAI_AUX_MODEL: 'aux-model',
      OPENAI_REACT_MODEL: 'react-model',
    });

    expect(config.auxiliaryModel).toBe('aux-model');
    expect(config.reactModel).toBe('react-model');
  });

  it('keeps unsupported providers explicit instead of silently falling back to stub', () => {
    expect(() => createProvider('gemini')).toThrow(/not implemented yet/);
    expect(() => createProvider('ollama')).toThrow(/not implemented yet/);
  });
});

describe('OpenAiLlmProvider', () => {
  it('sends Responses API structured-output payloads with JSON Schema', async () => {
    const client = new FakeOpenAiClient(
      JSON.stringify({
        scope: 'infrastructure',
        intent: 'create',
        reason: 'Infrastructure request.',
      }),
    );
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'aux-model',
        reactModel: 'react-model',
      },
      client,
    );

    const response = await provider.completeStructured({
      system: 'classify',
      user: 'Create nginx',
      purpose: 'auxiliary',
      schemaName: 'intent_classification',
      schema: intentClassificationJsonSchema,
    });

    expect(JSON.parse(response.text)).toMatchObject({
      scope: 'infrastructure',
      intent: 'create',
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.model).toBe('aux-model');
    expect(client.calls[0]?.instructions).toBe('classify');
    expect(client.calls[0]?.input).toBe('Create nginx');
    expect(client.calls[0]?.text?.format).toEqual({
      type: 'json_schema',
      name: 'intent_classification',
      schema: intentClassificationJsonSchema,
      strict: true,
    });
  });

  it('uses the ReAct model for non-structured reasoning calls', async () => {
    const client = new FakeOpenAiClient('plain reasoning text');
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'aux-model',
        reactModel: 'react-model',
      },
      client,
    );

    const response = await provider.complete({
      system: 'reason',
      user: 'validated query',
      purpose: 'react',
    });

    expect(response.text).toBe('plain reasoning text');
    expect(client.calls[0]?.model).toBe('react-model');
    expect(client.calls[0]?.text).toBeUndefined();
  });
});
