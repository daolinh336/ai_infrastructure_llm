import type { AgentRunResult, ExecutionPlan, StateSnapshot } from '../domain/types.js';
import { renderCompose } from '../compose/render-compose.js';
import {
  validateAgentRunResult,
  validateExecutionPlan,
  validateStateSnapshot,
} from '../domain/schemas.js';
import { saveState } from '../state/file-state-store.js';

export interface ExecutionResult {
  composeYaml: string;
  stateSnapshot: StateSnapshot;
}

export class ExecutionEngine {
  async dryRun(result: AgentRunResult): Promise<ExecutionResult> {
    const validResult = validateAgentRunResult(result);
    const composeYaml = renderCompose(validResult.plan.spec);
    const stateSnapshot = validateStateSnapshot(this.toStateSnapshot(validResult.plan));

    return {
      composeYaml,
      stateSnapshot,
    };
  }

  async saveDesiredState(result: AgentRunResult): Promise<ExecutionResult> {
    const executionResult = await this.dryRun(result);
    await saveState(executionResult.stateSnapshot);
    return executionResult;
  }

  async apply(result: AgentRunResult): Promise<ExecutionResult> {
    return this.saveDesiredState(result);
  }

  private toStateSnapshot(plan: ExecutionPlan): StateSnapshot {
    const validPlan = validateExecutionPlan(plan);

    return {
      desired: validPlan.spec,
      actual: {
        containers: [],
        lastObservedAt: null,
      },
      desiredStateSavedAt: new Date().toISOString(),
      lastAppliedAt: null,
    };
  }
}
