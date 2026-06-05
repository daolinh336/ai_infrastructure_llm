import { describe, expect, it } from 'vitest';
import { StubLlmProvider } from '../src/llm/provider.js';
import { StaticGateway } from '../src/static-gateway/static-gateway.js';

function createGateway(): StaticGateway {
  return new StaticGateway(new StubLlmProvider('openai'));
}

describe('StaticGateway', () => {
  it('validates an infrastructure query before ReAct starts', async () => {
    const result = await createGateway().validate('Tạo nginx port 80 replica 2');

    expect(result.status).toBe('validated');
    expect(result.metrics.runtimeCallsDuringStaticValidation).toBe(0);

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.intent).toBe('create');
    expect(result.validatedQuery.draft.services[0]?.image).toBe('nginx');
    expect(result.validatedQuery.draft.services[0]?.port).toBe(80);
    expect(result.validatedQuery.draft.services[0]?.replicas).toBe(2);
  });

  it('rejects static logic errors without invoking ReAct', async () => {
    const result = await createGateway().validate(
      'Tạo cho anh cái web dùng nginx port 99999, nhưng cho số lượng chạy là -2 nhé.',
    );

    expect(result.status).toBe('rejected');
    expect(result.metrics.schemaValidationFailed).toBe(1);
    expect(result.metrics.reactInvocationsAfterStaticValidationFailure).toBe(0);

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected result.');
    }

    expect(result.issues.join('\n')).toContain('port must be between 1 and 65535');
    expect(result.issues.join('\n')).toContain('replicas must be between 1 and 10');
  });

  it('rejects out-of-scope requests at the intent router', async () => {
    const result = await createGateway().validate('Kể cho tôi một câu chuyện cười');

    expect(result.status).toBe('rejected');
    expect(result.metrics.intentRejected).toBe(1);
    expect(result.metrics.runtimeCallsDuringStaticValidation).toBe(0);
  });

  it('rejects unsafe requests at the intent router', async () => {
    const result = await createGateway().validate('Làm sao để hack facebook');

    expect(result.status).toBe('rejected');
    expect(result.metrics.unsafeRejected).toBe(1);
    expect(result.metrics.runtimeCallsDuringStaticValidation).toBe(0);
  });

  it('blocks dangerous Docker mounts during static validation', async () => {
    const result = await createGateway().validate('Tạo nginx và mount /var/run/docker.sock');

    expect(result.status).toBe('rejected');
    expect(result.metrics.securityBlocked).toBe(1);

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected result.');
    }

    expect(result.issues.join('\n')).toContain('/var/run/docker.sock');
  });

  it('asks for clarification when a create request lacks image/runtime information', async () => {
    const result = await createGateway().validate('Tạo web app');

    expect(result.status).toBe('clarification');
    expect(result.metrics.clarificationRequired).toBe(1);

    if (result.status !== 'clarification') {
      throw new Error('Expected clarification result.');
    }

    expect(result.question).toContain('image/runtime');
  });
});
