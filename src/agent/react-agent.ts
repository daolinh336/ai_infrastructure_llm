import {
  validateInfrastructureSpec,
  validateValidatedQuery,
} from '../domain/schemas.js';
import { renderCompose } from '../compose/render-compose.js';
import type {
  AgentObservation,
  AgentRunResult,
  AgentTool,
  AgentToolResult,
  ExecutionPlan,
  InfrastructureService,
  InfrastructureSpec,
  ReActStep,
  ValidatedQuery,
} from '../domain/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { loadState } from '../state/file-state-store.js';

function buildExecutionPlan(query: ValidatedQuery): ExecutionPlan {
  const spec = buildSpecFromDraft(query);

  return {
    summary: `Plan for: ${query.raw}`,
    spec,
    steps: [
      {
        id: 'generate-compose',
        description: 'Generate docker-compose YAML from desired infrastructure spec.',
        action: 'generate-compose',
      },
      {
        id: 'write-state',
        description: 'Persist desired state snapshot for drift detection and status commands.',
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
    ],
  };
}

export class ReActAgent {
  private readonly tools: AgentTool[];

  constructor(private readonly provider: LlmProvider) {
    this.tools = [
      createLoadStateTool(),
      createBuildExecutionPlanTool(),
      createValidateInfrastructureSpecTool(),
      createRenderComposePreviewTool(),
    ];
  }

  async run(query: ValidatedQuery): Promise<AgentRunResult> {
    const validatedQuery = validateValidatedQuery(query);
    const observations: AgentObservation[] = [];
    const trace: ReActStep[] = [];

    recordStep(trace, observations, {
      phase: 'reason',
      message:
        'Read the ValidatedQuery and decide which infrastructure planning tools should run next.',
      toolName: null,
    });

    const completion = await this.provider.complete({
      system:
        'You are a ReAct infrastructure agent. Reason over the ValidatedQuery, tool observations, service dependencies, and safe execution order. Do not call Docker directly.',
      user: JSON.stringify(validatedQuery),
    });

    recordStep(trace, observations, {
      phase: 'observe',
      message: completion.text,
      toolName: 'llm_reasoning',
    });

    await this.runTool('load_state', validatedQuery, trace, observations);

    const planResult = await this.runTool('build_execution_plan', validatedQuery, trace, observations);
    const plan = planResult.data as ExecutionPlan;

    await this.runTool('validate_infra_spec', plan.spec, trace, observations);

    recordStep(trace, observations, {
      phase: 'reason',
      message:
        'The infrastructure spec validation passed, so render a Compose preview as the next safe action.',
      toolName: null,
    });

    await this.runTool('render_compose_preview', plan.spec, trace, observations);

    recordStep(trace, observations, {
      phase: 'reason',
      message:
        'The plan spec is valid, so return the execution plan to the CLI for preview/dry-run.',
      toolName: null,
    });

    return {
      plan,
      observations,
      trace,
    };
  }

  private async runTool(
    toolName: string,
    input: unknown,
    trace: ReActStep[],
    observations: AgentObservation[],
  ): Promise<AgentToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      throw new Error(`Unknown agent tool: ${toolName}`);
    }

    recordStep(trace, observations, {
      phase: 'act',
      message: `Call internal tool: ${tool.name}.`,
      toolName: tool.name,
    });

    const result = await tool.invoke(input);

    recordStep(trace, observations, {
      phase: 'observe',
      message: result.observation,
      toolName: tool.name,
    });

    if (!result.ok) {
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

function createBuildExecutionPlanTool(): AgentTool {
  return {
    name: 'build_execution_plan',
    description: 'Build an execution plan from a ValidatedQuery.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      const query = validateValidatedQuery(input);
      const plan = buildExecutionPlan(query);

      return {
        ok: true,
        observation: `Built execution plan with ${plan.spec.services.length} service(s).`,
        data: plan,
      };
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

function recordStep(
  trace: ReActStep[],
  observations: AgentObservation[],
  step: Omit<ReActStep, 'id'>,
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
}

function buildSpecFromDraft(query: ValidatedQuery): InfrastructureSpec {
  const services = query.draft.services.filter((service) => service.image !== null);
  const serviceImages = new Set(services.map((service) => getImageBase(service.image ?? '')));

  if (
    serviceImages.has('nginx') &&
    serviceImages.has('node') &&
    serviceImages.has('postgres')
  ) {
    return buildWebAppSpec(query);
  }

  return buildGenericSpec(query);
}

function buildWebAppSpec(query: ValidatedQuery): InfrastructureSpec {
  const nginxDraft = findDraftService(query, 'nginx');
  const nodeDraft = findDraftService(query, 'node');

  return {
    projectName: 'sample-infra',
    networks: ['app-network'],
    volumes: ['postgres-data'],
    services: [
      {
        kind: 'reverse-proxy',
        name: 'nginx',
        image: 'nginx:stable',
        ports: [`${nginxDraft?.port ?? 80}:80`],
        dependsOn: ['api'],
      },
      {
        kind: 'backend',
        name: 'api',
        image: 'node:20-alpine',
        replicas: nodeDraft?.replicas ?? 2,
        dependsOn: ['postgres'],
      },
      {
        kind: 'database',
        name: 'postgres',
        image: 'postgres:16',
        environment: {
          POSTGRES_DB: 'app',
          POSTGRES_USER: 'app',
          POSTGRES_PASSWORD: 'app',
        },
        volumes: ['postgres-data:/var/lib/postgresql/data'],
      },
    ],
  };
}

function buildGenericSpec(query: ValidatedQuery): InfrastructureSpec {
  const services: InfrastructureService[] = [];
  const volumes = new Set<string>();

  query.draft.services
    .filter((service) => service.image !== null)
    .forEach((service, index) => {
      const image = service.image ?? 'nginx';
      const imageBase = getImageBase(image);
      const name = service.name ?? (imageBase || `service-${index + 1}`);
      const volumeName = isDatabaseImage(imageBase) ? `${name}-data` : null;

      if (volumeName !== null) {
        volumes.add(volumeName);
      }

      services.push({
        kind: getServiceKind(imageBase),
        name,
        image: getDefaultImage(image),
        ...(service.replicas !== null ? { replicas: service.replicas } : {}),
        ...(service.port !== null
          ? { ports: [`${service.port}:${getDefaultContainerPort(imageBase)}`] }
          : {}),
        ...(volumeName !== null
          ? { volumes: [`${volumeName}:${getDefaultVolumeTarget(imageBase)}`] }
          : {}),
      });
    });

  return {
    projectName: 'sample-infra',
    networks: ['app-network'],
    volumes: [...volumes],
    services,
  };
}

function findDraftService(query: ValidatedQuery, imageBase: string) {
  return query.draft.services.find(
    (service) => service.image !== null && getImageBase(service.image) === imageBase,
  );
}

function getImageBase(image: string): string {
  return image.split(':')[0]?.split('/').pop()?.toLowerCase() ?? image.toLowerCase();
}

function getDefaultImage(image: string): string {
  const imageBase = getImageBase(image);

  switch (imageBase) {
    case 'nginx':
      return 'nginx:stable';
    case 'node':
      return 'node:20-alpine';
    case 'python':
      return 'python:3.12-alpine';
    case 'postgres':
      return 'postgres:16';
    case 'mysql':
      return 'mysql:8';
    case 'redis':
      return 'redis:7-alpine';
    default:
      return image;
  }
}

function getServiceKind(imageBase: string): InfrastructureService['kind'] {
  if (imageBase === 'nginx') {
    return 'reverse-proxy';
  }

  if (isDatabaseImage(imageBase)) {
    return 'database';
  }

  return 'backend';
}

function isDatabaseImage(imageBase: string): boolean {
  return imageBase === 'postgres' || imageBase === 'mysql' || imageBase === 'redis';
}

function getDefaultContainerPort(imageBase: string): number {
  switch (imageBase) {
    case 'nginx':
      return 80;
    case 'postgres':
      return 5432;
    case 'mysql':
      return 3306;
    case 'redis':
      return 6379;
    default:
      return 3000;
  }
}

function getDefaultVolumeTarget(imageBase: string): string {
  switch (imageBase) {
    case 'postgres':
      return '/var/lib/postgresql/data';
    case 'mysql':
      return '/var/lib/mysql';
    case 'redis':
      return '/data';
    default:
      return '/data';
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
