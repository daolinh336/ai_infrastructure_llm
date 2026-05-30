import type { AgentObservation, AgentRunResult, ExecutionPlan, UserCommand } from '../domain/types.js';
import type { LlmProvider } from '../llm/provider.js';

function buildSeedPlan(command: UserCommand): ExecutionPlan {
  return {
    summary: `Plan for: ${command.raw}`,
    spec: {
      projectName: 'sample-infra',
      networks: ['app-network'],
      volumes: ['postgres-data'],
      services: [
        {
          kind: 'reverse-proxy',
          name: 'nginx',
          image: 'nginx:stable',
          ports: ['80:80'],
          dependsOn: ['api'],
        },
        {
          kind: 'backend',
          name: 'api',
          image: 'node:20-alpine',
          replicas: 2,
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
    },
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
  constructor(private readonly provider: LlmProvider) {}

  async run(command: UserCommand): Promise<AgentRunResult> {
    const observations: AgentObservation[] = [
      {
        source: 'reason',
        message: 'Interpret the natural-language request and identify the target infrastructure topology.',
      },
    ];

    const completion = await this.provider.complete({
      system:
        'You are a ReAct infrastructure agent. Analyze the request, think about services, dependencies, and safe execution order.',
      user: command.raw,
    });

    observations.push({
      source: 'observe',
      message: completion.text,
    });

    observations.push({
      source: 'act',
      message: 'Produce an execution plan, compose spec, and follow-up deployment steps.',
    });

    return {
      plan: buildSeedPlan(command),
      observations,
    };
  }
}
