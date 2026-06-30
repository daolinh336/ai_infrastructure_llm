import { describe, expect, it } from 'vitest';
import {
  createOpenAiConfig,
  createProvider,
  DEFAULT_OPENAI_TEMPERATURE,
  getDefaultProviderName,
  getFallbackProviderName,
  OpenAiLlmProvider,
  type OpenAiResponseCreateInput,
  type OpenAiResponsesClient,
} from '../src/llm/provider.js';
import { feedbackIntentJsonSchema, specPatchPlanJsonSchema } from '../src/domain/structured-output-schemas.js';

describe('LLM provider routing', () => {
  it('defaults to OpenAI even when INFRA_AGENT_PROVIDER is set to Gemini', () => {
    expect(getDefaultProviderName({ INFRA_AGENT_PROVIDER: 'gemini' } as NodeJS.ProcessEnv)).toBe('openai');
  });

  it('uses Gemini as implicit fallback only when Gemini credentials are available', () => {
    expect(getFallbackProviderName({} as NodeJS.ProcessEnv)).toBeNull();
    expect(getFallbackProviderName({ GEMINI_API_KEY: 'gemini-key' } as NodeJS.ProcessEnv)).toBe('gemini');
  });

  it('falls back to Gemini when default OpenAI is not configured', () => {
    const provider = createProvider(undefined, { GEMINI_API_KEY: 'gemini-key' } as NodeJS.ProcessEnv);

    expect(provider.name).toBe('gemini');
  });

  it('keeps OpenAI primary when both OpenAI and Gemini credentials are available', () => {
    const provider = createProvider(undefined, {
      OPENAI_API_KEY: 'openai-key',
      GEMINI_API_KEY: 'gemini-key',
    } as NodeJS.ProcessEnv);

    expect(provider.name).toBe('openai');
  });
});

describe('OpenAI provider responses', () => {
  it('uses the SDK output_text helper when present', async () => {
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({ output_text: '{"accepted":true}' }),
    );

    await expect(
      provider.complete({
        system: 'system',
        user: 'user',
      }),
    ).resolves.toEqual({ text: '{"accepted":true}' });
  });

  it('falls back to output message content when output_text is missing', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: '{"accepted":true}',
              },
            ],
          },
        ],
      }, (input) => {
        capturedInputs.push(input);
      }),
    );

    await expect(
      provider.completeStructured({
        system: 'system',
        user: 'user',
        purpose: 'auxiliary',
        schemaName: 'intent_classification',
        schema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      }),
    ).resolves.toEqual({ text: '{"accepted":true}' });

    expect(capturedInputs[0]?.text?.format.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(capturedInputs[0]?.temperature).toBe(0.1);
  });

  it('uses default OpenAI temperature from configuration', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      createOpenAiConfig({ OPENAI_API_KEY: 'test-key' } as NodeJS.ProcessEnv),
      createOpenAiClient({ output_text: '{"accepted":true}' }, (input) => {
        capturedInputs.push(input);
      }),
    );

    await provider.complete({
      system: 'system',
      user: 'user',
    });

    expect(capturedInputs[0]?.temperature).toBe(0.1);
  });

  it('allows overriding OpenAI temperature from env', () => {
    expect(
      createOpenAiConfig({
        OPENAI_API_KEY: 'test-key',
        OPENAI_TEMPERATURE: '0.3',
      } as NodeJS.ProcessEnv).temperature,
    ).toBe(0.3);
  });

  it('adds additionalProperties false to nested OpenAI structured output objects', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({ output_text: '{"items":[]}' }, (input) => {
        capturedInputs.push(input);
      }),
    );

    await provider.completeStructured({
      system: 'system',
      user: 'user',
      purpose: 'auxiliary',
      schemaName: 'nested_schema',
      schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
        required: ['items'],
      },
    });

    expect(capturedInputs[0]?.text?.format.schema).toEqual({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    });
  });

  it('marks optional OpenAI structured output properties as required nullable fields', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({ output_text: '{"target":{"name":"api","kind":null}}' }, (input) => {
        capturedInputs.push(input);
      }),
    );

    await provider.completeStructured({
      system: 'system',
      user: 'user',
      purpose: 'auxiliary',
      schemaName: 'selector_schema',
      schema: {
        type: 'object',
        properties: {
          target: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string', enum: ['backend', 'database'] },
            },
            required: ['name'],
          },
        },
        required: ['target'],
      },
    });

    expect(capturedInputs[0]?.text?.format.schema).toMatchObject({
      properties: {
        target: {
          required: ['name', 'kind'],
          properties: {
            kind: { nullable: true },
          },
        },
      },
    });
  });

  it('keeps revision structured output schemas free of string-map additionalProperties', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({ output_text: '{"patches":[],"explanation":"ok","assumptions":[],"ambiguities":[],"requiresUserInput":false,"confidence":1}' }, (input) => {
        capturedInputs.push(input);
      }),
    );

    await provider.completeStructured({
      system: 'system',
      user: 'user',
      purpose: 'react',
      schemaName: 'spec_patch_plan',
      schema: specPatchPlanJsonSchema,
    });

    const schema = capturedInputs[0]?.text?.format.schema as Record<string, unknown>;
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{"type":"string"}');
    const properties = schema.properties as Record<string, unknown>;
    const addServicePatch = ((((properties.patches as Record<string, unknown>)?.items as Record<string, unknown>)?.anyOf) as Array<Record<string, unknown>>)
      .find((item) => (((item.properties as Record<string, unknown>)?.op as Record<string, unknown>)?.enum as string[] | undefined)?.includes('add-service'));
    const service = (addServicePatch?.properties as Record<string, unknown>)?.service as Record<string, unknown>;
    const environment = ((service.properties as Record<string, unknown>).environment as Record<string, unknown>);
    expect(environment.type).toBe('array');
    expect(((environment.items as Record<string, unknown>).required)).toEqual(['key', 'value']);
  });

  it('uses key/value entries for feedback intent environment transport schema', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({ output_text: '{"source":"user-other-feedback","rawText":"set env","intent":"change-env","confidence":1,"ambiguities":[],"requiresUserInput":false}' }, (input) => {
        capturedInputs.push(input);
      }),
    );

    await provider.completeStructured({
      system: 'system',
      user: 'user',
      purpose: 'react',
      schemaName: 'feedback_intent',
      schema: feedbackIntentJsonSchema,
    });

    const schema = capturedInputs[0]?.text?.format.schema as Record<string, unknown>;
    expect(JSON.stringify(schema)).not.toContain('"additionalProperties":{"type":"string"}');
    const properties = schema.properties as Record<string, unknown>;
    const desiredChange = properties.desiredChange as Record<string, unknown>;
    const environment = (desiredChange.properties as Record<string, unknown>).environment as Record<string, unknown>;
    expect(environment.type).toBe('array');
    expect((environment.items as Record<string, unknown>).required).toEqual(['key', 'value']);
  });

  it('falls back to chat completion message content when using a compatible endpoint', async () => {
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
        temperature: DEFAULT_OPENAI_TEMPERATURE,
      },
      createOpenAiClient({
        choices: [
          {
            message: {
              content: '{"accepted":true}',
            },
          },
        ],
      }),
    );

    await expect(
      provider.complete({
        system: 'system',
        user: 'user',
      }),
    ).resolves.toEqual({ text: '{"accepted":true}' });
  });
});

function createOpenAiClient(
  response: Awaited<ReturnType<OpenAiResponsesClient['responses']['create']>>,
  onCreate?: (input: OpenAiResponseCreateInput) => void,
): OpenAiResponsesClient {
  return {
    responses: {
      async create(input) {
        onCreate?.(input);
        return response;
      },
    },
  };
}
