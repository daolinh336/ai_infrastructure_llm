import { randomBytes } from 'node:crypto';
import type { InfrastructureSpec } from '../domain/types.js';
import { isSecretLikeKey, type SecretResolutionResult } from './secret-resolver.js';

export interface RepairedSecret {
  serviceName: string;
  key: string;
  envVarName: string;
  originalSource: 'env-file' | 'auto-generated' | 'unknown';
  reason: string;
}

export interface SecretPolicyRepairResult {
  updatedSpec: InfrastructureSpec;
  repairedSecrets: RepairedSecret[];
}

export function repairExposedSecrets(
  spec: InfrastructureSpec,
  secretResolution?: SecretResolutionResult,
): SecretPolicyRepairResult {
  const repairedSecrets: RepairedSecret[] = [];
  const updatedServices = spec.services.map((service) => {
    const environment = { ...(service.environment ?? {}) };
    let changed = false;

    for (const [key, value] of Object.entries(environment)) {
      if (!isSecretLikeKey(key)) {
        continue;
      }

      const repairReason = getObviousSecretExposureReason(value);
      if (repairReason === null) {
        continue;
      }

      const resolvedSecret = secretResolution?.services
        .find((resolution) => resolution.serviceName === service.name)
        ?.secrets.find((secret) => secret.key === key);

      environment[key] = generatePolicyRepairSecret();
      changed = true;
      repairedSecrets.push({
        serviceName: service.name,
        key,
        envVarName: resolvedSecret?.envVarName ?? key,
        originalSource: resolvedSecret?.source ?? 'unknown',
        reason: repairReason,
      });
    }

    return changed ? { ...service, environment } : service;
  });

  return {
    updatedSpec: { ...spec, services: updatedServices },
    repairedSecrets,
  };
}

export function isObviouslyExposedSecret(value: string): boolean {
  return getObviousSecretExposureReason(value) !== null;
}

function getObviousSecretExposureReason(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return 'empty secret value';
  }
  if (['app', 'admin', 'password', 'changeme', 'secret', 'postgres', 'root'].includes(normalized)) {
    return 'common default password';
  }
  if (/^\d+$/.test(normalized)) {
    return 'numeric-only password';
  }
  if (/^(.)\1+$/.test(normalized)) {
    return 'single repeated character';
  }
  if (isRepeatedPattern(normalized)) {
    return 'repeated pattern password';
  }
  if (containsSequentialRun(normalized)) {
    return 'sequential pattern password';
  }
  if (normalized.length < 12) {
    return 'short password';
  }
  return null;
}

function generatePolicyRepairSecret(): string {
  return 'pw-' + randomBytes(12).toString('hex');
}

function isRepeatedPattern(value: string): boolean {
  for (let size = 2; size <= Math.floor(value.length / 2); size += 1) {
    if (value.length % size !== 0) {
      continue;
    }
    const pattern = value.slice(0, size);
    if (pattern.repeat(value.length / size) === value) {
      return true;
    }
  }
  return false;
}

function containsSequentialRun(value: string): boolean {
  return /(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|defg|efgh|fghi|ghij|hijk|ijkl|jklm|klmn|lmno|mnop|nopq|opqr|pqrs|qrst|rstu|stuv|tuvw|uvwx|vwxy|wxyz)/i.test(value);
}
