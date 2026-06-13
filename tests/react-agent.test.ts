import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  InfrastructureSpec,
  InfrastructureStateFile,
  ValidatedQuery,
} from '../src/domain/types.js';
import { ReActAgent } from '../src/agent/react-agent.js';
import { StubLlmProvider, type StructuredLlmRequest } from '../src/llm/provider.js';
import { StaticGateway } from '../src/static-gateway/static-gateway.js';
import {
  createComposeArtifactRecord,
  createVerificationState,
  saveState,
} from '../src/state/file-state-store.js';

describe('ReActAgent', () => {
  it('runs a structured Reason-Act-Observe trace from a ValidatedQuery', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate(
      'Tạo một web application gồm nginx reverse proxy, 2 instance node.js backend, và 1 postgresql database',
    );

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(result.trace?.map((step) => step.phase)).toContain('reason');
    expect(result.trace?.map((step) => step.phase)).toContain('act');
    expect(result.trace?.map((step) => step.phase)).toContain('observe');
    expect(agent.listTools().map((tool) => tool.name)).toContain('save_state');
    expect(agent.listTools().map((tool) => tool.name)).toContain('resolve_image_reference');
    expect(agent.listTools().map((tool) => tool.name)).toContain('propose_draft_spec');
    expect(agent.listTools().map((tool) => tool.name)).toContain('repair_infra_spec');
    expect(agent.listTools().map((tool) => tool.name)).toContain(
      'build_dependency_aware_execution_schedule',
    );
    expect(agent.listTools().map((tool) => tool.name)).toContain(
      'build_detailed_dry_run_preview',
    );
    expect(agent.listTools().map((tool) => tool.name)).toContain('evaluate_dry_run_policy');
    expect(result.observations.some((observation) => observation.source === 'act:load_state')).toBe(
      true,
    );
    expect(
      result.observations.some((observation) => observation.source === 'act:propose_draft_spec'),
    ).toBe(true);
    expect(result.observations.some((observation) => observation.source === 'act:build_execution_plan')).toBe(
      true,
    );
    expect(
      result.observations.some((observation) => observation.source === 'observe:validate_infra_spec'),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'observe:render_compose_preview'),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:build_dependency_aware_execution_schedule' &&
          observation.message.includes('postgres -> api -> nginx'),
      ),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:build_detailed_dry_run_preview' &&
          observation.message.includes('Docker not called'),
      ),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:evaluate_dry_run_policy' &&
          observation.message.includes('Warnings:'),
      ),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:llm_reasoning' &&
          observation.message.includes('Structured LLM reasoning summary'),
      ),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'act:save_state'),
    ).toBe(false);
    expect(result.request).toMatchObject({
      raw: gatewayResult.validatedQuery.raw,
      normalizedPrompt: gatewayResult.validatedQuery.normalizedPrompt,
      intent: 'create',
    });
    expect(result.plan.spec.services.map((service) => service.name)).toEqual([
      'nginx',
      'api',
      'postgres',
    ]);
    expect(result.plan.spec.services.find((service) => service.name === 'api')?.replicas).toBe(2);
    expect(result.plan.spec.services.find((service) => service.name === 'nginx')?.dependsOn).toEqual([
      'api',
    ]);
    expect(result.plan.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual([
      'postgres',
    ]);
    expect(result.plan.assumptions.join('\n')).toContain('InfrastructureSpec is the desired-state source of truth');
    expect(result.plan.steps.find((step) => step.id === 'write-state')?.dependsOn).toEqual([
      'generate-compose',
    ]);
  });

  it('loads current and pending state memory as a ReAct observation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'infra-agent-react-'));
    const stateFilePath = path.join(tempDir, 'infra-state.json');

    try {
      await saveState(createMemoryStateFile(), { stateFilePath });
      const gateway = new StaticGateway(new StubLlmProvider('stub'));
      const gatewayResult = await gateway.validate('Tao nginx port 80');

      if (gatewayResult.status !== 'validated') {
        throw new Error('Expected validated query.');
      }

      const agent = new ReActAgent(
        new StubLlmProvider('stub'),
        () => undefined,
        { stateFilePath },
      );
      const result = await agent.run(gatewayResult.validatedQuery);

      expect(result.status).toBe('planned');
      expect(
        result.observations.some(
          (observation) =>
            observation.source === 'observe:load_state' &&
            observation.message.includes('current verified project "demo"') &&
            observation.message.includes('pending preview for project "demo"'),
        ),
      ).toBe(true);
      expect(
        result.observations.some((observation) => observation.source === 'act:save_state'),
      ).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('lets different natural-language prompts produce different specs', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate('Tao redis port 6379');

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(result.plan.spec.services).toHaveLength(1);
    expect(result.plan.spec.services[0]).toMatchObject({
      kind: 'database',
      name: 'redis',
      image: 'redis:7-alpine',
      ports: ['6379:6379'],
      volumes: ['redis-data:/data'],
    });
    expect(result.plan.spec.volumes).toEqual(['redis-data']);
  });

  it('resolves high-confidence image typos inside the ReAct loop', async () => {
    const query = createValidatedQueryWithSingleImage('Tao ngnix port 80', 'ngnix', 80);
    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(query);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'act:resolve_image_reference' ||
          observation.source === 'observe:resolve_image_reference',
      ),
    ).toBe(true);
    expect(result.plan.spec.services[0]).toMatchObject({
      name: 'nginx',
      image: 'nginx:stable',
      ports: ['80:80'],
    });
  });

  it('plans newly supported stateful images with sensible defaults', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate('Tao mongo port 27017');

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(result.plan.spec.services[0]).toMatchObject({
      kind: 'database',
      name: 'mongo',
      image: 'mongo:7',
      ports: ['27017:27017'],
      volumes: ['mongo-data:/data/db'],
      environment: {
        MONGO_INITDB_ROOT_USERNAME: 'app',
        MONGO_INITDB_ROOT_PASSWORD: 'app',
      },
    });
    expect(result.plan.spec.volumes).toEqual(['mongo-data']);
  });

  it('accepts java as an openjdk alias and renders the maintained Temurin image', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate('Tao java app port 8080');

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(result.plan.spec.services[0]).toMatchObject({
      kind: 'backend',
      name: 'openjdk',
      image: 'eclipse-temurin:21-jdk',
      ports: ['8080:3000'],
    });
  });

  it('asks for clarification when an image reference is unsupported', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate('Tao image bitnami');

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') {
      throw new Error('Expected clarification result.');
    }

    expect(result.clarificationQuestion).toContain('bitnami');
    expect(result.clarificationQuestion).toContain('Supported images');
    expect(
      result.observations.some(
        (observation) => observation.source === 'observe:resolve_image_reference',
      ),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'observe:ask_user'),
    ).toBe(true);
  });

  it('repairs an invalid draft spec observation before building the final plan', async () => {
    const query = createValidatedQueryWithDuplicateDraftNames();
    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(query);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:validate_infra_spec' &&
          observation.message.includes('Duplicate value'),
      ),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'act:repair_infra_spec'),
    ).toBe(true);
    expect(result.plan.spec.services.map((service) => service.name)).toEqual(['db', 'db-2']);
    expect(result.plan.spec.volumes).toEqual(['db-data', 'db-2-data']);
    expect(result.plan.assumptions).toContain(
      'Draft spec required automatic repair before validation could pass.',
    );
  });

  it('turns invalid structured ReAct output into an observation and continues safely', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate('Tao nginx port 80');

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    class InvalidReactReasoningProvider extends StubLlmProvider {
      override async completeStructured(input: StructuredLlmRequest) {
        if (input.schemaName === 'react_reasoning_output') {
          return { text: 'not-json' };
        }

        return super.completeStructured(input);
      }
    }

    const agent = new ReActAgent(new InvalidReactReasoningProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error('Expected planned result.');
    }

    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:llm_reasoning' &&
          observation.message.includes('Structured ReAct reasoning output was invalid'),
      ),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'observe:render_compose_preview'),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) =>
          observation.source === 'observe:build_dependency_aware_execution_schedule',
      ),
    ).toBe(true);
    expect(
      result.observations.some(
        (observation) => observation.source === 'observe:build_detailed_dry_run_preview',
      ),
    ).toBe(true);
    expect(
      result.observations.some((observation) => observation.source === 'act:save_state'),
    ).toBe(false);
  });

  it('asks for deploy details in ReAct when the request is infrastructure-related but underspecified', async () => {
    const gateway = new StaticGateway(new StubLlmProvider('stub'));
    const gatewayResult = await gateway.validate(
      'tao cho toi 300 cai image, 1000 cai container',
    );

    if (gatewayResult.status !== 'validated') {
      throw new Error('Expected validated query.');
    }

    const agent = new ReActAgent(new StubLlmProvider('stub'));
    const result = await agent.run(gatewayResult.validatedQuery);

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') {
      throw new Error('Expected clarification result.');
    }

    expect(result.clarificationQuestion).toContain('image/runtime');
    expect(result.clarificationQuestion).toContain('container');
    expect(result.clarificationQuestion).toContain('network');
    expect(result.clarificationQuestion).toContain('volume');
    expect(
      result.observations.some((observation) => observation.source === 'observe:ask_user'),
    ).toBe(true);
  });
});

function createValidatedQueryWithDuplicateDraftNames(): ValidatedQuery {
  const raw = 'Tao postgres va redis cung ten db';

  return {
    raw,
    normalizedPrompt: raw,
    intent: 'create',
    draft: {
      raw,
      normalizedPrompt: raw,
      intent: 'create',
      services: [
        {
          name: 'db',
          image: 'postgres',
          port: null,
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
          name: 'db',
          image: 'redis',
          port: null,
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
    },
    riskFlags: [],
    securityFindings: [],
    resourceEstimate: {
      totalContainers: 2,
      maxCpu: null,
      maxMemoryGb: null,
    },
    clarificationRequired: false,
    clarificationQuestion: null,
  };
}

function createValidatedQueryWithSingleImage(
  raw: string,
  image: string,
  port: number | null,
): ValidatedQuery {
  return {
    raw,
    normalizedPrompt: raw,
    intent: 'create',
    draft: {
      raw,
      normalizedPrompt: raw,
      intent: 'create',
      services: [
        {
          name: image,
          image,
          port,
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
    },
    riskFlags: [`services.0.unresolved-image-reference:${image}`],
    securityFindings: [],
    resourceEstimate: {
      totalContainers: 1,
      maxCpu: null,
      maxMemoryGb: null,
    },
    clarificationRequired: false,
    clarificationQuestion: null,
  };
}

function createMemoryStateFile(): InfrastructureStateFile {
  const spec = createSingleNginxSpec();
  const composeYaml = 'services:\n  nginx:\n    image: nginx:stable\n';

  return {
    schemaVersion: 1,
    current: {
      id: 'current-test',
      request: {
        raw: 'Tao nginx port 80',
        normalizedPrompt: 'Tao nginx port 80',
        intent: 'create',
      },
      desired: spec,
      composeArtifact: createComposeArtifactRecord(
        'docker-compose.yaml',
        composeYaml,
        true,
        '2026-06-04T11:24:44.723Z',
      ),
      actual: {
        source: 'runtime-adapter',
        containers: [
          {
            name: 'demo-nginx',
            image: 'nginx:stable',
            status: 'running',
            ports: ['80:80'],
          },
        ],
        networks: [
          {
            name: 'app-network',
            status: 'present',
          },
        ],
        volumes: [],
        images: [
          {
            reference: 'nginx:stable',
            id: 'sha256:test',
            status: 'present',
          },
        ],
        lastObservedAt: '2026-06-04T11:25:44.723Z',
      },
      verification: {
        status: 'passed',
        scope: 'runtime',
        checkedAt: '2026-06-04T11:25:44.723Z',
        summary: 'Runtime state matched desired state.',
        issues: [],
        evidence: ['Container demo-nginx was running.'],
      },
      approvedAt: '2026-06-04T11:24:50.000Z',
      appliedAt: '2026-06-04T11:25:00.000Z',
      savedAt: '2026-06-04T11:25:44.723Z',
    },
    pendingPreview: {
      id: 'pending-test',
      request: {
        raw: 'Tao nginx port 80',
        normalizedPrompt: 'Tao nginx port 80',
        intent: 'create',
      },
      desired: spec,
      plan: {
        summary: 'Pending test plan',
        spec,
        assumptions: ['Test fixture.'],
        steps: [
          {
            id: 'generate-compose',
            description: 'Generate compose.',
            action: 'generate-compose',
          },
        ],
      },
      composeArtifact: createComposeArtifactRecord(
        'docker-compose.yaml',
        composeYaml,
        false,
        null,
      ),
      dryRunPreview: null,
      observations: [],
      trace: [],
      verification: createVerificationState('preview', 'Preview not verified.'),
      createdAt: '2026-06-04T12:00:00.000Z',
      acceptedAt: null,
    },
    history: [],
  };
}

function createSingleNginxSpec(): InfrastructureSpec {
  return {
    projectName: 'demo',
    networks: ['app-network'],
    volumes: [],
    services: [
      {
        kind: 'reverse-proxy',
        name: 'nginx',
        image: 'nginx:stable',
        ports: ['80:80'],
      },
    ],
  };
}
