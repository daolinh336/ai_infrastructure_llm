/**
 * ReActLoopGuard — termination guard for the self-repair loop (Sprint C.1 + D).
 *
 * Four mechanisms, in guarantee order (only the iteration budget alone
 * guarantees termination; the rest stop early and assign a clean reason):
 *   1. iteration budget        — unconditional upper bound on loop turns
 *   2. quagmire / no-op        — consecutive identical step signature
 *   3. per-tool call cap       — bounds ping-pong via the runTool chokepoint
 *   4. convergence / delta     — consecutive iterations with no measurable delta
 *
 * Every guard event is written to a LoopLogSink so a run can be audited after
 * it finishes. The default sink appends to a timestamped file under ./state.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { GuardTelemetry, GuardToolCallCount, GuardDeltaEntry } from '../domain/types.js';
export type { GuardTelemetry, GuardToolCallCount, GuardDeltaEntry };

export interface LoopGuardConfig {
  maxIterations: number;
  repeatTolerance: number;
  maxCallsPerTool: number;
  noProgressTolerance: number;
}

/** Trial-approved defaults: 14 / 3 / 5 / 3 (overridable via env). */
export const DEFAULT_LOOP_GUARD_CONFIG: LoopGuardConfig = {
  maxIterations: 14,
  repeatTolerance: 3,
  maxCallsPerTool: 5,
  noProgressTolerance: 3,
};

const ENV_MAX_ITERATIONS = 'INFRA_AGENT_MAX_REACT_ITERATIONS';
const ENV_REPEAT_TOLERANCE = 'INFRA_AGENT_REPEAT_TOLERANCE';
const ENV_MAX_CALLS_PER_TOOL = 'INFRA_AGENT_MAX_CALLS_PER_TOOL';
const ENV_NO_PROGRESS_TOLERANCE = 'INFRA_AGENT_NO_PROGRESS_TOLERANCE';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function loadLoopGuardConfig(env: NodeJS.ProcessEnv = process.env): LoopGuardConfig {
  return {
    maxIterations: parsePositiveInt(env[ENV_MAX_ITERATIONS], DEFAULT_LOOP_GUARD_CONFIG.maxIterations),
    repeatTolerance: parsePositiveInt(env[ENV_REPEAT_TOLERANCE], DEFAULT_LOOP_GUARD_CONFIG.repeatTolerance),
    maxCallsPerTool: parsePositiveInt(env[ENV_MAX_CALLS_PER_TOOL], DEFAULT_LOOP_GUARD_CONFIG.maxCallsPerTool),
    noProgressTolerance: parsePositiveInt(env[ENV_NO_PROGRESS_TOLERANCE], DEFAULT_LOOP_GUARD_CONFIG.noProgressTolerance),
  };
}


export class ReActLoopGuardError extends Error {
  constructor(
    readonly blockReason: string,
    readonly iterations: number,
    readonly telemetry: GuardTelemetry,
  ) {
    super(`ReAct loop guard stopped: ${blockReason} after ${iterations} iteration(s).`);
    this.name = 'ReActLoopGuardError';
  }
}

export interface LoopLogSink {
  readonly filePath: string | null;
  log(line: string): void;
  close(): void;
}

export class NoopLoopLogSink implements LoopLogSink {
  readonly filePath = null;
  log(): void {}
  close(): void {}
}

export class FileLoopLogSink implements LoopLogSink {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.log(`# ReAct loop guard log — started ${new Date().toISOString()}`);
  }

  log(line: string): void {
    appendFileSync(this.filePath, line + '\n', 'utf8');
  }

  close(): void {
    this.log(`# closed ${new Date().toISOString()}`);
  }
}

export interface LoopLogSinkOptions {
  enabled?: boolean;
  filePath?: string;
  stateDir?: string;
}

export function createLoopLogSink(options: LoopLogSinkOptions = {}): LoopLogSink {
  if (options.enabled === false) return new NoopLoopLogSink();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = options.stateDir ?? join(process.cwd(), 'state');
  const filePath = options.filePath ?? join(dir, `react-loop-${stamp}.log`);
  return new FileLoopLogSink(filePath);
}

function hashString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Stable spec hash for delta detection. Serializes the canonical fields so two
 * structurally equal specs hash identically regardless of key order.
 */
export function hashSpec(spec: unknown): string {
  return hashString(JSON.stringify(spec));
}

/**
 * Approximate issue count parsed from a DomainValidationError message, which is
 * formatted as `Invalid <label>:\n- issue\n- issue`. Used only as a delta signal.
 */
export function countValidationIssues(observation: string): number {
  return observation.split('\n').filter((line) => line.trim().startsWith('- ')).length;
}

export class ReActLoopGuard {
  private iterations = 0;
  private readonly perToolCounts = new Map<string, number>();
  private lastStepHash: string | null = null;
  private consecutiveRepeat = 0;
  private noProgress = 0;
  private readonly deltaHistory: GuardDeltaEntry[] = [];

  constructor(
    private readonly config: LoopGuardConfig,
    private readonly sink: LoopLogSink = new NoopLoopLogSink(),
  ) {}

  get iterationCount(): number {
    return this.iterations;
  }

  get logFilePath(): string | null {
    return this.sink.filePath;
  }

  beginRun(): void {
    this.sink.log(
      `config: maxIterations=${this.config.maxIterations} repeatTolerance=${this.config.repeatTolerance}` +
        ` maxCallsPerTool=${this.config.maxCallsPerTool} noProgressTolerance=${this.config.noProgressTolerance}`,
    );
  }

  /** Mechanism 1: unconditional iteration budget. Call at the top of each loop body. */
  tickIteration(): void {
    this.iterations += 1;
    this.sink.log(`[iter ${this.iterations}] tick`);
    if (this.iterations > this.config.maxIterations) {
      this.block('iteration_budget_exhausted');
    }
  }

  /** Mechanism 3: per-tool call cap. Call from the runTool chokepoint before invoke. */
  checkToolCap(tool: string): void {
    const next = (this.perToolCounts.get(tool) ?? 0) + 1;
    this.perToolCounts.set(tool, next);
    const capped = next > this.config.maxCallsPerTool;
    this.sink.log(`[tool] ${tool} call #${next}${capped ? ' (CAP EXCEEDED)' : ''}`);
    if (capped) {
      this.block(`tool_cap_exceeded:${tool}`);
    }
  }

  /** Mechanism 2: quagmire detection on a step signature. Returns the hash used. */
  observeStep(signature: string): string {
    const stepHash = hashString(signature);
    if (stepHash === this.lastStepHash) {
      this.consecutiveRepeat += 1;
    } else {
      this.consecutiveRepeat = 1;
    }
    this.lastStepHash = stepHash;
    this.sink.log(`[quagmire] stepHash=${stepHash} consecutiveRepeat=${this.consecutiveRepeat}`);
    if (this.consecutiveRepeat >= this.config.repeatTolerance) {
      this.block('quagmire_repeat');
    }
    return stepHash;
  }

  /** Mechanism 4: convergence / no-progress. Call after each observe. */
  recordProgress(hasDelta: boolean, specHash: string, issueCount: number, stepHash: string): void {
    this.noProgress = hasDelta ? 0 : this.noProgress + 1;
    this.deltaHistory.push({ iteration: this.iterations, hasDelta, specHash, issueCount, stepHash });
    this.sink.log(
      `[delta] iter=${this.iterations} hasDelta=${hasDelta} specHash=${specHash}` +
        ` issueCount=${issueCount} noProgress=${this.noProgress}`,
    );
    if (this.noProgress >= this.config.noProgressTolerance) {
      this.block('no_progress');
    }
  }

  /** Call when the loop converged (validation passed). */
  converge(): GuardTelemetry {
    this.sink.log(`[outcome] converged after ${this.iterations} iteration(s)`);
    return this.buildTelemetry('converged', null);
  }

  close(): void {
    this.sink.close();
  }

  private block(reason: string): never {
    const telemetry = this.buildTelemetry('blocked', reason);
    this.sink.log(`[outcome] BLOCKED reason=${reason} after ${this.iterations} iteration(s)`);
    throw new ReActLoopGuardError(reason, this.iterations, telemetry);
  }

  private buildTelemetry(outcome: 'converged' | 'blocked', blockReason: string | null): GuardTelemetry {
    const perToolCounts: GuardToolCallCount[] = [...this.perToolCounts.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([tool, count]) => ({ tool, count, capped: count > this.config.maxCallsPerTool }));
    return {
      iterations: this.iterations,
      outcome,
      blockReason,
      perToolCounts,
      deltaHistory: [...this.deltaHistory],
      logFilePath: this.sink.filePath,
    };
  }
}