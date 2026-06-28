import { randomBytes } from 'node:crypto';
import {
  validateClarificationAnswer,
  validateExecutionPlan,
  validatePlanningClarificationContext,
  validateInfrastructureSpec,
  validatePlanningUncertainty,
  validateReactReasoningOutput,
  validateValidatedQuery,
} from '../domain/schemas.js';
import { reactReasoningOutputJsonSchema } from '../domain/structured-output-schemas.js';
import {
  SUPPORTED_IMAGE_BASES,
  getImageReferenceBase,
  isSupportedImageReference,
  type ImageReferenceResolution,
} from '../domain/supported-images.js';
import type {
  AgentObservation,
  AgentRunResult,
  AgentTool,
  AgentToolResult,
  ClarificationAnswer,
  ClarificationChoice,
  DependencyAwareExecutionSchedule,
  DetailedDryRunPreview,
  DraftServiceQuery,
  ExecutionPlan,
  InfrastructureStateSnapshot,
  InfrastructureService,
  InfrastructureSpec,
  PlanStep,
  PlanningUncertainty,
  ProgressReporter,
  ReActStep,
  ReActReasoningOutput,
  ValidatedQuery,
  VerificationReport,
  GuardTelemetry,
  PlannerRevisionRequest,
  PlannerRevisionResult,
  PlanningClarificationContext,
} from '../domain/types.js';
import { parseJsonResponse } from '../llm/json-response.js';
import type { LlmProvider } from '../llm/provider.js';
import type { StateStoreOptions } from '../state/sqlite-state-store.js';
import { AgentToolRegistry } from './tool-registry.js';
import {
  createInternalAgentToolRegistry,
  type DraftSpecProposal,
  type PlanBuildInput,
} from './internal-tools.js';
import type { PlannerAgent, VerifierAgent } from './agent-interfaces.js';
import { StandardPlannerAgent } from './standard-planner-agent.js';
import { StandardVerifierAgent } from './standard-verifier-agent.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import {
  ReActLoopGuard,
  ReActLoopGuardError,
  loadLoopGuardConfig,
  createLoopLogSink,
  hashSpec,
  countValidationIssues,
  type LoopGuardConfig,
  type LoopLogSink,
} from './loop-guard.js';


const DEFAULT_IMAGE_BY_BASE = new Map<string, string>([
  ['alpine', 'alpine:3.20'],
  ['ubuntu', 'ubuntu:24.04'],
  ['debian', 'debian:12'],
  ['busybox', 'busybox:1.36'],
  ['nginx', 'nginx:stable'],
  ['httpd', 'httpd:2.4'],
  ['traefik', 'traefik:v3.1'],
  ['node', 'node:20-alpine'],
  ['python', 'python:3.12-alpine'],
  ['golang', 'golang:1.23-alpine'],
  ['openjdk', 'eclipse-temurin:21-jdk'],
  ['eclipse-temurin', 'eclipse-temurin:21-jdk'],
  ['postgres', 'postgres:16'],
  ['mysql', 'mysql:8'],
  ['mariadb', 'mariadb:11'],
  ['mongo', 'mongo:7'],
  ['redis', 'redis:7-alpine'],
  ['rabbitmq', 'rabbitmq:3-management'],
  ['elasticsearch', 'docker.elastic.co/elasticsearch/elasticsearch:8.15.0'],
  ['kafka', 'apache/kafka:3.8.0'],
  ['keycloak', 'quay.io/keycloak/keycloak:26.0'],
]);

const REVERSE_PROXY_IMAGES = new Set(['nginx', 'httpd', 'traefik']);
const STATEFUL_SERVICE_IMAGES = new Set([
  'postgres',
  'mysql',
  'mariadb',
  'mongo',
  'redis',
  'rabbitmq',
  'elasticsearch',
  'kafka',
]);

interface ImageReferenceResolutionInput {
  image: string;
}

interface SpecRepairInput {
  spec: InfrastructureSpec;
  rawPrompt: string;
  validationIssue: string;
}

interface DetailedDryRunPreviewInput {
  plan: ExecutionPlan;
  composeYaml: string;
  schedule: DependencyAwareExecutionSchedule;
}

function buildExecutionPlanFromSpec(input: PlanBuildInput): ExecutionPlan {
  const spec = validateInfrastructureSpec(input.spec);

  return validateExecutionPlan({
    summary: `Plan for: ${input.rawPrompt}`,
    spec,
    assumptions: input.assumptions,
    steps: buildExecutionSteps(),
  });
}

function buildExecutionSteps(): PlanStep[] {
  return [
    {
      id: 'generate-compose',
      description: 'Generate docker-compose YAML from the validated desired-state spec.',
      action: 'generate-compose',
    },
    {
      id: 'write-state',
      description: 'Persist the validated desired-state spec for status and drift workflows.',
      action: 'write-state',
      dependsOn: ['generate-compose'],
    },
    {
      id: 'deploy-compose',
      description: 'Deploy the generated Docker Compose stack after user confirmation.',
      action: 'deploy-compose',
      dependsOn: ['write-state'],
    },
    {
      id: 'inspect-drift',
      description: 'Inspect running containers and compare actual state with desired state.',
      action: 'inspect-drift',
      dependsOn: ['deploy-compose'],
    },
  ];
}

export interface ReActAgentLoopOptions {
  config?: LoopGuardConfig;
  logSink?: LoopLogSink;
  logEnabled?: boolean;
}

export class ReActAgent {
  private readonly tools: AgentToolRegistry;
  private readonly loopGuardConfig: LoopGuardConfig;
  private readonly loopOptions: ReActAgentLoopOptions;
  private guard: ReActLoopGuard | null = null;

  constructor(
    private readonly provider: LlmProvider,
    private readonly reportProgress: ProgressReporter = noopProgress,
    private readonly stateStore: StateStoreOptions = {},
    private readonly planner: PlannerAgent = new StandardPlannerAgent(provider),
    private readonly verifier: VerifierAgent = new StandardVerifierAgent(),
    loopOptions: ReActAgentLoopOptions = {},
  ) {
    this.loopGuardConfig = loopOptions.config ?? loadLoopGuardConfig();
    this.loopOptions = loopOptions;
    this.tools = createInternalAgentToolRegistry({
      stateStore: this.stateStore,
      formatStateMemoryObservation,
      proposeDraftSpec,
      repairInfrastructureSpec,
      buildExecutionPlanFromSpec,
    });
  }

  listTools(): Array<Pick<AgentTool, 'name' | 'description'>> {
    return this.tools.listTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  async verifyAfterApply(plan: ExecutionPlan, mcpClient: DockerMcpGateway): Promise<VerificationReport> {
    return this.verifier.verify(plan.spec, mcpClient);
  }

  async reviseFromFeedback(request: PlannerRevisionRequest): Promise<PlannerRevisionResult> {
    return this.planner.reviseFromFeedback(request);
  }

  async continueFromClarification(
    context: PlanningClarificationContext,
    answer: ClarificationAnswer,
  ): Promise<AgentRunResult> {
    const validContext = validatePlanningClarificationContext(context);
    const validAnswer = validateClarificationAnswer(answer);
    const resolvedSpec = applyClarificationAnswer(validContext, validAnswer);
    const remainingUncertainties = detectPlanningUncertainties(resolvedSpec).filter(
      (uncertainty) => uncertainty.severity === 'blocking',
    );

    const observations: AgentObservation[] = [
      {
        source: 'observe:user_clarification',
        message:
          validAnswer.otherText !== null
            ? `User clarification: ${validAnswer.otherText}`
            : `User selected clarification choice ${validAnswer.selectedChoiceId}.`,
      },
    ];
    const trace: ReActStep[] = [];

    if (remainingUncertainties.length) {
      const primaryUncertainty = remainingUncertainties[0]!;
      return {
        status: 'clarification',
        clarificationQuestion: formatPlanningUncertaintyQuestion(primaryUncertainty),
        clarificationChoices: primaryUncertainty.choices,
        allowOther: primaryUncertainty.allowOther,
        uncertainties: remainingUncertainties,
        clarificationContext: {
          ...validContext,
          spec: resolvedSpec,
          uncertainties: remainingUncertainties,
        },
        observations,
        trace,
      };
    }

    return this.buildPlannedResultFromValidatedSpec(
      validContext.query,
      resolvedSpec,
      [
        ...validContext.assumptions,
        `User resolved planning uncertainty ${validAnswer.uncertaintyId} before final plan build.`,
      ],
      observations,
      trace,
    );
  }

  async run(query: ValidatedQuery): Promise<AgentRunResult> {
    let validatedQuery = validateValidatedQuery(query);
    const observations: AgentObservation[] = [];
    const trace: ReActStep[] = [];

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'Read the ValidatedQuery and decide which infrastructure planning tools should run next.',
        toolName: null,
      },
      this.reportProgress,
    );

    const reasoning = await this.observeStructuredReasoning(validatedQuery, trace, observations);

    const imageResolution = await this.resolveDraftImageReferences(
      validatedQuery,
      trace,
      observations,
    );

    if (imageResolution.status === 'clarification') {
      return imageResolution.result;
    }

    validatedQuery = imageResolution.query;

    const imageSelectionClarification = buildImageSelectionClarification(
      validatedQuery,
      reasoning,
      trace,
      observations,
      this.reportProgress,
    );
    if (imageSelectionClarification) {
      return imageSelectionClarification;
    }

    await this.runTool('load_state', validatedQuery, trace, observations);

    const draftProposalResult = await this.runTool(
      'propose_draft_spec',
      validatedQuery,
      trace,
      observations,
    );
    const draftProposal = draftProposalResult.data as DraftSpecProposal;

    try {
    // --- Bounded self-repair loop (Sprint C.1) with ReActLoopGuard (Sprint D) ---
    // propose -> validate -> (repair -> re-validate)* until the spec passes or the
    // guard stops the loop. The guard is created per run() and shared with runTool()
    // so the per-tool cap counts every tool call.
    this.guard = new ReActLoopGuard(
      this.loopGuardConfig,
      this.loopOptions.logSink ?? createLoopLogSink({ enabled: this.loopOptions.logEnabled ?? true }),
    );
    this.guard.beginRun();

    let specValidationResult = await this.runTool(
      'validate_infra_spec',
      draftProposal.spec,
      trace,
      observations,
      { throwOnFailure: false },
    );

    let proposal = draftProposal;
    let repairAssumptions = 0;

    while (!specValidationResult.ok) {
      this.guard.tickIteration();

      const validateStepHash = this.guard.observeStep(
        `validate:${hashSpec(proposal.spec)}`,
      );

      recordStep(
        trace,
        observations,
        {
          phase: 'reason',
          message:
            'The proposed draft spec is invalid, so repair it before turning it into the final execution plan.',
          toolName: null,
        },
        this.reportProgress,
      );

      const repairResult = await this.runTool(
        'repair_infra_spec',
        {
          spec: proposal.spec,
          rawPrompt: validatedQuery.raw,
          validationIssue: specValidationResult.observation,
        } satisfies SpecRepairInput,
        trace,
        observations,
        { throwOnFailure: false },
      );

      if (!repairResult.ok) {
        recordStep(
          trace,
          observations,
          {
            phase: 'observe',
            message:
              'Draft spec repair was not possible, so ask the user for one more round of details.',
            toolName: 'ask_user',
          },
          this.reportProgress,
        );

        const telemetry = this.guard.converge();
        return {
          status: 'clarification',
          clarificationQuestion:
            'Draft spec validation failed and the agent could not repair it automatically. Please restate the desired services, dependencies, and volume layout in more concrete terms.',
          observations,
          trace,
          guardTelemetry: telemetry,
        };
      }

      const repairedSpec = repairResult.data as InfrastructureSpec;
      const previousIssueCount = countValidationIssues(specValidationResult.observation);
      const specChanged = hashSpec(repairedSpec) !== hashSpec(proposal.spec);
      this.guard.recordProgress(
        specChanged,
        hashSpec(repairedSpec),
        previousIssueCount,
        validateStepHash,
      );

      repairAssumptions += 1;
      proposal = {
        spec: repairedSpec,
        assumptions: [
          ...proposal.assumptions,
          repairAssumptions === 1
            ? 'Draft spec required automatic repair before validation could pass.'
            : `Draft spec required ${repairAssumptions} automatic repair attempts before validation could pass.`,
        ],
      };

      specValidationResult = await this.runTool(
        'validate_infra_spec',
        proposal.spec,
        trace,
        observations,
        { throwOnFailure: false },
      );
    }

    const validatedSpec = specValidationResult.data as InfrastructureSpec;

    const planningUncertainties = detectPlanningUncertainties(validatedSpec);
    const blockingUncertainties = planningUncertainties.filter(
      (uncertainty) => uncertainty.severity === 'blocking',
    );

    if (blockingUncertainties.length) {
      const primaryUncertainty = blockingUncertainties[0]!;
      const clarificationQuestion = formatPlanningUncertaintyQuestion(primaryUncertainty);
      recordStep(
        trace,
        observations,
        {
          phase: 'observe',
          message: [
            'Planning uncertainty is blocking safe dependency inference.',
            primaryUncertainty.message,
            primaryUncertainty.reason,
          ].join(' '),
          toolName: 'ask_user',
        },
        this.reportProgress,
      );

      return {
        status: 'clarification',
        clarificationQuestion,
        clarificationChoices: primaryUncertainty.choices,
        allowOther: primaryUncertainty.allowOther,
        uncertainties: blockingUncertainties,
        clarificationContext: {
          query: validatedQuery,
          spec: validatedSpec,
          assumptions: proposal.assumptions,
          uncertainties: blockingUncertainties,
        },
        observations,
        trace,
        guardTelemetry: this.guard.converge(),
      };
    }
    return this.buildPlannedResultFromValidatedSpec(
      validatedQuery,
      validatedSpec,
      proposal.assumptions,
      observations,
      trace,
    );
  } catch (error) {
    if (error instanceof ReActLoopGuardError) {
      return {
        status: 'blocked',
        blockReason: error.blockReason,
        iterations: error.iterations,
        guardTelemetry: error.telemetry,
        observations,
        trace,
      };
    }
    throw error;
  } finally {
    this.guard?.close();
    this.guard = null;
  }
  }

  private async buildPlannedResultFromValidatedSpec(
    query: ValidatedQuery,
    validatedSpec: InfrastructureSpec,
    assumptions: string[],
    observations: AgentObservation[],
    trace: ReActStep[],
  ): Promise<AgentRunResult> {
    const guardTelemetry: GuardTelemetry | undefined = this.guard?.converge();

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'The infrastructure spec validation passed, so build the final execution plan from the validated spec.',
        toolName: null,
      },
      this.reportProgress,
    );

    const planResult = await this.runTool(
      'build_execution_plan',
      {
        spec: validatedSpec,
        rawPrompt: query.raw,
        assumptions,
      } satisfies PlanBuildInput,
      trace,
      observations,
    );
    const plan = planResult.data as ExecutionPlan;

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'The plan is built, so create a dependency-aware execution schedule before rendering any dry-run preview.',
        toolName: null,
      },
      this.reportProgress,
    );

    const scheduleResult = await this.runTool(
      'build_dependency_aware_execution_schedule',
      plan.spec,
      trace,
      observations,
    );
    const schedule = scheduleResult.data as DependencyAwareExecutionSchedule;

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'The execution schedule is valid, so render Docker Compose as a preview artifact from the source-of-truth spec.',
        toolName: null,
      },
      this.reportProgress,
    );

    const composePreviewResult = await this.runTool(
      'render_compose_preview',
      plan.spec,
      trace,
      observations,
    );
    const composeYaml = composePreviewResult.data as string;

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'The compose preview and schedule are available, so build a detailed dry-run report without runtime side effects.',
        toolName: null,
      },
      this.reportProgress,
    );

    const dryRunPreviewResult = await this.runTool(
      'build_detailed_dry_run_preview',
      {
        plan,
        composeYaml,
        schedule,
      } satisfies DetailedDryRunPreviewInput,
      trace,
      observations,
    );
    const dryRunPreview = dryRunPreviewResult.data as DetailedDryRunPreview;

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'The detailed dry-run report is ready, so evaluate policy warnings before user review or approval.',
        toolName: null,
      },
      this.reportProgress,
    );

    await this.runTool('evaluate_dry_run_policy', dryRunPreview, trace, observations);

    recordStep(
      trace,
      observations,
      {
        phase: 'reason',
        message:
          'The plan spec is valid. The save_state tool is side-effecting, so persistence remains with the execution engine after CLI dry-run/save-state policy is known.',
        toolName: null,
      },
      this.reportProgress,
    );

    return {
      status: 'planned',
      request: {
        raw: query.raw,
        normalizedPrompt: query.normalizedPrompt,
        intent: query.intent,
      },
      plan,
      observations,
      trace,
      ...(guardTelemetry ? { guardTelemetry } : {}),
    };
  }
  private async observeStructuredReasoning(
    query: ValidatedQuery,
    trace: ReActStep[],
    observations: AgentObservation[],
  ): Promise<ReActReasoningOutput | null> {
    try {
      this.reportProgress({
        phase: 'plan',
        message: 'thinking... request structured ReAct reasoning from provider.',
        toolName: 'llm_reasoning',
      });
      const completion = await this.provider.completeStructured({
        system:
          'You are a ReAct infrastructure agent. Return structured reasoning only. Do not call Docker, MCP, shell, or side-effecting tools. Treat your output as an observation; deterministic internal tools remain the execution authority.',
        user: JSON.stringify(query),
        purpose: 'react',
        schemaName: 'react_reasoning_output',
        schema: reactReasoningOutputJsonSchema,
      });
      const reasoning = validateReactReasoningOutput(parseJsonResponse(completion.text));

      recordStep(trace, observations, {
        phase: 'observe',
        message: formatReasoningObservation(reasoning),
        toolName: 'llm_reasoning',
      }, this.reportProgress);
      return reasoning;
    } catch (error) {
      recordStep(trace, observations, {
        phase: 'observe',
        message: [
          'Structured ReAct reasoning output was invalid.',
          getErrorMessage(error),
          'Continuing with deterministic internal tools only; no Docker, MCP, or side-effecting tool is called.',
        ].join(' '),
        toolName: 'llm_reasoning',
      }, this.reportProgress);
      return null;
    }
  }

  private async resolveDraftImageReferences(
    query: ValidatedQuery,
    trace: ReActStep[],
    observations: AgentObservation[],
  ): Promise<
    | { status: 'resolved'; query: ValidatedQuery }
    | { status: 'clarification'; result: AgentRunResult }
  > {
    let changed = false;
    const services: DraftServiceQuery[] = [];

    for (const service of query.draft.services) {
      if (service.image === null || isSupportedImageReference(service.image)) {
        services.push(service);
        continue;
      }

      const result = await this.runTool(
        'resolve_image_reference',
        { image: service.image } satisfies ImageReferenceResolutionInput,
        trace,
        observations,
        { throwOnFailure: false },
      );

      if (!result.ok) {
        const fallbackResult = buildUnsupportedImageClarification(
          query,
          service,
          {
            raw: service.image,
            resolved: null,
            candidates: [],
            confidence: 'none',
            reason: 'unsupported',
            needsClarification: true,
          },
          result.observation,
          trace,
          observations,
          this.reportProgress,
        );

        return {
          status: 'clarification',
          result: fallbackResult,
        };
      }

      const resolution = result.data as ImageReferenceResolution;

      if (resolution.confidence !== 'high' || resolution.resolved === null) {
        const result = buildUnsupportedImageClarification(
          query,
          service,
          resolution,
          buildImageResolutionQuestion(resolution),
          trace,
          observations,
          this.reportProgress,
        );

        return {
          status: 'clarification',
          result,
        };
      }

      changed = true;
      services.push({
        ...service,
        image: resolution.resolved,
        name:
          service.name === null || service.name === getImageReferenceBase(service.image)
            ? getImageReferenceBase(resolution.resolved)
            : service.name,
      });
    }

    if (!changed) {
      return {
        status: 'resolved',
        query,
      };
    }

    return {
      status: 'resolved',
      query: validateValidatedQuery({
        ...query,
        draft: {
          ...query.draft,
          services,
        },
      }),
    };
  }

  private async runTool(
    toolName: string,
    input: unknown,
    trace: ReActStep[],
    observations: AgentObservation[],
    options: { throwOnFailure?: boolean } = {},
  ): Promise<AgentToolResult> {
    const tool = this.tools.get(toolName);

    this.guard?.checkToolCap(toolName);

    recordStep(trace, observations, {
      phase: 'act',
      message: `Call internal tool: ${tool.name}.`,
      toolName: tool.name,
    }, this.reportProgress);

    const result = await this.tools.invoke(toolName, input);

    recordStep(trace, observations, {
      phase: 'observe',
      message: result.observation,
      toolName: tool.name,
    }, this.reportProgress);

    if (!result.ok && options.throwOnFailure !== false) {
      throw new Error(result.observation);
    }

    return result;
  }
}

function formatStateMemoryObservation(snapshot: InfrastructureStateSnapshot): string {
  const currentText = snapshot.current
    ? `current verified project "${snapshot.current.desired.projectName}" with actual source "${snapshot.current.actual.source}"`
    : 'no verified current runtime state';
  const pendingText = snapshot.pendingPreview
    ? `pending preview for project "${snapshot.pendingPreview.desired.projectName}" created at ${snapshot.pendingPreview.createdAt}`
    : 'no pending preview';

  return [
    `Loaded state memory: ${currentText}; ${pendingText}.`,
    'Actual Docker runtime remains unverified unless current.actual.source comes from a read-only runtime observation.',
  ].join(' ');
}

function recordStep(
  trace: ReActStep[],
  observations: AgentObservation[],
  step: Omit<ReActStep, 'id'>,
  reportProgress: ProgressReporter = noopProgress,
): void {
  const id = `${step.phase}-${trace.length + 1}`;
  trace.push({
    id,
    ...step,
  });
  observations.push({
    source: step.toolName ? `${step.phase}:${step.toolName}` : step.phase,
    message: step.message,
  });
  reportProgress({
    phase: toProgressPhase(step.phase),
    message: toProgressMessage(step),
    ...(step.toolName !== null ? { toolName: step.toolName } : {}),
  });
}

function toProgressPhase(phase: ReActStep['phase']) {
  if (phase === 'reason') {
    return 'plan';
  }

  if (phase === 'act') {
    return 'acting';
  }

  return 'observe';
}

function toProgressMessage(step: Omit<ReActStep, 'id'>): string {
  if (step.phase === 'reason') {
    return `thinking... ${step.message}`;
  }

  if (step.phase === 'act') {
    return `acting... ${step.message}`;
  }

  return `observe... ${step.message}`;
}

function formatReasoningObservation(reasoning: ReActReasoningOutput): string {
  const safetyNotes = reasoning.safetyNotes.length
    ? ` Safety notes: ${reasoning.safetyNotes.join('; ')}`
    : '';

  return [
    `Structured LLM reasoning summary: ${reasoning.summary}`,
    `Next action advisory: ${reasoning.nextAction}.`,
    `Rationale: ${reasoning.rationale}.`,
    'This output is advisory only; internal deterministic tools still build, validate, and render.',
    safetyNotes,
  ].join(' ');
}

function buildImageSelectionClarification(
  query: ValidatedQuery,
  reasoning: ReActReasoningOutput | null,
  trace: ReActStep[],
  observations: AgentObservation[],
  reportProgress: ProgressReporter,
): AgentRunResult | null {
  if (query.intent !== 'create') {
    return null;
  }

  const hasNullImageService = query.draft.services.some((service) => service.image === null);
  if (!hasNullImageService || !hasGenericDeployTargetSignal(query)) {
    return null;
  }

  const recommendedImage = inferRecommendedImage(query, reasoning);
  const provisionalQuery: ValidatedQuery = {
    ...query,
    draft: {
      ...query.draft,
      services: query.draft.services.map((service) =>
        service.image === null
          ? { ...service, image: recommendedImage, name: service.name ?? 'web' }
          : service,
      ),
    },
  };

  const provisionalSpec = buildSpecFromDraft(provisionalQuery);
  const targetService =
    provisionalSpec.services.find((service) => service.image === recommendedImage) ??
    provisionalSpec.services[0];

  if (!targetService) {
    return null;
  }

  const uncertainty = validatePlanningUncertainty({
    id: `select-image:${targetService.name}`,
    severity: 'blocking',
    field: 'services[].image',
    message: `ReAct reasoning interpreted the request "${query.normalizedPrompt}" but no image/runtime was specified. Choose the default image to create the preview.`,
    reason: `LLM reasoning: ${reasoning ? reasoning.summary : 'none'}. You can confirm it or choose another option; you can still revise after the dry run if needed.`,
    affectedServices: [targetService.name],
    choices: buildImageSelectionCandidates(targetService.name, recommendedImage),
    allowOther: true,
  });

  recordStep(
    trace,
    observations,
    {
      phase: 'reason',
      message: `The request has no explicit image/runtime; ReAct reasoning proposes "${recommendedImage}" and asks the user to confirm before planning.`,
      toolName: null,
    },
    reportProgress,
  );

  recordStep(
    trace,
    observations,
    {
      phase: 'observe',
      message: formatPlanningUncertaintyQuestion(uncertainty),
      toolName: 'ask_user',
    },
    reportProgress,
  );

  return {
    status: 'clarification',
    clarificationQuestion: formatPlanningUncertaintyQuestion(uncertainty),
    clarificationChoices: uncertainty.choices,
    allowOther: uncertainty.allowOther,
    uncertainties: [uncertainty],
    clarificationContext: {
      query,
      spec: provisionalSpec,
      assumptions: inferPlanAssumptions(query, provisionalSpec),
      uncertainties: [uncertainty],
    },
    observations,
    trace,
  };
}

function hasGenericDeployTargetSignal(query: ValidatedQuery): boolean {
  return /\b(web|website|trang web|app|ung dung|service|container|containers|image|images)\b/i.test(
    query.normalizedPrompt,
  );
}

function inferRecommendedImage(
  query: ValidatedQuery,
  reasoning: ReActReasoningOutput | null,
): string {
  const text = [reasoning?.summary ?? '', reasoning?.rationale ?? '', query.normalizedPrompt]
    .join(' ')
    .toLowerCase();

  if (/\b(static|tinh|website|web)\b/.test(text)) {
    return 'nginx:stable';
  }

  if (/\b(backend|api|node|server|ung dung)\b/.test(text)) {
    return 'node:20-alpine';
  }

  return 'nginx:stable';
}

function buildImageSelectionCandidates(
  serviceName: string,
  recommendedImage: string,
): ClarificationChoice[] {
  const all = [
    {
      image: 'nginx:stable',
      label: 'nginx - static web server',
      description: 'Serves a static website (HTML/CSS/JS). Suitable for a static web request.',
    },
    {
      image: 'httpd:2.4',
      label: 'httpd - static web server',
      description: 'Apache httpd, another static web server option.',
    },
    {
      image: 'node:20-alpine',
      label: 'node - backend app server',
      description: 'Node.js for a backend/API application.',
    },
  ];

  const ordered = [
    ...all.filter((candidate) => candidate.image === recommendedImage),
    ...all.filter((candidate) => candidate.image !== recommendedImage),
  ];

  return ordered.map((candidate, index) => ({
    id: String(index + 1),
    label: candidate.label,
    description: candidate.description,
    value: `setServiceImage:${serviceName}:${candidate.image}`,
  }));
}

function buildUnsupportedImageClarification(
  query: ValidatedQuery,
  targetService: DraftServiceQuery,
  resolution: ImageReferenceResolution,
  question: string,
  trace: ReActStep[],
  observations: AgentObservation[],
  reportProgress: ProgressReporter,
): AgentRunResult {
  const serviceName =
    targetService.name ??
    getImageReferenceBase(resolution.candidates[0] ?? resolution.raw) ??
    'service';
  const suggestedImages = buildSuggestedImageReferences(resolution);
  const defaultImage = suggestedImages[0] ?? 'nginx:stable';
  const provisionalQuery = validateValidatedQuery({
    ...query,
    draft: {
      ...query.draft,
      services: query.draft.services.map((service) =>
        service === targetService
          ? {
              ...service,
              image: defaultImage,
              name: service.name ?? serviceName,
            }
          : service,
      ),
    },
  });
  const provisionalSpec = buildSpecFromDraft(provisionalQuery);
  const resolvedServiceName =
    provisionalSpec.services.find((service) => service.image === defaultImage)?.name ?? serviceName;
  const uncertainty = validatePlanningUncertainty({
    id: `unsupported-image:${resolvedServiceName}`,
    severity: 'blocking',
    field: 'services[].image',
    message: `The requested image/runtime "${resolution.raw}" is not currently supported by the catalog. Choose one of the suggested images to continue planning, or select Other to keep a custom value.`,
    reason: question,
    affectedServices: [resolvedServiceName],
    choices: suggestedImages.map((image, index) => ({
      id: String(index + 1),
      label: image,
      description:
        index === 0
          ? 'Recommended closest supported image/runtime.'
          : 'Alternative supported image/runtime suggestion.',
      value: `setServiceImage:${resolvedServiceName}:${image}`,
    })),
    allowOther: true,
  });

  recordStep(
    trace,
    observations,
    {
      phase: 'observe',
      message: formatPlanningUncertaintyQuestion(uncertainty),
      toolName: 'ask_user',
    },
    reportProgress,
  );

  return {
    status: 'clarification',
    clarificationQuestion: formatPlanningUncertaintyQuestion(uncertainty),
    clarificationChoices: uncertainty.choices,
    allowOther: true,
    uncertainties: [uncertainty],
    clarificationContext: {
      query,
      spec: provisionalSpec,
      assumptions: [
        ...inferPlanAssumptions(provisionalQuery, provisionalSpec),
        `The original requested image/runtime was "${resolution.raw}" and requires user confirmation before final planning.`,
      ],
      uncertainties: [uncertainty],
    },
    observations,
    trace,
  };
}

function buildSuggestedImageReferences(resolution: ImageReferenceResolution): string[] {
  const suggested = resolution.candidates.map(
    (candidate) => DEFAULT_IMAGE_BY_BASE.get(candidate) ?? candidate,
  );

  if (!suggested.length) {
    return ['nginx:stable', 'httpd:2.4', 'node:20-alpine'];
  }

  const fallbacks = ['nginx:stable', 'httpd:2.4', 'node:20-alpine'];
  const unique = new Set<string>();

  for (const image of [...suggested, ...fallbacks]) {
    unique.add(image);
    if (unique.size >= 3) {
      break;
    }
  }

  return [...unique];
}

function buildImageResolutionQuestion(resolution: ImageReferenceResolution): string {
  const candidateText = resolution.candidates.length
    ? ` Candidates: ${resolution.candidates.join(', ')}.`
    : '';

  return [
    `Please confirm image/runtime "${resolution.raw}" before planning.`,
    resolution.reason === 'ambiguous'
      ? 'The system found multiple supported images that may match this name, but not enough confidence to auto-correct it.'
      : 'This image/runtime is not in the supported image list.',
    candidateText,
    `Currently supported images: ${SUPPORTED_IMAGE_BASES.join(', ')}.`,
  ].join(' ');
}

function proposeDraftSpec(query: ValidatedQuery): DraftSpecProposal {
  const spec = buildSpecFromDraft(query);

  return {
    spec,
    assumptions: inferPlanAssumptions(query, spec),
  };
}

function buildSpecFromDraft(query: ValidatedQuery): InfrastructureSpec {
  const deployableServices = query.draft.services.filter(
    (service): service is DraftServiceQuery & { image: string } => service.image !== null,
  );
  const topology = inferTopology(deployableServices);
  const volumes = new Set<string>();
  const services = deployableServices.map((service, index) =>
    buildServiceFromDraft(service, index, topology, volumes),
  );

  applyInferredDependencies(services);

  return {
    projectName: 'sample-infra',
    networks: ['app-network'],
    volumes: [...volumes],
    services,
  };
}

function inferTopology(
  services: Array<DraftServiceQuery & { image: string }>,
): {
  hasReverseProxy: boolean;
  hasBackend: boolean;
  hasDatabase: boolean;
} {
  const imageBases = services.map((service) => getImageBase(service.image));

  return {
    hasReverseProxy: imageBases.some((imageBase) => getServiceKind(imageBase) === 'reverse-proxy'),
    hasBackend: imageBases.some((imageBase) => getServiceKind(imageBase) === 'backend'),
    hasDatabase: imageBases.some((imageBase) => getServiceKind(imageBase) === 'database'),
  };
}

function buildServiceFromDraft(
  service: DraftServiceQuery & { image: string },
  index: number,
  topology: ReturnType<typeof inferTopology>,
  declaredVolumes: Set<string>,
): InfrastructureService {
  const imageBase = getImageBase(service.image);
  const name = shouldUseDefaultServiceName(service.name, imageBase, topology)
    ? getDefaultServiceName(imageBase, index, topology)
    : (service.name ?? getDefaultServiceName(imageBase, index, topology));
  const volumeName = isStatefulServiceImage(imageBase) ? `${name}-data` : null;
  const hostPort = service.port ?? getDefaultHostPort(imageBase);

  if (volumeName !== null) {
    declaredVolumes.add(volumeName);
  }

  return {
    kind: getServiceKind(imageBase),
    name,
    image: getDefaultImage(service.image),
    ...getDefaultEnvironment(imageBase),
    ...(service.replicas !== null ? { replicas: service.replicas } : {}),
    ...(hostPort !== null ? { ports: [`${hostPort}:${getDefaultContainerPort(imageBase, hostPort)}`] } : {}),
    ...(volumeName !== null ? { volumes: [`${volumeName}:${getDefaultVolumeTarget(imageBase)}`] } : {}),
  };
}

function shouldUseDefaultServiceName(
  name: string | null,
  imageBase: string,
  topology: ReturnType<typeof inferTopology>,
): boolean {
  return (
    name === null ||
    (imageBase === 'node' &&
      name === 'node' &&
      (topology.hasReverseProxy || topology.hasDatabase))
  );
}

function applyInferredDependencies(services: InfrastructureService[]): void {
  const databaseNames = services
    .filter((service) => service.kind === 'database')
    .map((service) => service.name);
  const backendNames = services
    .filter((service) => service.kind === 'backend')
    .map((service) => service.name);

  for (const service of services) {
    if (service.kind === 'backend' && databaseNames.length) {
      service.dependsOn = databaseNames;
    }

    if (service.kind === 'reverse-proxy' && backendNames.length) {
      service.dependsOn = backendNames;
    }
  }
}

function inferPlanAssumptions(query: ValidatedQuery, spec: InfrastructureSpec): string[] {
  const assumptions = [
    'InfrastructureSpec is the desired-state source of truth; Docker Compose is only a rendered preview artifact.',
    'No Docker runtime, MCP tool, or host mutation is executed during planning.',
    'Services share the default app-network unless the user provides a later network model.',
  ];

  if (spec.services.some((service) => service.image.includes(':'))) {
    assumptions.push('Base image names are expanded to safe default tags for preview.');
  }

  if (spec.services.some((service) => service.volumes?.length)) {
    assumptions.push('Stateful services receive a named persistent volume with local default credentials where the image commonly requires them for preview.');
  }

  if (query.draft.services.some((service) => service.port === null) && spec.services.some((service) => service.ports?.length)) {
    assumptions.push('Reverse-proxy/web-server images expose host port 80 by default when no explicit port is provided.');
  }

  return assumptions;
}

function detectPlanningUncertainties(spec: InfrastructureSpec): PlanningUncertainty[] {
  const servicesByName = new Map(spec.services.map((service) => [service.name, service]));
  const backendNames = spec.services
    .filter((service) => service.kind === 'backend')
    .map((service) => service.name);
  const databaseNames = spec.services
    .filter((service) => service.kind === 'database')
    .map((service) => service.name);
  const uncertainties: PlanningUncertainty[] = [];

  for (const service of spec.services) {
    const dependencyNames = service.dependsOn ?? [];
    const backendDependencies = dependencyNames.filter(
      (dependencyName) => servicesByName.get(dependencyName)?.kind === 'backend',
    );
    const databaseDependencies = dependencyNames.filter(
      (dependencyName) => servicesByName.get(dependencyName)?.kind === 'database',
    );

    if (
      service.kind === 'reverse-proxy' &&
      backendNames.length > 1 &&
      backendDependencies.length !== 1
    ) {
      uncertainties.push(
        validatePlanningUncertainty({
          id: `depends-on:${service.name}:backend-target`,
          severity: 'blocking',
          field: 'services[].dependsOn',
          message: `Reverse proxy service "${service.name}" has multiple possible backend targets.`,
          reason:
            'Choosing the wrong backend changes routing and startup order, so the planner must not silently infer this dependency.',
          affectedServices: [service.name, ...backendNames],
          choices: backendNames.map((backendName, index) => ({
            id: String(index + 1),
            label: `Route to ${backendName}`,
            description: `Set ${service.name}.dependsOn to ${backendName}.`,
            value: `dependsOn:${service.name}:${backendName}`,
          })),
          allowOther: true,
        }),
      );
    }

    if (
      service.kind === 'backend' &&
      databaseNames.length > 1 &&
      databaseDependencies.length !== 1
    ) {
      uncertainties.push(
        validatePlanningUncertainty({
          id: `depends-on:${service.name}:database-target`,
          severity: 'blocking',
          field: 'services[].dependsOn',
          message: `Backend service "${service.name}" has multiple possible database dependencies.`,
          reason:
            'Choosing the wrong database changes app state and readiness order, so the planner must ask user before finalizing dependsOn.',
          affectedServices: [service.name, ...databaseNames],
          choices: [
            ...databaseNames.map((databaseName, index) => ({
              id: String(index + 1),
              label: `Use ${databaseName}`,
              description: `Set ${service.name}.dependsOn to ${databaseName}.`,
              value: `dependsOn:${service.name}:${databaseName}`,
            })),
            {
              id: String(databaseNames.length + 1),
              label: 'No database dependency',
              description: `Leave ${service.name}.dependsOn without a database dependency.`,
              value: `noDatabase:${service.name}`,
            },
          ],
          allowOther: true,
        }),
      );
    }
  }

  const cyclePath = findDependencyCycle(spec.services);
  if (cyclePath.length) {
    uncertainties.push(
      validatePlanningUncertainty({
        id: 'depends-on:cycle',
        severity: 'blocking',
        field: 'services[].dependsOn',
        message: `Dependency cycle detected: ${cyclePath.join(' -> ')}.`,
        reason:
          'Cyclic dependsOn cannot produce a safe startup order; user must choose which dependency edge to remove or revise.',
        affectedServices: uniqueIdentifiers(cyclePath),
        choices: cyclePath.slice(0, -1).map((serviceName, index) => {
          const nextServiceName = cyclePath[index + 1]!;
          return {
            id: String(index + 1),
            label: `Remove ${serviceName} -> ${nextServiceName}`,
            description: `Remove ${nextServiceName} from ${serviceName}.dependsOn.`,
            value: `removeEdge:${serviceName}:${nextServiceName}`,
          };
        }),
        allowOther: true,
      }),
    );
  }

  return uncertainties;
}

function applyClarificationAnswer(
  context: PlanningClarificationContext,
  answer: ClarificationAnswer,
): InfrastructureSpec {
  const uncertainty = context.uncertainties.find(
    (candidate) => candidate.id === answer.uncertaintyId,
  );

  if (!uncertainty) {
    throw new Error(`Unknown planning uncertainty: ${answer.uncertaintyId}`);
  }

  const choiceValue = answer.selectedChoiceId !== null
    ? uncertainty.choices.find((choice) => choice.id === answer.selectedChoiceId)?.value ?? null
    : null;
  const resolvedValue = choiceValue ?? inferChoiceValueFromOtherText(uncertainty, answer.otherText);

  if (resolvedValue === null) {
    throw new Error('Clarification answer did not resolve to a supported planning change.');
  }

  const services = context.spec.services.map((service) => ({
    ...service,
    dependsOn: service.dependsOn ? [...service.dependsOn] : undefined,
  }));

  if (resolvedValue.startsWith('dependsOn:')) {
    const [, serviceName, dependencyName] = resolvedValue.split(':');
    const service = services.find((candidate) => candidate.name === serviceName);
    if (!service || !dependencyName) {
      throw new Error(`Invalid clarification dependency value: ${resolvedValue}`);
    }
    service.dependsOn = [dependencyName];
  } else if (resolvedValue.startsWith('noDatabase:')) {
    const [, serviceName] = resolvedValue.split(':');
    const databaseNames = new Set(
      context.spec.services
        .filter((service) => service.kind === 'database')
        .map((service) => service.name),
    );
    const service = services.find((candidate) => candidate.name === serviceName);
    if (!service) {
      throw new Error(`Invalid clarification no-database value: ${resolvedValue}`);
    }
    const remainingDependencies = (service.dependsOn ?? []).filter(
      (dependencyName) => !databaseNames.has(dependencyName),
    );
    service.dependsOn = remainingDependencies.length ? remainingDependencies : undefined;
  } else if (resolvedValue.startsWith('removeEdge:')) {
    const [, serviceName, dependencyName] = resolvedValue.split(':');
    const service = services.find((candidate) => candidate.name === serviceName);
    if (!service || !dependencyName) {
      throw new Error(`Invalid clarification remove-edge value: ${resolvedValue}`);
    }
    const remainingDependencies = (service.dependsOn ?? []).filter(
      (candidate) => candidate !== dependencyName,
    );
    service.dependsOn = remainingDependencies.length ? remainingDependencies : undefined;
  } else if (resolvedValue.startsWith('setServiceImage:')) {
    const [, serviceName, ...imageParts] = resolvedValue.split(':');
    const imageRef = imageParts.join(':');
    const service = services.find((candidate) => candidate.name === serviceName);
    if (!service || !imageRef) {
      throw new Error(`Invalid clarification setServiceImage value: ${resolvedValue}`);
    }
    service.image = imageRef;
  } else {
    throw new Error(`Unsupported clarification value: ${resolvedValue}`);
  }

  return validateInfrastructureSpec({
    ...context.spec,
    services,
  });
}

function inferChoiceValueFromOtherText(
  uncertainty: PlanningUncertainty,
  otherText: string | null,
): string | null {
  if (otherText === null) {
    return null;
  }

  const normalized = otherText.toLowerCase();
  const matchedChoice = uncertainty.choices.find((choice) => {
    const [, , dependencyName] = choice.value.split(':');
    return dependencyName !== undefined && normalized.includes(dependencyName.toLowerCase());
  });

  if (matchedChoice) {
    return matchedChoice.value;
  }

  if (uncertainty.field === 'services[].image') {
    const serviceName = uncertainty.affectedServices[0];
    if (serviceName !== undefined) {
      return `setServiceImage:${serviceName}:${otherText}`;
    }
  }

  if (
    uncertainty.id.includes(':database-target') &&
    /\b(no|none|khong|kh\u00f4ng)\b/i.test(otherText)
  ) {
    return uncertainty.choices.find((choice) => choice.value.startsWith('noDatabase:'))?.value ?? null;
  }

  return null;
}

function formatPlanningUncertaintyQuestion(uncertainty: PlanningUncertainty): string {
  const choices = uncertainty.choices.map(
    (choice) => `${choice.id}. ${choice.label} - ${choice.description}`,
  );
  if (uncertainty.allowOther) {
    choices.push('Other. Enter a custom choice if the options above are not correct.');
  }

  return [
    uncertainty.message,
    uncertainty.reason,
    'Choose one option so ReAct can use the answer as an observation and continue planning:',
    ...choices,
  ].join('\n');
}

function findDependencyCycle(services: InfrastructureService[]): string[] {
  const servicesByName = new Map(services.map((service) => [service.name, service]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(serviceName: string): string[] | null {
    if (visiting.has(serviceName)) {
      const startIndex = path.indexOf(serviceName);
      return [...path.slice(Math.max(startIndex, 0)), serviceName];
    }

    if (visited.has(serviceName)) {
      return null;
    }

    const service = servicesByName.get(serviceName);
    if (!service) {
      return null;
    }

    visiting.add(serviceName);
    path.push(serviceName);

    for (const dependencyName of service.dependsOn ?? []) {
      const cycle = visit(dependencyName);
      if (cycle !== null) {
        return cycle;
      }
    }

    path.pop();
    visiting.delete(serviceName);
    visited.add(serviceName);
    return null;
  }

  for (const service of services) {
    const cycle = visit(service.name);
    if (cycle !== null) {
      return cycle;
    }
  }

  return [];
}

function repairInfrastructureSpec(spec: InfrastructureSpec): InfrastructureSpec {
  const projectName = sanitizeIdentifier(spec.projectName) || 'sample-infra';
  const networks = uniqueIdentifiers(spec.networks.map(sanitizeIdentifier)).filter(Boolean);
  const repairedNetworks = networks.length ? networks : ['app-network'];
  const originalToRepairedName = new Map<string, string>();
  const usedServiceNames = new Set<string>();

  const services = spec.services.map((service, index) => {
    const imageBase = getImageBase(service.image);
    const fallbackName = getDefaultServiceName(imageBase, index, {
      hasReverseProxy: spec.services.some(
        (candidate) => getServiceKind(getImageBase(candidate.image)) === 'reverse-proxy',
      ),
      hasBackend: spec.services.some(
        (candidate) => getServiceKind(getImageBase(candidate.image)) === 'backend',
      ),
      hasDatabase: spec.services.some(
        (candidate) => getServiceKind(getImageBase(candidate.image)) === 'database',
      ),
    });
    const repairedName = makeUniqueIdentifier(
      sanitizeIdentifier(service.name) || fallbackName,
      usedServiceNames,
    );

    if (!originalToRepairedName.has(service.name)) {
      originalToRepairedName.set(service.name, repairedName);
    }

    const repairedPorts = service.ports?.filter(isValidPortMapping) ?? [];
    const repairedVolumes =
      service.volumes
        ?.map((mount) => repairVolumeMount(mount, service.name, repairedName))
        .filter((mount): mount is string => mount !== null) ?? [];
    const repairedReplicas =
      service.replicas === undefined
        ? undefined
        : Math.min(Math.max(service.replicas, 1), 50);

    return {
      kind: getServiceKind(imageBase),
      name: repairedName,
      image: getDefaultImage(service.image),
      ...getDefaultEnvironment(imageBase),
      ...(repairedReplicas !== undefined ? { replicas: repairedReplicas } : {}),
      ...(repairedPorts.length ? { ports: repairedPorts } : {}),
      ...(repairedVolumes.length ? { volumes: repairedVolumes } : {}),
      ...(service.dependsOn?.length ? { dependsOn: service.dependsOn } : {}),
    };
  });

  const serviceNames = new Set(services.map((service) => service.name));
  const repairedServices = services.map((service) => {
    const dependsOn = uniqueIdentifiers(
      service.dependsOn
        ?.map((dependency) => originalToRepairedName.get(dependency) ?? sanitizeIdentifier(dependency))
        .filter((dependency) => dependency && dependency !== service.name && serviceNames.has(dependency)) ?? [],
    );
    const { dependsOn: _dependsOn, ...serviceWithoutDependencies } = service;

    return dependsOn.length
      ? {
          ...serviceWithoutDependencies,
          dependsOn,
        }
      : serviceWithoutDependencies;
  });

  const volumes = new Set(uniqueIdentifiers(spec.volumes.map(sanitizeIdentifier)).filter(Boolean));
  for (const service of repairedServices) {
    for (const mount of service.volumes ?? []) {
      const [source] = mount.split(':');
      if (source) {
        volumes.add(source);
      }
    }
  }

  return {
    projectName,
    networks: repairedNetworks,
    volumes: [...volumes],
    services: repairedServices,
  };
}

function getImageBase(image: string): string {
  return image.split(':')[0]?.split('/').pop()?.toLowerCase() ?? image.toLowerCase();
}

function getDefaultServiceName(
  imageBase: string,
  index: number,
  topology: {
    hasReverseProxy: boolean;
    hasBackend: boolean;
    hasDatabase: boolean;
  },
): string {
  if (imageBase === 'node' && (topology.hasReverseProxy || topology.hasDatabase)) {
    return 'api';
  }

  return imageBase || `service-${index + 1}`;
}

function getDefaultImage(image: string): string {
  const imageBase = getImageBase(image);

  return DEFAULT_IMAGE_BY_BASE.get(imageBase) ?? image;
}

function generateDefaultSecret(): string {
  return 'pw-' + randomBytes(8).toString('hex');
}

function getDefaultEnvironment(
  imageBase: string,
): { environment: Record<string, string> } | Record<string, never> {
  if (imageBase === 'postgres') {
    return {
      environment: {
        POSTGRES_DB: 'app',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: generateDefaultSecret(),
      },
    };
  }

  if (imageBase === 'mysql' || imageBase === 'mariadb') {
    return {
      environment: {
        ...(imageBase === 'mysql'
          ? {
              MYSQL_DATABASE: 'app',
              MYSQL_USER: 'app',
              MYSQL_PASSWORD: generateDefaultSecret(),
              MYSQL_ROOT_PASSWORD: generateDefaultSecret(),
            }
          : {
              MARIADB_DATABASE: 'app',
              MARIADB_USER: 'app',
              MARIADB_PASSWORD: generateDefaultSecret(),
              MARIADB_ROOT_PASSWORD: generateDefaultSecret(),
            }),
      },
    };
  }

  if (imageBase === 'mongo') {
    return {
      environment: {
        MONGO_INITDB_ROOT_USERNAME: 'app',
        MONGO_INITDB_ROOT_PASSWORD: generateDefaultSecret(),
      },
    };
  }

  if (imageBase === 'rabbitmq') {
    return {
      environment: {
        RABBITMQ_DEFAULT_USER: 'app',
        RABBITMQ_DEFAULT_PASS: generateDefaultSecret(),
      },
    };
  }

  if (imageBase === 'elasticsearch') {
    return {
      environment: {
        ES_SETTING_DISCOVERY_TYPE: 'single-node',
        ES_SETTING_XPACK_SECURITY_ENABLED: 'false',
      },
    };
  }

  if (imageBase === 'kafka') {
    return {
      environment: {
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://kafka:9092',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      },
    };
  }

  if (imageBase === 'keycloak') {
    return {
      environment: {
        KEYCLOAK_ADMIN: 'admin',
        KEYCLOAK_ADMIN_PASSWORD: generateDefaultSecret(),
      },
    };
  }

  return {};
}

function getServiceKind(imageBase: string): InfrastructureService['kind'] {
  if (REVERSE_PROXY_IMAGES.has(imageBase)) {
    return 'reverse-proxy';
  }

  if (isDatabaseImage(imageBase)) {
    return 'database';
  }

  return 'backend';
}

function isDatabaseImage(imageBase: string): boolean {
  return STATEFUL_SERVICE_IMAGES.has(imageBase);
}

function isStatefulServiceImage(imageBase: string): boolean {
  return STATEFUL_SERVICE_IMAGES.has(imageBase);
}

function getDefaultHostPort(imageBase: string): number | null {
  if (REVERSE_PROXY_IMAGES.has(imageBase)) {
    return 80;
  }

  return null;
}

function getDefaultContainerPort(imageBase: string, hostPort: number): number {
  switch (imageBase) {
    case 'nginx':
    case 'httpd':
    case 'traefik':
      return 80;
    case 'postgres':
      return 5432;
    case 'mysql':
    case 'mariadb':
      return 3306;
    case 'mongo':
      return 27017;
    case 'redis':
      return 6379;
    case 'rabbitmq':
      return hostPort === 15672 ? 15672 : 5672;
    case 'elasticsearch':
      return 9200;
    case 'kafka':
      return 9092;
    case 'keycloak':
      return 8080;
    case 'node':
    case 'python':
    case 'golang':
    case 'openjdk':
    case 'eclipse-temurin':
      return 3000;
    default:
      return hostPort;
  }
}

function getDefaultVolumeTarget(imageBase: string): string {
  switch (imageBase) {
    case 'postgres':
      return '/var/lib/postgresql/data';
    case 'mysql':
    case 'mariadb':
      return '/var/lib/mysql';
    case 'mongo':
      return '/data/db';
    case 'redis':
      return '/data';
    case 'rabbitmq':
      return '/var/lib/rabbitmq';
    case 'elasticsearch':
      return '/usr/share/elasticsearch/data';
    case 'kafka':
      return '/tmp/kraft-combined-logs';
    default:
      return '/data';
  }
}

function repairVolumeMount(
  mount: string,
  originalServiceName: string,
  repairedServiceName: string,
): string | null {
  const [source, target] = mount.split(':');
  const originalDataVolume = `${sanitizeIdentifier(originalServiceName)}-data`;
  const sanitizedSource = sanitizeIdentifier(source ?? '');
  const repairedSource =
    sanitizedSource === originalDataVolume ? `${repairedServiceName}-data` : sanitizedSource;

  if (!repairedSource || !target?.startsWith('/')) {
    return null;
  }

  return `${repairedSource}:${target}`;
}

function isValidPortMapping(port: string): boolean {
  const [hostPortText, containerPortText] = port.split(':');
  const hostPort = Number(hostPortText);
  const containerPort = Number(containerPortText);

  return (
    Number.isInteger(hostPort) &&
    Number.isInteger(containerPort) &&
    hostPort >= 1 &&
    hostPort <= 65535 &&
    containerPort >= 1 &&
    containerPort <= 65535
  );
}

function makeUniqueIdentifier(base: string, used: Set<string>): string {
  const normalizedBase = base || 'service';
  let candidate = normalizedBase;
  let suffix = 2;

  while (used.has(candidate)) {
    candidate = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }

  used.add(candidate);
  return candidate;
}

function uniqueIdentifiers(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+/g, '-');

  return sanitized || '';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function noopProgress(): void {
  return undefined;
}


