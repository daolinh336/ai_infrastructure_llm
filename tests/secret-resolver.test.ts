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

  it('does not reuse previous state secrets when env is absent', () => {
    const result = resolveSecrets(expandedPostgresSpec(1), previousPostgresSpec('state-password'), {
      env: {},
    });

    const service = result.updatedSpec.services[0];
    expect(service?.environment?.POSTGRES_PASSWORD).toBe('generated-1');
    expect(result.services[0]?.secrets[0]).toEqual(
      expect.objectContaining({
        key: 'POSTGRES_PASSWORD',
        source: 'auto-generated',
        value: 'generated-1',
      }),
    );
  });

  it('uses env secrets instead of previous state secrets', () => {
    const result = resolveSecrets(expandedPostgresSpec(1), previousPostgresSpec('state-password'), {
      env: { POSTGRES_PASSWORD: 'env-password-strong' },
    });

    expect(result.updatedSpec.services[0]?.environment?.POSTGRES_PASSWORD).toBe('env-password-strong');
    expect(result.services[0]?.secrets[0]).toEqual(
      expect.objectContaining({
        envVarName: 'POSTGRES_PASSWORD',
        source: 'env-file',
        value: 'env-password-strong',
      }),
    );
  });

  it('uses prefixed env secrets before shared env secrets for duplicate keys', () => {
    const result = resolveSecrets(expandedPostgresSpec(2), null, {
      env: {
        POSTGRES_2_POSTGRES_PASSWORD: 'prefixed-password-strong',
        POSTGRES_PASSWORD: 'shared-password-strong',
      },
    });

    expect(result.updatedSpec.services[0]?.environment?.POSTGRES_PASSWORD).toBe('shared-password-strong');
    expect(result.updatedSpec.services[1]?.environment?.POSTGRES_PASSWORD).toBe('prefixed-password-strong');
    expect(result.services[1]?.secrets[0]).toEqual(
      expect.objectContaining({
        envVarName: 'POSTGRES_2_POSTGRES_PASSWORD',
        source: 'env-file',
        value: 'prefixed-password-strong',
      }),
    );
  });
});

function previousPostgresSpec(password: string): InfrastructureSpec {
  const spec = expandedPostgresSpec(1);
  return {
    ...spec,
    services: spec.services.map((service) => ({
      ...service,
      environment: { ...(service.environment ?? {}), POSTGRES_PASSWORD: password },
    })),
  };
}

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
