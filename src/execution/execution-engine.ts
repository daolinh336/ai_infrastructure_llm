import type {
  AgentRunResult,
  DetailedDryRunPreview,
  PendingPreviewState,
} from '../domain/types.js';
import { renderCompose } from '../compose/render-compose.js';
import { validateAgentRunResult } from '../domain/schemas.js';
import {
  createPendingPreviewState,
  savePendingPreview,
  type StateStoreOptions,
} from '../state/file-state-store.js';
import {
  buildDependencyAwareExecutionSchedule,
  buildDetailedDryRunPreview,
} from './dependency-schedule.js';

export interface ExecutionResult {
  composeYaml: string;
  dryRunPreview: DetailedDryRunPreview;
  pendingPreview: PendingPreviewState;
}

export interface ExecutionEngineOptions {
  stateStore?: StateStoreOptions;
}

export class ExecutionEngine {
  constructor(private readonly options: ExecutionEngineOptions = {}) {}

  async dryRun(result: AgentRunResult): Promise<ExecutionResult> {
    const validResult = validateAgentRunResult(result);
    if (validResult.status !== 'planned') {
      throw new Error('Execution requires a planned agent result.');
    }

    const composeYaml = renderCompose(validResult.plan.spec);
    const schedule = buildDependencyAwareExecutionSchedule(validResult.plan.spec);
    const dryRunPreview = buildDetailedDryRunPreview(
      validResult.plan,
      composeYaml,
      schedule,
    );
    const pendingPreview = createPendingPreviewState({
      request: validResult.request,
      plan: validResult.plan,
      composeYaml,
      dryRunPreview,
      observations: validResult.observations,
      trace: validResult.trace ?? [],
    });

    return {
      composeYaml,
      dryRunPreview,
      pendingPreview,
    };
  }

  async saveDesiredState(result: AgentRunResult): Promise<ExecutionResult> {
    const executionResult = await this.dryRun(result);
    await savePendingPreview(executionResult.pendingPreview, this.options.stateStore);
    return executionResult;
  }

  async apply(result: AgentRunResult): Promise<ExecutionResult> {
    return this.saveDesiredState(result);
  }
}
