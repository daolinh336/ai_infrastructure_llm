import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderCompose } from '../compose/render-compose.js';
import {
  DomainValidationError,
  validateInfrastructureStateFile,
  validateLegacyStateSnapshot,
} from '../domain/schemas.js';
import type {
  AgentObservation,
  ComposeArtifactRecord,
  DetailedDryRunPreview,
  ExecutionPlan,
  InfrastructureStateFile,
  LegacyStateSnapshot,
  PendingPreviewState,
  ReActStep,
  RequestMetadata,
  RuntimeActualState,
  VerificationState,
} from '../domain/types.js';

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'infra-state.json');
const STATE_SCHEMA_VERSION = 1;
const COMPOSE_ARTIFACT_TARGET_PATH = 'docker-compose.yaml';

export interface StateStoreOptions {
  stateFilePath?: string;
}

export interface CreatePendingPreviewInput {
  request: RequestMetadata;
  plan: ExecutionPlan;
  composeYaml: string;
  dryRunPreview: DetailedDryRunPreview;
  observations: AgentObservation[];
  trace: ReActStep[];
  createdAt?: string;
}

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreError';
  }
}

export async function loadState(
  options: StateStoreOptions = {},
): Promise<InfrastructureStateFile | null> {
  const stateFilePath = getStateFilePath(options);
  let content: string;

  try {
    content = await readFile(stateFilePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }

    throw new StateStoreError(`Failed to read state file: ${getErrorMessage(error)}`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new StateStoreError(`State file is malformed JSON: ${getErrorMessage(error)}`);
  }

  try {
    return validateInfrastructureStateFile(parsed);
  } catch (stateError) {
    try {
      const legacySnapshot = validateLegacyStateSnapshot(parsed);
      return migrateLegacyStateSnapshot(legacySnapshot);
    } catch (legacyError) {
      throw new StateStoreError(
        [
          'State file has invalid schema.',
          getValidationErrorMessage(stateError),
          'Legacy state migration also failed.',
          getValidationErrorMessage(legacyError),
        ].join('\n'),
      );
    }
  }
}

export async function saveState(
  stateFile: InfrastructureStateFile,
  options: StateStoreOptions = {},
): Promise<void> {
  const validStateFile = validateInfrastructureStateFile(stateFile);
  const stateFilePath = getStateFilePath(options);
  const content = `${JSON.stringify(validStateFile, null, 2)}\n`;

  await mkdir(path.dirname(stateFilePath), { recursive: true });
  await writeStateFileAtomic(stateFilePath, content);
}

export async function savePendingPreview(
  pendingPreview: PendingPreviewState,
  options: StateStoreOptions = {},
): Promise<InfrastructureStateFile> {
  const existingState = (await loadState(options)) ?? createEmptyStateFile();
  const operation = createStateOperationRecord({
    type: 'pending-preview-saved',
    projectName: pendingPreview.desired.projectName,
    request: pendingPreview.request,
    summary: `Saved pending preview for project "${pendingPreview.desired.projectName}".`,
    createdAt: pendingPreview.createdAt,
  });
  const nextState = validateInfrastructureStateFile({
    ...existingState,
    pendingPreview,
    history: [...existingState.history, operation],
  });

  await saveState(nextState, options);
  return nextState;
}

export function createPendingPreviewState(
  input: CreatePendingPreviewInput,
): PendingPreviewState {
  const createdAt = input.createdAt ?? new Date().toISOString();

  return {
    id: `pending-preview-${toStableId(createdAt)}`,
    request: input.request,
    desired: input.plan.spec,
    plan: input.plan,
    composeArtifact: createComposeArtifactRecord(
      input.dryRunPreview.artifactTargetPath,
      input.composeYaml,
      false,
      null,
    ),
    dryRunPreview: input.dryRunPreview,
    observations: input.observations,
    trace: input.trace,
    verification: createVerificationState(
      'preview',
      'Preview generated; runtime verification has not run in Phase 7.',
      [
        'Docker Engine API was not called.',
        'MCP tools were not called.',
        'Final desired/actual runtime state was not saved.',
      ],
    ),
    createdAt,
    acceptedAt: null,
  };
}

export function createComposeArtifactRecord(
  targetPath: string,
  previewContent: string,
  written: boolean,
  writtenAt: string | null,
): ComposeArtifactRecord {
  return {
    targetPath,
    previewContent,
    previewSha256: createHash('sha256').update(previewContent).digest('hex'),
    lineCount: countNonEmptyLines(previewContent),
    written,
    writtenAt,
  };
}

export function createNotObservedRuntimeState(
  source: RuntimeActualState['source'] = 'not-observed',
): RuntimeActualState {
  return {
    source,
    containers: [],
    networks: [],
    volumes: [],
    images: [],
    lastObservedAt: null,
  };
}

export function createVerificationState(
  scope: VerificationState['scope'],
  summary: string,
  evidence: string[] = [],
): VerificationState {
  return {
    status: 'not-run',
    scope,
    checkedAt: null,
    summary,
    issues: [],
    evidence,
  };
}

export function getStateFilePath(options: StateStoreOptions = {}): string {
  return options.stateFilePath ?? STATE_FILE;
}

function createEmptyStateFile(): InfrastructureStateFile {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    current: null,
    pendingPreview: null,
    history: [],
  };
}

function migrateLegacyStateSnapshot(
  legacySnapshot: LegacyStateSnapshot,
): InfrastructureStateFile {
  const createdAt =
    legacySnapshot.desiredStateSavedAt ??
    legacySnapshot.lastAppliedAt ??
    new Date().toISOString();
  const request: RequestMetadata = {
    raw: 'Legacy state imported from state/infra-state.json.',
    normalizedPrompt: 'legacy-state-import',
    intent: 'create',
  };
  const composeYaml = renderCompose(legacySnapshot.desired);
  const legacyPlan: ExecutionPlan = {
    summary: `Legacy imported state for project "${legacySnapshot.desired.projectName}".`,
    spec: legacySnapshot.desired,
    assumptions: [
      'Imported from legacy v0 state file during Phase 7 state migration.',
      'Legacy actual runtime values are treated as placeholders, not verified runtime state.',
    ],
    steps: [
      {
        id: 'legacy-import',
        description: 'Import legacy desired state as pending preview memory.',
        action: 'write-state',
      },
    ],
  };
  const pendingPreview: PendingPreviewState = {
    id: `legacy-preview-${toStableId(createdAt)}`,
    request,
    desired: legacySnapshot.desired,
    plan: legacyPlan,
    composeArtifact: createComposeArtifactRecord(
      COMPOSE_ARTIFACT_TARGET_PATH,
      composeYaml,
      false,
      null,
    ),
    dryRunPreview: null,
    observations: [
      {
        source: 'state:migration',
        message:
          'Legacy v0 state was imported as pending preview memory; no verified runtime current state was created.',
      },
    ],
    trace: [],
    verification: createVerificationState(
      'preview',
      'Legacy state migration has not verified actual Docker runtime state.',
      ['Current state remains null until a future approved apply observes runtime.'],
    ),
    createdAt,
    acceptedAt: null,
  };

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    current: null,
    pendingPreview,
    history: [
      createStateOperationRecord({
        type: 'legacy-state-migrated',
        projectName: legacySnapshot.desired.projectName,
        request,
        summary:
          'Imported legacy state as pending preview; verified current runtime state remains empty.',
        createdAt,
      }),
    ],
  };
}

function createStateOperationRecord(input: {
  type: InfrastructureStateFile['history'][number]['type'];
  projectName: string;
  request: RequestMetadata | null;
  summary: string;
  createdAt: string;
}): InfrastructureStateFile['history'][number] {
  return {
    id: `${input.type}-${toStableId(input.createdAt)}`,
    type: input.type,
    projectName: input.projectName,
    request: input.request,
    summary: input.summary,
    createdAt: input.createdAt,
  };
}

async function writeStateFileAtomic(filePath: string, content: string): Promise<void> {
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(tempFilePath, content, 'utf8');
  await rename(tempFilePath, filePath);
}

function countNonEmptyLines(value: string): number {
  return value.trim() === '' ? 0 : value.trim().split(/\r?\n/).length;
}

function toStableId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function getValidationErrorMessage(error: unknown): string {
  if (error instanceof DomainValidationError) {
    return error.message;
  }

  return getErrorMessage(error);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
