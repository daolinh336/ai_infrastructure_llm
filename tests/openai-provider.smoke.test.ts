import { describe, expect, it } from 'vitest';
import { StaticGateway } from '../src/static-gateway/static-gateway.js';
import { createProvider } from '../src/llm/provider.js';

const runOpenAiSmoke =
  process.env.RUN_OPENAI_SMOKE === '1' && Boolean(process.env.OPENAI_API_KEY);
const smokeIt = runOpenAiSmoke ? it : it.skip;

describe('OpenAI provider smoke test', () => {
  smokeIt('classifies and parses a simple infrastructure prompt with the real API', async () => {
    const gateway = new StaticGateway(createProvider('openai'));
    const result = await gateway.validate('Create nginx on port 80');

    expect(result.status).toBe('validated');

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.draft.services[0]?.image).toBe('nginx');
  });
});
