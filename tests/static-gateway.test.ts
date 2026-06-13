import { describe, expect, it } from 'vitest';
import { StubLlmProvider } from '../src/llm/provider.js';
import { StaticGateway } from '../src/static-gateway/static-gateway.js';

function createGateway(): StaticGateway {
  return new StaticGateway(new StubLlmProvider('stub'));
}

describe('StaticGateway', () => {
  it('validates an infrastructure query before ReAct starts', async () => {
    const result = await createGateway().validate('Tao nginx port 80 replica 2');

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

  it('uses deterministic fast path for obvious infrastructure prompts', async () => {
    let providerCalls = 0;
    const gateway = new StaticGateway({
      name: 'stub',
      async complete() {
        providerCalls += 1;
        throw new Error('Provider should not be called for fast-path prompts.');
      },
      async completeStructured() {
        providerCalls += 1;
        throw new Error('Provider should not be called for fast-path prompts.');
      },
    });

    const result = await gateway.validate('Tao nginx port 80 replica 2');

    expect(result.status).toBe('validated');
    expect(providerCalls).toBe(0);

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.draft.services[0]?.image).toBe('nginx');
    expect(result.validatedQuery.draft.services[0]?.port).toBe(80);
    expect(result.validatedQuery.draft.services[0]?.replicas).toBe(2);
  });

  it('parses natural backend replica phrasing on the deterministic fast path', async () => {
    const result = await createGateway().validate(
      'Tao web application gom nginx reverse proxy, 2 node backend, va postgres database',
    );

    expect(result.status).toBe('validated');

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    const nodeService = result.validatedQuery.draft.services.find(
      (service) => service.image === 'node',
    );
    expect(nodeService?.replicas).toBe(2);
    expect(result.validatedQuery.resourceEstimate.totalContainers).toBe(4);
  });

  it('rejects static logic errors without invoking ReAct', async () => {
    const result = await createGateway().validate(
      'Tao web dung nginx port 99999 replica -2',
    );

    expect(result.status).toBe('rejected');
    expect(result.metrics.schemaValidationFailed).toBe(1);
    expect(result.metrics.reactInvocationsAfterStaticValidationFailure).toBe(0);

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected result.');
    }

    expect(result.issues.join('\n')).toContain('port must be between 1 and 65535');
    expect(result.issues.join('\n')).toContain('replicas must be >= 1');
  });

  it('rejects out-of-scope requests at the intent router', async () => {
    const result = await createGateway().validate('Ke cho toi mot cau chuyen cuoi');

    expect(result.status).toBe('rejected');
    expect(result.metrics.intentRejected).toBe(1);
    expect(result.metrics.runtimeCallsDuringStaticValidation).toBe(0);
  });

  it('rejects unsafe requests at the intent router', async () => {
    const result = await createGateway().validate('Lam sao de hack facebook');

    expect(result.status).toBe('rejected');
    expect(result.metrics.unsafeRejected).toBe(1);
    expect(result.metrics.runtimeCallsDuringStaticValidation).toBe(0);
  });

  it('blocks dangerous Docker mounts during static validation', async () => {
    const result = await createGateway().validate('Tao nginx va mount /var/run/docker.sock');

    expect(result.status).toBe('rejected');
    expect(result.metrics.securityBlocked).toBe(1);

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected result.');
    }

    expect(result.issues.join('\n')).toContain('/var/run/docker.sock');
  });

  it('allows underspecified infrastructure requests through to ReAct', async () => {
    const result = await createGateway().validate('Tao web app');

    expect(result.status).toBe('validated');
    expect(result.metrics.clarificationRequired).toBe(0);

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.draft.services.every((service) => service.image === null)).toBe(
      true,
    );
  });

  it('does not ask deploy-detail clarification inside Static Gateway', async () => {
    const result = await createGateway().validate(
      'tao cho toi 300 cai image, 1000 cai container',
    );

    expect(result.status).toBe('validated');
    expect(result.metrics.clarificationRequired).toBe(0);
    expect(result.metrics.reactInvocationsAfterStaticValidationFailure).toBe(0);

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.intent).toBe('create');
  });

  it('normalizes small image typos before static validation', async () => {
    const gateway = new StaticGateway({
      name: 'stub',
      async complete() {
        return { text: 'unused' };
      },
      async completeStructured(input) {
        if (input.schemaName === 'intent_classification') {
          return {
            text: JSON.stringify({
              scope: 'infrastructure',
              intent: 'create',
              reason: 'Infrastructure request.',
            }),
          };
        }

        return {
          text: JSON.stringify({
            raw: 'please provision the thing from my previous message',
            normalizedPrompt: 'please provision the thing from my previous message',
            intent: 'create',
            services: [
              {
                name: 'postresql',
                image: 'postresql',
                port: 5432,
                replicas: null,
                requestedMounts: [],
                privileged: null,
                networkMode: null,
                pidMode: null,
                ipcMode: null,
                cpu: null,
                memoryGb: null,
              },
              {
                name: 'redos',
                image: 'redos',
                port: 6379,
                replicas: null,
                requestedMounts: [],
                privileged: null,
                networkMode: null,
                pidMode: null,
                ipcMode: null,
                cpu: null,
                memoryGb: null,
              },
            ],
            destructive: false,
            missingInformation: [],
          }),
        };
      },
    });

    const result = await gateway.validate('please provision the thing from my previous message');

    expect(result.status).toBe('validated');

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.draft.services[0]?.name).toBe('postgres');
    expect(result.validatedQuery.draft.services[0]?.image).toBe('postgres');
    expect(result.validatedQuery.draft.services[1]?.name).toBe('redis');
    expect(result.validatedQuery.draft.services[1]?.image).toBe('redis');
  });

  it('understands supported-image typos on the deterministic fast path', async () => {
    const result = await createGateway().validate('Tao ngnix pyhton myql ndoe redos va mong');

    expect(result.status).toBe('validated');

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.validatedQuery.draft.services.map((service) => service.image)).toEqual([
      'nginx',
      'python',
      'mysql',
      'node',
      'redis',
      'mongo',
    ]);
  });

  it('passes unresolved image references to ReAct instead of hard failing in Static Gateway', async () => {
    const result = await createGateway().validate('Tao image bitnami');

    expect(result.status).toBe('validated');

    if (result.status !== 'validated') {
      throw new Error('Expected validated result.');
    }

    expect(result.metrics.imageWhitelistBlocked).toBe(0);
    expect(result.validatedQuery.riskFlags).toContain(
      'services.0.unresolved-image-reference:bitnami',
    );
    expect(result.validatedQuery.draft.services[0]?.image).toBe('bitnami');
  });

  it('rejects invalid structured provider JSON before ReAct starts', async () => {
    const gateway = new StaticGateway({
      name: 'stub',
      async complete() {
        return { text: 'not-json' };
      },
      async completeStructured() {
        return { text: 'not-json' };
      },
    });

    const result = await gateway.validate('please provision the thing from my previous message');

    expect(result.status).toBe('rejected');
    expect(result.metrics.schemaValidationFailed).toBe(1);
    expect(result.metrics.reactInvocationsAfterStaticValidationFailure).toBe(0);

    if (result.status !== 'rejected') {
      throw new Error('Expected rejected result.');
    }

    expect(result.reason).toContain('Intent classifier output was invalid');
  });
});
