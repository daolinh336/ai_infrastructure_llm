import { describe, expect, it } from 'vitest';
import { resolveSecrets } from '../src/compose/secret-resolver.js';
import type { InfrastructureSpec } from '../src/domain/types.js';

describe('secret and database account resolution', () => {
  it('uses shared .env postgres user and password for an expanded database group', () => {
    const result = resolveSecrets(expandedPostgresSpec(3), null, {
      env: {
        POSTGRES_USER: 'custom-user',
        POSTGRES_PASSWORD: 'custom-password',
      },
    });

    for (const service of result.updatedSpec.services.filter((service) => service.kind === 'database')) {
      expect(service.environment?.POSTGRES_USER).toBe('custom-user');
      expect(service.environment?.POSTGRES_PASSWORD).toBe('custom-password');
    }

    expect(result.services.flatMap((service) => service.secrets)).toEqual([
      expect.objectContaining({ key: 'POSTGRES_PASSWORD', envVarName: 'POSTGRES_PASSWORD', source: 'env-file', value: 'custom-password' }),
      expect.objectContaining({ key: 'POSTGRES_PASSWORD', envVarName: 'POSTGRES_PASSWORD', source: 'env-file', value: 'custom-password' }),
      expect.objectContaining({ key: 'POSTGRES_PASSWORD', envVarName: 'POSTGRES_PASSWORD', source: 'env-file', value: 'custom-password' }),
    ]);
  });

  it('keeps the default postgres user when .env does not provide one', () => {
    const result = resolveSecrets(expandedPostgresSpec(2), null, {
      env: {
        POSTGRES_PASSWORD: 'custom-password',
      },
    });

    for (const service of result.updatedSpec.services.filter((service) => service.kind === 'database')) {
      expect(service.environment?.POSTGRES_USER).toBe('app');
      expect(service.environment?.POSTGRES_PASSWORD).toBe('custom-password');
    }
  });
});

function expandedPostgresSpec(replicas: number): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: Array.from({ length: replicas }, (_, index) => ({
      kind: 'database' as const,
      name: `postgres-${index + 1}`,
      image: 'postgres:16',
      environment: {
        POSTGRES_DB: 'app',
        POSTGRES_USER: 'app',
        POSTGRES_PASSWORD: `generated-${index + 1}`,
      },
      volumes: [`postgres-data-${index + 1}:/var/lib/postgresql/data`],
      ...(index === 0 ? {} : { dependsOn: ['postgres-1'] }),
    })),
    networks: ['app-network'],
    volumes: Array.from({ length: replicas }, (_, index) => `postgres-data-${index + 1}`),
  };
}
