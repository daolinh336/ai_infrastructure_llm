import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { renderCompose } from '../src/compose/render-compose.js';
import { validateInfrastructureSpec } from '../src/domain/schemas.js';
import {
  getContainerVolumeMountsForReplica,
  normalizeStatefulDatabaseReplicaVolumes,
} from '../src/domain/stateful-database-volumes.js';
import type { InfrastructureSpec } from '../src/domain/types.js';

describe('stateful database replica volumes', () => {
  it('rejects a replicated database with one shared data volume', () => {
    expect(() =>
      validateInfrastructureSpec({
        projectName: 'sample-infra',
        services: [
          {
            kind: 'database',
            name: 'postgres',
            image: 'postgres:16',
            replicas: 3,
            volumes: ['postgres-data:/var/lib/postgresql/data'],
          },
        ],
        networks: ['app-network'],
        volumes: ['postgres-data'],
      }),
    ).toThrow('cannot use one shared data volume');
  });

  it('adds generated per-replica volumes when a database is scaled up', () => {
    const normalized = normalizeStatefulDatabaseReplicaVolumes(baseSpec());

    expect(normalized.volumes).toEqual([
      'postgres-data-1',
      'postgres-data-2',
      'postgres-data-3',
    ]);

    const primary = normalized.services[0]!;
    const secondReplica = normalized.services[2]!;
    expect(primary.name).toBe('postgres-1');
    expect(secondReplica.name).toBe('postgres-3');
    expect(getContainerVolumeMountsForReplica(primary, 0)).toEqual([
      'postgres-data-1:/var/lib/postgresql/data',
    ]);
    expect(getContainerVolumeMountsForReplica(secondReplica, 0)).toEqual([
      'postgres-data-3:/var/lib/postgresql/data',
    ]);
  });

  it('renders database replicas as isolated compose services with separate volumes', () => {
    const composeYaml = renderCompose(baseSpec());
    const parsed = YAML.parse(composeYaml) as {
      services: Record<string, { deploy?: unknown; volumes?: string[]; depends_on?: string[] }>;
      volumes: Record<string, unknown>;
    };

    expect(composeYaml).not.toContain('&');
    expect(composeYaml).not.toContain('*');
    expect(Object.keys(parsed.services)).toEqual(['postgres-1', 'postgres-2', 'postgres-3', 'api']);
    expect(parsed.services['postgres-1']?.deploy).toEqual({ replicas: 1 });
    expect(parsed.services['postgres-1']?.volumes).toEqual(['postgres-data-1:/var/lib/postgresql/data']);
    expect(parsed.services['postgres-2']?.volumes).toEqual(['postgres-data-2:/var/lib/postgresql/data']);
    expect(parsed.services['postgres-3']?.volumes).toEqual(['postgres-data-3:/var/lib/postgresql/data']);
    expect(parsed.services['postgres-2']?.depends_on).toEqual(['postgres-1']);
    expect(parsed.services['postgres-3']?.depends_on).toEqual(['postgres-1']);
    expect(parsed.services.api?.depends_on).toEqual(['postgres-1', 'postgres-2', 'postgres-3']);
    expect(Object.keys(parsed.volumes)).toEqual(['postgres-data-1', 'postgres-data-2', 'postgres-data-3']);
  });
});

function baseSpec(): InfrastructureSpec {
  return {
    projectName: 'sample-infra',
    services: [
      {
        kind: 'database',
        name: 'postgres',
        image: 'postgres:16',
        replicas: 3,
        environment: {
          POSTGRES_DB: 'app',
          POSTGRES_USER: 'app',
          POSTGRES_PASSWORD: 'secret',
        },
      },
      {
        kind: 'backend',
        name: 'api',
        image: 'node:20-alpine',
        dependsOn: ['postgres'],
      },
    ],
    networks: ['app-network'],
    volumes: [],
  };
}
