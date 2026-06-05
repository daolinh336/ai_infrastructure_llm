import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DomainValidationError,
  validateStateSnapshot,
} from '../domain/schemas.js';
import type { StateSnapshot } from '../domain/types.js';

const STATE_DIR = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'infra-state.json');

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreError';
  }
}

export async function loadState(): Promise<StateSnapshot | null> {
  let content: string;

  try {
    content = await readFile(STATE_FILE, 'utf8');
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
    throw new StateStoreError(`State file is not valid JSON: ${getErrorMessage(error)}`);
  }

  try {
    return validateStateSnapshot(parsed);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new StateStoreError(error.message);
    }

    throw error;
  }
}

export async function saveState(snapshot: StateSnapshot): Promise<void> {
  const validSnapshot = validateStateSnapshot(snapshot);

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(validSnapshot, null, 2), 'utf8');
}

export function getStateFilePath(): string {
  return STATE_FILE;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
