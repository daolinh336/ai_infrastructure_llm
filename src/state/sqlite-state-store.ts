import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { renderCompose } from '../compose/render-compose.js';
import {
  DomainValidationError,
  validateInfrastructureStateSnapshot,
  validateLegacyStateSnapshot,
} from '../domain/schemas.js';
import type {
  AgentObservation,
  ApprovalResult,
  ApprovedAction,
  ComposeArtifactRecord,
  DetailedDryRunPreview,
  ExecutionPlan,
  InfrastructureStateSnapshot,
  LegacyStateSnapshot,
  PendingPreviewState,
  InfrastructureSpec,
  ReActStep,
  RequestMetadata,
  RuntimeActualState,
  RuntimeResourceRefs,
  DriftReport,
  RepairReport,
  CleanupReport,
  StateOperationRecord,
  VerificationReport,
  VerificationState,
  VerifiedRuntimeSnapshot,
} from '../domain/types.js';

const STATE_DIR = path.resolve('state');
const STATE_DATABASE = path.join(STATE_DIR, 'infra-state.sqlite');
const LEGACY_JSON_STATE_FILE = path.join(STATE_DIR, 'infra-state.json');
const STATE_SCHEMA_VERSION = 1;
const SQLITE_USER_VERSION = 1;
const COMPOSE_ARTIFACT_TARGET_PATH = 'docker-compose.yaml';
const SINGLETON_STATE_ID = 1;

export interface StateStoreOptions {
  stateDatabasePath?: string;
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

interface StateSnapshotRow {
  schema_version: number;
  current_json: string | null;
  pending_preview_json: string | null;
}

interface StateOperationRow {
  id: string;
  type: StateOperationRecord['type'];
  project_name: string;
  request_json: string | null;
  summary: string;
  created_at: string;
  payload_json: string;
}

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreError';
  }
}

export async function loadState(
  options: StateStoreOptions = {},
): Promise<InfrastructureStateSnapshot | null> {
  const databasePath = getStateDatabasePath(options);

  if (databasePath !== ':memory:' && !existsSync(databasePath)) {
    const migratedState = loadLegacyJsonStateIfPresent(databasePath);
    return migratedState;
  }

  const database = openDatabase(databasePath);

  try {
    ensureSchema(database);
    const snapshot = database
      .prepare(
        [
          'SELECT schema_version, current_json, pending_preview_json',
          'FROM state_snapshots',
          'WHERE id = ?',
        ].join(' '),
      )
      .get(SINGLETON_STATE_ID) as StateSnapshotRow | undefined;

    if (!snapshot) {
      return null;
    }

    const historyRows = database
      .prepare(
        [
          'SELECT id, type, project_name, request_json, summary, created_at, payload_json',
          'FROM state_operations',
          'ORDER BY rowid ASC',
        ].join(' '),
      )
      .all() as StateOperationRow[];

    return validateInfrastructureStateSnapshot({
      schemaVersion: snapshot.schema_version,
      current: parseJsonField<VerifiedRuntimeSnapshot | null>(
        snapshot.current_json,
        'current_json',
      ),
      pendingPreview: parseJsonField<PendingPreviewState | null>(
        snapshot.pending_preview_json,
        'pending_preview_json',
      ),
      history: historyRows.map((row) =>
        parseJsonField<StateOperationRecord>(row.payload_json, `history:${row.id}`),
      ),
    });
  } catch (error) {
    if (error instanceof StateStoreError || error instanceof DomainValidationError) {
      throw new StateStoreError(getValidationErrorMessage(error));
    }

    throw new StateStoreError(`Failed to load SQLite state: ${getErrorMessage(error)}`);
  } finally {
    database.close();
  }
}

export async function saveState(
  stateSnapshot: InfrastructureStateSnapshot,
  options: StateStoreOptions = {},
): Promise<void> {
  const validStateSnapshot = validateInfrastructureStateSnapshot(stateSnapshot);
  const database = openDatabaseForWrite(options);

  try {
    ensureSchema(database);
    const write = database.transaction(() => {
      upsertSnapshot(database, validStateSnapshot);
      replaceOperations(database, validStateSnapshot.history);
    });

    write();
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new StateStoreError(error.message);
    }

    throw new StateStoreError(`Failed to save SQLite state: ${getErrorMessage(error)}`);
  } finally {
    database.close();
  }
}

export async function savePendingPreview(
  pendingPreview: PendingPreviewState,
  options: StateStoreOptions = {},
): Promise<InfrastructureStateSnapshot> {
  const existingState = (await loadState(options)) ?? createEmptyStateSnapshot();
  const operation = createStateOperationRecord({
    type: 'pending-preview-saved',
    projectName: pendingPreview.desired.projectName,
    request: pendingPreview.request,
    summary: `Saved pending preview for project "${pendingPreview.desired.projectName}".`,
    createdAt: pendingPreview.createdAt,
  });
  const nextState = validateInfrastructureStateSnapshot({
    ...existingState,
    pendingPreview,
    history: [...existingState.history, operation],
  });

  await saveState(nextState, options);
  return nextState;
}

export async function saveApprovalRejection(
  pendingPreview: PendingPreviewState,
  approval: ApprovalResult,
  options: StateStoreOptions = {},
): Promise<InfrastructureStateSnapshot> {
  const existingState = (await loadState(options)) ?? createEmptyStateSnapshot();
  const rejectedPreview = validatePendingPreviewForState({
    ...pendingPreview,
    approval,
    approvedAction: null,
  });
  const operation = createStateOperationRecord({
    type: 'approval-rejected',
    projectName: pendingPreview.desired.projectName,
    request: pendingPreview.request,
    summary: `Approval rejected for project "${pendingPreview.desired.projectName}".`,
    createdAt: approval.respondedAt,
  });
  const nextState = validateInfrastructureStateSnapshot({
    ...existingState,
    current: existingState.current,
    pendingPreview: rejectedPreview,
    history: [...existingState.history, operation],
  });

  await saveState(nextState, options);
  return nextState;
}

export async function saveApprovedAction(
  pendingPreview: PendingPreviewState,
  approvedAction: ApprovedAction,
  options: StateStoreOptions = {},
): Promise<InfrastructureStateSnapshot> {
  const existingState = (await loadState(options)) ?? createEmptyStateSnapshot();
  const acceptedAt = approvedAction.approvalMarker.approvedAt;
  const acceptedPreview = validatePendingPreviewForState({
    ...pendingPreview,
    composeArtifact: approvedAction.composeArtifact,
    acceptedAt,
    approval: approvedAction.approval,
    approvedAction,
  });
  const composeWrittenOperation = createStateOperationRecord({
    type: 'compose-artifact-written',
    projectName: pendingPreview.desired.projectName,
    request: pendingPreview.request,
    summary: `Wrote compose artifact "${approvedAction.composeArtifact.targetPath}" for project "${pendingPreview.desired.projectName}".`,
    createdAt: acceptedAt,
  });
  const approvedActionOperation = createStateOperationRecord({
    type: 'approved-action-created',
    projectName: pendingPreview.desired.projectName,
    request: pendingPreview.request,
    summary: `Created ApprovedAction for project "${pendingPreview.desired.projectName}".`,
    createdAt: acceptedAt,
  });
  const nextState = validateInfrastructureStateSnapshot({
    ...existingState,
    current: existingState.current,
    pendingPreview: acceptedPreview,
    history: [
      ...existingState.history,
      composeWrittenOperation,
      approvedActionOperation,
    ],
  });

  await saveState(nextState, options);
  return nextState;
}

export interface SaveVerifiedRuntimeSnapshotInput {
  approvedAction?: ApprovedAction;
  sourceSnapshot?: VerifiedRuntimeSnapshot;
  desired?: InfrastructureSpec;
  actual: RuntimeActualState;
  verificationReport: VerificationReport;
  operation: 'deploy' | 'repair' | 'destroy' | 'sync';
  resourceRefs: RuntimeResourceRefs;
  driftReport?: DriftReport | null;
  repairReport?: RepairReport | null;
  cleanupReport?: CleanupReport | null;
  observedAt?: string;
  appliedAt?: string;
  savedAt?: string;
}

export async function saveVerifiedRuntimeSnapshot(
  input: SaveVerifiedRuntimeSnapshotInput,
  options: StateStoreOptions = {},
): Promise<InfrastructureStateSnapshot> {
  const existingState = (await loadState(options)) ?? createEmptyStateSnapshot();
  const savedAt = input.savedAt ?? new Date().toISOString();
  const observedAt = input.observedAt ?? savedAt;
  const appliedAt = input.appliedAt ?? savedAt;
  const verification = toVerificationState(input.verificationReport);
  const source = input.approvedAction ?? input.sourceSnapshot;
  if (!source) {
    throw new Error('saveVerifiedRuntimeSnapshot requires either approvedAction or sourceSnapshot.');
  }
  const request = input.approvedAction
    ? input.approvedAction.request
    : input.sourceSnapshot!.request;
  const desired = input.desired
    ?? (input.approvedAction
      ? input.approvedAction.validatedSpec
      : input.sourceSnapshot!.desired);
  const composeArtifact = input.approvedAction
    ? input.approvedAction.composeArtifact
    : input.sourceSnapshot!.composeArtifact;
  const approvedAt = input.approvedAction
    ? input.approvedAction.approvalMarker.approvedAt
    : input.sourceSnapshot!.approvedAt;
  const snapshot: VerifiedRuntimeSnapshot = {
    id: `verified-runtime-${toStableId(savedAt)}`,
    request,
    desired,
    composeArtifact,
    actual: input.actual,
    verification,
    verificationReport: input.verificationReport,
    resourceRefs: input.resourceRefs,
    driftReport: input.driftReport ?? null,
    repairReport: input.repairReport ?? null,
    cleanupReport: input.cleanupReport ?? null,
    observedAt,
    operation: input.operation,
    approvedAt,
    appliedAt,
    savedAt,
  };
  const operation = createStateOperationRecord({
    type: 'verified-runtime-saved',
    projectName: desired.projectName,
    request,
    summary: `Saved verified runtime snapshot for project "${desired.projectName}" after ${input.operation}.`,
    createdAt: savedAt,
  });
  const nextState = validateInfrastructureStateSnapshot({
    ...existingState,
    current: snapshot,
    history: [...existingState.history, operation],
  });
  await saveState(nextState, options);
  return nextState;
}

function toVerificationState(report: VerificationReport): VerificationState {
  return {
    status: report.status === 'passed' ? 'passed' : report.status === 'uncertain' ? 'uncertain' : 'failed',
    scope: 'runtime',
    checkedAt: report.checkedAt,
    summary: report.status === 'passed' ? 'Runtime verification passed.' : report.errorReason ?? 'Runtime verification did not pass.',
    issues: report.issues,
    evidence: report.evidence,
  };
}

export interface SaveStateOperationInput {
  type: StateOperationRecord['type'];
  projectName: string;
  request: RequestMetadata | null;
  summary: string;
  createdAt?: string;
}

export async function saveStateOperationRecord(
  input: SaveStateOperationInput,
  options: StateStoreOptions = {},
): Promise<InfrastructureStateSnapshot> {
  const existingState = (await loadState(options)) ?? createEmptyStateSnapshot();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const record = createStateOperationRecord({
    type: input.type,
    projectName: input.projectName,
    request: input.request,
    summary: input.summary,
    createdAt,
  });
  const nextState = validateInfrastructureStateSnapshot({
    ...existingState,
    current: existingState.current,
    pendingPreview: existingState.pendingPreview,
    history: [...existingState.history, record],
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
    approval: null,
    approvedAction: null,
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

export function getStateDatabasePath(options: StateStoreOptions = {}): string {
  return options.stateDatabasePath ?? STATE_DATABASE;
}

export function getLegacyJsonStatePath(): string {
  return LEGACY_JSON_STATE_FILE;
}

export function migrateLegacyStateSnapshot(
  legacySnapshot: LegacyStateSnapshot,
): InfrastructureStateSnapshot {
  const createdAt =
    legacySnapshot.desiredStateSavedAt ??
    legacySnapshot.lastAppliedAt ??
    new Date().toISOString();
  const request: RequestMetadata = {
    raw: 'Legacy state imported from pre-SQLite state storage.',
    normalizedPrompt: 'legacy-state-import',
    intent: 'create',
  };
  const composeYaml = renderCompose(legacySnapshot.desired);
  const legacyPlan: ExecutionPlan = {
    summary: `Legacy imported state for project "${legacySnapshot.desired.projectName}".`,
    spec: legacySnapshot.desired,
    assumptions: [
      'Imported from legacy pre-SQLite state during state migration.',
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
          'Legacy pre-SQLite state was imported as pending preview memory; no verified runtime current state was created.',
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
    approval: null,
    approvedAction: null,
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

function openDatabaseForWrite(options: StateStoreOptions): Database.Database {
  const databasePath = getStateDatabasePath(options);

  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  return openDatabase(databasePath);
}

function loadLegacyJsonStateIfPresent(
  databasePath: string,
): InfrastructureStateSnapshot | null {
  const legacyJsonPath = path.join(path.dirname(databasePath), 'infra-state.json');

  if (!existsSync(legacyJsonPath)) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(legacyJsonPath, 'utf8'));
  } catch (error) {
    throw new StateStoreError(
      `Legacy JSON state file is malformed and cannot be imported: ${getErrorMessage(error)}`,
    );
  }

  try {
    return validateInfrastructureStateSnapshot(parsed);
  } catch (stateError) {
    try {
      return migrateLegacyStateSnapshot(validateLegacyStateSnapshot(parsed));
    } catch (legacyError) {
      throw new StateStoreError(
        [
          'Legacy JSON state file cannot be imported as a SQLite-compatible state snapshot.',
          getValidationErrorMessage(stateError),
          'Legacy v0 migration also failed.',
          getValidationErrorMessage(legacyError),
        ].join('\n'),
      );
    }
  }
}

function openDatabase(databasePath: string): Database.Database {
  return new Database(databasePath);
}

function ensureSchema(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma(`user_version = ${SQLITE_USER_VERSION}`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS state_snapshots (
      id INTEGER PRIMARY KEY CHECK (id = ${SINGLETON_STATE_ID}),
      schema_version INTEGER NOT NULL,
      current_json TEXT,
      pending_preview_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS state_operations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_name TEXT NOT NULL,
      request_json TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_state_operations_project_created
      ON state_operations(project_name, created_at);

    CREATE INDEX IF NOT EXISTS idx_state_operations_type_created
      ON state_operations(type, created_at);
  `);
}

function upsertSnapshot(
  database: Database.Database,
  stateSnapshot: InfrastructureStateSnapshot,
): void {
  database
    .prepare(
      [
        'INSERT INTO state_snapshots',
        '(id, schema_version, current_json, pending_preview_json, updated_at)',
        'VALUES (@id, @schemaVersion, @currentJson, @pendingPreviewJson, @updatedAt)',
        'ON CONFLICT(id) DO UPDATE SET',
        'schema_version = excluded.schema_version,',
        'current_json = excluded.current_json,',
        'pending_preview_json = excluded.pending_preview_json,',
        'updated_at = excluded.updated_at',
      ].join(' '),
    )
    .run({
      id: SINGLETON_STATE_ID,
      schemaVersion: stateSnapshot.schemaVersion,
      currentJson: stringifyNullableJson(stateSnapshot.current),
      pendingPreviewJson: stringifyNullableJson(stateSnapshot.pendingPreview),
      updatedAt: new Date().toISOString(),
    });
}

function replaceOperations(
  database: Database.Database,
  history: StateOperationRecord[],
): void {
  database.prepare('DELETE FROM state_operations').run();
  const insertOperation = database.prepare(
    [
      'INSERT INTO state_operations',
      '(id, type, project_name, request_json, summary, created_at, payload_json)',
      'VALUES (@id, @type, @projectName, @requestJson, @summary, @createdAt, @payloadJson)',
    ].join(' '),
  );

  for (const operation of history) {
    insertOperation.run({
      id: operation.id,
      type: operation.type,
      projectName: operation.projectName,
      requestJson: stringifyNullableJson(operation.request),
      summary: operation.summary,
      createdAt: operation.createdAt,
      payloadJson: JSON.stringify(operation),
    });
  }
}

function createEmptyStateSnapshot(): InfrastructureStateSnapshot {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    current: null,
    pendingPreview: null,
    history: [],
  };
}

function createStateOperationRecord(input: {
  type: InfrastructureStateSnapshot['history'][number]['type'];
  projectName: string;
  request: RequestMetadata | null;
  summary: string;
  createdAt: string;
}): InfrastructureStateSnapshot['history'][number] {
  return {
    id: `${input.type}-${toStableId(input.createdAt)}`,
    type: input.type,
    projectName: input.projectName,
    request: input.request,
    summary: input.summary,
    createdAt: input.createdAt,
  };
}

function validatePendingPreviewForState(
  pendingPreview: PendingPreviewState,
): PendingPreviewState {
  return validateInfrastructureStateSnapshot({
    schemaVersion: STATE_SCHEMA_VERSION,
    current: null,
    pendingPreview,
    history: [],
  }).pendingPreview as PendingPreviewState;
}

function parseJsonField<T>(value: string | null, label: string): T | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new StateStoreError(
      `State database field "${label}" contains malformed JSON: ${getErrorMessage(error)}`,
    );
  }
}

function stringifyNullableJson(value: unknown | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function countNonEmptyLines(value: string): number {
  return value.trim() === '' ? 0 : value.trim().split(/\r?\n/).length;
}

function toStableId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-');
}

function getValidationErrorMessage(error: unknown): string {
  if (error instanceof DomainValidationError || error instanceof StateStoreError) {
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
