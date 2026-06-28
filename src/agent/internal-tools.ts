import { z } from 'zod';
import { renderCompose } from '../compose/render-compose.js';
import {
  dependencyAwareExecutionScheduleSchema,
  detailedDryRunPreviewSchema,
  dryRunPolicyFindingSchema,
  executionPlanSchema,
  infrastructureSpecSchema,
  infrastructureStateSnapshotSchema,
  validateDependencyAwareExecutionSchedule,
  validateDetailedDryRunPreview,
  validateExecutionPlan,
  validateInfrastructureSpec,
  validateInfrastructureStateSnapshot,
  validateValidatedQuery,
  validatedQuerySchema,
} from '../domain/schemas.js';
import { resolveImageReference, type ImageReferenceResolution } from '../domain/supported-images.js';
import type {
  AgentTool,
  AgentToolResult,
  DependencyAwareExecutionSchedule,
  ExecutionPlan,
  InfrastructureSpec,
  InfrastructureStateSnapshot,
  ValidatedQuery,
} from '../domain/types.js';
import { buildDependencyAwareExecutionSchedule, buildDetailedDryRunPreview } from '../execution/dependency-schedule.js';
import { loadState, saveState, type StateStoreOptions } from '../state/sqlite-state-store.js';
import { AgentToolRegistry } from './tool-registry.js';
import { defineAgentTool, type AgentToolCategory } from './tool-types.js';

export interface DraftSpecProposal {
  spec: InfrastructureSpec;
  assumptions: string[];
}

export interface PlanBuildInput {
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

interface DetailedDryRunPreviewInput {
  plan: ExecutionPlan;
  composeYaml: string;
  schedule: DependencyAwareExecutionSchedule;
}

export interface InternalAgentToolDependencies {
  stateStore: StateStoreOptions;
  formatStateMemoryObservation(snapshot: InfrastructureStateSnapshot): string;
  proposeDraftSpec(query: ValidatedQuery): DraftSpecProposal;
  repairInfrastructureSpec(spec: InfrastructureSpec): InfrastructureSpec;
  buildExecutionPlanFromSpec(input: PlanBuildInput): ExecutionPlan;
}

const imageReferenceResolutionInputSchema = z.object({ image: z.string().trim().min(1) });
const draftSpecProposalSchema = z.object({
  spec: infrastructureSpecSchema,
  assumptions: z.array(z.string().trim().min(1)),
});
const specRepairInputSchema = z.object({
  spec: infrastructureSpecSchema,
  rawPrompt: z.string().trim().min(1),
  validationIssue: z.string().trim().min(1),
});
const planBuildInputSchema = z.object({
  spec: infrastructureSpecSchema,
  rawPrompt: z.string().trim().min(1),
  assumptions: z.array(z.string().trim().min(1)).min(1),
});
const detailedDryRunPreviewInputSchema = z.object({
  plan: executionPlanSchema,
  composeYaml: z.string().trim().min(1),
  schedule: dependencyAwareExecutionScheduleSchema,
});
const dryRunPolicyFindingsSchema = z.array(dryRunPolicyFindingSchema);

export function createInternalAgentToolRegistry(
  dependencies: InternalAgentToolDependencies,
): AgentToolRegistry {
  return new AgentToolRegistry(
    [
      createLoadStateTool(dependencies),
      createResolveImageReferenceTool(),
      createProposeDraftSpecTool(dependencies),
      createRepairInfrastructureSpecTool(dependencies),
      createBuildExecutionPlanTool(dependencies),
      createValidateInfrastructureSpecTool(),
      createBuildDependencyAwareExecutionScheduleTool(),
      createRenderComposePreviewTool(),
      createBuildDetailedDryRunPreviewTool(),
      createEvaluateDryRunPolicyTool(),
      createSaveStateTool(dependencies),
    ].map(wrapInternalTool),
  );
}

function wrapInternalTool(tool: AgentTool) {
  const inputSchema = getInternalToolInputSchema(tool.name);
  const outputSchema = getInternalToolOutputSchema(tool.name);
  return defineAgentTool({
    ...tool,
    category: getInternalToolCategory(tool.name),
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  });
}

function getInternalToolCategory(toolName: string): AgentToolCategory {
  switch (toolName) {
    case 'load_state':
      return 'read';
    case 'save_state':
      return 'state';
    case 'validate_infra_spec':
      return 'validate';
    case 'render_compose_preview':
    case 'build_detailed_dry_run_preview':
    case 'evaluate_dry_run_policy':
      return 'preview';
    default:
      return 'plan';
  }
}

function getInternalToolInputSchema(toolName: string): z.ZodType<unknown> | undefined {
  switch (toolName) {
    case 'resolve_image_reference':
      return imageReferenceResolutionInputSchema;
    case 'propose_draft_spec':
      return validatedQuerySchema;
    case 'repair_infra_spec':
      return specRepairInputSchema;
    case 'build_execution_plan':
      return planBuildInputSchema;
    case 'validate_infra_spec':
    case 'build_dependency_aware_execution_schedule':
    case 'render_compose_preview':
      return infrastructureSpecSchema;
    case 'build_detailed_dry_run_preview':
      return detailedDryRunPreviewInputSchema;
    case 'evaluate_dry_run_policy':
      return detailedDryRunPreviewSchema;
    case 'save_state':
      return infrastructureStateSnapshotSchema;
    default:
      return undefined;
  }
}

function getInternalToolOutputSchema(toolName: string): z.ZodType<unknown> | undefined {
  switch (toolName) {
    case 'propose_draft_spec':
      return draftSpecProposalSchema;
    case 'repair_infra_spec':
    case 'validate_infra_spec':
      return infrastructureSpecSchema;
    case 'build_execution_plan':
      return executionPlanSchema;
    case 'build_dependency_aware_execution_schedule':
      return dependencyAwareExecutionScheduleSchema;
    case 'render_compose_preview':
      return z.string().trim().min(1);
    case 'build_detailed_dry_run_preview':
      return detailedDryRunPreviewSchema;
    case 'evaluate_dry_run_policy':
      return dryRunPolicyFindingsSchema;
    case 'save_state':
      return infrastructureStateSnapshotSchema;
    default:
      return undefined;
  }
}

function createLoadStateTool(dependencies: InternalAgentToolDependencies): AgentTool {
  return {
    name: 'load_state',
    description: 'Read saved desired/actual state as ReAct memory without mutating runtime.',
    async invoke(): Promise<AgentToolResult> {
      const snapshot = await loadState(dependencies.stateStore).catch((error: unknown) => ({
        error: getErrorMessage(error),
      }));

      if (snapshot !== null && 'error' in snapshot) {
        return { ok: true, observation: `Saved state could not be loaded: ${snapshot.error}`, data: null };
      }

      if (snapshot === null) {
        return { ok: true, observation: 'No saved infrastructure state found.', data: null };
      }

      return {
        ok: true,
        observation: dependencies.formatStateMemoryObservation(snapshot),
        data: snapshot,
      };
    },
  };
}

function createResolveImageReferenceTool(): AgentTool {
  return {
    name: 'resolve_image_reference',
    description: 'Resolve one image/runtime reference against the supported image catalog before spec generation.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const imageInput = parseImageReferenceResolutionInput(input);
        const resolution = resolveImageReference(imageInput.image);
        return { ok: true, observation: formatImageResolutionObservation(resolution), data: resolution };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createProposeDraftSpecTool(dependencies: InternalAgentToolDependencies): AgentTool {
  return {
    name: 'propose_draft_spec',
    description: 'Normalize the ValidatedQuery draft into a candidate InfrastructureSpec before validation.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const query = validateValidatedQuery(input);
        const proposal = dependencies.proposeDraftSpec(query);
        return {
          ok: true,
          observation: [
            `Proposed draft spec with ${proposal.spec.services.length} service(s).`,
            `Assumptions: ${proposal.assumptions.join('; ')}.`,
          ].join(' '),
          data: proposal,
        };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createRepairInfrastructureSpecTool(dependencies: InternalAgentToolDependencies): AgentTool {
  return {
    name: 'repair_infra_spec',
    description: 'Repair a candidate InfrastructureSpec after validation returns an observation.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const repairInput = parseSpecRepairInput(input);
        const repairedSpec = dependencies.repairInfrastructureSpec(repairInput.spec);
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
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createBuildExecutionPlanTool(dependencies: InternalAgentToolDependencies): AgentTool {
  return {
    name: 'build_execution_plan',
    description: 'Build an execution plan from a validated InfrastructureSpec.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const planInput = parsePlanBuildInput(input);
        const plan = dependencies.buildExecutionPlanFromSpec(planInput);
        return {
          ok: true,
          observation: [
            `Built execution plan from validated spec with ${plan.spec.services.length} service(s).`,
            `Assumptions: ${plan.assumptions.join('; ')}.`,
          ].join(' '),
          data: plan,
        };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
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
        return { ok: true, observation: `Validated infrastructure spec for project "${spec.projectName}".`, data: spec };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createBuildDependencyAwareExecutionScheduleTool(): AgentTool {
  return {
    name: 'build_dependency_aware_execution_schedule',
    description: 'Build a dependency-aware dry-run execution schedule without mutating runtime.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const spec = validateInfrastructureSpec(input);
        const schedule = buildDependencyAwareExecutionSchedule(spec);
        return {
          ok: true,
          observation: [
            `Built dependency-aware execution schedule with ${schedule.steps.length} step(s).`,
            `Service start order: ${schedule.serviceStartOrder.join(' -> ')}.`,
            `Destroy order preview: ${schedule.destroyOrder.join(' -> ')}.`,
            `Readiness warnings: ${schedule.warnings.length}.`,
          ].join(' '),
          data: schedule,
        };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
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
        return { ok: true, observation: `Rendered Docker Compose preview with ${lineCount} line(s).`, data: composeYaml };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createBuildDetailedDryRunPreviewTool(): AgentTool {
  return {
    name: 'build_detailed_dry_run_preview',
    description: 'Build a detailed dependency-aware dry-run report without Docker, MCP, artifact writes, or state writes.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const previewInput = parseDetailedDryRunPreviewInput(input);
        const preview = buildDetailedDryRunPreview(previewInput.plan, previewInput.composeYaml, previewInput.schedule);
        return {
          ok: true,
          observation: [
            `Built detailed dry-run preview for ${preview.totalServices} service(s) and ${preview.totalContainers} container(s).`,
            `Artifact target "${preview.artifactTargetPath}" was not written.`,
            'Docker not called; MCP not called; state not saved.',
          ].join(' '),
          data: preview,
        };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createEvaluateDryRunPolicyTool(): AgentTool {
  return {
    name: 'evaluate_dry_run_policy',
    description: 'Evaluate detailed dry-run policy warnings such as exposed ports, default secrets, volumes, and preview-only readiness gates.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const preview = validateDetailedDryRunPreview(input);
        const findings = preview.policyFindings;
        const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
        const blockerCount = findings.filter((finding) => finding.severity === 'blocker').length;
        return {
          ok: blockerCount === 0,
          observation: [
            `Evaluated dry-run policy with ${findings.length} finding(s).`,
            `Warnings: ${warningCount}. Blockers: ${blockerCount}.`,
          ].join(' '),
          data: findings,
        };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function createSaveStateTool(dependencies: InternalAgentToolDependencies): AgentTool {
  return {
    name: 'save_state',
    description: 'Persist a validated desired-state snapshot after the approval/execution phase allows state writes.',
    async invoke(input: unknown): Promise<AgentToolResult> {
      try {
        const snapshot = validateInfrastructureStateSnapshot(input);
        await saveState(snapshot, dependencies.stateStore);
        return { ok: true, observation: 'Saved infrastructure state memory file.', data: snapshot };
      } catch (error) {
        return { ok: false, observation: getErrorMessage(error), data: null };
      }
    },
  };
}

function parseImageReferenceResolutionInput(input: unknown): ImageReferenceResolutionInput {
  if (!isRecord(input)) throw new Error('Image reference resolution input must be an object.');
  const image = input.image;
  if (typeof image !== 'string' || image.trim() === '') {
    throw new Error('Image reference resolution input requires image.');
  }
  return { image };
}

function parseDetailedDryRunPreviewInput(input: unknown): DetailedDryRunPreviewInput {
  if (!isRecord(input)) throw new Error('Detailed dry-run preview input must be an object.');
  const composeYaml = input.composeYaml;
  if (typeof composeYaml !== 'string' || composeYaml.trim() === '') {
    throw new Error('Detailed dry-run preview input requires composeYaml.');
  }
  return {
    plan: validateExecutionPlan(input.plan),
    composeYaml,
    schedule: validateDependencyAwareExecutionSchedule(input.schedule),
  };
}

function parsePlanBuildInput(input: unknown): PlanBuildInput {
  if (!isRecord(input)) throw new Error('Plan build input must be an object.');
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
  return { spec: validateInfrastructureSpec(input.spec), rawPrompt, assumptions };
}

function parseSpecRepairInput(input: unknown): SpecRepairInput {
  if (!isRecord(input)) throw new Error('Spec repair input must be an object.');
  const rawPrompt = input.rawPrompt;
  const validationIssue = input.validationIssue;
  if (typeof rawPrompt !== 'string' || rawPrompt.trim() === '') {
    throw new Error('Spec repair input requires rawPrompt.');
  }
  if (typeof validationIssue !== 'string' || validationIssue.trim() === '') {
    throw new Error('Spec repair input requires validationIssue.');
  }
  return { spec: validateInfrastructureSpec(input.spec), rawPrompt, validationIssue };
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
    `Could not confidently resolve image/runtime "${resolution.raw}".`,
    resolution.reason,
    candidateText,
  ].join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
