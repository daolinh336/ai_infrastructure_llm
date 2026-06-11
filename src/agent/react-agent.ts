import {
  validateExecutionPlan,
  validateInfrastructureSpec,
  validateReactReasoningOutput,
  validateStateSnapshot,
  validateValidatedQuery,
} from '../domain/schemas.js';
import { renderCompose } from '../compose/render-compose.js';
import { reactReasoningOutputJsonSchema } from '../domain/structured-output-schemas.js';
import {
  SUPPORTED_IMAGE_BASES,
  getImageReferenceBase,
  isSupportedImageReference,
  resolveImageReference,
  type ImageReferenceResolution,
} from '../domain/supported-images.js';
import type {
  AgentObservation,
  AgentRunResult,
  AgentTool,
  AgentToolResult,
  DraftServiceQuery,
  ExecutionPlan,
  InfrastructureService,
  InfrastructureSpec,
  PlanStep,
  ProgressReporter,
  ReActStep,
  ReActReasoningOutput,
  ValidatedQuery,
} from '../domain/types.js';
import { parseJsonResponse } from '../llm/json-response.js';
import type { LlmProvider } from '../llm/provider.js';
import { loadState, saveState } from '../state/file-state-store.js';

const DEPLOY_DETAILS_CLARIFICATION_QUESTION = [
  'Can ban noi ro hon truoc khi lap plan.',
  'Vui long cho biet: image/runtime nao se dung cho tung service/container, container nao deploy tu image nao, so luong/replicas mong muon, port nao can expose, network nao can tao/dung chung, volume nao can mount/persist, va env/secrets neu co.',
  `Hien baseline chi ho tro image/runtime: ${SUPPORTED_IMAGE_BASES.join(', ')}.`,
].join(' ');

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

interface DraftSpecProposal {
  spec: InfrastructureSpec;
  assumptions: string[];
}

interface PlanBuildInput {
  spec: InfrastructureSpec;
  rawPrompt: string;
  assumptions: string[];
}

interface SpecRepairInput {
  spec: InfrastructureSpec;
  rawPrompt: string;
  validationIssue: string;
}

interface ImageReferenceResolutionInput {
  image: string;
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

export class ReActAgent {
  private readonly tools: AgentTool[];

  constructor(
    private readonly provider: LlmProvider,
    private readonly reportProgress: ProgressReporter = noopProgress,
  ) {
    this.tools = [
      createLoadStateTool(),
      createResolveImageReferenceTool(),
      createProposeDraftSpecTool(),
      createRepairInfrastructureSpecTool(),
      createBuildExecutionPlanTool(),
      createValidateInfrastructureSpecTool(),
      createRenderComposePreviewTool(),
      createSaveStateTool(),
    ];
  }

  listTools(): Array<Pick<AgentTool, 'name' | 'description'>> {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
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

    await this.observeStructuredReasoning(validatedQuery, trace, observations);

    const imageResolution = await this.resolveDraftImageReferences(
      validatedQuery,
      trace,
      observations,
    );

    if (imageResolution.status === 'clarification') {
      return {
        status: 'clarification',
        clarificationQuestion: imageResolution.question,
        observations,
        trace,
      };
    }

    validatedQuery = imageResolution.query;

    if (needsDeployDetailsClarification(validatedQuery)) {
      recordStep(
        trace,
        observations,
        {
          phase: 'reason',
          message:
            'The request is infrastructure-related but not deployable yet because image/container/network/volume details are missing.',
          toolName: null,
        },
        this.reportProgress,
      );
      recordStep(
        trace,
        observations,
        {
          phase: 'observe',
          message: DEPLOY_DETAILS_CLARIFICATION_QUESTION,
          toolName: 'ask_user',
        },
        this.reportProgress,
      );

      return {
        status: 'clarification',
        clarificationQuestion: DEPLOY_DETAILS_CLARIFICATION_QUESTION,
        observations,
        trace,
      };
    }

    await this.runTool('load_state', validatedQuery, trace, observations);

    const draftProposalResult = await this.runTool(
      'propose_draft_spec',
      validatedQuery,
      trace,
      observations,
    );
    const draftProposal = draftProposalResult.data as DraftSpecProposal;

    let specValidationResult = await this.runTool(
      'validate_infra_spec',
      draftProposal.spec,
      trace,
      observations,
      { throwOnFailure: false },
    );

    let proposal = draftProposal;
    if (!specValidationResult.ok) {
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
          spec: draftProposal.spec,
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

        return {
          status: 'clarification',
          clarificationQuestion:
            'Draft spec validation failed and the agent could not repair it automatically. Please restate the desired services, dependencies, and volume layout in more concrete terms.',
          observations,
          trace,
        };
      }

      proposal = {
        spec: repairResult.data as InfrastructureSpec,
        assumptions: [
          ...draftProposal.assumptions,
          'Draft spec required automatic repair before validation could pass.',
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

    if (!specValidationResult.ok) {
      recordStep(
        trace,
        observations,
        {
          phase: 'observe',
          message:
            'Draft spec validation still failed after repair, so ask the user for clarification.',
          toolName: 'ask_user',
        },
        this.reportProgress,
      );

      return {
        status: 'clarification',
        clarificationQuestion:
          'The generated infrastructure spec is still invalid after repair. Please confirm the service names, dependencies, and volume declarations.',
        observations,
        trace,
      };
    }

    const validatedSpec = specValidationResult.data as InfrastructureSpec;

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
        rawPrompt: validatedQuery.raw,
        assumptions: proposal.assumptions,
      } satisfies PlanBuildInput,
      trace,
      observations,
    );
    const plan = planResult.data as ExecutionPlan;

    await this.runTool('render_compose_preview', plan.spec, trace, observations);

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
      plan,
      observations,
      trace,
    };
  }

  private async observeStructuredReasoning(
    query: ValidatedQuery,
    trace: ReActStep[],
    observations: AgentObservation[],
  ): Promise<void> {
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
    }
  }

  private async resolveDraftImageReferences(
    query: ValidatedQuery,
    trace: ReActStep[],
    observations: AgentObservation[],
  ): Promise<
    | { status: 'resolved'; query: ValidatedQuery }
    | { status: 'clarification'; question: string }
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
        recordStep(
          trace,
          observations,
          {
            phase: 'observe',
            message: result.observation,
            toolName: 'ask_user',
          },
          this.reportProgress,
        );

        return {
          status: 'clarification',
          question: result.observation,
        };
      }

      const resolution = result.data as ImageReferenceResolution;

      if (resolution.confidence !== 'high' || resolution.resolved === null) {
        const question = buildImageResolutionQuestion(resolution);
        recordStep(
          trace,
          observations,
          {
            phase: 'observe',
            message: question,
            toolName: 'ask_user',
          },
          this.reportProgress,
        );

        return {
          status: 'clarification',
          question,
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
    const tool = this.tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      throw new Error(`Unknown agent tool: ${toolName}`);
    }

    recordStep(trace, observations, {
      phase: 'act',
      message: `Call internal tool: ${tool.name}.`,
      toolName: tool.name,
    }, this.reportProgress);

    const result = await tool.invoke(input);

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

function createLoadStateTool(): AgentTool {
  return {
    name: 'load_state',
    description: 'Read saved desired/actual state as ReAct memory without mutating runtime.',
    async invoke(): Promise<AgentToolResult> {
      const snapshot = await loadState().catch((error: unknown) => ({
        error: getErrorMessage(error),
      }));

      if (snapshot !== null && 'error' in snapshot) {
        return {
          ok: true,
          observation: `Saved state could not be loaded: ${snapshot.error}`,
          data: null,
        };
      }

      if (snapshot === null) {
        return {
          ok: true,
          observation: 'No saved infrastructure state found.',
          data: null,
        };
      }

      return {
        ok: true,
        observation: `Loaded saved state for project "${snapshot.desired.projectName}".`,
        data: snapshot,
      };
    },
  };
}

function createResolveImageReferenceTool(): AgentTool {
  return {
    name: 'resolve_image_reference',
    description:
      'Resolve one image/runtime reference against the supported image catalog before spec generation.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const imageInput = parseImageReferenceResolutionInput(input);
        const resolution = resolveImageReference(imageInput.image);

        return {
          ok: true,
          observation: formatImageResolutionObservation(resolution),
          data: resolution,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
}

function createProposeDraftSpecTool(): AgentTool {
  return {
    name: 'propose_draft_spec',
    description:
      'Normalize the ValidatedQuery draft into a candidate InfrastructureSpec before validation.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const query = validateValidatedQuery(input);
        const proposal = proposeDraftSpec(query);

        return {
          ok: true,
          observation: [
            `Proposed draft spec with ${proposal.spec.services.length} service(s).`,
            `Assumptions: ${proposal.assumptions.join('; ')}.`,
          ].join(' '),
          data: proposal,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
}

function createRepairInfrastructureSpecTool(): AgentTool {
  return {
    name: 'repair_infra_spec',
    description:
      'Repair a candidate InfrastructureSpec after validation returns an observation.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const repairInput = parseSpecRepairInput(input);
        const repairedSpec = repairInfrastructureSpec(repairInput.spec);
        const validSpec = validateInfrastructureSpec(repairedSpec);

        return {
          ok: true,
          observation: [
            'Repaired draft spec and validation can be retried.',
            `Original validation issue: ${repairInput.validationIssue}`,
          ].join(' '),
          data: validSpec,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
}

function createBuildExecutionPlanTool(): AgentTool {
  return {
    name: 'build_execution_plan',
    description: 'Build an execution plan from a validated InfrastructureSpec.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const planInput = parsePlanBuildInput(input);
        const plan = buildExecutionPlanFromSpec(planInput);

        return {
          ok: true,
          observation: [
            `Built execution plan from validated spec with ${plan.spec.services.length} service(s).`,
            `Assumptions: ${plan.assumptions.join('; ')}.`,
          ].join(' '),
          data: plan,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
}

function createValidateInfrastructureSpecTool(): AgentTool {
  return {
    name: 'validate_infra_spec',
    description: 'Validate the infrastructure spec before returning a plan.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const spec = validateInfrastructureSpec(input);

        return {
          ok: true,
          observation: `Validated infrastructure spec for project "${spec.projectName}".`,
          data: spec,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
}

function createRenderComposePreviewTool(): AgentTool {
  return {
    name: 'render_compose_preview',
    description: 'Render Docker Compose YAML from a validated infrastructure spec.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const spec = validateInfrastructureSpec(input);
        const composeYaml = renderCompose(spec);
        const lineCount = composeYaml.trim().split(/\r?\n/).length;

        return {
          ok: true,
          observation: `Rendered Docker Compose preview with ${lineCount} line(s).`,
          data: composeYaml,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
}

function createSaveStateTool(): AgentTool {
  return {
    name: 'save_state',
    description:
      'Persist a validated desired-state snapshot after the approval/execution phase allows state writes.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const snapshot = validateStateSnapshot(input);
        await saveState(snapshot);

        return {
          ok: true,
          observation: `Saved desired state for project "${snapshot.desired.projectName}".`,
          data: snapshot,
        };
      } catch (error) {
        return {
          ok: false,
          observation: getErrorMessage(error),
          data: null,
        };
      }
    },
  };
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

function needsDeployDetailsClarification(query: ValidatedQuery): boolean {
  if (query.intent !== 'create') {
    return false;
  }

  return (
    !query.draft.services.length ||
    query.draft.services.every((service) => service.image === null)
  );
}

function parseImageReferenceResolutionInput(input: unknown): ImageReferenceResolutionInput {
  if (!isRecord(input)) {
    throw new Error('Image resolution input must be an object.');
  }

  const image = input.image;

  if (typeof image !== 'string' || image.trim() === '') {
    throw new Error('Image resolution input requires image.');
  }

  return {
    image,
  };
}

function formatImageResolutionObservation(resolution: ImageReferenceResolution): string {
  if (resolution.confidence === 'high' && resolution.resolved !== null) {
    return [
      `Resolved image reference "${resolution.raw}" to "${resolution.resolved}".`,
      `Confidence: ${resolution.confidence}.`,
      `Reason: ${resolution.reason}.`,
    ].join(' ');
  }

  return buildImageResolutionQuestion(resolution);
}

function buildImageResolutionQuestion(resolution: ImageReferenceResolution): string {
  const candidateText = resolution.candidates.length
    ? ` Candidates: ${resolution.candidates.join(', ')}.`
    : '';

  return [
    `Can ban xac nhan image/runtime "${resolution.raw}" truoc khi lap plan.`,
    resolution.reason === 'ambiguous'
      ? 'He thong thay ten nay gan voi mot vai image supported nhung chua du chac de tu sua.'
      : 'Image/runtime nay chua nam trong supported image list.',
    candidateText,
    `Supported images hien tai: ${SUPPORTED_IMAGE_BASES.join(', ')}.`,
  ].join(' ');
}

function parsePlanBuildInput(input: unknown): PlanBuildInput {
  if (!isRecord(input)) {
    throw new Error('Plan build input must be an object.');
  }

  const rawPrompt = input.rawPrompt;
  const assumptions = input.assumptions;

  if (typeof rawPrompt !== 'string' || rawPrompt.trim() === '') {
    throw new Error('Plan build input requires rawPrompt.');
  }

  if (
    !Array.isArray(assumptions) ||
    assumptions.length === 0 ||
    !assumptions.every((assumption) => typeof assumption === 'string' && assumption.trim() !== '')
  ) {
    throw new Error('Plan build input requires at least one assumption.');
  }

  return {
    spec: validateInfrastructureSpec(input.spec),
    rawPrompt,
    assumptions,
  };
}

function parseSpecRepairInput(input: unknown): SpecRepairInput {
  if (!isRecord(input)) {
    throw new Error('Spec repair input must be an object.');
  }

  const rawPrompt = input.rawPrompt;
  const validationIssue = input.validationIssue;

  if (typeof rawPrompt !== 'string' || rawPrompt.trim() === '') {
    throw new Error('Spec repair input requires rawPrompt.');
  }

  if (typeof validationIssue !== 'string' || validationIssue.trim() === '') {
    throw new Error('Spec repair input requires validationIssue.');
  }

  return {
    spec: input.spec as InfrastructureSpec,
    rawPrompt,
    validationIssue,
  };
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

function getDefaultEnvironment(
  imageBase: string,
): { environment: Record<string, string> } | Record<string, never> {
  if (imageBase === 'postgres') {
    return {
      environment: {
        POSTGRES_DB: 'app',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: 'app',
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
              MYSQL_PASSWORD: 'app',
              MYSQL_ROOT_PASSWORD: 'app',
            }
          : {
              MARIADB_DATABASE: 'app',
              MARIADB_USER: 'app',
              MARIADB_PASSWORD: 'app',
              MARIADB_ROOT_PASSWORD: 'app',
            }),
      },
    };
  }

  if (imageBase === 'mongo') {
    return {
      environment: {
        MONGO_INITDB_ROOT_USERNAME: 'app',
        MONGO_INITDB_ROOT_PASSWORD: 'app',
      },
    };
  }

  if (imageBase === 'rabbitmq') {
    return {
      environment: {
        RABBITMQ_DEFAULT_USER: 'app',
        RABBITMQ_DEFAULT_PASS: 'app',
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
        KEYCLOAK_ADMIN_PASSWORD: 'admin',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
