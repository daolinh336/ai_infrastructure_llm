import { describe, expect, it } from 'vitest';
import {
  createProvider,
  getDefaultProviderName,
  getFallbackProviderName,
  OpenAiLlmProvider,
  type OpenAiResponseCreateInput,
  type OpenAiResponsesClient,
} from '../src/llm/provider.js';

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
  });

  it('adds additionalProperties false to nested OpenAI structured output objects', async () => {
    const capturedInputs: OpenAiResponseCreateInput[] = [];
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
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

  it('falls back to chat completion message content when using a compatible endpoint', async () => {
    const provider = new OpenAiLlmProvider(
      {
        apiKey: 'test-key',
        auxiliaryModel: 'test-aux-model',
        reactModel: 'test-react-model',
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
