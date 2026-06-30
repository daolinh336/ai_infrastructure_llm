import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  validateInfrastructureStateSnapshot,
  validatePlannerRevisionRequest,
  validateRevisionObservation,
  validateUserFeedback,
  validateVerificationReport,
} from '../src/domain/schemas.js';
import type {
  DraftQuery,
  DraftServiceQuery,
  ApprovalDecision,
  ApprovedAction,
  CleanupReport,
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  PlannerRevisionResult,
  PlannerRevisionRequest,
  RevisionObservation,
  RuntimeActualState,
  SpecPatchPlan,
  ValidatedQuery,
  VerificationReport,
  UserFeedback,
} from '../src/domain/types.js';
import { ReActAgent } from '../src/agent/react-agent.js';
import { StandardPlannerAgent } from '../src/agent/standard-planner-agent.js';
import { TestLlmProvider } from '../src/llm/provider.js';
import { StaticGateway } from '../src/static-gateway/static-gateway.js';
import {
  ClosedLoopGuard,
  ClosedLoopGuardError,
  DEFAULT_CLOSED_LOOP_CONFIG,
} from '../src/agent/closed-loop-guard.js';
import { hashSpec } from '../src/agent/loop-guard.js';
import { buildDriftReport } from '../src/execution/drift-detector.js';
import { buildRepairPlan } from '../src/execution/repair-planner.js';
import { parseInspectResult, parseInspectSummaryResult } from '../src/execution/docker-mcp-parsers.js';
import { DockerMcpGateway } from '../src/execution/docker-mcp-gateway.js';
import type { PlannerRuntimeReader } from '../src/execution/runtime-environment-reader.js';
import { createConflictVerificationReport, detectPreDeployConflicts } from '../src/cli/shared.js';
import { McpRoutingTable } from '../src/execution/mcp-routing-table.js';
import { renderCompose } from '../src/compose/render-compose.js';
import { ExecutionEngine } from '../src/execution/execution-engine.js';
import { savePendingPreview } from '../src/state/sqlite-state-store.js';
import { runClosedLoopDeploy } from '../src/cli/deploy-loop.js';

class RecordingTestLlmProvider extends TestLlmProvider {
  readonly intentRequests: string[] = [];
  readonly draftRequests: string[] = [];
  readonly reactRequests: string[] = [];

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'intent_classification') {
      this.intentRequests.push(input.user);
    }

    if (input.schemaName === 'draft_query') {
      this.draftRequests.push(input.user);
    }

    if (input.schemaName === 'react_reasoning_output') {
      this.reactRequests.push(input.user);
    }

    return super.completeStructured(input);
  }
}

class FixedDraftTestLlmProvider extends TestLlmProvider {
  constructor(private readonly draft: DraftQuery) {
    super();
  }

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'draft_query') {
      return { text: JSON.stringify(this.draft) };
    }

    return super.completeStructured(input);
  }
}

class ComponentsDraftTestLlmProvider extends TestLlmProvider {
  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'draft_query') {
      return {
        text: JSON.stringify({
          intent: 'create',
          components: [
            { role: 'web', image: 'nginx', replicas: 1, ports: null },
            { role: 'backend', image: 'nodejs', replicas: 2, ports: null },
            { role: 'database', image: 'postgresql', replicas: 3, ports: null },
          ],
        }),
      };
    }

    return super.completeStructured(input);
  }
}

class FixedPatchTestLlmProvider extends TestLlmProvider {
  constructor(private readonly patchPlan: SpecPatchPlan) {
    super();
  }

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'spec_patch_plan') {
      return { text: JSON.stringify(this.patchPlan) };
    }

    return super.completeStructured(input);
  }
}

class RecordingPatchTestLlmProvider extends TestLlmProvider {
  readonly patchRequests: string[] = [];

  constructor(private readonly patchPlan: SpecPatchPlan) {
    super();
  }

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'spec_patch_plan') {
      this.patchRequests.push(input.user);
      return { text: JSON.stringify(this.patchPlan) };
    }

    return super.completeStructured(input);
  }
}

class FeedbackIntentPatchTestLlmProvider extends TestLlmProvider {
  readonly feedbackIntentRequests: string[] = [];
  readonly patchRequests: string[] = [];

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'feedback_intent') {
      this.feedbackIntentRequests.push(input.user);
      return {
        text: JSON.stringify({
          source: 'user-other-feedback',
          rawText: 'd?i sang 8080',
          intent: 'change-port',
          target: {
            resourceKind: 'port',
            serviceSelector: { name: 'nginx' },
            currentValue: '80',
          },
          desiredChange: { hostPort: 8080, containerPort: 80 },
          confidence: 0.96,
          ambiguities: [],
          requiresUserInput: false,
        }),
      };
    }

    if (input.schemaName === 'spec_patch_plan') {
      this.patchRequests.push(input.user);
      return {
        text: JSON.stringify({
          patches: [
            {
              op: 'replace-service-port',
              target: { name: 'nginx' },
              from: '80:80',
              to: '8080:80',
              reason: 'Apply parsed other feedback to move nginx off occupied host port 80.',
            },
          ],
          explanation: 'Convert FeedbackIntent(change-port) into a spec patch.',
          assumptions: ['Other feedback was parsed before patch planning.'],
          ambiguities: [],
          requiresUserInput: false,
          confidence: 0.96,
        }),
      };
    }

    return super.completeStructured(input);
  }
}

class InvalidPatchTestLlmProvider extends TestLlmProvider {
  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'spec_patch_plan') {
      return { text: JSON.stringify({ not: 'a patch plan' }) };
    }

    return super.completeStructured(input);
  }
}

class RawPatchTestLlmProvider extends TestLlmProvider {
  constructor(private readonly rawPatchPlan: unknown) {
    super();
  }

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'spec_patch_plan') {
      return { text: JSON.stringify(this.rawPatchPlan) };
    }

    return super.completeStructured(input);
  }
}

class MisparsedQuantityAsPortTestLlmProvider extends TestLlmProvider {
  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'draft_query') {
      return {
        text: JSON.stringify({
          raw: 'tao cho toi 1 web dung ngix, 2 backend nodejs va 3 db dung postresql',
          normalizedPrompt: 'tao cho toi 1 web dung ngix, 2 backend nodejs va 3 db dung postresql',
          intent: 'create',
          services: [
            { name: 'web', image: 'ngix', port: null, replicas: 1, requestedMounts: [], privileged: null, networkMode: null, pidMode: null, ipcMode: null, cpu: null, memoryGb: null },
            { name: 'backend', image: 'nodejs', port: 0, replicas: 2, requestedMounts: [], privileged: null, networkMode: null, pidMode: null, ipcMode: null, cpu: null, memoryGb: null },
            { name: 'db', image: 'postresql', port: 0, replicas: 3, requestedMounts: [], privileged: null, networkMode: null, pidMode: null, ipcMode: null, cpu: null, memoryGb: null },
          ],
          destructive: false,
          missingInformation: [],
        }),
      };
    }

    return super.completeStructured(input);
  }
}

class MalformedDatabaseFeedbackIntentTestLlmProvider extends TestLlmProvider {
  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'feedback_intent') {
      return {
        text: JSON.stringify({
          target: { kind: 'database', serviceNames: ['postgres-1', 'postgres-2'], scope: 'database-group' },
          desiredChange: { mode: 'total', totalInstances: 4 },
          intent: 'set-instances',
          confidence: 0.87,
          ambiguities: [],
          requiresUserInput: false,
        }),
      };
    }

    if (input.schemaName === 'spec_patch_plan') {
      return {
        text: JSON.stringify({
          patches: [],
          explanation: 'LLM patch planner failed to emit a direct patch.',
          assumptions: [],
          ambiguities: [],
          requiresUserInput: true,
          confidence: 0.2,
        }),
      };
    }

    return super.completeStructured(input);
  }
}

class FixedFeedbackIntentTestLlmProvider extends TestLlmProvider {
  constructor(private readonly feedbackIntent: unknown) {
    super();
  }

  override async completeStructured(input: Parameters<TestLlmProvider['completeStructured']>[0]) {
    if (input.schemaName === 'feedback_intent') {
      return { text: JSON.stringify(this.feedbackIntent) };
    }

    if (input.schemaName === 'spec_patch_plan') {
      return {
        text: JSON.stringify({
          patches: [],
          explanation: 'Force deterministic conversion from FeedbackIntent. Any final patch comes from local mapping.',
          assumptions: [],
          ambiguities: [],
          requiresUserInput: false,
          confidence: 0.7,
        }),
      };
    }

    return super.completeStructured(input);
  }
}

function patchProvider(patches: SpecPatchPlan['patches'], overrides: Partial<SpecPatchPlan> = {}): FixedPatchTestLlmProvider {
  return new FixedPatchTestLlmProvider({
    patches,
    explanation: 'Test provider returned schema-valid patches.',
    assumptions: ['Patch intent is supplied as structured LLM output for this test.'],
    ambiguities: [],
    requiresUserInput: false,
    confidence: 0.9,
    ...overrides,
  });
}

describe('StaticGateway topology clarification', () => {
  it('sends the full request to the LLM intent gate before accepting infrastructure scope', async () => {
    const provider = new RecordingTestLlmProvider();
    const gateway = new StaticGateway(provider);

    const result = await gateway.validate('tao 1 terminator');

    expect(provider.intentRequests).toEqual(['tao 1 terminator']);
    expect(provider.draftRequests).toHaveLength(0);
    expect(result.status).toBe('rejected');
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('sends accepted infrastructure requests to the LLM structured parser', async () => {
    const provider = new RecordingTestLlmProvider();
    const gateway = new StaticGateway(provider);

    const result = await gateway.validate('Create nginx and node');

    expect(provider.intentRequests).toEqual(['Create nginx and node']);
    expect(provider.draftRequests).toEqual([
      JSON.stringify({ raw: 'Create nginx and node', intent: 'create' }),
    ]);
    expect(result.status).toBe('validated');
  });

  it('normalizes component-shaped structured parser output before validation', async () => {
    const gateway = new StaticGateway(new ComponentsDraftTestLlmProvider());

    const result = await gateway.validate(
      'tao cho toi 1 web dung ngix, 2 backend nodejs va 3 db dung postresql',
    );

    expect(result.status).toBe('validated');
    if (result.status !== 'validated') {
      throw new Error(`Expected validated, got ${result.status}`);
    }
    expect(result.validatedQuery.draft.services).toEqual([
      expect.objectContaining({ image: 'nginx', replicas: 1 }),
      expect.objectContaining({ image: 'node', replicas: 2 }),
      expect.objectContaining({ image: 'postgres', replicas: 3 }),
    ]);
  });

  it('ignores quantity numbers misparsed as ports when prompt has no port keyword', async () => {
    const gateway = new StaticGateway(new MisparsedQuantityAsPortTestLlmProvider());

    const result = await gateway.validate(
      'tao cho toi 1 web dung ngix, 2 backend nodejs va 3 db dung postresql',
    );

    expect(result.status).toBe('validated');
    if (result.status !== 'validated') {
      throw new Error(`Expected validated, got ${result.status}: ${result.issues.join(', ')}`);
    }
    expect(result.validatedQuery.draft.services.map((service) => service.port)).toEqual([null, null, null]);
  });

  it('rejects harmful create requests before ReAct planning starts', async () => {
    const provider = new RecordingTestLlmProvider();
    const gateway = new StaticGateway(provider);

    const result = await gateway.validate('tao cho toi 1 model AI co the chinh phuc the gioi');

    expect(provider.intentRequests).toEqual([
      'tao cho toi 1 model AI co the chinh phuc the gioi',
    ]);
    expect(result.status).toBe('rejected');
    expect(result.metrics.unsafeRejected).toBe(1);
    expect(result.metrics.intentAccepted).toBe(0);
    expect(result.metrics.schemaValidationPassed).toBe(0);
  });

  it('asks before connecting a reverse proxy directly to a database', async () => {
    const gateway = new StaticGateway(new TestLlmProvider());

    const result = await gateway.validate('Create nginx and mysql');

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') {
      throw new Error(`Expected clarification, got ${result.status}`);
    }
    expect(result.question).toContain('reverse proxy and a database');
    expect(result.question).toContain('backend service');
  });

  it('allows backend plus database without requiring nginx', async () => {
    const gateway = new StaticGateway(new TestLlmProvider());

    const result = await gateway.validate('Create node and postgres');

    expect(result.status).toBe('validated');
  });

  it('allows reverse proxy plus backend without requiring a database', async () => {
    const gateway = new StaticGateway(new TestLlmProvider());

    const result = await gateway.validate('Create nginx and node');

    expect(result.status).toBe('validated');
  });

  it('rejects high replicas even when the image is unresolved', async () => {
    const gateway = new StaticGateway(
      new FixedDraftTestLlmProvider({
        raw: 'Create a web service and 1000 database containers',
        normalizedPrompt: 'Create a web service and 1000 database containers',
        intent: 'create',
        services: [
          {
            name: 'database',
            image: null,
            port: null,
            replicas: 1000,
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
    );

    const result = await gateway.validate('Create a web service and 1000 database containers');

    expect(result.status).toBe('rejected');
    expect(result.metrics.resourceLimitBlocked).toBe(1);
    expect(result.issues).toContain('services.0.replicas must be <= 50.');
  });

  it('rejects explicit huge container counts even if the parser misses replicas', async () => {
    const gateway = new StaticGateway(new TestLlmProvider());

    const result = await gateway.validate('Create a static web service with 1000 containers');

    expect(result.status).toBe('rejected');
    expect(result.metrics.resourceLimitBlocked).toBe(1);
    expect(result.issues).toContain('Explicit container count must be <= 50; got 1000.');
  });
});

describe('ReAct planning uncertainty gate', () => {
  it('feeds bounded prior reasoning memory into the next LLM reasoning call', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'react-memory-'));
    const stateStore = { stateDatabasePath: join(stateDir, 'infra-state.sqlite') };

    try {
      const firstAgent = new ReActAgent(
        new TestLlmProvider(),
        undefined,
        stateStore,
        undefined,
        undefined,
        { logEnabled: false },
      );
      const firstResult = await firstAgent.run(
        makeGenericValidatedQuery('Create one nginx service', [serviceHint({ name: 'web', image: 'nginx:stable' })]),
      );
      expect(firstResult.status).toBe('planned');
      if (firstResult.status !== 'planned') {
        throw new Error(`Expected planned, got ${firstResult.status}`);
      }

      const dryRun = await new ExecutionEngine({ stateStore }).dryRun(firstResult);
      await savePendingPreview(dryRun.pendingPreview, stateStore);

      const recordingProvider = new RecordingTestLlmProvider();
      const secondAgent = new ReActAgent(
        recordingProvider,
        undefined,
        stateStore,
        undefined,
        undefined,
        { logEnabled: false },
      );
      await secondAgent.run(
        makeGenericValidatedQuery('Create one node service', [serviceHint({ name: 'api', image: 'node:20-alpine' })]),
      );

      expect(recordingProvider.reactRequests).toHaveLength(1);
      const reasoningInput = JSON.parse(recordingProvider.reactRequests[0]!);
      expect(reasoningInput.memory.summary).toContain('pending preview for project');
      expect(reasoningInput.memory.priorReasoning.length).toBeGreaterThan(0);
      expect(reasoningInput.memory.priorObservations.length).toBeGreaterThan(0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('asks when a reverse proxy has multiple possible backend targets', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const result = await agent.run(
      makeValidatedQuery([
        serviceHint({ name: 'web', image: 'nginx' }),
        serviceHint({ name: 'api', image: 'node' }),
        serviceHint({ name: 'admin', image: 'python' }),
      ]),
    );

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') {
      throw new Error(`Expected clarification, got ${result.status}`);
    }
    expect(result.clarificationQuestion).toContain('multiple possible backend targets');
    expect(result.clarificationChoices?.map((choice) => choice.label)).toEqual([
      'Route to api',
      'Route to admin',
    ]);
    expect(result.uncertainties?.[0]?.field).toBe('services[].dependsOn');
  });

  it('continues planning after user selects a clarification choice', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const firstResult = await agent.run(
      makeValidatedQuery([
        serviceHint({ name: 'web', image: 'nginx' }),
        serviceHint({ name: 'api', image: 'node' }),
        serviceHint({ name: 'admin', image: 'python' }),
      ]),
    );

    expect(firstResult.status).toBe('clarification');
    if (firstResult.status !== 'clarification' || !firstResult.clarificationContext) {
      throw new Error(`Expected clarification with context, got ${firstResult.status}`);
    }

    const resumedResult = await agent.continueFromClarification(firstResult.clarificationContext, {
      uncertaintyId: firstResult.uncertainties![0]!.id,
      selectedChoiceId: '1',
      otherText: null,
      submittedAt: new Date().toISOString(),
    });

    expect(resumedResult.status).toBe('planned');
    if (resumedResult.status !== 'planned') {
      throw new Error(`Expected planned, got ${resumedResult.status}`);
    }
    expect(resumedResult.plan.spec.services.find((service) => service.name === 'web')?.dependsOn).toEqual([
      'api',
    ]);
  });

  it('continues without asking for a single clear proxy/backend/database chain', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const result = await agent.run(
      makeValidatedQuery([
        serviceHint({ name: 'web', image: 'nginx' }),
        serviceHint({ name: 'api', image: 'node' }),
        serviceHint({ name: 'db', image: 'postgres' }),
      ]),
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error(`Expected planned, got ${result.status}`);
    }
    expect(result.plan.spec.services.find((service) => service.name === 'web')?.dependsOn).toEqual([
      'api',
    ]);
    expect(result.plan.spec.services.find((service) => service.name === 'api')?.dependsOn).toEqual([
      'db',
    ]);
  });

  it('does not put host ports in source spec except reverse-proxy services', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const result = await agent.run(
      makeValidatedQuery([
        serviceHint({ name: 'web', image: 'nginx', port: 8080 }),
        serviceHint({ name: 'api', image: 'node', port: 3000 }),
        serviceHint({ name: 'db', image: 'postgres', port: 5432 }),
      ]),
    );

    expect(result.status).toBe('planned');
    if (result.status !== 'planned') {
      throw new Error(`Expected planned, got ${result.status}`);
    }

    expect(result.plan.spec.services.find((service) => service.name === 'web')?.ports).toEqual(['8080:80']);
    expect(result.plan.spec.services.find((service) => service.name === 'api')?.ports).toBeUndefined();
    expect(result.plan.spec.services.filter((service) => service.kind === 'database').every((service) => service.ports === undefined)).toBe(true);
  });
});

describe('ReAct image-selection confirmation', () => {
  it('asks the user to confirm a default image for a generic static-web request', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const result = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 web tinh', [serviceHint({})]),
    );

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') {
      throw new Error(`Expected clarification, got ${result.status}`);
    }
    expect(result.uncertainties?.[0]?.field).toBe('services[].image');
    expect(result.uncertainties?.[0]?.id).toBe('select-image:web');
    expect(result.clarificationChoices?.[0]?.value).toContain('setServiceImage:');
    expect(result.clarificationChoices?.[0]?.value).toContain('nginx:stable');
    expect(result.allowOther).toBe(true);
  });

  it('continues planning after the user confirms the default image', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const firstResult = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 web tinh', [serviceHint({})]),
    );

    expect(firstResult.status).toBe('clarification');
    if (firstResult.status !== 'clarification' || !firstResult.clarificationContext) {
      throw new Error(`Expected clarification with context, got ${firstResult.status}`);
    }

    const resumedResult = await agent.continueFromClarification(firstResult.clarificationContext, {
      uncertaintyId: firstResult.uncertainties![0]!.id,
      selectedChoiceId: '1',
      otherText: null,
      submittedAt: new Date().toISOString(),
    });

    expect(resumedResult.status).toBe('planned');
    if (resumedResult.status !== 'planned') {
      throw new Error(`Expected planned, got ${resumedResult.status}`);
    }
    expect(
      resumedResult.plan.spec.services.some((service) => service.image === 'nginx:stable'),
    ).toBe(true);
  });

  it('keeps inferred backend and database services when confirming a web image', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const firstResult = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 web dung nginx, 2 backend nodejs va 3 db dung postgresql', [
        serviceHint({ name: 'web', image: null, replicas: 1 }),
        serviceHint({ name: 'backend', image: null, replicas: 2 }),
        serviceHint({ name: 'db', image: null, replicas: 3 }),
      ]),
    );

    expect(firstResult.status).toBe('clarification');
    if (firstResult.status !== 'clarification' || !firstResult.clarificationContext) {
      throw new Error(`Expected clarification with context, got ${firstResult.status}`);
    }

    const resumedResult = await agent.continueFromClarification(firstResult.clarificationContext, {
      uncertaintyId: firstResult.uncertainties![0]!.id,
      selectedChoiceId: '1',
      otherText: null,
      submittedAt: new Date().toISOString(),
    });

    expect(resumedResult.status).toBe('clarification');
    if (resumedResult.status !== 'clarification' || !resumedResult.clarificationContext) {
      throw new Error(`Expected database clarification, got ${resumedResult.status}`);
    }
    expect(resumedResult.uncertainties?.[0]?.id).toBe('depends-on:backend:database-target');

    const plannedResult = await agent.continueFromClarification(resumedResult.clarificationContext, {
      uncertaintyId: resumedResult.uncertainties![0]!.id,
      selectedChoiceId: '1',
      otherText: null,
      submittedAt: new Date().toISOString(),
    });

    expect(plannedResult.status).toBe('planned');
    if (plannedResult.status !== 'planned') {
      throw new Error(`Expected planned, got ${plannedResult.status}`);
    }
    expect(plannedResult.plan.spec.services.some((service) => service.kind === 'reverse-proxy')).toBe(true);
    expect(plannedResult.plan.spec.services.some((service) => service.kind === 'backend')).toBe(true);
    expect(plannedResult.plan.spec.services.filter((service) => service.kind === 'database')).toHaveLength(3);
  });

  it('applies an alternative image when the user selects a different choice', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const firstResult = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 web tinh', [serviceHint({})]),
    );

    expect(firstResult.status).toBe('clarification');
    if (firstResult.status !== 'clarification' || !firstResult.clarificationContext || !firstResult.clarificationChoices) {
      throw new Error(`Expected clarification with context, got ${firstResult.status}`);
    }

    const httpdChoice = firstResult.clarificationChoices.find((choice) =>
      choice.value.includes('httpd:2.4'),
    );
    if (!httpdChoice) {
      throw new Error('Expected an httpd choice');
    }

    const resumedResult = await agent.continueFromClarification(firstResult.clarificationContext, {
      uncertaintyId: firstResult.uncertainties![0]!.id,
      selectedChoiceId: httpdChoice.id,
      otherText: null,
      submittedAt: new Date().toISOString(),
    });

    expect(resumedResult.status).toBe('planned');
    if (resumedResult.status !== 'planned') {
      throw new Error(`Expected planned, got ${resumedResult.status}`);
    }
    expect(
      resumedResult.plan.spec.services.some((service) => service.image === 'httpd:2.4'),
    ).toBe(true);
  });

  it('offers 1/2/3 choices when the requested image is unsupported', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const result = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 service dung caddy', [serviceHint({ image: 'caddy' })]),
    );

    expect(result.status).toBe('clarification');
    if (result.status !== 'clarification') {
      throw new Error(`Expected clarification, got ${result.status}`);
    }

    expect(result.uncertainties?.[0]?.field).toBe('services[].image');
    expect(result.uncertainties?.[0]?.id).toContain('unsupported-image:');
    expect(result.clarificationChoices?.map((choice) => choice.id)).toEqual(['1', '2', '3']);
    expect(result.allowOther).toBe(true);
    expect(result.clarificationQuestion).toContain('not currently supported');
  });

  it('continues planning after the user picks a suggested replacement for an unsupported image', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const firstResult = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 service dung caddy', [serviceHint({ image: 'caddy' })]),
    );

    expect(firstResult.status).toBe('clarification');
    if (firstResult.status !== 'clarification' || !firstResult.clarificationContext) {
      throw new Error(`Expected clarification with context, got ${firstResult.status}`);
    }

    const resumedResult = await agent.continueFromClarification(firstResult.clarificationContext, {
      uncertaintyId: firstResult.uncertainties![0]!.id,
      selectedChoiceId: '1',
      otherText: null,
      submittedAt: new Date().toISOString(),
    });

    expect(resumedResult.status).toBe('planned');
    if (resumedResult.status !== 'planned') {
      throw new Error(`Expected planned, got ${resumedResult.status}`);
    }
    expect(resumedResult.plan.spec.services[0]?.image).toBe('nginx:stable');
  });

  it('accepts Other for an unsupported image and keeps the custom value', async () => {
    const agent = new ReActAgent(
      new TestLlmProvider(),
      undefined,
      {},
      undefined,
      undefined,
      { logEnabled: false },
    );

    const firstResult = await agent.run(
      makeGenericValidatedQuery('tao cho toi 1 service dung caddy', [serviceHint({ image: 'caddy' })]),
    );

    expect(firstResult.status).toBe('clarification');
    if (firstResult.status !== 'clarification' || !firstResult.clarificationContext) {
      throw new Error(`Expected clarification with context, got ${firstResult.status}`);
    }

    const resumedResult = await agent.continueFromClarification(firstResult.clarificationContext, {
      uncertaintyId: firstResult.uncertainties![0]!.id,
      selectedChoiceId: null,
      otherText: 'caddy:2.8',
      submittedAt: new Date().toISOString(),
    });

    expect(resumedResult.status).toBe('planned');
    if (resumedResult.status !== 'planned') {
      throw new Error(`Expected planned, got ${resumedResult.status}`);
    }
    expect(resumedResult.plan.spec.services[0]?.image).toBe('caddy:2.8');
  });
});

describe('MCP inspect runtime evidence', () => {
  it('routes inspectContainer to an inspect MCP tool', () => {
    const route = new McpRoutingTable().resolve('inspectContainer');

    expect(route.mcpToolName).toContain('inspect');
    expect(route.mcpToolName).not.toBe('list_containers');
  });

  it('parses inspect output into image, status, ports, and environment', () => {
    const parsed = parseInspectResult(JSON.stringify({
      Name: '/sample-infra-nginx',
      Config: {
        Image: 'nginx:stable',
        Env: ['APP_ENV=demo', 'PORT=80'],
      },
      State: { Status: 'running' },
      NetworkSettings: {
        Ports: {
          '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        },
      },
    }), 'sample-infra-nginx');

    expect(parsed?.name).toBe('sample-infra-nginx');
    expect(parsed?.image).toBe('nginx:stable');
    expect(parsed?.status).toBe('running');
    expect(parsed?.ports).toEqual(['8080:80']);
    expect(parsed?.environment).toEqual({ APP_ENV: 'demo', PORT: '80' });
  });

  it('redacts inspect output for planner-safe container summaries', () => {
    const summary = parseInspectSummaryResult(JSON.stringify({
      Name: '/sample-infra-nginx',
      Config: {
        Image: 'nginx:stable',
        Env: ['DATABASE_URL=postgres://secret', 'TOKEN=abc'],
        Cmd: ['--password=secret'],
        Labels: { token: 'secret-label' },
      },
      HostConfig: {
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      },
      Mounts: [
        { Source: 'C:/Users/secret/project/.env', Destination: '/run/secrets/app.env' },
      ],
      State: { Status: 'running', Health: { Status: 'healthy' } },
      NetworkSettings: {
        Networks: { app_net: { IPAddress: '172.18.0.2' } },
        Ports: {
          '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        },
      },
    }), 'sample-infra-nginx');

    expect(summary).toEqual({
      name: 'sample-infra-nginx',
      image: 'nginx:stable',
      status: 'running',
      ports: ['8080:80'],
      networks: ['app_net'],
      mountDestinations: ['/run/secrets/app.env'],
      restartPolicy: 'on-failure:3',
      healthStatus: 'healthy',
    });
    expect(JSON.stringify(summary)).not.toContain('postgres://secret');
    expect(JSON.stringify(summary)).not.toContain('secret-label');
    expect(JSON.stringify(summary)).not.toContain('password=secret');
    expect(JSON.stringify(summary)).not.toContain('C:/Users/secret/project/.env');
    expect(JSON.stringify(summary)).not.toContain('172.18.0.2');
  });

  it('calls inspect_container with the MCP container_id argument', async () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });
    const executeRoute = vi.fn().mockResolvedValue(JSON.stringify({
      Name: '/sample-infra-web',
      Config: { Image: 'nginx:stable', Env: [] },
      State: { Status: 'running' },
      NetworkSettings: { Ports: {} },
    }));

    (gateway as unknown as { executeRoute: typeof executeRoute }).executeRoute = executeRoute;

    const inspected = await gateway.inspectContainer('sample-infra-web');

    expect(executeRoute).toHaveBeenCalledWith('inspectContainer', { container_id: 'sample-infra-web' });
    expect(inspected?.environment).toEqual({});
  });

  it('exposes inspectContainerSummary without raw sensitive fields', async () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });
    const executeRoute = vi.fn().mockResolvedValue(JSON.stringify({
      Name: '/sample-infra-web',
      Config: { Image: 'nginx:stable', Env: ['TOKEN=secret'], Labels: { token: 'secret' } },
      State: { Status: 'running' },
      NetworkSettings: { Networks: { app: { IPAddress: '172.18.0.3' } }, Ports: {} },
      Mounts: [{ Source: '/host/secret', Destination: '/data' }],
    }));

    (gateway as unknown as { executeRoute: typeof executeRoute }).executeRoute = executeRoute;

    const summary = await gateway.inspectContainerSummary('sample-infra-web');

    expect(executeRoute).toHaveBeenCalledWith('inspectContainer', { container_id: 'sample-infra-web' });
    expect(summary?.mountDestinations).toEqual(['/data']);
    expect(JSON.stringify(summary)).not.toContain('TOKEN=secret');
    expect(JSON.stringify(summary)).not.toContain('/host/secret');
    expect(JSON.stringify(summary)).not.toContain('172.18.0.3');
  });

  it('fails closed when MCP inspect fails', async () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });

    (gateway as unknown as { executeRoute: () => Promise<string> }).executeRoute = async () => {
      throw new Error('invalid argument: container is required');
    };

    await expect(gateway.inspectContainer('missing-container-for-test')).rejects.toThrow('invalid argument');
  });

  it('fails strict observation when inspect enrichment fails', async () => {
    const gateway = new DockerMcpGateway({ skipInitialize: true });

    vi.spyOn(gateway, 'listContainers').mockResolvedValue([
      { name: 'sample-infra-web', image: 'nginx:stable', status: 'running', ports: ['80:80'] },
    ]);
    vi.spyOn(gateway, 'listNetworks').mockResolvedValue([]);
    vi.spyOn(gateway, 'listVolumes').mockResolvedValue([]);
    vi.spyOn(gateway, 'listImages').mockResolvedValue([]);
    vi.spyOn(gateway, 'inspectContainer').mockRejectedValue(new Error('inspect unavailable'));

    await expect(gateway.observeActualStateWithInspect({ containerNames: ['sample-infra-web'] })).rejects.toThrow('inspect unavailable');
  });
});

function makeSpec(): InfrastructureSpec {
  return {
    projectName: 'test-revision',
    services: [
      { kind: 'backend', name: 'api', image: 'node:20-alpine' },
      { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', dependsOn: ['api'] },
    ],
    networks: ['app-network'],
    volumes: [],
  };
}

function makeThreeDatabaseSpec(): InfrastructureSpec {
  return {
    projectName: 'test-revision',
    services: [
      { kind: 'backend', name: 'api', image: 'node:20-alpine', dependsOn: ['postgres-1'] },
      { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', dependsOn: ['api'] },
      { kind: 'database', name: 'postgres-1', image: 'postgres:16', volumes: ['postgres-data-1:/var/lib/postgresql/data'] },
      { kind: 'database', name: 'postgres-2', image: 'postgres:16', dependsOn: ['postgres-1'], volumes: ['postgres-data-2:/var/lib/postgresql/data'] },
      { kind: 'database', name: 'postgres-3', image: 'postgres:16', dependsOn: ['postgres-1'], volumes: ['postgres-data-3:/var/lib/postgresql/data'] },
    ],
    networks: ['app-network'],
    volumes: ['postgres-data-1', 'postgres-data-2', 'postgres-data-3'],
  };
}

function makeValidatedQuery(services: DraftServiceQuery[]): ValidatedQuery {
  return {
    raw: 'Create infrastructure with explicit services',
    normalizedPrompt: 'create infrastructure with explicit services',
    intent: 'create',
    draft: {
      raw: 'Create infrastructure with explicit services',
      normalizedPrompt: 'create infrastructure with explicit services',
      intent: 'create',
      services,
      destructive: false,
      missingInformation: [],
    },
    riskFlags: [],
    securityFindings: [],
    resourceEstimate: {
      totalContainers: services.reduce((total, service) => total + (service.replicas ?? 1), 0),
      maxCpu: null,
      maxMemoryGb: null,
    },
    clarificationRequired: false,
    clarificationQuestion: null,
  };
}

function makeGenericValidatedQuery(prompt: string, services: DraftServiceQuery[]): ValidatedQuery {
  return {
    raw: prompt,
    normalizedPrompt: prompt,
    intent: 'create',
    draft: {
      raw: prompt,
      normalizedPrompt: prompt,
      intent: 'create',
      services,
      destructive: false,
      missingInformation: [],
    },
    riskFlags: [],
    securityFindings: [],
    resourceEstimate: {
      totalContainers: services.reduce((total, service) => total + (service.replicas ?? 1), 0),
      maxCpu: null,
      maxMemoryGb: null,
    },
    clarificationRequired: false,
    clarificationQuestion: null,
  };
}

function serviceHint(overrides: Partial<DraftServiceQuery>): DraftServiceQuery {
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

function makeVerificationReport(issues: string[]): VerificationReport {
  return {
    status: issues.length > 0 ? 'failed' : 'passed',
    scope: 'tool-runtime',
    checkedAt: new Date().toISOString(),
    issues,
    evidence: ['test evidence'],
    errorReason: issues.length > 0 ? 'test failure' : null,
    revisionHint: issues.length > 0 ? 'fix it' : null,
    confidence: 0.6,
  };
}

function makeApprovedAction(validatedSpec: InfrastructureSpec): ApprovedAction {
  const now = new Date().toISOString();
  return {
    id: 'approved-test',
    action: 'write-compose-artifact',
    request: { raw: 'test', normalizedPrompt: 'test', intent: 'create' },
    classification: {
      capability: 'compose-artifact-write',
      risk: 'artifact-write',
      summary: 'test approval',
      requiresApproval: true,
      mutatesRuntime: false,
      writesArtifact: true,
      writesState: false,
      callsDocker: false,
      callsMcp: false,
    },
    approval: {
      id: 'approval-test',
      requestId: 'request-test',
      decision: 'approved',
      respondedAt: now,
      approvedBy: 'cli-user',
      reason: null,
    },
    approvalMarker: {
      type: 'phase8-human-approval',
      approvalId: 'approval-test',
      approvedAt: now,
      approvedBy: 'cli-user',
    },
    validatedSpec,
    composeArtifact: {
      targetPath: 'docker-compose.yaml',
      previewContent: renderCompose(validatedSpec),
      previewSha256: 'test-hash',
      lineCount: 1,
      written: true,
      writtenAt: now,
    },
    dependencySchedule: {
      projectName: validatedSpec.projectName,
      steps: [],
      dependencyGraph: [],
      serviceStartOrder: validatedSpec.services.map((service) => service.name),
      destroyOrder: validatedSpec.services.map((service) => service.name).reverse(),
      warnings: [],
    },
    preflight: {
      status: 'passed',
      checkedAt: now,
      issues: [],
      evidence: [],
      policyFindings: [],
      verificationReport: makeVerificationReport([]),
    },
    policyFindings: [],
    dockerCalled: false,
    mcpCalled: false,
    runtimeMutation: false,
  };
}

function makeActualState(containers: RuntimeActualState['containers'] = []): RuntimeActualState {
  return {
    source: 'mcp-readonly',
    containers,
    networks: [],
    volumes: [],
    images: [],
    lastObservedAt: new Date().toISOString(),
  };
}

function makeDeployResult(approvedAction: ApprovedAction, operationId = 'op-test') {
  return {
    networksCreated: [],
    imagesPulled: [],
    containersStarted: [],
    startedAt: new Date().toISOString(),
    operationId,
    attemptScope: {
      operationId,
      approvedActionId: approvedAction.id,
      projectName: approvedAction.validatedSpec.projectName,
      attemptIndex: 0,
      createdAt: new Date().toISOString(),
    },
  };
}

function makeRevisionResult(
  revisedSpec: InfrastructureSpec,
  revisionDecision: NonNullable<PlannerRevisionResult['revisionDecision']>,
  revisionSummary = 'Planner still needs a target service.',
): PlannerRevisionResult {
  return {
    revisedSpec,
    revisionSummary,
    assumptions: ['test revision assumption'],
    revisionDecision,
    ...(revisionDecision === 'needs-user-input'
      ? {
          clarificationContext: [
            {
              id: 'test-clarification',
              severity: 'warning',
              field: 'topology',
              message: 'Planner needs a target service.',
              reason: 'Multiple services could match.',
              affectedServices: revisedSpec.services.map((service) => service.name),
              choices: [
                {
                  id: '1',
                  label: 'Use api',
                  description: 'Apply the revision to api.',
                  value: 'targetService:api',
                },
              ],
              allowOther: true,
            },
          ],
        }
      : {}),
  };
}

describe('Pre-deploy conflict diagnostics', () => {
  it('verifies against the approved revised spec instead of the original plan spec', async () => {
    const originalSpec = {
      ...makeSpec(),
      services: makeSpec().services.map((service) =>
        service.name === 'nginx' ? { ...service, ports: ['80:80'] } : service,
      ),
    };
    const revisedSpec = {
      ...makeSpec(),
      services: makeSpec().services.map((service) =>
        service.name === 'nginx' ? { ...service, ports: ['84:84'] } : service,
      ),
    };
    const observedSpecs: InfrastructureSpec[] = [];
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [
        { name: 'test-revision-nginx', image: 'nginx:stable', status: 'running', ports: ['84:84'] },
      ],
      networks: [],
      volumes: [],
      images: [],
      lastObservedAt: new Date().toISOString(),
    };
    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: async (plan) => {
          observedSpecs.push(plan.spec);
          return makeVerificationReport(
            plan.spec.services.some((service) => service.ports?.includes('84:84')) ? [] : ['PORT_MISMATCH'],
          );
        },
        reviseFromFeedback: vi.fn(),
      },
      engine: {
        deployWithDocker: vi.fn(async () => ({
          networksCreated: [],
          imagesPulled: [],
          containersStarted: [],
          startedAt: new Date().toISOString(),
          operationId: 'op-test',
          attemptScope: {
            operationId: 'op-test',
            approvedActionId: 'approved-test',
            projectName: 'test-revision',
            attemptIndex: 0,
            createdAt: new Date().toISOString(),
          },
        })),
        cleanupAttemptScope: vi.fn(),
      },
      mcpClient: {
        observeActualState: vi.fn(async () => ({ ...actual, containers: [] })),
        observeActualStateWithInspect: vi.fn(async () => actual),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 3 }),
      approvedAction: makeApprovedAction(revisedSpec),
      plan: { summary: 'original', spec: originalSpec, assumptions: [], steps: [] },
      requestRuntimeApproval: vi.fn(),
      requestRevisionClarification: vi.fn(),
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('passed');
    expect(observedSpecs[0]).toEqual(revisedSpec);
  });

  it('stops before deploy when pre-deploy conflict revision still needs user input', async () => {
    const spec = makeSpec();
    const approvedAction = makeApprovedAction(spec);
    const deployWithDocker = vi.fn(async () => makeDeployResult(approvedAction));
    const reviseFromFeedback = vi.fn(async (_request: PlannerRevisionRequest): Promise<PlannerRevisionResult> =>
      makeRevisionResult(spec, 'needs-user-input'),
    );
    const clarificationFeedbacks: Array<UserFeedback | null> = [
      { message: 'Use api', submittedAt: new Date().toISOString() },
      null,
    ];
    const requestRevisionClarification = vi.fn(async (): Promise<UserFeedback | null> =>
      clarificationFeedbacks.shift() ?? null,
    );

    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: vi.fn(async () => makeVerificationReport([])),
        reviseFromFeedback,
      },
      engine: {
        deployWithDocker,
        cleanupAttemptScope: vi.fn(),
      },
      mcpClient: {
        observeActualState: vi.fn(async () => makeActualState([{ name: 'test-revision-api', image: 'node:20-alpine', status: 'running', ports: [] }])),
        observeActualStateWithInspect: vi.fn(async () => makeActualState()),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 3 }),
      approvedAction,
      plan: { summary: 'test', spec, assumptions: [], steps: [] },
      requestRuntimeApproval: vi.fn(),
      requestRevisionClarification,
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('failed');
    expect(deployWithDocker).not.toHaveBeenCalled();
    expect(reviseFromFeedback).toHaveBeenCalledTimes(2);
    expect(requestRevisionClarification).toHaveBeenCalledTimes(2);
    expect(result.revisionHistory[0]?.revisionDecision).toBe('needs-user-input');
    expect(result.revisionHistory[0]?.userFeedback?.message).toBe('Use api');
  });

  it('stops after deploy error when revision remains ambiguous after clarification', async () => {
    const spec = makeSpec();
    const approvedAction = makeApprovedAction(spec);
    const deployWithDocker = vi.fn(async () => {
      throw new Error('MCP tool error: port allocation failed');
    });
    const reviseFromFeedback = vi.fn(async (_request: PlannerRevisionRequest): Promise<PlannerRevisionResult> =>
      makeRevisionResult(spec, 'needs-user-input'),
    );
    const clarificationFeedbacks: Array<UserFeedback | null> = [
      { message: 'Use nginx', submittedAt: new Date().toISOString() },
      null,
    ];
    const requestRevisionClarification = vi.fn(async (): Promise<UserFeedback | null> =>
      clarificationFeedbacks.shift() ?? null,
    );

    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: vi.fn(async () => makeVerificationReport([])),
        reviseFromFeedback,
      },
      engine: {
        deployWithDocker,
        cleanupAttemptScope: vi.fn(),
      },
      mcpClient: {
        observeActualState: vi.fn(async () => makeActualState()),
        observeActualStateWithInspect: vi.fn(async () => makeActualState()),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 3 }),
      approvedAction,
      plan: { summary: 'test', spec, assumptions: [], steps: [] },
      requestRuntimeApproval: vi.fn(async (): Promise<ApprovalDecision> => ({ choice: 'approved', userFeedback: null })),
      requestRevisionClarification,
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('failed');
    expect(deployWithDocker).toHaveBeenCalledTimes(1);
    expect(reviseFromFeedback).toHaveBeenCalledTimes(2);
    expect(requestRevisionClarification).toHaveBeenCalledTimes(2);
    expect(result.revisionHistory[0]?.revisionDecision).toBe('needs-user-input');
  });

  it('cleans up and stops when post-deploy verifier revision still needs user input', async () => {
    const spec = makeSpec();
    const approvedAction = makeApprovedAction(spec);
    const deployWithDocker = vi.fn(async () => makeDeployResult(approvedAction, 'op-verify'));
    const cleanupAttemptScope = vi.fn(async (): Promise<CleanupReport> => ({
      trigger: 'deploy-failed',
      attempted: [],
      succeeded: [],
      failed: [],
      leftovers: [],
    }));
    const reviseFromFeedback = vi.fn(async (_request: PlannerRevisionRequest): Promise<PlannerRevisionResult> =>
      makeRevisionResult(spec, 'needs-user-input'),
    );
    const clarificationFeedbacks: Array<UserFeedback | null> = [
      { message: 'Use api', submittedAt: new Date().toISOString() },
      null,
    ];
    const requestRevisionClarification = vi.fn(async (): Promise<UserFeedback | null> =>
      clarificationFeedbacks.shift() ?? null,
    );

    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: vi.fn(async () => makeVerificationReport(['CONTAINER_UNHEALTHY: api failed readiness'])),
        reviseFromFeedback,
      },
      engine: {
        deployWithDocker,
        cleanupAttemptScope,
      },
      mcpClient: {
        observeActualState: vi.fn(async () => makeActualState()),
        observeActualStateWithInspect: vi.fn(async () => makeActualState()),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 3 }),
      approvedAction,
      plan: { summary: 'test', spec, assumptions: [], steps: [] },
      requestRuntimeApproval: vi.fn(async (): Promise<ApprovalDecision> => ({ choice: 'approved', userFeedback: null })),
      requestRevisionClarification,
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('failed');
    expect(deployWithDocker).toHaveBeenCalledTimes(1);
    expect(cleanupAttemptScope).toHaveBeenCalledTimes(1);
    expect(reviseFromFeedback).toHaveBeenCalledTimes(2);
    expect(result.revisionHistory[0]?.revisionDecision).toBe('needs-user-input');
  });

  it('continues after clarification resolves a needs-user-input pre-deploy revision', async () => {
    const originalSpec = makeSpec();
    const revisedSpec = {
      ...makeSpec(),
      services: makeSpec().services.map((service) =>
        service.name === 'nginx' ? { ...service, name: 'edge' } : service,
      ),
    };
    const approvedAction = makeApprovedAction(originalSpec);
    const deployWithDocker = vi.fn(async (action: ApprovedAction) => makeDeployResult(action, 'op-resolved'));
    const revisionResults = [
      makeRevisionResult(originalSpec, 'needs-user-input'),
      makeRevisionResult(revisedSpec, 'auto-revised', 'Clarification resolved target service.'),
    ];
    const reviseFromFeedback = vi.fn(async (_request: PlannerRevisionRequest): Promise<PlannerRevisionResult> =>
      revisionResults.shift() ?? makeRevisionResult(revisedSpec, 'auto-revised', 'Clarification resolved target service.'),
    );
    const requestRevisionClarification = vi.fn(async (): Promise<UserFeedback | null> => ({
      message: 'User selected Use api: targetService:api',
      submittedAt: new Date().toISOString(),
    }));

    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: vi.fn(async () => makeVerificationReport([])),
        reviseFromFeedback,
      },
      engine: {
        deployWithDocker,
        cleanupAttemptScope: vi.fn(),
      },
      mcpClient: {
        observeActualState: vi
          .fn()
          .mockResolvedValueOnce(makeActualState([{ name: 'test-revision-api', image: 'node:20-alpine', status: 'running', ports: [] }]))
          .mockResolvedValue(makeActualState()),
        observeActualStateWithInspect: vi.fn(async () => makeActualState()),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 3 }),
      approvedAction,
      plan: { summary: 'test', spec: originalSpec, assumptions: [], steps: [] },
      requestRuntimeApproval: vi.fn(),
      requestRevisionClarification,
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('passed');
    expect(requestRevisionClarification).toHaveBeenCalledTimes(1);
    expect(reviseFromFeedback).toHaveBeenCalledTimes(2);
    expect(deployWithDocker).toHaveBeenCalledTimes(1);
    expect(result.currentApprovedAction.validatedSpec).toEqual(revisedSpec);
    expect(result.revisionHistory[0]?.revisionDecision).toBe('auto-revised');
  });


  it('normalizes deploy port allocation errors and uses structured other feedback before redeploy', async () => {
    const spec: InfrastructureSpec = {
      projectName: 'test-revision',
      services: [
        { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'] },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const provider = new FeedbackIntentPatchTestLlmProvider();
    const planner = new StandardPlannerAgent(provider);
    const deploySpecs: InfrastructureSpec[] = [];
    const runtimeReports: PlannerRevisionRequest['runtimeIssueReport'][] = [];
    let deployAttempt = 0;
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [],
      volumes: [],
      images: [],
      lastObservedAt: new Date().toISOString(),
    };

    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: async (plan) => {
          expect(plan.spec.services[0]?.ports).toEqual(['8080:80']);
          return makeVerificationReport([]);
        },
        reviseFromFeedback: async (request) => {
          runtimeReports.push(request.runtimeIssueReport);
          return planner.reviseFromFeedback(request);
        },
      },
      engine: {
        deployWithDocker: vi.fn(async (approvedAction: ApprovedAction) => {
          deployAttempt += 1;
          deploySpecs.push(approvedAction.validatedSpec);
          if (deployAttempt === 1) {
            throw new Error(
              'MCP tool error: Error: (HTTP code 500) server error - failed to set up container networking: driver failed programming external connectivity on endpoint test-revision-nginx: Bind for 0.0.0.0:80 failed: port is already allocated',
            );
          }
          return {
            networksCreated: [],
            imagesPulled: [],
            containersStarted: [{ name: 'test-revision-nginx', id: 'nginx-id' }],
            startedAt: new Date().toISOString(),
            operationId: 'op-retry',
            attemptScope: {
              operationId: 'op-retry',
              approvedActionId: 'approved-test',
              projectName: 'test-revision',
              attemptIndex: 1,
              createdAt: new Date().toISOString(),
            },
          };
        }),
        cleanupAttemptScope: vi.fn(),
      },
      mcpClient: {
        observeActualState: vi.fn(async () => actual),
        observeActualStateWithInspect: vi.fn(async () => ({
          ...actual,
          containers: [
            { name: 'test-revision-nginx', image: 'nginx:stable', status: 'running', ports: ['8080:80'], environment: {} },
          ],
        })),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 3 }),
      approvedAction: makeApprovedAction(spec),
      plan: { summary: 'deploy nginx', spec, assumptions: [], steps: [] },
      requestRuntimeApproval: vi.fn(async (): Promise<ApprovalDecision> => ({
        choice: 'other',
        userFeedback: { message: 'd?i sang 8080', submittedAt: new Date().toISOString() },
      })),
      requestRevisionClarification: vi.fn(),
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('passed');
    expect(deploySpecs.map((deployed) => deployed.services[0]?.ports)).toEqual([['80:80'], ['8080:80']]);
    expect(runtimeReports[0]?.issues[0]?.code).toBe('HOST_PORT_CONFLICT');
    expect(provider.feedbackIntentRequests).toHaveLength(1);
    expect(provider.patchRequests[0]).toContain('feedbackIntent');
  });

  it('turns verifier and planner observations into schema patches used by the next act', async () => {
    const originalSpec: InfrastructureSpec = {
      projectName: 'test-revision',
      services: [
        { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['api'] },
        { kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2 },
        { kind: 'database', name: 'postgres', image: 'postgres:16' },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const expectedRevisedSpec: InfrastructureSpec = {
      projectName: 'test-revision',
      services: [
        { kind: 'reverse-proxy', name: 'edge', image: 'nginx:stable', ports: ['8088:80'], dependsOn: ['app'] },
        { kind: 'backend', name: 'app', image: 'node:20-alpine', replicas: 4 },
        { kind: 'database', name: 'postgres', image: 'postgres:16' },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const planner = new StandardPlannerAgent(new FixedPatchTestLlmProvider({
      patches: [
        {
          op: 'rename-service',
          target: { name: 'api' },
          name: 'app',
          reason: 'Planner must canonicalize backend service name from verifier feedback.',
        },
        {
          op: 'set-service-replicas',
          target: { name: 'app' },
          replicas: 4,
          reason: 'Verifier observed under-capacity; next act must use four backend replicas.',
        },
        {
          op: 'rename-service',
          target: { name: 'nginx' },
          name: 'edge',
          reason: 'Planner must rename the edge proxy service.',
        },
        {
          op: 'replace-service-port',
          target: { name: 'edge' },
          from: '80:80',
          to: '8088:80',
          reason: 'Verifier observed host port conflict on 80.',
        },
      ],
      explanation: 'Apply verifier observations as schema patches before the next act.',
      assumptions: ['Verifier feedback is authoritative for this test.'],
      ambiguities: [],
      requiresUserInput: false,
      confidence: 0.95,
    }));
    const deploySpecs: InfrastructureSpec[] = [];
    const verifySpecs: InfrastructureSpec[] = [];
    const cleanupScopes: string[] = [];
    const revisionRequests: PlannerRevisionRequest[] = [];
    const actualFor = (spec: InfrastructureSpec): RuntimeActualState => ({
      source: 'mcp-readonly',
      containers: spec.services.flatMap((service) => {
        const replicas = service.replicas ?? 1;
        return Array.from({ length: replicas }, (_, index) => ({
          name: `test-revision-${service.name}${replicas > 1 ? '-' + String(index + 1) : ''}`,
          image: service.image,
          status: 'running',
          ports: service.ports ?? [],
          environment: {},
        }));
      }),
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: spec.services.map((service) => ({ reference: service.image, id: 'sha256:' + service.name, status: null })),
      lastObservedAt: new Date().toISOString(),
    });
    let currentActual = actualFor(originalSpec);

    const result = await runClosedLoopDeploy({
      agent: {
        verifyAfterApply: async (plan) => {
          verifySpecs.push(plan.spec);
          if (verifySpecs.length === 1) {
            return validateVerificationReport({
              status: 'failed',
              scope: 'tool-runtime',
              checkedAt: new Date().toISOString(),
              issues: [
                'HOST_PORT_CONFLICT: nginx host port 80 is already allocated; use host port 8088.',
                'REPLICA_MISMATCH: backend api needs 4 replicas, observed 2.',
                'SERVICE_NAME_MISMATCH: rename api to app and nginx to edge before retry.',
              ],
              findings: [
                {
                  code: 'HOST_PORT_CONFLICT',
                  severity: 'blocker',
                  resourceKind: 'port',
                  resourceName: 'nginx',
                  expected: '8088:80',
                  actual: '80:80',
                  evidence: ['Nginx must move from 80:80 to 8088:80.'],
                  confidence: 0.95,
                  suggestedAction: { action: 'auto-revise', summary: 'Replace nginx port with 8088:80.' },
                  requiresUserInput: false,
                },
                {
                  code: 'RUNTIME_DRIFT',
                  severity: 'error',
                  resourceKind: 'service',
                  resourceName: 'api',
                  expected: '4 replicas',
                  actual: '2 replicas',
                  evidence: ['Backend api must run four replicas.'],
                  confidence: 0.9,
                  suggestedAction: { action: 'auto-revise', summary: 'Set backend replicas to 4.' },
                  requiresUserInput: false,
                },
                {
                  code: 'RUNTIME_DRIFT',
                  severity: 'error',
                  resourceKind: 'service',
                  resourceName: 'api',
                  expected: 'app and edge service names',
                  actual: 'api and nginx service names',
                  evidence: ['Backend should be renamed to app and proxy to edge.'],
                  confidence: 0.9,
                  suggestedAction: { action: 'auto-revise', summary: 'Rename api to app and nginx to edge.' },
                  requiresUserInput: false,
                },
              ],
              evidence: ['Verifier produced structured findings that must be revised into schema.'],
              errorReason: 'First act does not match verifier target schema.',
              revisionHint: 'Rename services, set backend replicas to 4, and move proxy host port to 8088.',
              confidence: 0.9,
            });
          }

          expect(plan.spec).toEqual(expectedRevisedSpec);
          return makeVerificationReport([]);
        },
        reviseFromFeedback: async (request) => {
          revisionRequests.push(request);
          const revised = await planner.reviseFromFeedback(request);
          expect(revised.patchPlan?.patches.map((patch) => patch.op)).toEqual([
            'rename-service',
            'set-service-replicas',
            'rename-service',
            'replace-service-port',
          ]);
          expect(revised.revisedSpec).toEqual(expectedRevisedSpec);
          return revised;
        },
      },
      engine: {
        deployWithDocker: vi.fn(async (approvedAction: ApprovedAction) => {
          deploySpecs.push(approvedAction.validatedSpec);
          currentActual = actualFor(approvedAction.validatedSpec);
          return {
            networksCreated: approvedAction.validatedSpec.networks,
            imagesPulled: approvedAction.validatedSpec.services.map((service) => service.image),
            containersStarted: currentActual.containers.map((container) => ({ name: container.name, id: container.name + '-id' })),
            startedAt: new Date().toISOString(),
            operationId: 'op-' + String(deploySpecs.length),
            attemptScope: {
              operationId: 'op-' + String(deploySpecs.length),
              approvedActionId: 'approved-test',
              projectName: approvedAction.validatedSpec.projectName,
              attemptIndex: deploySpecs.length - 1,
              createdAt: new Date().toISOString(),
            },
          };
        }),
        cleanupAttemptScope: vi.fn(async (_mcpClient, attemptScope): Promise<CleanupReport> => {
          cleanupScopes.push(attemptScope.operationId);
          return {
            trigger: 'deploy-failed',
            attempted: [],
            succeeded: [],
            failed: [],
            leftovers: [],
          };
        }),
      },
      mcpClient: {
        observeActualState: vi.fn(async () => ({ ...currentActual, containers: [] })),
        observeActualStateWithInspect: vi.fn(async () => currentActual),
      } as unknown as DockerMcpGateway,
      closedLoopGuard: new ClosedLoopGuard({ ...DEFAULT_CLOSED_LOOP_CONFIG, maxVerifyReviseIterations: 4 }),
      approvedAction: makeApprovedAction(originalSpec),
      plan: { summary: 'original', spec: originalSpec, assumptions: ['initial'], steps: [] },
      requestRuntimeApproval: vi.fn(async (): Promise<ApprovalDecision> => ({
        choice: 'approved',
        userFeedback: {
          message: 'Apply verifier correction: backend 4 replicas, rename api to app, nginx to edge, and use port 8088:80.',
          submittedAt: new Date().toISOString(),
        },
      })),
      requestRevisionClarification: vi.fn(),
      saveVerifiedRuntimeSnapshot: vi.fn(),
    });

    expect(result.status).toBe('passed');
    expect(deploySpecs).toEqual([originalSpec, expectedRevisedSpec]);
    expect(verifySpecs).toEqual([originalSpec, expectedRevisedSpec]);
    expect(cleanupScopes).toEqual(['op-1']);
    expect(revisionRequests).toHaveLength(1);
    expect(revisionRequests[0]?.revisionObservation.verificationReport?.findings?.map((finding) => finding.code)).toEqual([
      'HOST_PORT_CONFLICT',
      'RUNTIME_DRIFT',
      'RUNTIME_DRIFT',
    ]);
    expect(revisionRequests[0]?.revisionObservation.userFeedback?.message).toContain('backend 4 replicas');
    expect(result.currentApprovedAction.validatedSpec).toEqual(expectedRevisedSpec);
    expect(result.currentPlan.spec).toEqual(expectedRevisedSpec);
    expect(result.successfulDeployResult?.containersStarted.map((container) => container.name)).toEqual([
      'test-revision-edge',
      'test-revision-app-1',
      'test-revision-app-2',
      'test-revision-app-3',
      'test-revision-app-4',
      'test-revision-postgres',
    ]);
    expect(result.revisionHistory[0]?.revisionSummary).toContain('patch(es) applied');
  });
  it('allows existing networks and volumes during pre-deploy checks', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        { kind: 'database', name: 'db', image: 'postgres:16-alpine', volumes: ['db-data:/var/lib/postgresql/data'] },
      ],
      networks: ['app-network'],
      volumes: ['db-data'],
    };
    const actual: RuntimeActualState = {
      source: 'mcp-readonly',
      containers: [],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [{ name: 'db-data', status: 'local' }],
      images: [],
      lastObservedAt: new Date().toISOString(),
    };

    const issues = detectPreDeployConflicts(desired, actual);
    const report = createConflictVerificationReport(issues);

    expect(issues).toEqual([]);
    expect(report.status).toBe('passed');
    expect(report.findings).toEqual([]);
  });
});
describe('Verification diagnostics schema', () => {
  it('validates structured findings while preserving issues compatibility', () => {
    const report = validateVerificationReport({
      status: 'failed',
      scope: 'tool-runtime',
      checkedAt: new Date().toISOString(),
      issues: ['HOST_PORT_CONFLICT: port 8088 is already used.'],
      findings: [
        {
          code: 'HOST_PORT_CONFLICT',
          severity: 'blocker',
          resourceKind: 'port',
          resourceName: 'nginx',
          expected: '8088',
          actual: 'already used',
          evidence: ['Port 8088 is bound by old-nginx.'],
          confidence: 0.98,
          suggestedAction: { action: 'auto-revise', summary: 'Choose next safe host port.' },
          requiresUserInput: false,
        },
      ],
      evidence: ['Pre-deploy runtime scan found conflict.'],
      errorReason: 'Pre-deploy conflict detection blocked unsafe deployment.',
      revisionHint: 'Pick a different host port.',
      confidence: 0.98,
    });

    expect(report.findings?.[0]?.code).toBe('HOST_PORT_CONFLICT');
    expect(report.issues[0]).toContain('HOST_PORT_CONFLICT');
  });

  it('validates revision history inside verified runtime snapshots', () => {
    const now = new Date().toISOString();
    const snapshot: InfrastructureStateSnapshot = {
      schemaVersion: 1,
      pendingPreview: null,
      current: {
        id: 'verified-runtime-test',
        request: { raw: 'create nginx', normalizedPrompt: 'create nginx', intent: 'create' },
        desired: makeSpec(),
        composeArtifact: {
          targetPath: 'docker-compose.yaml',
          previewContent: 'services:\n  api:\n    image: node:20-alpine\n',
          previewSha256: 'a'.repeat(64),
          lineCount: 3,
          written: true,
          writtenAt: now,
        },
        actual: {
          source: 'mcp-readonly',
          containers: [],
          networks: [],
          volumes: [],
          images: [],
          lastObservedAt: now,
        },
        verification: {
          status: 'failed',
          scope: 'runtime',
          checkedAt: now,
          summary: 'Runtime verification did not pass.',
          issues: ['HOST_PORT_CONFLICT: port conflict'],
          evidence: ['test evidence'],
        },
        verificationReport: makeVerificationReport(['HOST_PORT_CONFLICT: port conflict']),
        revisionHistory: [
          {
            attemptIndex: 1,
            revisionDecision: 'auto-revised',
            revisionSummary: 'Port conflict auto-revised.',
            findings: [],
            userFeedback: null,
            createdAt: now,
          },
        ],
        approvedAt: now,
        appliedAt: now,
        savedAt: now,
      },
      history: [],
    };

    const result = validateInfrastructureStateSnapshot(snapshot);

    expect(result.current?.revisionHistory?.[0]?.revisionDecision).toBe('auto-revised');
  });
});
describe('PlannerRevisionRequest schema', () => {
  it('validates a well-formed revision request', () => {
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: makeVerificationReport(['Container "api" exited']),
        userFeedback: null,
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };
    const result = validatePlannerRevisionRequest(req);
    expect(result.desiredSpec.projectName).toBe('test-revision');
    expect(result.attemptIndex).toBe(0);
  });

  it('rejects revision observation with no verifier report and no user feedback', () => {
    expect(() =>
      validateRevisionObservation({
        verificationReport: null,
        userFeedback: null,
        driftSummary: null,
      }),
    ).toThrow();
  });

  it('validates user feedback with message and timestamp', () => {
    const feedback: UserFeedback = {
      message: 'Please add a database service',
      submittedAt: new Date().toISOString(),
    };
    const result = validateUserFeedback(feedback);
    expect(result.message).toBe('Please add a database service');
  });

  it('rejects user feedback with empty message', () => {
    expect(() =>
      validateUserFeedback({ message: '', submittedAt: new Date().toISOString() }),
    ).toThrow();
  });

  it('accepts a revision request with only user feedback (no verifier report)', () => {
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'I want redis added', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 1,
    };
    const result = validatePlannerRevisionRequest(req);
    expect(result.attemptIndex).toBe(1);
  });
});

describe('StandardPlannerAgent.proposeSpec runtime context', () => {
  it('uses redacted planner summaries to avoid existing names and occupied ports', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const runtimeReader: PlannerRuntimeReader = {
      async listUsedHostPorts() {
        return [{ hostPort: '8080', containerName: 'create-web-api-web' }];
      },
      async listContainerNames() {
        return ['create-web-api-web'];
      },
      async listImageReferences() {
        return ['nginx:stable'];
      },
      async listNetworkNames() {
        return ['app-network'];
      },
      async listVolumeNames() {
        return [];
      },
      async inspectContainerSummary(name: string) {
        return {
          name,
          image: 'nginx:stable',
          status: 'running',
          ports: ['8080:80'],
          networks: ['app-network'],
          mountDestinations: ['/usr/share/nginx/html'],
          restartPolicy: 'unless-stopped',
          healthStatus: 'healthy',
        };
      },
    };

    const spec = await planner.proposeSpec(
      makeGenericValidatedQuery('create web api', [
        serviceHint({ name: 'web', image: 'nginx:stable', port: 8080 }),
        serviceHint({ name: 'api', image: 'node:20-alpine' }),
      ]),
      null,
      runtimeReader,
    );

    expect(spec.projectName).toBe('create-web-api-planned');
    expect(spec.services[0]?.ports).toBeUndefined();
  });
});

describe('StandardPlannerAgent.reviseFromFeedback', () => {
  it('produces a revised spec from verifier feedback', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: makeVerificationReport(['Container "api" is not running (status: exited).']),
        userFeedback: null,
        driftSummary: '1 drift finding(s)',
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };
    const result = await planner.reviseFromFeedback(req);
    expect(result.revisedSpec.projectName).toBe('test-revision');
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.revisionSummary).toContain('Verifier status');
  });

  it('merges verifier issues + user feedback into the revision', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: makeVerificationReport(['Container "api" exited']),
        userFeedback: { message: 'Use a different image for api', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 1,
    };
    const result = await planner.reviseFromFeedback(req);
    expect(result.assumptions.some((a) => a.includes('Revision 2'))).toBe(true);
  });

  it('re-validates the spec and returns a valid InfrastructureSpec', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'Add replicas', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 2,
    };
    const result = await planner.reviseFromFeedback(req);
    expect(result.revisedSpec.services.length).toBe(2);
  });

  it('applies user feedback that requests a new host port', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'replace-service-port', target: { name: 'nginx' }, to: '8090:80', reason: 'LLM mapped feedback to a port patch.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['8088:80'] },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'Please revise the nginx host port to 8090 before writing compose.',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['8090:80']);
    expect(result.revisionSummary).toContain('User feedback received');
  });

  it('applies user feedback that requests a full port mapping', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'replace-service-port', target: { name: 'nginx-web' }, to: '81:81', reason: 'LLM mapped feedback to a port patch.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx-web', image: 'nginx:stable', ports: ['80:80'] },
          { kind: 'backend', name: 'nodejs-backend', image: 'node:20-alpine', replicas: 2 },
          { kind: 'database', name: 'postgres', image: 'postgres:16' },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'change nginx port 80:80 to 81:81',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['81:81']);
    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches[0]?.op).toBe('replace-service-port');
    expect(result.revisionSummary).toContain('1 patch(es) applied');
  });

  it('scales an expanded database group from deterministic user feedback when LLM patches are empty', async () => {
    const planner = new StandardPlannerAgent(patchProvider([], {
      explanation: 'LLM revision output did not contain a directly applicable schema-valid patch.',
      requiresUserInput: true,
      ambiguities: ['There are currently 3 database services.'],
      confidence: 0.2,
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['api'] },
          { kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres-1'] },
          {
            kind: 'database',
            name: 'postgres-1',
            image: 'postgres:16',
            environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'password' },
            volumes: ['postgres-data-1:/var/lib/postgresql/data'],
          },
          {
            kind: 'database',
            name: 'postgres-2',
            image: 'postgres:16',
            environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'password' },
            dependsOn: ['postgres-1'],
            volumes: ['postgres-data-2:/var/lib/postgresql/data'],
          },
          {
            kind: 'database',
            name: 'postgres-3',
            image: 'postgres:16',
            environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'password' },
            dependsOn: ['postgres-1'],
            volumes: ['postgres-data-3:/var/lib/postgresql/data'],
          },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data-1', 'postgres-data-2', 'postgres-data-3'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'i want 2 database instance', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches).toEqual([
      expect.objectContaining({ op: 'set-service-replicas', target: { kind: 'database' }, replicas: 2 }),
    ]);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['nginx', 'api', 'postgres-1', 'postgres-2']);
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['postgres-1', 'postgres-2']);
    expect(result.revisedSpec.volumes).toEqual(['postgres-data-1', 'postgres-data-2']);
    expect(result.assumptions).toContain('Revision patch source: semantic feedback intent fallback replaced empty/unavailable LLM patch plan.');
  });

  it('scales up an expanded database group from deterministic user feedback by adding the next replica', async () => {
    const planner = new StandardPlannerAgent(patchProvider([], {
      explanation: 'LLM revision output did not contain a directly applicable schema-valid patch.',
      requiresUserInput: true,
      ambiguities: ['There are currently 3 database services.'],
      confidence: 0.2,
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['api'] },
          { kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres-1', 'postgres-2', 'postgres-3'] },
          {
            kind: 'database',
            name: 'postgres-1',
            image: 'postgres:16',
            environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'password' },
            volumes: ['postgres-data-1:/var/lib/postgresql/data'],
          },
          {
            kind: 'database',
            name: 'postgres-2',
            image: 'postgres:16',
            environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'password' },
            dependsOn: ['postgres-1'],
            volumes: ['postgres-data-2:/var/lib/postgresql/data'],
          },
          {
            kind: 'database',
            name: 'postgres-3',
            image: 'postgres:16',
            environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'password' },
            dependsOn: ['postgres-1'],
            volumes: ['postgres-data-3:/var/lib/postgresql/data'],
          },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data-1', 'postgres-data-2', 'postgres-data-3'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'i want 4 database instance', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches).toEqual([
      expect.objectContaining({ op: 'set-service-replicas', target: expect.objectContaining({ kind: 'database' }), replicas: 4 }),
    ]);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['nginx', 'api', 'postgres-1', 'postgres-2', 'postgres-3', 'postgres-4']);
    expect(result.revisedSpec.services.find((service) => service.name === 'postgres-4')).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-4:/var/lib/postgresql/data'],
    });
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['postgres-1', 'postgres-2', 'postgres-3', 'postgres-4']);
    expect(result.revisedSpec.volumes).toEqual(['postgres-data-1', 'postgres-data-2', 'postgres-data-3', 'postgres-data-4']);
  });

  it('resolves an nginx alias to a web service when applying a structured port mapping', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'replace-service-port', target: { imageFamily: 'nginx' }, to: '83:83', reason: 'LLM selected the nginx image family from service catalog.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'web', image: 'nginx:stable', ports: ['80:80'] },
          { kind: 'backend', name: 'backend', image: 'node:20-alpine', replicas: 2 },
          { kind: 'database', name: 'db', image: 'postgres:16' },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'change nginx port from 80:80 to 83:83',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['83:83']);
    expect(result.patchResults?.[0]?.matchedServiceNames).toEqual(['web']);
    expect(result.assumptions.some((assumption) => assumption.includes('structured patch'))).toBe(true);
  });

  it('falls back to a schema-valid port patch when structured revision output is invalid', async () => {
    const planner = new StandardPlannerAgent(new InvalidPatchTestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'web', image: 'nginx:stable', ports: ['80:80'] },
          { kind: 'backend', name: 'backend', image: 'node:20-alpine', replicas: 2 },
          { kind: 'database', name: 'db', image: 'postgres:16' },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'change nginx port from 80:80 to 83:83',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['83:83']);
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'replace-service-port',
      target: { name: 'web' },
      to: '83:83',
    });
    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.assumptions.some((assumption) => assumption.includes('fallback'))).toBe(true);
  });

  it('applies user feedback that changes only the web host port', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'replace-service-port', target: { name: 'web-nginx' }, to: '67:80', reason: 'LLM preserved the existing container port.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'web-nginx', image: 'nginx:stable', ports: ['80:80'] },
          { kind: 'backend', name: 'backend-nodejs', image: 'node:20-alpine', replicas: 2 },
          { kind: 'database', name: 'db-postgresql', image: 'postgres:16' },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'change web port from 80 to 67',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['67:80']);
    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches[0]?.op).toBe('replace-service-port');
  });

  it('falls back to a schema-valid host-port patch when structured output is invalid', async () => {
    const planner = new StandardPlannerAgent(new InvalidPatchTestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'web-nginx', image: 'nginx:stable', ports: ['80:80'] },
          { kind: 'backend', name: 'backend-nodejs', image: 'node:20-alpine', replicas: 2 },
          { kind: 'database', name: 'db-postgresql', image: 'postgres:16' },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'change web port from 80 to 67',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['67:80']);
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'replace-service-port',
      target: { kind: 'reverse-proxy' },
      to: '67:80',
    });
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('uses structured LLM patches for db instance reduction feedback', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'set-service-replicas', target: { name: 'postgres' }, replicas: 1, reason: 'LLM mapped db wording to the postgres service from catalog.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx-web', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['nodejs-backend'] },
          { kind: 'backend', name: 'nodejs-backend', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres'] },
          { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 3, ports: ['5432:5432'] },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'i want to reduce, just 1 instance db',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[2]?.replicas).toBe(1);
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'set-service-replicas',
      target: { name: 'postgres' },
      replicas: 1,
    });
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('falls back to a schema-valid db replica patch when LLM output is invalid', async () => {
    const planner = new StandardPlannerAgent(new InvalidPatchTestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['api'] },
          { kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres'] },
          { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 3 },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'just 2 instances of database only',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services.map((service) => service.name)).toEqual([
      'nginx',
      'api',
      'postgres-1',
      'postgres-2',
    ]);
    expect(result.revisedSpec.services[2]).not.toHaveProperty('replicas');
    expect(result.revisedSpec.services[3]).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-2:/var/lib/postgresql/data'],
    });
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'set-service-replicas',
      target: { kind: 'database' },
      replicas: 2,
    });
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('falls back for Vietnamese no-accent database scale feedback', async () => {
    const planner = new StandardPlannerAgent(new InvalidPatchTestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'web', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['backend'] },
          { kind: 'backend', name: 'backend', image: 'node:20-alpine', replicas: 2, dependsOn: ['db'] },
          { kind: 'database', name: 'db', image: 'postgres:16', replicas: 3 },
        ],
        networks: ['app-network'],
        volumes: ['db-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'giam xuong con 2 instance db thoi',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual([
      'web',
      'backend',
      'db-1',
      'db-2',
    ]);
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'set-service-replicas',
      target: { name: 'db' },
      replicas: 2,
    });
  });

  it('normalizes non-contract LLM patch aliases before applying feedback', async () => {
    const planner = new StandardPlannerAgent(new RawPatchTestLlmProvider({
      patches: [
        {
          op: 'update-service-replicas',
          serviceName: 'postgres',
          count: 2,
        },
      ],
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 3 },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'just 2 instances of database only',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services.map((service) => service.name)).toEqual([
      'postgres-1',
      'postgres-2',
    ]);
    expect(result.revisedSpec.services[0]).not.toHaveProperty('replicas');
    expect(result.revisedSpec.services[1]).toMatchObject({
      dependsOn: ['postgres-1'],
      volumes: ['postgres-data-2:/var/lib/postgresql/data'],
    });
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'set-service-replicas',
      target: { name: 'postgres' },
      replicas: 2,
    });
    expect(result.patchPlan?.explanation).toContain('Normalized LLM revision output');
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('normalizes camelCase LLM replica patch output with selector target', async () => {
    const planner = new StandardPlannerAgent(new RawPatchTestLlmProvider({
      patches: [
        {
          op: 'setReplicas',
          selector: { name: 'db', kind: 'database', imageFamily: 'postgres' },
          replicas: 2,
        },
      ],
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'web', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['backend'] },
          { kind: 'backend', name: 'backend', image: 'node:20-alpine', replicas: 2, dependsOn: ['db'] },
          { kind: 'database', name: 'db', image: 'postgres:16', replicas: 3 },
        ],
        networks: ['app-network'],
        volumes: ['db-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'giam xuong con 2 instance db thoi',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual([
      'web',
      'backend',
      'db-1',
      'db-2',
    ]);
    expect(result.patchPlan?.patches[0]).toMatchObject({
      op: 'set-service-replicas',
      target: { name: 'db', kind: 'database', imageFamily: 'postgres' },
      replicas: 2,
    });
  });

  it('asks the user to choose from current services when replica feedback has no clear target', async () => {
    const planner = new StandardPlannerAgent(patchProvider([], {
      explanation: 'Target service is ambiguous.',
      assumptions: ['The current service catalog has multiple plausible targets.'],
      ambiguities: ['Which existing service should receive the requested replica/instance count?'],
      requiresUserInput: true,
      confidence: 0.35,
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx-web', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['nodejs-backend'] },
          { kind: 'backend', name: 'nodejs-backend', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres'] },
          { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 3, ports: ['5432:5432'] },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'reduce to 1 instance',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('needs-user-input');
    expect(result.revisedSpec.services[1]?.replicas).toBe(2);
    expect(result.revisedSpec.services[2]?.replicas).toBe(3);
    expect(result.clarificationContext?.[0]?.choices.map((choice) => choice.value)).toEqual([
      'targetService:nginx-web',
      'targetService:nodejs-backend',
      'targetService:postgres',
    ]);
  });

  it('uses an other clarification target with verifier context still present', async () => {
    const provider = new RecordingPatchTestLlmProvider({
      patches: [{ op: 'set-service-replicas', target: { name: 'postgres' }, replicas: 1, reason: 'Real LLM mapped user feedback to the selected service.' }],
      explanation: 'Apply selected database replica count.',
      assumptions: ['The selected targetService value identifies postgres.'],
      ambiguities: [],
      requiresUserInput: false,
      confidence: 0.9,
    });
    const planner = new StandardPlannerAgent(provider);
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx-web', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['nodejs-backend'] },
          { kind: 'backend', name: 'nodejs-backend', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres'] },
          { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 3, ports: ['5432:5432'] },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data'],
      },
      revisionObservation: {
        verificationReport: makeVerificationReport(['REPLICA_MISMATCH: target selection needed before revision.']),
        userFeedback: {
          message: 'User selected Postgres: targetService:postgres. reduce to 1 instance',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      resourceRefs: {
        projectName: 'sample-infra',
        containers: ['sample-infra-postgres-1', 'sample-infra-postgres-2', 'sample-infra-postgres-3'],
        networks: ['sample-infra_app-network'],
        volumes: ['sample-infra_postgres-data'],
        images: ['postgres:16'],
      },
      attemptIndex: 1,
    };

    const result = await planner.reviseFromFeedback(req);
    const patchPayload = JSON.parse(provider.patchRequests[0] ?? '{}') as {
      serviceCatalog?: unknown;
      verifierObservation?: { issues?: string[] };
      userFeedback?: { message?: string };
      runtimeRefs?: { containers?: string[] };
    };

    expect(result.revisedSpec.services[2]?.replicas).toBe(1);
    expect(result.patchPlan?.patches[0]).toMatchObject({ target: { name: 'postgres' } });
    expect(Array.isArray(patchPayload.serviceCatalog)).toBe(true);
    expect(patchPayload.verifierObservation?.issues).toContain('REPLICA_MISMATCH: target selection needed before revision.');
    expect(patchPayload.userFeedback?.message).toContain('targetService:postgres');
    expect(patchPayload.runtimeRefs?.containers).toContain('sample-infra-postgres-1');
  });

  it('applies user feedback that requests backend replicas through structured patches', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'set-service-replicas', target: { name: 'nodejs-backend' }, replicas: 3, reason: 'LLM mapped backend wording to nodejs-backend.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx-web', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['nodejs-backend'] },
          { kind: 'backend', name: 'nodejs-backend', image: 'node:20-alpine', replicas: 2 },
          { kind: 'database', name: 'postgres', image: 'postgres:16' },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'set backend replicas to 3',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[1]?.replicas).toBe(3);
    expect(result.patchPlan?.patches[0]?.op).toBe('set-service-replicas');
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('applies multiple replica changes from one fallback feedback sentence', async () => {
    const planner = new StandardPlannerAgent(new InvalidPatchTestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['80:80'], dependsOn: ['api'] },
          { kind: 'backend', name: 'api', image: 'node:20-alpine', replicas: 2, dependsOn: ['postgres-1', 'postgres-2', 'postgres-3'] },
          { kind: 'database', name: 'postgres-1', image: 'postgres:16', volumes: ['postgres-data-1:/var/lib/postgresql/data'] },
          { kind: 'database', name: 'postgres-2', image: 'postgres:16', dependsOn: ['postgres-1'], volumes: ['postgres-data-2:/var/lib/postgresql/data'] },
          { kind: 'database', name: 'postgres-3', image: 'postgres:16', dependsOn: ['postgres-1'], volumes: ['postgres-data-3:/var/lib/postgresql/data'] },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data-1', 'postgres-data-2', 'postgres-data-3'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'i want 1 instance of backend and 2 instance databse',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.patchPlan?.patches).toMatchObject([
      { op: 'set-service-replicas', target: { kind: 'backend' }, replicas: 1 },
      { op: 'set-service-replicas', target: { kind: 'database' }, replicas: 2 },
    ]);
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.replicas).toBe(1);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['nginx', 'api', 'postgres-1', 'postgres-2']);
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['postgres-1', 'postgres-2']);
    expect(result.revisedSpec.volumes).toEqual(['postgres-data-1', 'postgres-data-2']);
    expect(result.revisionSummary).toContain('2 patch(es) applied.');
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('applies user feedback that requests adding a cache service through structured patches', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'add-service', service: { kind: 'database', name: 'redis', image: 'redis:7-alpine' }, reason: 'LLM mapped cache request to Redis service.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'thêm redis cache cho backend',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services.some((service) => service.name === 'redis')).toBe(true);
    expect(result.revisedSpec.services.find((service) => service.name === 'redis')?.image).toBe('redis:7-alpine');
    expect(result.patchPlan?.patches[0]?.op).toBe('add-service');
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('normalizes feedback intent add-service environment entries before applying patches', async () => {
    const planner = new StandardPlannerAgent(new FixedFeedbackIntentTestLlmProvider({
      source: 'user-other-feedback',
      rawText: 'add redis with env',
      intent: 'add-service',
      desiredChange: {
        service: {
          kind: 'database',
          name: 'redis',
          image: 'redis:7-alpine',
          environment: [{ key: 'REDIS_MODE', value: 'cache' }],
        },
      },
      confidence: 0.9,
      ambiguities: [],
      requiresUserInput: false,
    }));

    const result = await planner.reviseFromFeedback({
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'add redis with env', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    });

    expect(result.patchPlan?.patches).toMatchObject([
      { op: 'add-service', service: { name: 'redis', environment: { REDIS_MODE: 'cache' } } },
    ]);
    expect(result.revisedSpec.services.find((service) => service.name === 'redis')?.environment).toEqual({ REDIS_MODE: 'cache' });
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('converts feedback intent env entries into set-service-env patches', async () => {
    const planner = new StandardPlannerAgent(new FixedFeedbackIntentTestLlmProvider({
      source: 'user-other-feedback',
      rawText: 'set api env',
      intent: 'change-env',
      target: { resourceKind: 'environment', serviceSelector: { name: 'api' } },
      desiredChange: {
        environment: [
          { key: 'NODE_ENV', value: 'production' },
          { key: 'LOG_LEVEL', value: 'debug' },
        ],
      },
      confidence: 0.94,
      ambiguities: [],
      requiresUserInput: false,
    }));

    const result = await planner.reviseFromFeedback({
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'set api env', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    });

    expect(result.patchPlan?.patches).toMatchObject([
      { op: 'set-service-env', target: { name: 'api' }, key: 'NODE_ENV', value: 'production' },
      { op: 'set-service-env', target: { name: 'api' }, key: 'LOG_LEVEL', value: 'debug' },
    ]);
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.environment).toEqual({
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
    });
  });

  it('converts feedback intent remove-env into remove-service-env patches', async () => {
    const planner = new StandardPlannerAgent(new FixedFeedbackIntentTestLlmProvider({
      source: 'user-other-feedback',
      rawText: 'remove api debug env',
      intent: 'remove-env',
      target: { resourceKind: 'environment', serviceSelector: { name: 'api' }, currentValue: 'DEBUG' },
      confidence: 0.9,
      ambiguities: [],
      requiresUserInput: false,
    }));
    const spec = makeSpec();
    spec.services[0] = { ...spec.services[0]!, environment: { DEBUG: 'true', NODE_ENV: 'production' } };

    const result = await planner.reviseFromFeedback({
      desiredSpec: spec,
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'remove api debug env', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    });

    expect(result.patchPlan?.patches).toMatchObject([
      { op: 'remove-service-env', target: { name: 'api' }, key: 'DEBUG' },
    ]);
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.environment).toEqual({ NODE_ENV: 'production' });
  });

  it('converts feedback intent volume dependency status project and network changes', async () => {
    const cases: Array<{ intent: unknown; expectedPatch: unknown; assertSpec: (spec: InfrastructureSpec) => void }> = [
      {
        intent: {
          source: 'user-other-feedback', rawText: 'add api volume', intent: 'change-volume',
          target: { resourceKind: 'volume', serviceSelector: { name: 'api' } },
          desiredChange: { volumes: ['api-data:/data'] }, confidence: 0.9, ambiguities: [], requiresUserInput: false,
        },
        expectedPatch: { op: 'add-service-volume', target: { name: 'api' }, volume: 'api-data:/data' },
        assertSpec: (spec) => expect(spec.services.find((service) => service.name === 'api')?.volumes).toEqual(['api-data:/data']),
      },
      {
        intent: {
          source: 'user-other-feedback', rawText: 'add nginx dependency on api', intent: 'change-dependency',
          target: { resourceKind: 'service', serviceSelector: { name: 'nginx' } },
          desiredChange: { dependencies: ['api'] }, confidence: 0.9, ambiguities: [], requiresUserInput: false,
        },
        expectedPatch: { op: 'add-service-dependency', target: { name: 'nginx' }, dependencyName: 'api' },
        assertSpec: (spec) => expect(spec.services.find((service) => service.name === 'nginx')?.dependsOn).toEqual(['api']),
      },
      {
        intent: {
          source: 'user-other-feedback', rawText: 'stop api', intent: 'change-status',
          target: { resourceKind: 'service', serviceSelector: { name: 'api' } },
          desiredChange: { desiredStatus: 'stopped' }, confidence: 0.9, ambiguities: [], requiresUserInput: false,
        },
        expectedPatch: { op: 'set-service-desired-status', target: { name: 'api' }, desiredStatus: 'stopped' },
        assertSpec: (spec) => expect(spec.services.find((service) => service.name === 'api')?.desiredStatus).toBe('stopped'),
      },
      {
        intent: {
          source: 'user-other-feedback', rawText: 'rename project', intent: 'change-project',
          target: { resourceKind: 'project' }, desiredChange: { name: 'demo-prod' }, confidence: 0.9, ambiguities: [], requiresUserInput: false,
        },
        expectedPatch: { op: 'set-project-name', name: 'demo-prod' },
        assertSpec: (spec) => expect(spec.projectName).toBe('demo-prod'),
      },
      {
        intent: {
          source: 'user-other-feedback', rawText: 'rename network', intent: 'rename-network',
          target: { resourceKind: 'network', currentValue: 'app-network' }, desiredChange: { name: 'prod-network' }, confidence: 0.9, ambiguities: [], requiresUserInput: false,
        },
        expectedPatch: { op: 'rename-network', from: 'app-network', to: 'prod-network' },
        assertSpec: (spec) => expect(spec.networks).toEqual(['prod-network']),
      },
      {
        intent: {
          source: 'user-other-feedback', rawText: 'set networks', intent: 'set-networks',
          target: { resourceKind: 'network' }, desiredChange: { networks: ['frontend', 'backend'] }, confidence: 0.9, ambiguities: [], requiresUserInput: false,
        },
        expectedPatch: { op: 'set-networks', networks: ['frontend', 'backend'] },
        assertSpec: (spec) => expect(spec.networks).toEqual(['frontend', 'backend']),
      },
    ];

    for (const testCase of cases) {
      const planner = new StandardPlannerAgent(new FixedFeedbackIntentTestLlmProvider(testCase.intent));
      const result = await planner.reviseFromFeedback({
        desiredSpec: makeSpec(),
        revisionObservation: {
          verificationReport: null,
          userFeedback: { message: String((testCase.intent as { rawText: string }).rawText), submittedAt: new Date().toISOString() },
          driftSummary: null,
        },
        stateSnapshot: null,
        attemptIndex: 0,
      });

      expect(result.patchPlan?.patches[0]).toMatchObject(testCase.expectedPatch as Record<string, unknown>);
      testCase.assertSpec(result.revisedSpec);
    }
  });

  it('blocks risky structured patches and returns clarification context', async () => {
    const planner = new StandardPlannerAgent(new FixedPatchTestLlmProvider({
      patches: [
        {
          op: 'remove-service',
          target: { name: 'api' },
          reason: 'User asked to remove the backend service.',
        },
      ],
      explanation: 'Remove backend service requested by user.',
      assumptions: [],
      ambiguities: [],
      requiresUserInput: false,
      confidence: 0.8,
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'remove api service', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['api', 'nginx']);
    expect(result.revisionDecision).toBe('needs-user-input');
    expect(result.patchResults?.[0]?.blockedReason).toContain('Removing a service requires explicit user confirmation');
    expect(result.clarificationContext?.[0]?.choices[0]?.value).toBe('allow:remove-service');
  });

  it('applies a risky structured patch after explicit allow feedback', async () => {
    const planner = new StandardPlannerAgent(new FixedPatchTestLlmProvider({
      patches: [
        {
          op: 'remove-service',
          target: { name: 'api' },
          reason: 'User explicitly allowed removing the backend service.',
        },
      ],
      explanation: 'Remove backend service after explicit confirmation.',
      assumptions: [],
      ambiguities: [],
      requiresUserInput: false,
      confidence: 0.8,
    }));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'User selected Allow patch: allow:remove-service', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 1,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['nginx']);
    expect(result.revisedSpec.services[0]?.dependsOn).toBeUndefined();
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('treats database reduction feedback as a replica-count change for the database group', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeThreeDatabaseSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'giam xuong 2 db instance thoi', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['api', 'nginx', 'postgres-1', 'postgres-2']);
    expect(result.patchPlan?.patches).toEqual([
      expect.objectContaining({ op: 'set-service-replicas', target: { kind: 'database' }, replicas: 2 }),
    ]);
    expect(result.patchResults?.[0]?.blockedReason).toBeNull();
  });

  it('treats database group total feedback as one logical replica patch down to suffix 1', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeThreeDatabaseSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'i mean total instance in database group is 1, not each is one', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches).toEqual([
      expect.objectContaining({
        op: 'set-service-replicas',
        target: expect.objectContaining({ targetKind: 'replica-group', name: 'postgres', kind: 'database', imageFamily: 'postgres' }),
        replicas: 1,
      }),
    ]);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['api', 'nginx', 'postgres-1']);
    expect(result.revisedSpec.services.find((service) => service.name === 'api')?.dependsOn).toEqual(['postgres-1']);
    expect(result.revisedSpec.volumes).toEqual(['postgres-data-1']);
  });

  it('applies LLM replica-group target patches without physical service ambiguity', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      {
        op: 'set-service-replicas',
        target: { targetKind: 'replica-group', name: 'postgres', kind: 'database', imageFamily: 'postgres' },
        replicas: 4,
        reason: 'LLM targeted the logical postgres replica group.',
      },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeThreeDatabaseSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'set database group to total 4 instances', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchResults?.[0]?.blockedReason).toBeNull();
    expect(result.patchResults?.[0]?.matchedServiceNames).toEqual(['postgres-1', 'postgres-2', 'postgres-3']);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual([
      'api',
      'nginx',
      'postgres-1',
      'postgres-2',
      'postgres-3',
      'postgres-4',
    ]);
  });

  it('repairs per-physical database replica patches into one logical group patch for total feedback', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      {
        op: 'set-service-replicas',
        target: { name: 'postgres-1' },
        replicas: 1,
        reason: 'LLM incorrectly targeted physical replica 1.',
      },
      {
        op: 'set-service-replicas',
        target: { name: 'postgres-2' },
        replicas: 1,
        reason: 'LLM incorrectly targeted physical replica 2.',
      },
      {
        op: 'set-service-replicas',
        target: { name: 'postgres-3' },
        replicas: 1,
        reason: 'LLM incorrectly targeted physical replica 3.',
      },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeThreeDatabaseSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'total instance in database group is 1', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches).toEqual([
      expect.objectContaining({
        op: 'set-service-replicas',
        target: expect.objectContaining({ targetKind: 'replica-group', name: 'postgres', kind: 'database', imageFamily: 'postgres' }),
        replicas: 1,
      }),
    ]);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['api', 'nginx', 'postgres-1']);
    expect(result.revisedSpec.volumes).toEqual(['postgres-data-1']);
  });

  it('sends logical and physical service catalogs to revision patch planning', async () => {
    const provider = new RecordingPatchTestLlmProvider({
      patches: [],
      explanation: 'No patch needed for payload inspection.',
      assumptions: [],
      ambiguities: [],
      requiresUserInput: true,
      confidence: 0.1,
    });
    const planner = new StandardPlannerAgent(provider);
    const req: PlannerRevisionRequest = {
      desiredSpec: makeThreeDatabaseSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'which database services exist?', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    await planner.reviseFromFeedback(req);

    const payload = JSON.parse(provider.patchRequests[0] ?? '{}');
    expect(payload.logicalServiceCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'postgres',
        role: 'database',
        imageFamily: 'postgres',
        stateful: true,
        currentDesiredInstances: 3,
        expandedServices: ['postgres-1', 'postgres-2', 'postgres-3'],
      }),
    ]));
    expect(payload.physicalServiceCatalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'postgres-1', replicaGroup: 'postgres', ordinal: 1, physicalInstances: 1 }),
      expect.objectContaining({ name: 'postgres-2', replicaGroup: 'postgres', ordinal: 2, physicalInstances: 1 }),
      expect.objectContaining({ name: 'postgres-3', replicaGroup: 'postgres', ordinal: 3, physicalInstances: 1 }),
    ]));
  });

  it('normalizes malformed LLM feedback intent into a database replica patch', async () => {
    const planner = new StandardPlannerAgent(new MalformedDatabaseFeedbackIntentTestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeThreeDatabaseSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'i want total 4 instance database', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('auto-revised');
    expect(result.patchPlan?.patches).toEqual([
      expect.objectContaining({ op: 'set-service-replicas', target: expect.objectContaining({ kind: 'database' }), replicas: 4 }),
    ]);
    expect(result.revisedSpec.services.map((service) => service.name)).toEqual([
      'api',
      'nginx',
      'postgres-1',
      'postgres-2',
      'postgres-3',
      'postgres-4',
    ]);
    expect(result.revisedSpec.volumes).toEqual([
      'postgres-data-1',
      'postgres-data-2',
      'postgres-data-3',
      'postgres-data-4',
    ]);
  });

  it('requires user input when database replica feedback has no clear group target', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'test-revision',
        services: [
          { kind: 'database', name: 'postgres', image: 'postgres:16', replicas: 2 },
          { kind: 'database', name: 'redis', image: 'redis:7', replicas: 2 },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data', 'redis-data'],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: { message: 'giam xuong 1 db instance', submittedAt: new Date().toISOString() },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('needs-user-input');
    expect(result.revisedSpec.services.find((service) => service.name === 'postgres')?.replicas).toBe(2);
    expect(result.revisedSpec.services.find((service) => service.name === 'redis')?.replicas).toBe(2);
    expect(result.patchPlan?.patches).toEqual([]);
    expect(result.patchPlan?.ambiguities).toContain('Multiple database services match the feedback.');
  });

  it('applies user feedback that requests a network rename and rerenders compose from spec', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'rename-network', to: 'project1', reason: 'LLM mapped feedback to network rename.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'change network name to project1',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);
    const compose = renderCompose(result.revisedSpec);

    expect(result.revisedSpec.networks).toEqual(['project1']);
    expect(compose).toContain('project1:');
    expect(compose).not.toContain('app-network');
  });

  it('applies user feedback that renames a service and updates dependencies', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'rename-service', target: { name: 'api' }, name: 'backend', reason: 'LLM mapped feedback to service rename.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'rename api to backend',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services.map((service) => service.name)).toEqual(['backend', 'nginx']);
    expect(result.revisedSpec.services[1]?.dependsOn).toEqual(['backend']);
  });

  it('applies user feedback that adds and removes simple dependencies', async () => {
    const addPlanner = new StandardPlannerAgent(patchProvider([
      { op: 'add-service-dependency', target: { name: 'api' }, dependencyName: 'db', reason: 'LLM mapped feedback to dependency add.' },
    ]));
    const addReq: PlannerRevisionRequest = {
      desiredSpec: {
        ...makeSpec(),
        services: [
          { kind: 'backend', name: 'api', image: 'node:20-alpine' },
          { kind: 'database', name: 'db', image: 'postgres:16-alpine' },
        ],
      },
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'add dependency api depends on db',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const addResult = await addPlanner.reviseFromFeedback(addReq);

    expect(addResult.revisedSpec.services[0]?.dependsOn).toEqual(['db']);

    const removePlanner = new StandardPlannerAgent(patchProvider([
      { op: 'remove-service-dependency', target: { name: 'api' }, dependencyName: 'db', reason: 'LLM mapped feedback to dependency removal.' },
    ]));
    const removeResult = await removePlanner.reviseFromFeedback({
      ...addReq,
      desiredSpec: addResult.revisedSpec,
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'remove dependency api on db',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      attemptIndex: 1,
    });

    expect(removeResult.revisedSpec.services[0]?.dependsOn).toBeUndefined();
  });

  it('applies verifier observe for missing network by patching spec networks', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: { ...makeSpec(), networks: [] },
      revisionObservation: {
        verificationReport: makeVerificationReport(['missing-network: project1']),
        userFeedback: null,
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.networks).toEqual(['project1']);
  });

  it('asks for user input when feedback has no safe deterministic patch', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: null,
        userFeedback: {
          message: 'make it more production ready somehow',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec).toEqual(req.desiredSpec);
    expect(result.revisionDecision).toBe('needs-user-input');
    expect(result.assumptions.some((assumption) => assumption.includes('no schema-valid feedback patch could be inferred safely'))).toBe(true);
  });

  it('applies user feedback that requests a replacement image', async () => {
    const planner = new StandardPlannerAgent(patchProvider([
      { op: 'set-service-image', target: { name: 'node' }, image: 'nginx:stable', reason: 'LLM mapped feedback to image replacement.' },
      { op: 'replace-service-port', target: { name: 'node' }, to: '8092:80', reason: 'LLM mapped feedback to host port replacement.' },
    ]));
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'backend', name: 'node', image: 'node:20-alpine', ports: ['8091:8091'] },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: makeVerificationReport(['Container "sample-infra-node" is not running (status: exited).']),
        userFeedback: {
          message: 'Use nginx image and host port 8092 for node.',
          submittedAt: new Date().toISOString(),
        },
        driftSummary: 'Container exited after deploy',
      },
      stateSnapshot: null,
      attemptIndex: 1,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.kind).toBe('reverse-proxy');
    expect(result.revisedSpec.services[0]?.image).toBe('nginx:stable');
    expect(result.revisedSpec.services[0]?.ports).toEqual(['8092:80']);
  });

  it('auto-resolves structured host port conflicts to the next safe port', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['8088:80'] },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: {
          ...makeVerificationReport(['Host port conflict: service "nginx" wants 8088, already used by old-nginx.']),
          findings: [
            {
              code: 'HOST_PORT_CONFLICT',
              severity: 'blocker',
              resourceKind: 'port',
              resourceName: 'nginx',
              expected: '8088',
              actual: 'already used',
              evidence: ['Host port conflict: service "nginx" wants 8088, already used by old-nginx.'],
              confidence: 0.98,
              suggestedAction: { action: 'auto-revise', summary: 'Choose next host port.' },
              requiresUserInput: false,
            },
          ],
        },
        userFeedback: null,
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['8089:80']);
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('skips multiple occupied ports when auto-resolving conflicts', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: {
        projectName: 'sample-infra',
        services: [
          { kind: 'reverse-proxy', name: 'nginx', image: 'nginx:stable', ports: ['8088:80'] },
        ],
        networks: ['app-network'],
        volumes: [],
      },
      revisionObservation: {
        verificationReport: {
          ...makeVerificationReport([
            'Host port conflict: service "nginx" wants 8088, already used by old-nginx.',
            'Host port conflict: service "nginx" wants 8089, already used by older-nginx.',
          ]),
          findings: [
            {
              code: 'HOST_PORT_CONFLICT',
              severity: 'blocker',
              resourceKind: 'port',
              resourceName: 'nginx',
              expected: '8088',
              actual: 'old-nginx',
              evidence: ['Host port conflict: service "nginx" wants 8088, already used by old-nginx.'],
              confidence: 0.98,
              suggestedAction: { action: 'auto-revise', summary: 'Choose next host port.' },
              requiresUserInput: false,
            },
            {
              code: 'HOST_PORT_CONFLICT',
              severity: 'blocker',
              resourceKind: 'port',
              resourceName: 'nginx',
              expected: '8089',
              actual: 'older-nginx',
              evidence: ['Host port conflict: service "nginx" wants 8089, already used by older-nginx.'],
              confidence: 0.98,
              suggestedAction: { action: 'auto-revise', summary: 'Choose next host port.' },
              requiresUserInput: false,
            },
          ],
        },
        userFeedback: null,
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec.services[0]?.ports).toEqual(['8090:80']);
    expect(result.revisionDecision).toBe('auto-revised');
  });

  it('asks user when image-not-found has no supported fallback', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: {
          ...makeVerificationReport(['IMAGE_NOT_FOUND: private image unavailable.']),
          findings: [
            {
              code: 'IMAGE_NOT_FOUND',
              severity: 'error',
              resourceKind: 'image',
              resourceName: 'api',
              expected: 'private.registry.local/api:missing',
              actual: 'not found',
              evidence: ['Image private.registry.local/api:missing was not found locally or remotely.'],
              confidence: 0.8,
              suggestedAction: { action: 'ask-user', summary: 'Choose a supported fallback image or provide credentials.' },
              requiresUserInput: false,
            },
          ],
        },
        userFeedback: null,
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('needs-user-input');
    expect(result.clarificationContext?.[0]?.field).toBe('services[].image');
    expect(result.clarificationContext?.[0]?.allowOther).toBe(true);
  });

  it('keeps runtime drift as a repair decision instead of blindly changing spec', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const desiredSpec = makeSpec();
    const req: PlannerRevisionRequest = {
      desiredSpec,
      revisionObservation: {
        verificationReport: {
          ...makeVerificationReport(['RUNTIME_DRIFT: container stopped outside desired state.']),
          findings: [
            {
              code: 'RUNTIME_DRIFT',
              severity: 'error',
              resourceKind: 'runtime',
              resourceName: 'test-revision-api',
              expected: 'running',
              actual: 'exited',
              evidence: ['Container stopped outside desired state.'],
              confidence: 0.75,
              suggestedAction: { action: 'repair-runtime', summary: 'Start the stopped container instead of changing the spec.' },
              requiresUserInput: false,
            },
          ],
        },
        userFeedback: null,
        driftSummary: '1 drift finding(s)',
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisedSpec).toEqual(desiredSpec);
    expect(result.revisionDecision).toBe('no-safe-resolution');
  });
  it('marks ambiguous unhealthy findings as needing user input', async () => {
    const planner = new StandardPlannerAgent(new TestLlmProvider());
    const req: PlannerRevisionRequest = {
      desiredSpec: makeSpec(),
      revisionObservation: {
        verificationReport: {
          ...makeVerificationReport(['CONTAINER_UNHEALTHY: database startup failed with ambiguous logs.']),
          findings: [
            {
              code: 'CONTAINER_UNHEALTHY',
              severity: 'error',
              resourceKind: 'container',
              resourceName: 'test-revision-db',
              expected: 'healthy',
              actual: 'unhealthy',
              evidence: ['database startup failed with ambiguous logs'],
              confidence: 0.6,
              suggestedAction: { action: 'ask-user', summary: 'Need database env/secret guidance.' },
              requiresUserInput: true,
            },
          ],
        },
        userFeedback: null,
        driftSummary: null,
      },
      stateSnapshot: null,
      attemptIndex: 0,
    };

    const result = await planner.reviseFromFeedback(req);

    expect(result.revisionDecision).toBe('needs-user-input');
    expect(result.clarificationContext?.[0]?.allowOther).toBe(true);
  });
});

describe('RevisionObservation merge (agent + user)', () => {
  it('combines verifier report and user message into one observation', () => {
    const verifierReport = makeVerificationReport(['Container "api" exited', 'Port mismatch']);
    const userFeedback: UserFeedback = {
      message: 'The api needs a real command',
      submittedAt: new Date().toISOString(),
    };
    const obs: RevisionObservation = {
      verificationReport: verifierReport,
      userFeedback,
      driftSummary: 'drift detected',
    };
    const validated = validateRevisionObservation(obs);
    expect(validated.verificationReport).not.toBeNull();
    expect(validated.verificationReport!.issues).toHaveLength(2);
    expect(validated.userFeedback).not.toBeNull();
    expect(validated.userFeedback!.message).toBe('The api needs a real command');
    expect(validated.driftSummary).toBe('drift detected');
  });
});

describe('ClosedLoopGuard', () => {
  it('allows iterations up to the budget', () => {
    const guard = new ClosedLoopGuard({
      maxVerifyReviseIterations: 3,
      specStagnationTolerance: 5,
      repeatedFailureTolerance: 5,
    });
    const specHash = hashSpec(makeSpec());
    guard.tick(specHash, 'issue-1');
    guard.tick(specHash + 'changed', 'issue-2');
    guard.tick(specHash + 'again', 'issue-3');
    expect(guard.iterationCount).toBe(3);
  });

  it('stops on iteration budget exhaustion', () => {
    const guard = new ClosedLoopGuard({
      maxVerifyReviseIterations: 2,
      specStagnationTolerance: 10,
      repeatedFailureTolerance: 10,
    });
    const specHash = hashSpec(makeSpec());
    guard.tick(specHash, 'a');
    guard.tick(specHash + 'b', 'b');
    expect(() => guard.tick(specHash + 'c', 'c')).toThrow(ClosedLoopGuardError);
  });

  it('stops on spec stagnation (same spec hash repeated)', () => {
    const guard = new ClosedLoopGuard({
      maxVerifyReviseIterations: 10,
      specStagnationTolerance: 2,
      repeatedFailureTolerance: 10,
    });
    const specHash = hashSpec(makeSpec());
    guard.tick(specHash, 'a');
    guard.tick(specHash, 'b');
    expect(() => guard.tick(specHash, 'c')).toThrow(ClosedLoopGuardError);
  });

  it('stops on repeated failure (same failure signature)', () => {
    const guard = new ClosedLoopGuard({
      maxVerifyReviseIterations: 10,
      specStagnationTolerance: 10,
      repeatedFailureTolerance: 2,
    });
    const sig = ClosedLoopGuard.failureSignature(['container exited', 'port mismatch']);
    guard.tick(hashSpec(makeSpec()), sig);
    guard.tick(hashSpec(makeSpec()) + 'x', sig);
    expect(() => guard.tick(hashSpec(makeSpec()) + 'y', sig)).toThrow(ClosedLoopGuardError);
  });

  it('builds a deterministic failure signature from issues', () => {
    const sig1 = ClosedLoopGuard.failureSignature(['Container exited', 'Port mismatch']);
    const sig2 = ClosedLoopGuard.failureSignature(['Port mismatch', 'Container exited']);
    expect(sig1).toBe(sig2);
  });

  it('uses default config values when no config provided', () => {
    expect(DEFAULT_CLOSED_LOOP_CONFIG.maxVerifyReviseIterations).toBe(5);
    expect(DEFAULT_CLOSED_LOOP_CONFIG.specStagnationTolerance).toBe(3);
    expect(DEFAULT_CLOSED_LOOP_CONFIG.repeatedFailureTolerance).toBe(3);
  });
});

describe('Repair planning from runtime drift', () => {
  it('starts an exited container without planning a redundant recreate for missing ports', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'reverse-proxy',
          name: 'nginx',
          image: 'nginx:stable',
          ports: ['8088:80'],
        },
      ],
      networks: ['app-network'],
      volumes: [],
    };

    const drift = buildDriftReport(desired, {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-nginx',
          image: 'nginx:stable',
          status: 'exited',
          ports: [],
          environment: {},
        },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: 'sha256:test', status: null }],
      lastObservedAt: new Date().toISOString(),
    });

    const repair = buildRepairPlan(drift);

    expect(drift.findings.map((finding) => finding.kind)).toEqual(['stopped-container']);
    expect(repair.actions.map((action) => action.kind)).toEqual(['start-container']);
    expect(repair.requiresApproval).toBe(false);
  });

  it('does not drift when an exited container is desired stopped', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'reverse-proxy',
          name: 'nginx',
          image: 'nginx:stable',
          desiredStatus: 'stopped',
          ports: ['8088:80'],
        },
      ],
      networks: ['app-network'],
      volumes: [],
    };

    const drift = buildDriftReport(desired, {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-nginx',
          image: 'nginx:stable',
          status: 'exited',
          ports: [],
          environment: {},
        },
      ],
      networks: [{ name: 'app-network', status: 'bridge' }],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: 'sha256:test', status: null }],
      lastObservedAt: new Date().toISOString(),
    });

    expect(drift.status).toBe('none');
    expect(buildRepairPlan(drift).actions).toEqual([]);
  });

  it('plans to stop a running container when desired lifecycle is stopped', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'reverse-proxy',
          name: 'nginx',
          image: 'nginx:stable',
          desiredStatus: 'stopped',
        },
      ],
      networks: [],
      volumes: [],
    };

    const drift = buildDriftReport(desired, {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-nginx',
          image: 'nginx:stable',
          status: 'running',
          ports: ['8088:80'],
          environment: {},
        },
      ],
      networks: [],
      volumes: [],
      images: [{ reference: 'nginx:stable', id: 'sha256:test', status: null }],
      lastObservedAt: new Date().toISOString(),
    });

    const repair = buildRepairPlan(drift);

    expect(drift.findings.map((finding) => finding.kind)).toEqual(['running-container']);
    expect(repair.actions.map((action) => action.kind)).toEqual(['stop-container']);
    expect(repair.requiresApproval).toBe(true);
  });

  it('detects environment drift from inspect evidence', () => {
    const desired: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'database',
          name: 'postgres',
          image: 'postgres:16',
          environment: {
            POSTGRES_DB: 'app',
            POSTGRES_USER: 'app',
            POSTGRES_PASSWORD: 'expected-secret',
          },
        },
      ],
      networks: [],
      volumes: [],
    };

    const drift = buildDriftReport(desired, {
      source: 'mcp-readonly',
      containers: [
        {
          name: 'sample-infra-postgres',
          image: 'postgres:16',
          status: 'running',
          ports: [],
          environment: {
            POSTGRES_DB: 'app',
            POSTGRES_USER: 'app',
            POSTGRES_PASSWORD: 'actual-secret',
          },
        },
      ],
      networks: [],
      volumes: [],
      images: [{ reference: 'postgres:16', id: 'sha256:test', status: null }],
      lastObservedAt: new Date().toISOString(),
    });

    expect(drift.status).toBe('drifted');
    expect(drift.findings.map((finding) => finding.kind)).toContain('env-mismatch');
  });
});



