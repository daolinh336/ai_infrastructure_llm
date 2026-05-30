import type { AgentRunResult, ExecutionPlan, StateSnapshot } from '../domain/types.js';
import { renderCompose } from '../compose/render-compose.js';
import { saveState } from '../state/file-state-store.js';

export interface ExecutionResult {
  composeYaml: string;
  stateSnapshot: StateSnapshot;
}

export class ExecutionEngine {
  async dryRun(result: AgentRunResult): Promise<ExecutionResult> {
    const composeYaml = renderCompose(result.plan.spec);
    const stateSnapshot = this.toStateSnapshot(result.plan);

    return {
      composeYaml,
      stateSnapshot,
    };
  }

  async apply(result: AgentRunResult): Promise<ExecutionResult> {
    const executionResult = await this.dryRun(result);
    await saveState(executionResult.stateSnapshot);
    return executionResult;
  }

  private toStateSnapshot(plan: ExecutionPlan): StateSnapshot {
    return {
      desired: plan.spec,
      actual: {
        containers: [],
        lastObservedAt: null,
      },
      lastAppliedAt: new Date().toISOString(),
    };
  }
}
