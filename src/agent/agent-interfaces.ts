import type {
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  ValidatedQuery,
  VerificationReport,
  PlannerRevisionRequest,
  PlannerRevisionResult,
} from '../domain/types.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';

export interface PlannerAgent {
  proposeSpec(
    query: ValidatedQuery,
    stateSnapshot: InfrastructureStateSnapshot | null,
    dockerMcpClient?: DockerMcpGateway,
  ): Promise<InfrastructureSpec>;

  repairSpec(
    spec: InfrastructureSpec,
    issues: string[],
    dockerMcpClient?: DockerMcpGateway,
  ): Promise<InfrastructureSpec>;

  reviseFromFeedback(
    request: PlannerRevisionRequest,
  ): Promise<PlannerRevisionResult>;
}

export interface VerifierAgent {
  verify(
    desiredSpec: InfrastructureSpec,
    dockerMcpClient: DockerMcpGateway,
  ): Promise<VerificationReport>;

  compareState(
    desired: InfrastructureSpec,
    actual: import('../domain/types.js').RuntimeActualState,
  ): Promise<VerificationReport>;
}
