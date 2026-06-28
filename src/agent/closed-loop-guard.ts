/**
 * ClosedLoopGuard — termination guard for the verify ? revise ? re-preview ? approve cycle.
 *
 * Prevents infinite loops when the verifier keeps failing and the planner keeps
 * revising without converging. Distinct from ReActLoopGuard which guards the
 * spec self-repair loop inside a single planning run.
 *
 * Mechanisms:
 *   1. iteration budget — max verify/revise rounds
 *   2. spec-hash stagnation — revised spec hash unchanged across rounds
 *   3. repeated failure cause — verifier fails with the same issue repeatedly
 */

export interface ClosedLoopGuardConfig {
  maxVerifyReviseIterations: number;
  specStagnationTolerance: number;
  repeatedFailureTolerance: number;
}

export const DEFAULT_CLOSED_LOOP_CONFIG: ClosedLoopGuardConfig = {
  maxVerifyReviseIterations: 5,
  specStagnationTolerance: 3,
  repeatedFailureTolerance: 3,
};

const ENV_MAX_VERIFY_REVISE = 'INFRA_AGENT_MAX_VERIFY_REVISE_ITERATIONS';
const ENV_SPEC_STAGNATION = 'INFRA_AGENT_SPEC_STAGNATION_TOLERANCE';
const ENV_REPEATED_FAILURE = 'INFRA_AGENT_REPEATED_FAILURE_TOLERANCE';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function loadClosedLoopGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): ClosedLoopGuardConfig {
  return {
    maxVerifyReviseIterations: parsePositiveInt(
      env[ENV_MAX_VERIFY_REVISE],
      DEFAULT_CLOSED_LOOP_CONFIG.maxVerifyReviseIterations,
    ),
    specStagnationTolerance: parsePositiveInt(
      env[ENV_SPEC_STAGNATION],
      DEFAULT_CLOSED_LOOP_CONFIG.specStagnationTolerance,
    ),
    repeatedFailureTolerance: parsePositiveInt(
      env[ENV_REPEATED_FAILURE],
      DEFAULT_CLOSED_LOOP_CONFIG.repeatedFailureTolerance,
    ),
  };
}

export class ClosedLoopGuardError extends Error {
  constructor(
    readonly reason: string,
    readonly iterations: number,
  ) {
    super(`Closed-loop guard stopped: ${reason} after ${iterations} iteration(s).`);
    this.name = 'ClosedLoopGuardError';
  }
}

export class ClosedLoopGuard {
  private iterations = 0;
  private lastSpecHash: string | null = null;
  private consecutiveSameSpec = 0;
  private lastFailureSignature: string | null = null;
  private consecutiveSameFailure = 0;

  constructor(private readonly config: ClosedLoopGuardConfig = loadClosedLoopGuardConfig()) {}

  get iterationCount(): number {
    return this.iterations;
  }

  /**
   * Call at the start of each verify/revise round.
   * @param specHash hash of the current desired spec
   * @param failureSignature a normalized signature of the verifier failure (or null if passed)
   * @throws ClosedLoopGuardError if any termination condition is met
   */
  tick(specHash: string, failureSignature: string | null): void {
    this.iterations += 1;

    if (this.iterations > this.config.maxVerifyReviseIterations) {
      throw new ClosedLoopGuardError('iteration_budget_exhausted', this.iterations);
    }

    // Spec stagnation detection
    if (specHash === this.lastSpecHash) {
      this.consecutiveSameSpec += 1;
    } else {
      this.consecutiveSameSpec = 1;
    }
    this.lastSpecHash = specHash;

    if (this.consecutiveSameSpec > this.config.specStagnationTolerance) {
      throw new ClosedLoopGuardError('spec_stagnation', this.iterations);
    }

    // Repeated failure detection
    if (failureSignature !== null) {
      if (failureSignature === this.lastFailureSignature) {
        this.consecutiveSameFailure += 1;
      } else {
        this.consecutiveSameFailure = 1;
      }
      this.lastFailureSignature = failureSignature;

      if (this.consecutiveSameFailure > this.config.repeatedFailureTolerance) {
        throw new ClosedLoopGuardError('repeated_failure', this.iterations);
      }
    }
  }

  /** Build a normalized failure signature from verifier issues. */
  static failureSignature(issues: string[]): string {
    return issues
      .map((i) => i.trim().toLowerCase().replace(/\s+/g, ' '))
      .sort()
      .join('|')
      .slice(0, 200);
  }
}