import { DomainValidationError } from '../domain/schemas.js';

export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  try {
    return JSON.parse(withoutFence);
  } catch (error) {
    throw new DomainValidationError('structured LLM JSON', [
      `Response was not valid JSON: ${getErrorMessage(error)}`,
    ]);
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
