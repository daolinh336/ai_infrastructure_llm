import { describe, expect, it } from 'vitest';
import { ReActAgent } from '../src/agent/react-agent.js';
import { StubLlmProvider } from '../src/llm/provider.js';
import { StaticGateway } from '../src/static-gateway/static-gateway.js';

describe('ReActAgent', () => {
  it('runs a structured Reason-Act-Observe trace from a ValidatedQuery', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('openai'));
    const gatewayResult = await gateway.validate(
      'Tạo một web application gồm nginx reverse proxy, 2 instance node.js backend, và 1 postgresql database',
    );

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const result = await new ReActAgent(new StubLlmProvider('openai')).run(
      gatewayResult.validatedQuery,
    );

    expect(result.trace?.map((step) => step.phase)).toContain('reason');
    expect(result.trace?.map((step) => step.phase)).toContain('act');
    expect(result.trace?.map((step) => step.phase)).toContain('observe');
    expect(result.observations.some((observation) => observation.source === 'act:load_state')).toBe(
      true,
    );
    expect(result.observations.some((observation) => observation.source === 'act:build_execution_plan')).toBe(
      true,
    );
    expect(
      result.observations.some((observation) => observation.source === 'observe:validate_infra_spec'),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'observe:render_compose_preview'),
    ).toBe(true);
    expect(result.plan.spec.services.map((service) => service.name)).toEqual([
      'nginx',
      'api',
      'postgres',
    ]);
    expect(result.plan.spec.services.find((service) => service.name === 'api')?.replicas).toBe(2);
  });
});
