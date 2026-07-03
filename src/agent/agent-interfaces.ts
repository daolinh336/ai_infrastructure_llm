import type {
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  ValidatedQuery,
  VerificationReport,
  PlannerRevisionRequest,
  PlannerRevisionResult,
} from '../domain/types.js';
import type { PlannerRuntimeReader, VerifierRuntimeReader } from '../execution/runtime-environment-reader.js';

export interface PlannerAgent {
  proposeSpec(
    query: ValidatedQuery,
    stateSnapshot: InfrastructureStateSnapshot | null,
    runtimeReader?: PlannerRuntimeReader,
  ): Promise<InfrastructureSpec>;

  repairSpec(
    spec: InfrastructureSpec,
    issues: string[],
    runtimeReader?: PlannerRuntimeReader,
  ): Promise<InfrastructureSpec>;

  reviseFromFeedback(
    request: PlannerRevisionRequest,
    runtimeReader?: PlannerRuntimeReader,
  ): Promise<PlannerRevisionResult>;
}

export interface VerifierAgent {
  verify(
    desiredSpec: InfrastructureSpec,
    runtimeReader: VerifierRuntimeReader,
  ): Promise<VerificationReport>;

  compareState(
    desired: InfrastructureSpec,
    actual: import('../domain/types.js').RuntimeActualState,
  ): Promise<VerificationReport>;
}
